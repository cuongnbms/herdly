//! Machine manager: owns Machines, their Sessions and watchers, and the UI event stream.
use crate::{
    attach::AttachManager,
    error::{AppError, AppResult},
    files::paths::resolve_root,
    herdr::{
        background::{PiProbe, Probe},
        rpc,
        types::AgentStatus,
        watcher::{spawn_watcher, SharedMarks, WatchEvent},
    },
    transcript::{self, ChatManager, Located},
    transport::{
        drop_client_only, exec, herdr_argv,
        local::LocalTransport,
        parse_probe, parse_session_list, probe_argv, split_probe,
        ssh::{
            classify_ssh_error, clear_stale_ctl, link_alive, master_alive, master_exit,
            start_master, SshTransport,
        },
        MachineInfo, SessionEntry, Transport,
    },
    view::{MachineState, MachineView, PaneRef, PaneStatusEvent, PaneView, SessionView},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tokio::{sync::mpsc, task::JoinHandle};

pub const ALLOWED_METHODS: &[&str] = &[
    "pane.split",
    "pane.close",
    "pane.focus",
    "pane.rename",
    "pane.read",
    "pane.scroll",
    "pane.send_text",
    "tab.create",
    "tab.close",
    "tab.rename",
    "tab.move",
    "workspace.create",
    "workspace.close",
    "workspace.rename",
    "agent.start",
    "agent.prompt",
    "agent.send_keys",
    "agent.get",
];

const EMIT_THROTTLE: Duration = Duration::from_millis(100);
const START_WAIT: Duration = Duration::from_secs(10);
const START_POLL: Duration = Duration::from_millis(200);
/// How often a connected ssh Machine's master is checked.
const HEALTH_EVERY: Duration = Duration::from_secs(15);
/// How long to wait for herdr to report a just-started Claude agent's session.
const SESSION_WAIT: Duration = Duration::from_secs(3);
pub const LOCAL: &str = "local";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MachineConfig {
    pub id: String,
    pub label: String,
    pub ssh_target: String,
    pub herdr_path: Option<String>,
    pub enabled: bool,
}

/// Missing or corrupt file gives an empty list (corruption is logged).
pub fn load_registry(path: &Path) -> Vec<MachineConfig> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("cannot read {}: {e}", path.display());
            }
            return Vec::new();
        }
    };
    serde_json::from_str(&text).unwrap_or_else(|e| {
        tracing::error!("corrupt machine registry {}: {e}", path.display());
        Vec::new()
    })
}

/// Write to a temp file next to `path`, then rename over it.
pub fn save_registry(path: &Path, list: &[MachineConfig]) -> AppResult<()> {
    let json =
        serde_json::to_string_pretty(list).map_err(|e| AppError::new("io", e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Lowercase `[a-z0-9-]`, at most 16 chars, unique against `taken` (and never `local`).
pub fn slug(label: &str, taken: &[String]) -> String {
    let mut base = String::new();
    for c in label.to_lowercase().chars() {
        let c = if c.is_ascii_alphanumeric() { c } else { '-' };
        if c == '-' && (base.is_empty() || base.ends_with('-')) {
            continue;
        }
        base.push(c);
    }
    let trim = |s: &str, n: usize| {
        s.chars()
            .take(n)
            .collect::<String>()
            .trim_end_matches('-')
            .to_string()
    };
    let base = match trim(&base, 16) {
        b if b.is_empty() => "machine".to_string(),
        b => b,
    };
    let is_taken = |s: &str| s == LOCAL || taken.iter().any(|t| t == s);
    if !is_taken(&base) {
        return base;
    }
    (2u32..)
        .map(|n| {
            let suffix = format!("-{n}");
            format!("{}{suffix}", trim(&base, 16 - suffix.len()))
        })
        .find(|c| !is_taken(c))
        .expect("unbounded range")
}

/// Remove any forwarded-socket files (`<id>-<8 hex>.sock`) left in the runtime dir.
fn sweep_sockets(id: &str) {
    let dir = match crate::transport::secure_runtime_dir() {
        Ok(d) => d,
        Err(e) => {
            tracing::error!("not sweeping sockets, runtime dir is not secure: {e}");
            return;
        }
    };
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{id}-");
    for f in rd.flatten() {
        let name = f.file_name().to_string_lossy().into_owned();
        let hex = name
            .strip_prefix(&prefix)
            .and_then(|r| r.strip_suffix(".sock"));
        if hex.is_some_and(|h| h.len() == 8 && h.chars().all(|c| c.is_ascii_hexdigit())) {
            let _ = std::fs::remove_file(f.path());
        }
    }
}

/// The Sessions from `herdr session list`'s exit status and output, client-only ones dropped.
async fn session_entries(
    t: &dyn Transport,
    status: i32,
    stdout: &str,
    stderr: &str,
) -> AppResult<Vec<SessionEntry>> {
    if status != 0 {
        return Err(AppError::new(
            "herdr_error",
            format!("session list failed: {}", stderr.trim()),
        ));
    }
    Ok(drop_client_only(t, parse_session_list(stdout)).await)
}

/// Watcher retry delay: 1, 2, 4, 8, 16, 32, then 60 s.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(if attempt >= 6 { 60 } else { 1u64 << attempt })
}

/// How long a watcher must have been up (since its first snapshot) to count as recovered.
pub const STABLE_WATCH: Duration = Duration::from_secs(30);

/// The backoff attempt after a watcher ended: back to the start only when it had been up
/// for `STABLE_WATCH`, so one that fails right after its snapshot keeps backing off.
fn retry_attempt(attempt: u32, up_for: Option<Duration>) -> u32 {
    if up_for.is_some_and(|d| d >= STABLE_WATCH) {
        0
    } else {
        attempt
    }
}

pub enum UiEvent {
    Machine(MachineView),
    PaneStatus(PaneStatusEvent),
}
pub type Emit = Arc<dyn Fn(UiEvent) + Send + Sync>;
/// Test seam: replaces starting the batch ssh master.
type MasterStart = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send>>
        + Send
        + Sync,
>;
/// Test seam: replaces asking the ssh master to exit.
type MasterExit = Arc<dyn Fn() + Send + Sync>;
/// Test seam: replaces the health task's `master_alive` check.
type AliveCheck = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>> + Send + Sync,
>;
type Factory = Arc<dyn Fn(&MachineConfig) -> Arc<dyn Transport> + Send + Sync>;

struct Sess {
    entry: SessionEntry,
    view: Option<SessionView>,
    error: Option<AppError>,
    supervisor: Option<JoinHandle<()>>,
    /// Asks this Session's watcher for a fresh snapshot.
    refetch: Arc<tokio::sync::Notify>,
    /// Done marks the app keeps on top of herdr's statuses (see `DoneMarks`).
    marks: Arc<SharedMarks>,
}

struct Machine {
    cfg: MachineConfig,
    state: MachineState,
    error: Option<AppError>,
    info: Option<MachineInfo>,
    /// herdr found by the last probe; outlives `info` so a reconnect skips discovery.
    last_herdr: Option<String>,
    transport: Option<Arc<dyn Transport>>,
    /// The ssh Machine's one transport (its forward cache lives here); created lazily.
    ssh: Option<Arc<SshTransport>>,
    sessions: Vec<Sess>,
    /// Backoff retry task after an unexpected drop.
    reconnect: Option<JoinHandle<()>>,
    /// Serializes connects of this Machine.
    gate: Arc<tokio::sync::Mutex<()>>,
    /// Bumped by disconnect/remove; a connect that started under an older epoch is abandoned.
    epoch: u64,
    /// Periodic master check while an ssh Machine is connected.
    health: Option<JoinHandle<()>>,
    /// A link probe is out (see `check_link`); further timeouts wait for its verdict.
    probing: bool,
    /// Being removed: its views are no longer emitted.
    removing: bool,
}

impl Machine {
    fn new(cfg: MachineConfig) -> Self {
        Machine {
            cfg,
            state: MachineState::Disconnected,
            error: None,
            info: None,
            last_herdr: None,
            transport: None,
            ssh: None,
            sessions: Vec::new(),
            reconnect: None,
            gate: Arc::default(),
            epoch: 0,
            health: None,
            probing: false,
            removing: false,
        }
    }

    fn view(&self) -> MachineView {
        let sessions: Vec<SessionView> = self
            .sessions
            .iter()
            .map(|s| {
                let mut v = match (&s.view, s.entry.running) {
                    (Some(v), true) => v.clone(),
                    _ => SessionView {
                        name: s.entry.name.clone(),
                        running: s.entry.running,
                        status: AgentStatus::Unknown,
                        error: None,
                        workspaces: Vec::new(),
                    },
                };
                v.name = s.entry.name.clone();
                v.running = s.entry.running;
                v.error = s.error.clone();
                v
            })
            .collect();
        MachineView {
            id: self.cfg.id.clone(),
            label: self.cfg.label.clone(),
            kind: if self.cfg.id == LOCAL { "local" } else { "ssh" }.into(),
            state: self.state,
            error: self.error.clone(),
            version: self.info.as_ref().map(|i| i.version.clone()),
            pi_agent_dir: self.info.as_ref().map(|i| i.agent_dir.clone()),
            has_pi: self.info.as_ref().is_some_and(|i| !i.pi.is_empty()),
            status: AgentStatus::rollup(sessions.iter().map(|s| s.status)),
            sessions,
        }
    }

    fn abort_supervisors(&mut self) {
        for s in &mut self.sessions {
            if let Some(h) = s.supervisor.take() {
                h.abort();
            }
        }
    }
}

/// Aborts the wrapped task when dropped (so cancelling a supervisor stops its watcher).
struct AbortOnDrop(JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Default)]
struct Throttle {
    last: Option<Instant>,
    pending: bool,
    /// The view last emitted; an equal one is not emitted (nor serialized) again.
    sent: Option<MachineView>,
}

pub struct MachineManager {
    me: Weak<MachineManager>,
    registry: PathBuf,
    attach: Mutex<Option<Arc<AttachManager>>>,
    chats: Mutex<Option<Arc<ChatManager>>>,
    machines: Mutex<Vec<Machine>>,
    emit: Emit,
    factory: Mutex<Option<Factory>>,
    master_start: Mutex<Option<MasterStart>>,
    master_exit: Mutex<Option<MasterExit>>,
    alive_check: Mutex<Option<AliveCheck>>,
    /// Test seam: replaces `link_alive` in `check_link`.
    link_check: Mutex<Option<AliveCheck>>,
    health_every: Mutex<Duration>,
    throttle: Mutex<HashMap<String, Throttle>>,
}

/// Why a connect attempt ended without connecting.
enum Fail {
    /// The Machine was disconnected or removed meanwhile.
    Stale,
    Err(AppError),
}

impl From<AppError> for Fail {
    fn from(e: AppError) -> Self {
        Fail::Err(e)
    }
}

fn not_found(what: impl std::fmt::Display) -> AppError {
    AppError::new("not_found", what.to_string())
}

impl MachineManager {
    pub fn new(registry_path: PathBuf, emit: Emit) -> Arc<Self> {
        let mut machines = vec![Machine::new(MachineConfig {
            id: LOCAL.into(),
            label: "local".into(),
            ssh_target: String::new(),
            herdr_path: None,
            enabled: true,
        })];
        machines.extend(
            load_registry(&registry_path)
                .into_iter()
                .filter(|c| c.id != LOCAL)
                .map(Machine::new),
        );
        Arc::new_cyclic(|me| MachineManager {
            me: me.clone(),
            registry: registry_path,
            attach: Mutex::new(None),
            chats: Mutex::new(None),
            machines: Mutex::new(machines),
            emit,
            factory: Mutex::new(None),
            master_start: Mutex::new(None),
            master_exit: Mutex::new(None),
            alive_check: Mutex::new(None),
            link_check: Mutex::new(None),
            health_every: Mutex::new(HEALTH_EVERY),
            throttle: Mutex::new(HashMap::new()),
        })
    }

    /// Terminals are closed through this when a Machine disconnects.
    pub fn set_attach_manager(&self, a: Arc<AttachManager>) {
        *self.attach.lock().unwrap() = Some(a);
    }

    /// Chat tails are closed through this when a Machine is disconnected or removed.
    pub fn set_chat_manager(&self, c: Arc<ChatManager>) {
        *self.chats.lock().unwrap() = Some(c);
    }

    #[cfg_attr(not(test), allow(dead_code))] // test seam: replaces the default local/ssh transports
    pub(crate) fn with_transport_factory(self: &Arc<Self>, f: Factory) {
        *self.factory.lock().unwrap() = Some(f);
    }

    #[cfg(test)]
    fn with_master_start(&self, f: MasterStart) {
        *self.master_start.lock().unwrap() = Some(f);
    }

    #[cfg(test)]
    fn with_master_exit(&self, f: MasterExit) {
        *self.master_exit.lock().unwrap() = Some(f);
    }

    #[cfg(test)]
    fn with_health_check(&self, every: Duration, f: AliveCheck) {
        *self.health_every.lock().unwrap() = every;
        *self.alive_check.lock().unwrap() = Some(f);
    }

    #[cfg(test)]
    fn with_link_check(&self, f: AliveCheck) {
        *self.link_check.lock().unwrap() = Some(f);
    }

    async fn end_master(&self, s: &SshTransport) {
        let seam = self.master_exit.lock().unwrap().clone();
        match seam {
            Some(f) => f(),
            None => master_exit(&s.ctl, &s.target).await,
        }
    }

    fn make_transport(&self, cfg: &MachineConfig) -> AppResult<Arc<dyn Transport>> {
        if let Some(f) = self.factory.lock().unwrap().clone() {
            return Ok(f(cfg));
        }
        if cfg.id == LOCAL {
            Ok(Arc::new(LocalTransport))
        } else {
            Ok(self.ssh_for(cfg)?)
        }
    }

    /// The Machine's single `SshTransport`, created on first use. `None` when a test
    /// factory supplies the transport.
    fn ssh_for(&self, cfg: &MachineConfig) -> AppResult<Arc<SshTransport>> {
        let mut ms = self.machines.lock().unwrap();
        let m = ms
            .iter_mut()
            .find(|m| m.cfg.id == cfg.id)
            .ok_or_else(|| not_found(format!("unknown machine {}", cfg.id)))?;
        if m.ssh.is_none() {
            m.ssh = Some(Arc::new(SshTransport::new(&cfg.id, &cfg.ssh_target)?));
        }
        Ok(m.ssh.clone().expect("just set"))
    }

    fn ssh_of(&self, id: &str) -> Option<Arc<SshTransport>> {
        self.with_machine(id, |m| m.ssh.clone()).ok().flatten()
    }

    /// Control socket path and target for an ssh Machine (for the interactive master).
    pub fn ssh_master(&self, id: &str) -> AppResult<(PathBuf, String)> {
        if id == LOCAL {
            return Err(AppError::new(
                "invalid",
                "the local machine has no ssh connection",
            ));
        }
        let cfg = self.with_machine(id, |m| m.cfg.clone())?;
        let s = self.ssh_for(&cfg)?;
        Ok((s.ctl.clone(), s.target.clone()))
    }

    pub async fn master_alive(&self, id: &str) -> bool {
        match self.ssh_of(id) {
            Some(s) => master_alive(&s.ctl, &s.target).await,
            None => false,
        }
    }

    pub fn is_ssh(&self, id: &str) -> bool {
        id != LOCAL
    }

    fn persist(&self) -> AppResult<()> {
        let list: Vec<MachineConfig> = self
            .machines
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.cfg.id != LOCAL)
            .map(|m| m.cfg.clone())
            .collect();
        save_registry(&self.registry, &list)
    }

    fn with_machine<R>(&self, id: &str, f: impl FnOnce(&mut Machine) -> R) -> AppResult<R> {
        let mut ms = self.machines.lock().unwrap();
        ms.iter_mut()
            .find(|m| m.cfg.id == id)
            .map(f)
            .ok_or_else(|| not_found(format!("unknown machine {id}")))
    }

    // ---- queries -------------------------------------------------------

    pub fn views(&self) -> Vec<MachineView> {
        self.machines
            .lock()
            .unwrap()
            .iter()
            .map(Machine::view)
            .collect()
    }

    /// One Pane as `views()` shows it, found under the lock without cloning any view.
    pub fn pane_view(&self, r: &PaneRef) -> AppResult<PaneView> {
        let ms = self.machines.lock().unwrap();
        let sess = ms
            .iter()
            .find(|m| m.cfg.id == r.machine_id)
            .and_then(|m| m.sessions.iter().find(|s| s.entry.name == r.session))
            .ok_or_else(|| not_found(format!("unknown session {}/{}", r.machine_id, r.session)))?;
        // `Machine::view` shows a stopped Session, or one not yet seen, with no Workspaces.
        sess.view
            .as_ref()
            .filter(|_| sess.entry.running)
            .into_iter()
            .flat_map(|v| &v.workspaces)
            .flat_map(|w| &w.tabs)
            .flat_map(|t| &t.panes)
            .find(|p| p.pane_id == r.pane_id)
            .cloned()
            .ok_or_else(|| not_found(format!("unknown pane {}", r.pane_id)))
    }

    pub fn transport(&self, id: &str) -> AppResult<Arc<dyn Transport>> {
        self.with_machine(id, |m| m.transport.clone())?
            .ok_or_else(|| not_found(format!("machine {id} is not connected")))
    }

    pub fn info(&self, id: &str) -> AppResult<MachineInfo> {
        self.with_machine(id, |m| m.info.clone())?
            .ok_or_else(|| not_found(format!("no herdr info for machine {id}")))
    }

    pub fn session(&self, id: &str, name: &str) -> AppResult<SessionEntry> {
        self.with_machine(id, |m| {
            m.sessions
                .iter()
                .find(|s| s.entry.name == name)
                .map(|s| s.entry.clone())
        })?
        .ok_or_else(|| not_found(format!("unknown session {id}/{name}")))
    }

    /// The directory the agent in a Pane runs from, which may differ from the shell's cwd (best-effort).
    pub async fn foreground_cwd(&self, pane: &PaneRef) -> Option<String> {
        let PaneRef {
            machine_id,
            session,
            pane_id,
        } = pane;
        let transport = self.transport(machine_id).ok()?;
        let entry = self.session(machine_id, session).ok()?;
        let socket = transport.local_socket(&entry).await.ok()?;
        rpc::snapshot(&socket)
            .await
            .ok()
            .and_then(|s| s.panes.into_iter().find(|p| p.pane_id == *pane_id))
            .and_then(|p| p.foreground_cwd)
    }

    /// Resolves a Files root on Machine `id` against its home; every `files_*` command goes through it.
    pub fn files_root(&self, id: &str, root: &str) -> AppResult<String> {
        resolve_root(&self.info(id)?.home, root)
    }

    /// The transcript of the agent in a Pane: `path` when given (the user's choice), else located.
    pub async fn locate_pane(&self, pane: &PaneRef, path: Option<String>) -> AppResult<Located> {
        let PaneRef {
            machine_id,
            session,
            pane_id,
        } = pane;
        let pane_view = self.pane_view(pane)?;
        let transport = self.transport(machine_id)?;
        let fetch_agent = || {
            self.call(
                machine_id,
                session,
                "agent.get",
                serde_json::json!({ "target": pane_id }),
            )
        };
        let mut agent_get = match fetch_agent().await {
            Ok(v) => v,
            Err(_) if path.is_some() => Value::Null,
            Err(e) => return Err(e),
        };
        // Without its session, a just-started Claude would get another pane's transcript.
        if path.is_none() {
            let deadline = tokio::time::Instant::now() + SESSION_WAIT;
            while transcript::locate::awaiting_session(&agent_get)
                && tokio::time::Instant::now() < deadline
            {
                tokio::time::sleep(Duration::from_millis(250)).await;
                agent_get = fetch_agent().await?;
            }
        }
        Ok(match path {
            Some(p) => Located {
                agent: agent_get["agent"]["agent"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| pane_view.agent.clone())
                    .unwrap_or_default(),
                path: p,
                ambiguous: false,
                candidates: Vec::new(),
                pending: false,
                cached: false,
            },
            None => {
                let info = self.info(machine_id)?;
                let fg = self.foreground_cwd(pane).await;
                transcript::locate::locate_in(
                    &*transport,
                    &info,
                    &agent_get,
                    &pane_view,
                    fg.as_deref(),
                )
                .await?
            }
        })
    }

    // ---- events --------------------------------------------------------

    fn emit_now(&self, id: &str) {
        let view = self
            .machines
            .lock()
            .unwrap()
            .iter()
            .find(|m| m.cfg.id == id && !m.removing)
            .map(Machine::view);
        let Some(v) = view else { return };
        {
            let mut t = self.throttle.lock().unwrap();
            let e = t.entry(id.to_string()).or_default();
            if e.sent.as_ref() == Some(&v) {
                return;
            }
            e.sent = Some(v.clone());
        }
        (self.emit)(UiEvent::Machine(v));
    }

    /// Emit the Machine's view at most once per `EMIT_THROTTLE`; the latest state wins
    /// and a trailing emit guarantees the final state is delivered.
    fn notify(&self, id: &str) {
        let wait = {
            let mut t = self.throttle.lock().unwrap();
            let e = t.entry(id.to_string()).or_default();
            if e.pending {
                return;
            }
            match e.last {
                Some(l) if l.elapsed() < EMIT_THROTTLE => {
                    e.pending = true;
                    Some(EMIT_THROTTLE - l.elapsed())
                }
                _ => {
                    e.last = Some(Instant::now());
                    None
                }
            }
        };
        match wait {
            None => self.emit_now(id),
            Some(d) => {
                let Some(me) = self.me.upgrade() else { return };
                let id = id.to_string();
                tokio::spawn(async move {
                    tokio::time::sleep(d).await;
                    {
                        let mut t = me.throttle.lock().unwrap();
                        let e = t.entry(id.clone()).or_default();
                        e.pending = false;
                        e.last = Some(Instant::now());
                    }
                    me.emit_now(&id);
                });
            }
        }
    }

    /// A state change is emitted at once (the Terminal lens must see every transition);
    /// anything else goes through the throttle.
    fn set_state(&self, id: &str, state: MachineState, error: Option<AppError>) {
        let changed = self
            .with_machine(id, |m| {
                let changed = m.state != state;
                m.state = state;
                m.error = error;
                changed
            })
            .unwrap_or(false);
        self.emit_state(id, changed);
    }

    /// `set_state`, but only while the Machine is still at `epoch`. False when stale.
    fn set_state_at(
        &self,
        id: &str,
        epoch: u64,
        state: MachineState,
        error: Option<AppError>,
    ) -> bool {
        let r = self
            .with_machine(id, |m| {
                if m.epoch != epoch {
                    return None;
                }
                let changed = m.state != state;
                m.state = state;
                m.error = error;
                Some(changed)
            })
            .ok()
            .flatten();
        match r {
            Some(changed) => {
                self.emit_state(id, changed);
                true
            }
            None => false,
        }
    }

    fn emit_state(&self, id: &str, changed: bool) {
        if changed {
            self.emit_now(id);
        } else {
            self.notify(id);
        }
    }

    fn is_current(&self, id: &str, epoch: u64) -> bool {
        self.with_machine(id, |m| m.epoch == epoch).unwrap_or(false)
    }

    fn current(&self, id: &str, epoch: u64) -> Result<(), Fail> {
        if self.is_current(id, epoch) {
            Ok(())
        } else {
            Err(Fail::Stale)
        }
    }

    // ---- connection ----------------------------------------------------

    pub fn cancel_reconnect(&self, id: &str) {
        let _ = self.with_machine(id, |m| {
            if let Some(h) = m.reconnect.take() {
                h.abort();
            }
        });
    }

    pub async fn connect(&self, id: &str) -> AppResult<()> {
        let cfg = self.with_machine(id, |m| m.cfg.clone())?;
        if !cfg.enabled {
            return Err(AppError::new(
                "invalid",
                format!("machine {id} is disabled"),
            ));
        }
        self.cancel_reconnect(id);
        // Captured before waiting: a disconnect while we wait cancels this connect.
        let (gate, epoch) = self.with_machine(id, |m| (m.gate.clone(), m.epoch))?;
        let _g = gate.lock().await;
        if !self.is_current(id, epoch) {
            return Ok(());
        }
        // Reconnecting: stop watchers and release the old sockets first.
        self.teardown(id, false, false, false).await;
        self.connect_core(&cfg, epoch).await
    }

    /// One connect attempt under the Machine's gate. When the Machine was disconnected or
    /// removed meanwhile (`epoch` moved on), any master this attempt started is ended,
    /// the Machine's state is left alone and the result is `Ok`.
    async fn connect_core(&self, cfg: &MachineConfig, epoch: u64) -> AppResult<()> {
        let id = cfg.id.as_str();
        let ssh = if id != LOCAL && self.factory.lock().unwrap().is_none() {
            Some(self.ssh_for(cfg)?)
        } else {
            None
        };
        match self.connect_inner(cfg, ssh.as_deref(), epoch).await {
            Ok(()) if self.set_state_at(id, epoch, MachineState::Connected, None) => {
                self.start_health(id);
                Ok(())
            }
            Err(Fail::Err(e)) => {
                let state = if e.code == "incompatible" {
                    MachineState::Incompatible
                } else {
                    MachineState::Error
                };
                if self.set_state_at(id, epoch, state, Some(e.clone())) {
                    return Err(e);
                }
                self.abandon(id, ssh.as_deref()).await;
                Ok(())
            }
            Ok(()) | Err(Fail::Stale) => {
                self.abandon(id, ssh.as_deref()).await;
                Ok(())
            }
        }
    }

    /// Undo a stale connect: end the master it may have started and drop what it set up.
    async fn abandon(&self, id: &str, ssh: Option<&SshTransport>) {
        tracing::info!("connect of {id} abandoned: disconnected meanwhile");
        if let Some(s) = ssh {
            self.end_master(s).await;
        }
        let _ = self.with_machine(id, |m| {
            m.abort_supervisors();
            m.sessions.clear();
            m.transport = None;
            m.info = None;
        });
        self.notify(id);
    }

    async fn connect_inner(
        &self,
        cfg: &MachineConfig,
        ssh: Option<&SshTransport>,
        epoch: u64,
    ) -> Result<(), Fail> {
        let id = cfg.id.as_str();
        let transport: Arc<dyn Transport> = match ssh {
            Some(_) => self.ssh_for(cfg)?,
            None => self.make_transport(cfg)?,
        };
        self.with_machine(id, |m| {
            m.transport = Some(transport.clone());
            m.info = None;
        })?;
        if let Some(s) = ssh {
            if !self.set_state_at(id, epoch, MachineState::Authenticating, None) {
                return Err(Fail::Stale);
            }
            let alive = master_alive(&s.ctl, &s.target).await;
            self.current(id, epoch)?;
            if !alive {
                clear_stale_ctl(&s.ctl, &s.target).await;
                self.current(id, epoch)?;
                let seam = self.master_start.lock().unwrap().clone();
                match seam {
                    Some(f) => f().await?,
                    None => start_master(id, &s.ctl, &s.target).await?,
                }
                self.current(id, epoch)?;
            }
            // Whatever the master's history, its forwards are not the cached ones.
            s.forget_forwards();
        }
        if !self.set_state_at(id, epoch, MachineState::Probing, None) {
            return Err(Fail::Stale);
        }
        let known = self.with_machine(id, |m| m.last_herdr.clone())?;
        let argv = probe_argv(cfg.herdr_path.as_deref(), known.as_deref());
        let out = exec(transport.as_ref(), &argv).await?;
        self.current(id, epoch)?;
        let (head, sessions) = split_probe(&out.stdout);
        let info = parse_probe(head).inspect_err(|_| {
            // Rediscover next time: the known herdr may be the one that no longer fits.
            let _ = self.with_machine(id, |m| m.last_herdr = None);
        })?;
        self.with_machine(id, |m| {
            m.last_herdr = Some(info.herdr.clone());
            m.info = Some(info);
        })?;
        let list = match sessions {
            Some((status, list)) => {
                session_entries(transport.as_ref(), status, list, &out.stderr).await?
            }
            None => self.list_sessions(id).await?,
        };
        self.current(id, epoch)?;
        Ok(self.apply_list(id, list)?)
    }

    /// Watch a connected ssh Machine's master so a dead one is noticed even with no
    /// running Session (whose watcher would otherwise notice).
    fn start_health(&self, id: &str) {
        if id == LOCAL {
            return;
        }
        let Some(me) = self.me.upgrade() else { return };
        let h = tokio::spawn(me.health_loop(id.to_string()));
        let _ = self.with_machine(id, |m| {
            if let Some(old) = m.health.replace(h) {
                old.abort();
            }
        });
    }

    async fn health_loop(self: Arc<Self>, id: String) {
        loop {
            let every = *self.health_every.lock().unwrap();
            tokio::time::sleep(every).await;
            if !self.health_ok(&id).await {
                // Spawned: on_master_lost's teardown aborts this task.
                let me = self.clone();
                tokio::spawn(async move { me.on_master_lost(&id).await });
                return;
            }
        }
    }

    async fn health_ok(&self, id: &str) -> bool {
        let seam = self.alive_check.lock().unwrap().clone();
        if let Some(f) = seam {
            return f().await;
        }
        match self.ssh_of(id) {
            Some(s) => master_alive(&s.ctl, &s.target).await,
            None => true, // a test transport: nothing to check
        }
    }

    /// Stop watchers, close terminals and release forwarded sockets. `clear` also forgets the Sessions.
    /// `close_all` also closes Machine-level terminals (the interactive ssh master);
    /// a connect must not kill the master the user just authenticated.
    /// `quitting` forgets the forwards instead (`Transport::forget_socket`).
    async fn teardown(&self, id: &str, clear: bool, close_all: bool, quitting: bool) {
        let released = self
            .with_machine(id, |m| {
                m.abort_supervisors();
                if let Some(h) = m.health.take() {
                    h.abort();
                }
                let t = m.transport.take();
                let entries: Vec<SessionEntry> = if clear {
                    m.sessions.drain(..).map(|s| s.entry).collect()
                } else {
                    m.sessions.iter().map(|s| s.entry.clone()).collect()
                };
                m.info = None;
                (t, entries)
            })
            .ok();
        if let Some(a) = self.attach.lock().unwrap().clone() {
            if close_all {
                a.close_machine(id);
            } else {
                a.close_machine_sessions(id);
            }
        }
        if let Some((Some(t), entries)) = released {
            // Every Session, running or not: one that stopped outside the app may still hold a forward.
            for e in entries {
                let res = if quitting {
                    t.forget_socket(&e).await
                } else {
                    t.release_socket(&e).await
                };
                if let Err(err) = res {
                    tracing::error!("release_socket {id}/{}: {err}", e.name);
                }
            }
        }
    }

    /// Explicit disconnect: forgets the Sessions and, for ssh, ends the master.
    /// Bumps the epoch first, so a connect in flight abandons itself (and its master).
    pub async fn disconnect(&self, id: &str) {
        self.disconnect_with(id, false).await
    }

    /// `quitting`: the app is exiting, so forwards are dropped locally and left to the
    /// master's exit instead of being cancelled one by one.
    async fn disconnect_with(&self, id: &str, quitting: bool) {
        let _ = self.with_machine(id, |m| {
            m.epoch += 1;
            m.last_herdr = None;
        });
        self.cancel_reconnect(id);
        self.teardown(id, true, true, quitting).await;
        if let Some(c) = self.chats.lock().unwrap().clone() {
            c.close_machine(id);
        }
        if let Some(s) = self.ssh_of(id) {
            self.end_master(&s).await;
        }
        self.set_state(id, MachineState::Disconnected, None);
    }

    /// App start: the local Machine and every enabled ssh Machine, all at once.
    pub async fn connect_at_startup(self: &Arc<Self>) {
        let local = async {
            if let Err(e) = self.connect(LOCAL).await {
                tracing::error!("connect local: {e}");
            }
        };
        tokio::join!(local, self.connect_enabled_ssh());
    }

    /// Connect every enabled ssh Machine concurrently (app start). Batch mode only: one
    /// that needs a password or passphrase ends in `ssh_auth` and offers Connect….
    pub async fn connect_enabled_ssh(self: &Arc<Self>) {
        let ids: Vec<String> = self
            .machines
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.cfg.id != LOCAL && m.cfg.enabled)
            .map(|m| m.cfg.id.clone())
            .collect();
        let tasks: Vec<_> = ids
            .into_iter()
            .map(|id| {
                let me = self.clone();
                tokio::spawn(async move {
                    if let Err(e) = me.connect(&id).await {
                        tracing::warn!("connect {id} at startup: {e}");
                    }
                })
            })
            .collect();
        for t in tasks {
            let _ = t.await;
        }
    }

    /// Disconnect every ssh Machine concurrently (app exit).
    pub async fn disconnect_all_ssh(self: &Arc<Self>) {
        let ids: Vec<String> = self
            .machines
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.cfg.id != LOCAL)
            .map(|m| m.cfg.id.clone())
            .collect();
        let tasks: Vec<_> = ids
            .into_iter()
            .map(|id| {
                let me = self.clone();
                tokio::spawn(async move { me.disconnect_with(&id, true).await })
            })
            .collect();
        for t in tasks {
            let _ = t.await;
        }
    }

    /// The ssh master died under a connected Machine: grey it out, keep its last
    /// snapshot, close its terminals, and retry with backoff.
    pub(crate) async fn on_master_lost(&self, id: &str) {
        let go = self
            .with_machine(id, |m| {
                if m.state == MachineState::Disconnected
                    || m.reconnect.as_ref().is_some_and(|h| !h.is_finished())
                {
                    return false;
                }
                m.state = MachineState::Disconnected;
                m.error = None;
                true
            })
            .unwrap_or(false);
        if !go {
            return;
        }
        self.teardown(id, false, false, false).await;
        self.emit_now(id);
        if let Some(me) = self.me.upgrade() {
            let h = tokio::spawn(me.reconnect_loop(id.to_string()));
            let _ = self.with_machine(id, |m| m.reconnect = Some(h));
        }
    }

    /// An RPC to `id` timed out: ask the remote for an answer with a short deadline. None
    /// means the master's TCP died without the master noticing yet (its keepalives give up
    /// only after 15 s, which is how a Mac waking from sleep finds it), so end the master
    /// and reconnect now. Timeouts while a probe is out wait for its verdict.
    pub(crate) async fn check_link(&self, id: &str) {
        if id == LOCAL {
            return;
        }
        let epoch = self
            .with_machine(id, |m| {
                if m.state != MachineState::Connected || m.probing {
                    return None;
                }
                m.probing = true;
                Some(m.epoch)
            })
            .ok()
            .flatten();
        let Some(epoch) = epoch else { return };
        let alive = self.link_ok(id).await;
        let _ = self.with_machine(id, |m| m.probing = false);
        if alive || !self.is_current(id, epoch) {
            return;
        }
        tracing::warn!("{id}: the ssh link stopped answering, reconnecting");
        let seam = self.master_exit.lock().unwrap().clone();
        match (seam, self.ssh_of(id)) {
            (Some(f), _) => f(),
            (None, Some(s)) => master_exit(&s.ctl, &s.target).await,
            (None, None) => {}
        }
        self.on_master_lost(id).await;
    }

    async fn link_ok(&self, id: &str) -> bool {
        let seam = self.link_check.lock().unwrap().clone();
        if let Some(f) = seam {
            return f().await;
        }
        match self.ssh_of(id) {
            Some(s) => link_alive(&s.ctl, &s.target).await,
            None => true, // a test transport: nothing to check
        }
    }

    /// Retry the connection with `backoff`; an auth failure (or any state that needs the
    /// user) ends the retries.
    async fn reconnect_loop(self: Arc<Self>, id: String) {
        let mut attempt = 0u32;
        loop {
            tokio::time::sleep(backoff(attempt)).await;
            attempt = attempt.saturating_add(1);
            let Ok((cfg, gate, epoch)) =
                self.with_machine(&id, |m| (m.cfg.clone(), m.gate.clone(), m.epoch))
            else {
                return;
            };
            let _g = gate.lock().await;
            match self.connect_core(&cfg, epoch).await {
                Ok(()) => return,
                Err(e)
                    if matches!(
                        e.code.as_str(),
                        "ssh_auth" | "incompatible" | "herdr_not_found"
                    ) =>
                {
                    return
                }
                Err(e) => self.set_state(&id, MachineState::Disconnected, Some(e)),
            }
        }
    }

    // ---- registry ------------------------------------------------------

    pub async fn add(
        &self,
        ssh_target: String,
        label: Option<String>,
        herdr_path: Option<String>,
    ) -> AppResult<MachineView> {
        let target = ssh_target.trim().to_string();
        if target.is_empty()
            || target.starts_with('-')
            || target.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(AppError::new(
                "invalid",
                format!("invalid ssh target {ssh_target:?}"),
            ));
        }
        let label = label
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| target.clone());
        let herdr_path = herdr_path
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
        let id = {
            let mut ms = self.machines.lock().unwrap();
            let taken: Vec<String> = ms.iter().map(|m| m.cfg.id.clone()).collect();
            let id = slug(&label, &taken);
            ms.push(Machine::new(MachineConfig {
                id: id.clone(),
                label,
                ssh_target: target,
                herdr_path,
                enabled: true,
            }));
            id
        };
        if let Err(e) = self.persist() {
            self.machines.lock().unwrap().retain(|m| m.cfg.id != id);
            return Err(e);
        }
        self.emit_now(&id);
        self.with_machine(&id, |m| m.view())
    }

    pub async fn remove(&self, id: &str) -> AppResult<()> {
        if id == LOCAL {
            return Err(AppError::new(
                "invalid",
                "the local machine cannot be removed",
            ));
        }
        // From here on nothing about this Machine reaches the UI (no ghost row).
        self.with_machine(id, |m| m.removing = true)?;
        self.disconnect(id).await;
        // Wait out a connect in flight: it abandons itself and ends its master through the
        // control socket, which must still exist when it does.
        let gate = self.with_machine(id, |m| m.gate.clone())?;
        let _g = gate.lock().await;
        if let Some(s) = self.ssh_of(id) {
            let _ = std::fs::remove_file(&s.ctl);
        }
        sweep_sockets(id);
        self.machines.lock().unwrap().retain(|m| m.cfg.id != id);
        self.throttle.lock().unwrap().remove(id);
        self.persist()
    }

    /// Set the herdr path override, persist it and reconnect.
    pub async fn update(&self, id: &str, herdr_path: Option<String>) -> AppResult<MachineView> {
        if id == LOCAL {
            return Err(AppError::new(
                "invalid",
                "the local machine has no settings to update",
            ));
        }
        let herdr_path = herdr_path
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
        self.with_machine(id, |m| {
            m.cfg.herdr_path = herdr_path;
            m.last_herdr = None;
        })?;
        self.persist()?;
        // A failed connect is reported through the Machine's state and error.
        let _ = self.connect(id).await;
        self.with_machine(id, |m| m.view())
    }

    // ---- sessions ------------------------------------------------------

    async fn list_sessions(&self, id: &str) -> AppResult<Vec<SessionEntry>> {
        let (info, t) = (self.info(id)?, self.transport(id)?);
        let out = exec(
            t.as_ref(),
            &herdr_argv(&info, "default", &["session", "list"]),
        )
        .await?;
        session_entries(t.as_ref(), out.status, &out.stdout, &out.stderr).await
    }

    /// Reconcile the Machine's sessions with `list`; start watchers for newly running ones.
    fn apply_list(&self, id: &str, list: Vec<SessionEntry>) -> AppResult<()> {
        self.with_machine(id, |m| {
            let Some(transport) = m.transport.clone() else {
                return;
            };
            let mut old: Vec<Sess> = std::mem::take(&mut m.sessions);
            let mut next = Vec::new();
            for entry in list {
                let mut s = match old.iter().position(|s| s.entry.name == entry.name) {
                    Some(i) => old.remove(i),
                    None => Sess {
                        entry: entry.clone(),
                        view: None,
                        error: None,
                        supervisor: None,
                        refetch: Arc::default(),
                        marks: Arc::default(),
                    },
                };
                s.entry = entry;
                if s.entry.running {
                    if s.supervisor.is_none() {
                        if let Some(me) = self.me.upgrade() {
                            let (id, name) = (m.cfg.id.clone(), s.entry.name.clone());
                            s.supervisor = Some(tokio::spawn(me.supervise(
                                id,
                                name,
                                transport.clone(),
                                s.refetch.clone(),
                                s.marks.clone(),
                            )));
                        }
                    }
                } else {
                    if let Some(h) = s.supervisor.take() {
                        h.abort();
                    }
                    s.view = None;
                    s.error = None;
                }
                next.push(s);
            }
            for s in old {
                if let Some(h) = s.supervisor {
                    h.abort();
                }
            }
            m.sessions = next;
        })?;
        self.notify(id);
        Ok(())
    }

    pub async fn refresh_sessions(&self, id: &str) -> AppResult<()> {
        let list = self.list_sessions(id).await?;
        self.apply_list(id, list)
    }

    fn valid_session_name(name: &str) -> bool {
        !name.is_empty()
            && !name.starts_with('-')
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    }

    pub async fn start_session(&self, id: &str, name: &str) -> AppResult<()> {
        if !Self::valid_session_name(name) {
            return Err(AppError::new(
                "invalid",
                format!("invalid session name {name:?}"),
            ));
        }
        let (info, t) = (self.info(id)?, self.transport(id)?);
        let mut argv: Vec<String> = ["sh", "-c", r#"nohup "$@" >/dev/null 2>&1 &"#, "herdr-start"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        argv.extend(herdr_argv(&info, name, &["server"]));
        let out = exec(t.as_ref(), &argv).await?;
        if out.status != 0 {
            return Err(AppError::new(
                "herdr_error",
                format!("could not start {name}: {}", out.stderr.trim()),
            ));
        }
        let deadline = tokio::time::Instant::now() + START_WAIT;
        // Transient errors (an ssh hiccup, a socket not yet there) never end the wait early.
        let mut last_err: Option<AppError> = None;
        loop {
            match self.probe_started(id, name, t.as_ref()).await {
                Ok(true) => break,
                Ok(false) => {}
                Err(e) => last_err = Some(e),
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(last_err.unwrap_or_else(|| {
                    AppError::new(
                        "timeout",
                        format!(
                            "session {name} did not start within {}s",
                            START_WAIT.as_secs()
                        ),
                    )
                }));
            }
            tokio::time::sleep(START_POLL).await;
        }
        self.refresh_sessions(id).await
    }

    /// One poll of `start_session`: is `name` listed running and answering a snapshot?
    async fn probe_started(&self, id: &str, name: &str, t: &dyn Transport) -> AppResult<bool> {
        let Some(entry) = self
            .list_sessions(id)
            .await?
            .into_iter()
            .find(|e| e.name == name && e.running)
        else {
            return Ok(false);
        };
        let socket = t.local_socket(&entry).await?;
        match rpc::call(&socket, "session.snapshot", json!({})).await {
            Ok(_) => Ok(true),
            Err(e) => Err(self.forward_refusal(id, e)),
        }
    }

    /// Over ssh, a peer that closes before any frame means sshd refused the socket forward.
    fn forward_refusal(&self, id: &str, e: AppError) -> AppError {
        if id != LOCAL && rpc::closed_early(&e) {
            classify_ssh_error("administratively prohibited")
        } else {
            e
        }
    }

    pub async fn stop_session(&self, id: &str, name: &str) -> AppResult<()> {
        let entry = self.session(id, name)?;
        let t = self.transport(id)?;
        let socket = t.local_socket(&entry).await?;
        match rpc::call(&socket, "server.stop", json!({})).await {
            Ok(_) => {}
            // herdr may close the socket before replying: judge by the session list.
            Err(e) if e.code == "io" => {
                let list = self.list_sessions(id).await?;
                if list.iter().any(|s| s.name == name && s.running) {
                    return Err(e);
                }
            }
            Err(e) => return Err(e),
        }
        if let Err(e) = t.release_socket(&entry).await {
            tracing::error!("release_socket {id}/{name}: {e}");
        }
        self.refresh_sessions(id).await
    }

    /// Delete a stopped Session with `herdr session delete`; herdr refuses running ones, so do we.
    pub async fn delete_session(&self, id: &str, name: &str) -> AppResult<()> {
        let entry = self.session(id, name)?;
        if entry.running {
            return Err(AppError::new(
                "invalid",
                format!("stop session {name} before deleting it"),
            ));
        }
        let (info, t) = (self.info(id)?, self.transport(id)?);
        let out = exec(
            t.as_ref(),
            &herdr_argv(&info, "default", &["session", "delete", "--", name]),
        )
        .await?;
        if out.status != 0 {
            return Err(AppError::new(
                "herdr_error",
                format!("could not delete {name}: {}", out.stderr.trim()),
            ));
        }
        self.refresh_sessions(id).await
    }

    pub async fn call(
        &self,
        pane_machine: &str,
        session: &str,
        method: &str,
        params: Value,
    ) -> AppResult<Value> {
        if !ALLOWED_METHODS.contains(&method) {
            return Err(AppError::new(
                "invalid",
                format!("method {method} is not allowed"),
            ));
        }
        let entry = self.session(pane_machine, session)?;
        let socket = self.transport(pane_machine)?.local_socket(&entry).await?;
        if method == "pane.focus" {
            // Mark the pane seen here before herdr answers with its done → idle.
            if let Some(pane_id) = params["pane_id"].as_str() {
                let _ = self.with_machine(pane_machine, |m| {
                    if let Some(s) = m.sessions.iter().find(|s| s.entry.name == session) {
                        s.marks.app_focused(pane_id);
                    }
                });
            }
        }
        let result = rpc::call(&socket, method, params).await;
        if matches!(&result, Err(e) if e.code == "timeout") {
            if let Some(me) = self.me.upgrade() {
                let id = pane_machine.to_string();
                tokio::spawn(async move { me.check_link(&id).await });
            }
        }
        let result = result?;
        if method == "pane.rename" || method == "pane.close" {
            // Refetch now rather than wait for herdr's `pane.updated` / `pane.closed` event.
            let _ = self.with_machine(pane_machine, |m| {
                if let Some(s) = m.sessions.iter().find(|s| s.entry.name == session) {
                    s.refetch.notify_one();
                }
            });
        }
        Ok(result)
    }

    // ---- per-session supervisor ---------------------------------------

    fn update_session(&self, id: &str, name: &str, f: impl FnOnce(&mut Sess)) {
        let _ = self.with_machine(id, |m| {
            if let Some(s) = m.sessions.iter_mut().find(|s| s.entry.name == name) {
                f(s);
            }
        });
        self.notify(id);
    }

    fn session_running(&self, id: &str, name: &str) -> bool {
        self.session(id, name).map(|e| e.running).unwrap_or(false)
    }

    /// Keep a watcher alive for one running session; reconnect (fresh snapshot) with backoff.
    async fn supervise(
        self: Arc<Self>,
        id: String,
        name: String,
        transport: Arc<dyn Transport>,
        refetch: Arc<tokio::sync::Notify>,
        marks: Arc<SharedMarks>,
    ) {
        let mut attempt = 0u32;
        let probe: Arc<dyn Probe> = Arc::new(PiProbe::new(transport.clone()));
        loop {
            let Ok(entry) = self.session(&id, &name) else {
                return;
            };
            let mut first_view: Option<tokio::time::Instant> = None;
            let err = match transport.local_socket(&entry).await {
                Err(e) => e,
                Ok(socket) => {
                    let (tx, mut rx) = mpsc::unbounded_channel();
                    let _guard = AbortOnDrop(spawn_watcher(
                        name.clone(),
                        socket,
                        tx,
                        refetch.clone(),
                        marks.clone(),
                        Some(probe.clone()),
                    ));
                    let mut closed = None;
                    while let Some(ev) = rx.recv().await {
                        match ev {
                            WatchEvent::View(v) => {
                                first_view.get_or_insert_with(tokio::time::Instant::now);
                                self.update_session(&id, &name, |s| {
                                    s.view = Some(v);
                                    s.error = None;
                                });
                            }
                            WatchEvent::Status {
                                pane_id,
                                status,
                                previous,
                                title,
                            } => {
                                (self.emit)(UiEvent::PaneStatus(PaneStatusEvent {
                                    pane: PaneRef {
                                        machine_id: id.clone(),
                                        session: name.clone(),
                                        pane_id,
                                    },
                                    status,
                                    previous,
                                    title,
                                }));
                            }
                            WatchEvent::Closed(e) => {
                                closed = Some(e);
                                break;
                            }
                        }
                    }
                    closed.unwrap_or_else(|| AppError::new("io", "watcher ended"))
                }
            };
            // The first snapshot over a freshly forwarded socket ending in EOF: sshd refused it.
            let err = if first_view.is_none() {
                self.forward_refusal(&id, err)
            } else {
                err
            };
            self.update_session(&id, &name, |s| s.error = Some(err));
            if let Some(ssh) = self.ssh_of(&id) {
                if !master_alive(&ssh.ctl, &ssh.target).await {
                    let me = self.clone();
                    let id = id.clone();
                    tokio::spawn(async move { me.on_master_lost(&id).await });
                    return;
                }
            }
            if let Ok(list) = self.list_sessions(&id).await {
                if self.apply_list(&id, list).is_err() || !self.session_running(&id, &name) {
                    return; // stopped (apply_list already marked it) or machine gone
                }
            }
            attempt = retry_attempt(attempt, first_view.map(|t| t.elapsed()));
            tokio::time::sleep(backoff(attempt)).await;
            attempt = attempt.saturating_add(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        herdr::fake::FakeHerdr,
        transport::{local::LocalTransport, Transport},
    };
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn registry_roundtrip_and_corrupt_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("machines.json");
        assert!(load_registry(&p).is_empty());
        let list = vec![MachineConfig {
            id: "devtuf".into(),
            label: "devtuf".into(),
            ssh_target: "devtuf".into(),
            herdr_path: None,
            enabled: true,
        }];
        save_registry(&p, &list).unwrap();
        assert_eq!(load_registry(&p), list);
        std::fs::write(&p, "{oops").unwrap();
        assert!(load_registry(&p).is_empty());
    }
    #[test]
    fn slugs_are_short_unique_and_safe() {
        assert_eq!(slug("Dev Tuf!", &[]), "dev-tuf");
        assert_eq!(slug("devtuf", &["devtuf".into()]), "devtuf-2");
        assert!(slug("a-machine-label-that-is-way-too-long", &[]).len() <= 16);
        assert_eq!(slug("local", &[]), "local-2");
    }

    const PROBE_HEAD: &str =
        "HOME=/h\nHERDR=/h/herdr\nPI_DIR=/h/.pi/agent/sessions\nVERSION=0.9.3\nPROTOCOL=22\n";

    /// The probe's stdout when `herdr session list` printed `sessions`.
    fn probe_reply(sessions: &str) -> String {
        format!("{PROBE_HEAD}@@SESSIONS@@\n{sessions}@@SESSIONS_EXIT=0\n")
    }

    /// Fake transport: probe/session-list answered by a script, socket = FakeHerdr.
    struct FakeT {
        sock: String,
    }
    impl FakeT {
        fn list(&self) -> String {
            format!(
                "name status directory socket\ndefault running /x {}\nold stopped /y /y/herdr.sock\n",
                self.sock
            )
        }
    }
    #[async_trait::async_trait]
    impl Transport for FakeT {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let joined = argv.join(" ");
            let out = if joined.contains("HERDR=") {
                probe_reply(&self.list())
            } else if joined.contains("session list") {
                self.list()
            } else {
                PROBE_HEAD.to_string()
            };
            vec!["printf".into(), "%s".into(), out]
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            Ok(s.socket.clone().into())
        }
        async fn release_socket(&self, _: &SessionEntry) -> AppResult<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn connects_local_and_emits_views() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let events: Arc<Mutex<Vec<MachineView>>> = Arc::default();
        let ev = events.clone();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(
            d.path().join("m.json"),
            Arc::new(move |e| {
                if let UiEvent::Machine(v) = e {
                    ev.lock().unwrap().push(v)
                }
            }),
        );
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let v = mgr.views().into_iter().find(|v| v.id == "local").unwrap();
        assert_eq!(v.state, MachineState::Connected);
        assert_eq!(v.version.as_deref(), Some("0.9.3"));
        assert_eq!(
            v.sessions
                .iter()
                .map(|s| (s.name.as_str(), s.running))
                .collect::<Vec<_>>(),
            [("default", true), ("old", false)]
        );
        assert_eq!(v.sessions[0].workspaces.len(), 2);
        assert_eq!(v.status, crate::herdr::types::AgentStatus::Blocked);
        assert!(!events.lock().unwrap().is_empty());
        assert_eq!(
            mgr.call("local", "default", "server.stop", json!({}))
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
        mgr.call("local", "default", "pane.close", json!({"pane_id":"w1:p2"}))
            .await
            .unwrap();
        assert_eq!(f.calls_of("pane.close"), 1);
        let _ = LocalTransport; // default factory type exists
    }

    struct RecT {
        inner: FakeT,
        released: Arc<Mutex<Vec<String>>>,
    }
    #[async_trait::async_trait]
    impl Transport for RecT {
        fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
            self.inner.wrap(argv, tty)
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            self.inner.local_socket(s).await
        }
        async fn release_socket(&self, s: &SessionEntry) -> AppResult<()> {
            self.released.lock().unwrap().push(s.name.clone());
            Ok(())
        }
    }

    #[test]
    fn backoff_schedule() {
        let s: Vec<u64> = (0..9).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(s, vec![1, 2, 4, 8, 16, 32, 60, 60, 60]);
    }
    #[test]
    fn backoff_resets_only_after_a_stable_watch() {
        let s = std::time::Duration::from_secs;
        assert_eq!(retry_attempt(4, None), 4, "never got a snapshot");
        assert_eq!(
            retry_attempt(4, Some(s(5))),
            4,
            "snapshot, then a quick drop"
        );
        assert_eq!(retry_attempt(4, Some(s(30))), 0);
        assert_eq!(retry_attempt(0, Some(s(29))), 0);
    }
    #[tokio::test]
    async fn add_and_remove_persist() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("m.json");
        let mgr = MachineManager::new(p.clone(), Arc::new(|_| {}));
        let v = mgr
            .add("cuong@devtuf.lan".into(), Some("Dev Tuf".into()), None)
            .await
            .unwrap();
        assert_eq!(
            (v.id.as_str(), v.kind.as_str(), v.state.clone()),
            ("dev-tuf", "ssh", MachineState::Disconnected)
        );
        assert_eq!(load_registry(&p)[0].ssh_target, "cuong@devtuf.lan");
        mgr.remove("dev-tuf").await.unwrap();
        assert!(load_registry(&p).is_empty());
        assert!(mgr.views().iter().all(|m| m.id != "dev-tuf"));
    }
    #[tokio::test]
    async fn add_rejects_option_like_targets() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        assert_eq!(
            mgr.add("-oProxyCommand=x".into(), None, None)
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
        assert_eq!(
            mgr.add("  ".into(), None, None).await.unwrap_err().code,
            "invalid"
        );
    }

    async fn wait_for(mut cond: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if cond() {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test]
    async fn forward_refusal_marks_the_session() {
        // sshd refuses the forward: the local socket accepts, then closes with no frame.
        let d = tempfile::Builder::new()
            .prefix("hr")
            .tempdir_in("/tmp")
            .unwrap();
        let sock = d.path().join("x.sock");
        let l = tokio::net::UnixListener::bind(&sock).unwrap();
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                drop(s);
            }
        });
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let s = sock.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: s.clone() }) as Arc<dyn Transport>
        }));
        mgr.add("box".into(), None, None).await.unwrap();
        mgr.connect("box").await.unwrap();
        let m = mgr.clone();
        assert!(
            wait_for(
                move || m.views().iter().find(|v| v.id == "box").unwrap().sessions[0]
                    .error
                    .as_ref()
                    .is_some_and(|e| e.code == "ssh_forward_denied")
            )
            .await
        );
        mgr.disconnect("box").await;
    }

    #[tokio::test]
    async fn dropped_connection_keeps_last_snapshot_and_closes_terminals() {
        use crate::attach::{AttachEvent, AttachKey, AttachManager, Sink};
        struct Rec(Arc<Mutex<Vec<AttachEvent>>>);
        impl Sink for Rec {
            fn data(&self, _: Vec<u8>) {}
            fn event(&self, e: AttachEvent) {
                self.0.lock().unwrap().push(e);
            }
        }
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        let att = AttachManager::new(std::time::Duration::from_secs(15));
        mgr.set_attach_manager(att.clone());
        mgr.add("box".into(), None, None).await.unwrap();
        mgr.connect("box").await.unwrap();
        let m = mgr.clone();
        assert!(
            wait_for(
                move || !m.views().iter().find(|v| v.id == "box").unwrap().sessions[0]
                    .workspaces
                    .is_empty()
            )
            .await
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        att.open(
            AttachKey {
                machine_id: "box".into(),
                session: "default".into(),
                terminal_id: "t".into(),
            },
            vec!["cat".into()],
            80,
            24,
            Arc::new(Rec(events.clone())),
        )
        .unwrap();

        mgr.on_master_lost("box").await;
        let v = mgr.views().into_iter().find(|v| v.id == "box").unwrap();
        assert_eq!(v.state, MachineState::Disconnected);
        assert_eq!(v.sessions.len(), 2);
        assert!(
            !v.sessions[0].workspaces.is_empty(),
            "last snapshot is kept"
        );
        assert!(wait_for(|| events.lock().unwrap().contains(&AttachEvent::Detached)).await);
        // An explicit disconnect clears it.
        mgr.disconnect("box").await;
        assert!(mgr
            .views()
            .into_iter()
            .find(|v| v.id == "box")
            .unwrap()
            .sessions
            .is_empty());
    }

    /// A separate `session list` fails on calls 0..=2 (the connect's list rides in the probe);
    /// start_session must keep polling.
    struct FlakyT {
        inner: FakeT,
        lists: std::sync::atomic::AtomicU32,
    }
    #[async_trait::async_trait]
    impl Transport for FlakyT {
        fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
            let joined = argv.join(" ");
            if joined.contains("session list") && !joined.contains("HERDR=") {
                let n = self.lists.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if (0..=2).contains(&n) {
                    return vec!["sh".into(), "-c".into(), "echo boom >&2; exit 1".into()];
                }
            }
            self.inner.wrap(argv, tty)
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            self.inner.local_socket(s).await
        }
        async fn release_socket(&self, s: &SessionEntry) -> AppResult<()> {
            self.inner.release_socket(s).await
        }
    }

    #[tokio::test]
    async fn start_session_polls_through_transient_errors() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FlakyT {
                inner: FakeT { sock: sock.clone() },
                lists: Default::default(),
            }) as Arc<dyn Transport>
        }));
        // The connect lists through the probe, so every failing list hits start_session.
        mgr.connect("local").await.unwrap();
        mgr.start_session("local", "default").await.unwrap();
    }

    /// Records `session delete` argv; answers it with `fail` as stderr and exit 1 when set.
    struct DelT {
        inner: FakeT,
        deletes: Arc<Mutex<Vec<String>>>,
        fail: Option<&'static str>,
    }
    #[async_trait::async_trait]
    impl Transport for DelT {
        fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
            let joined = argv.join(" ");
            if joined.contains("session delete") {
                self.deletes.lock().unwrap().push(joined);
                return match self.fail {
                    Some(msg) => vec!["sh".into(), "-c".into(), format!("echo {msg} >&2; exit 1")],
                    None => vec!["true".into()],
                };
            }
            self.inner.wrap(argv, tty)
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            self.inner.local_socket(s).await
        }
        async fn release_socket(&self, s: &SessionEntry) -> AppResult<()> {
            self.inner.release_socket(s).await
        }
    }

    async fn delete_mgr(
        fail: Option<&'static str>,
    ) -> (Arc<MachineManager>, Arc<Mutex<Vec<String>>>, FakeHerdr) {
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({"type":"ok"}))));
        let deletes: Arc<Mutex<Vec<String>>> = Arc::default();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (sock, del) = (f.path.to_string_lossy().to_string(), deletes.clone());
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(DelT {
                inner: FakeT { sock: sock.clone() },
                deletes: del.clone(),
                fail,
            }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        (mgr, deletes, f)
    }

    #[tokio::test]
    async fn delete_session_runs_herdr_session_delete_for_a_stopped_session() {
        let (mgr, deletes, _f) = delete_mgr(None).await;
        mgr.delete_session("local", "old").await.unwrap();
        assert_eq!(*deletes.lock().unwrap(), ["/h/herdr session delete -- old"]);
    }

    #[tokio::test]
    async fn delete_session_refuses_a_running_or_unknown_session() {
        let (mgr, deletes, _f) = delete_mgr(None).await;
        assert_eq!(
            mgr.delete_session("local", "default")
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
        assert!(mgr.delete_session("local", "nope").await.is_err());
        assert!(deletes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_session_reports_herdr_failure() {
        let (mgr, _deletes, _f) = delete_mgr(Some("locked")).await;
        let e = mgr.delete_session("local", "old").await.unwrap_err();
        assert_eq!(e.code, "herdr_error");
        assert!(e.message.contains("locked"), "{}", e.message);
    }

    #[tokio::test]
    async fn disconnect_releases_sessions_stopped_outside_the_app() {
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({"type":"ok"}))));
        let released: Arc<Mutex<Vec<String>>> = Arc::default();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (sock, rel) = (f.path.to_string_lossy().to_string(), released.clone());
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(RecT {
                inner: FakeT { sock: sock.clone() },
                released: rel.clone(),
            }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap(); // lists `old` as stopped
        mgr.disconnect("local").await;
        assert!(
            released.lock().unwrap().contains(&"old".to_string()),
            "{:?}",
            released.lock().unwrap()
        );
    }

    #[tokio::test]
    async fn connect_spares_the_ssh_master_terminal() {
        use crate::attach::{AttachEvent, AttachKey, AttachManager, Sink};
        struct Rec(Arc<Mutex<Vec<AttachEvent>>>);
        impl Sink for Rec {
            fn data(&self, _: Vec<u8>) {}
            fn event(&self, e: AttachEvent) {
                self.0.lock().unwrap().push(e);
            }
        }
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({"type":"ok"}))));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        let att = AttachManager::new(std::time::Duration::from_secs(15));
        mgr.set_attach_manager(att.clone());
        mgr.add("box".into(), None, None).await.unwrap();
        let (master_ev, term_ev) = (
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        let mk = |session: &str, terminal: &str| AttachKey {
            machine_id: "box".into(),
            session: session.into(),
            terminal_id: terminal.into(),
        };
        att.open(
            mk("", "ssh-master"),
            vec!["sh".into(), "-c".into(), "sleep 5".into()],
            80,
            24,
            Arc::new(Rec(master_ev.clone())),
        )
        .unwrap();
        att.open(
            mk("default", "t"),
            vec!["cat".into()],
            80,
            24,
            Arc::new(Rec(term_ev.clone())),
        )
        .unwrap();
        mgr.connect("box").await.unwrap();
        assert!(wait_for(|| term_ev.lock().unwrap().contains(&AttachEvent::Detached)).await);
        assert!(!master_ev.lock().unwrap().contains(&AttachEvent::Detached));
        att.write(&mk("", "ssh-master"), b"x").unwrap();
        mgr.disconnect("box").await; // an explicit disconnect closes everything
        assert!(wait_for(|| master_ev.lock().unwrap().contains(&AttachEvent::Detached)).await);
    }

    fn counting_master(
        calls: Arc<std::sync::atomic::AtomicU32>,
        code: &'static str,
    ) -> MasterStart {
        Arc::new(move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move { Err(AppError::new(code, "boom")) })
        })
    }

    #[tokio::test]
    async fn retries_stop_on_ssh_auth_failure() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let calls: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        mgr.with_master_start(counting_master(calls.clone(), "ssh_auth"));
        mgr.add("retry-auth".into(), None, None).await.unwrap();
        assert_eq!(
            mgr.connect("retry-auth").await.unwrap_err().code,
            "ssh_auth"
        );
        mgr.on_master_lost("retry-auth").await;
        tokio::time::sleep(std::time::Duration::from_millis(3500)).await;
        // connect + exactly one retry (after 1 s); the 2 s retry never happens.
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        let v = mgr
            .views()
            .into_iter()
            .find(|v| v.id == "retry-auth")
            .unwrap();
        assert_eq!(
            (v.state, v.error.map(|e| e.code)),
            (MachineState::Error, Some("ssh_auth".to_string()))
        );
        mgr.remove("retry-auth").await.unwrap();
    }

    #[tokio::test]
    async fn cancel_reconnect_stops_the_loop() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let calls: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        mgr.with_master_start(counting_master(calls.clone(), "io"));
        mgr.add("retry-cancel".into(), None, None).await.unwrap();
        assert!(mgr.connect("retry-cancel").await.is_err());
        mgr.on_master_lost("retry-cancel").await;
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "an io failure keeps retrying"
        );
        mgr.cancel_reconnect("retry-cancel");
        tokio::time::sleep(std::time::Duration::from_millis(2600)).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        mgr.remove("retry-cancel").await.unwrap();
    }

    /// A master start that takes `ms` and then succeeds, flagging `started` when done.
    fn slow_master(ms: u64, started: Arc<std::sync::atomic::AtomicBool>) -> MasterStart {
        Arc::new(move || {
            let started = started.clone();
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                started.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
        })
    }

    /// Records, per master-exit call, whether the slow master start had finished by then.
    fn recording_exit(
        started: Arc<std::sync::atomic::AtomicBool>,
        log: Arc<Mutex<Vec<bool>>>,
    ) -> MasterExit {
        Arc::new(move || {
            log.lock()
                .unwrap()
                .push(started.load(std::sync::atomic::Ordering::SeqCst))
        })
    }

    #[tokio::test]
    async fn disconnect_during_connect_ends_the_new_master() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (started, exits) = (
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Arc::new(Mutex::new(Vec::new())),
        );
        mgr.with_master_start(slow_master(400, started.clone()));
        mgr.with_master_exit(recording_exit(started.clone(), exits.clone()));
        mgr.add("i1-disc".into(), None, None).await.unwrap();
        let m = mgr.clone();
        let connect = tokio::spawn(async move { m.connect("i1-disc").await });
        let m = mgr.clone();
        assert!(
            wait_for(move || m
                .views()
                .iter()
                .any(|v| v.id == "i1-disc" && v.state == MachineState::Authenticating))
            .await
        );
        mgr.disconnect("i1-disc").await;
        connect.await.unwrap().unwrap();
        assert!(started.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            exits.lock().unwrap().contains(&true),
            "the master started after the disconnect is ended: {:?}",
            exits.lock().unwrap()
        );
        let v = mgr.views().into_iter().find(|v| v.id == "i1-disc").unwrap();
        assert_eq!((v.state, v.error), (MachineState::Disconnected, None));
        assert!(mgr.transport("i1-disc").is_err());
        mgr.remove("i1-disc").await.unwrap();
    }

    #[tokio::test]
    async fn remove_during_connect_ends_the_new_master() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (started, exits) = (
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Arc::new(Mutex::new(Vec::new())),
        );
        mgr.with_master_start(slow_master(400, started.clone()));
        mgr.with_master_exit(recording_exit(started.clone(), exits.clone()));
        mgr.add("i1-remove".into(), None, None).await.unwrap();
        let m = mgr.clone();
        let connect = tokio::spawn(async move { m.connect("i1-remove").await });
        let m = mgr.clone();
        assert!(
            wait_for(move || m
                .views()
                .iter()
                .any(|v| v.id == "i1-remove" && v.state == MachineState::Authenticating))
            .await
        );
        mgr.remove("i1-remove").await.unwrap();
        connect.await.unwrap().unwrap();
        assert!(
            exits.lock().unwrap().contains(&true),
            "{:?}",
            exits.lock().unwrap()
        );
        assert!(mgr.views().iter().all(|v| v.id != "i1-remove"));
    }

    fn alive_seam(alive: bool, calls: Arc<std::sync::atomic::AtomicU32>) -> AliveCheck {
        Arc::new(move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move { alive })
        })
    }

    #[tokio::test]
    async fn health_task_notices_a_dead_master_without_sessions() {
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({"type":"ok"}))));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        let calls: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        mgr.with_health_check(
            std::time::Duration::from_millis(50),
            alive_seam(false, calls.clone()),
        );
        mgr.add("health-dead".into(), None, None).await.unwrap();
        mgr.connect("health-dead").await.unwrap();
        let m = mgr.clone();
        assert!(
            wait_for(move || m
                .views()
                .iter()
                .any(|v| v.id == "health-dead" && v.state == MachineState::Disconnected))
            .await
        );
        mgr.disconnect("health-dead").await;
    }

    /// A connected fake Machine whose link probe answers `alive` (after `delay_ms`) and whose
    /// master exits are counted.
    async fn link_machine(
        id: &str,
        alive: bool,
        delay_ms: u64,
    ) -> (
        Arc<MachineManager>,
        FakeHerdr,
        tempfile::TempDir,
        Arc<std::sync::atomic::AtomicU32>,
        Arc<std::sync::atomic::AtomicU32>,
    ) {
        use std::sync::atomic::{AtomicU32, Ordering};
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({"type":"ok"}))));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        let (probes, exits): (Arc<AtomicU32>, Arc<AtomicU32>) = Default::default();
        let p = probes.clone();
        mgr.with_link_check(Arc::new(move || {
            p.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                alive
            })
        }));
        let e = exits.clone();
        mgr.with_master_exit(Arc::new(move || {
            e.fetch_add(1, Ordering::SeqCst);
        }));
        mgr.add(id.into(), None, None).await.unwrap();
        mgr.connect(id).await.unwrap();
        (mgr, f, d, probes, exits)
    }

    fn state_of(mgr: &MachineManager, id: &str) -> MachineState {
        mgr.views().into_iter().find(|v| v.id == id).unwrap().state
    }

    #[tokio::test]
    async fn a_dead_link_ends_the_master_and_reconnects() {
        use std::sync::atomic::Ordering;
        let (mgr, _f, _d, probes, exits) = link_machine("link-dead", false, 0).await;
        mgr.check_link("link-dead").await;
        assert_eq!(probes.load(Ordering::SeqCst), 1);
        assert_eq!(exits.load(Ordering::SeqCst), 1);
        assert_eq!(state_of(&mgr, "link-dead"), MachineState::Disconnected);
        // The reconnect that follows brings it back.
        let m = mgr.clone();
        assert!(wait_for(move || state_of(&m, "link-dead") == MachineState::Connected).await);
        mgr.disconnect("link-dead").await;
    }

    #[tokio::test]
    async fn a_live_link_is_left_alone() {
        use std::sync::atomic::Ordering;
        let (mgr, _f, _d, probes, exits) = link_machine("link-ok", true, 0).await;
        mgr.check_link("link-ok").await;
        assert_eq!(probes.load(Ordering::SeqCst), 1);
        assert_eq!(exits.load(Ordering::SeqCst), 0);
        assert_eq!(state_of(&mgr, "link-ok"), MachineState::Connected);
        mgr.disconnect("link-ok").await;
    }

    #[tokio::test]
    async fn timeouts_at_once_share_one_probe() {
        use std::sync::atomic::Ordering;
        let (mgr, _f, _d, probes, exits) = link_machine("link-many", false, 200).await;
        let (a, b, c) = tokio::join!(
            mgr.check_link("link-many"),
            mgr.check_link("link-many"),
            mgr.check_link("link-many"),
        );
        let _ = (a, b, c);
        assert_eq!(probes.load(Ordering::SeqCst), 1);
        assert_eq!(exits.load(Ordering::SeqCst), 1);
        mgr.disconnect("link-many").await;
    }

    #[tokio::test]
    async fn the_local_machine_has_no_link_to_probe() {
        use std::sync::atomic::Ordering;
        let (mgr, _f, _d, probes, _exits) = link_machine("link-local", false, 0).await;
        mgr.connect("local").await.unwrap();
        mgr.check_link("local").await;
        assert_eq!(probes.load(Ordering::SeqCst), 0);
        mgr.disconnect("link-local").await;
    }

    #[tokio::test]
    async fn health_task_stops_on_disconnect() {
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({"type":"ok"}))));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        let calls: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        mgr.with_health_check(
            std::time::Duration::from_millis(50),
            alive_seam(true, calls.clone()),
        );
        mgr.add("health-ok".into(), None, None).await.unwrap();
        mgr.connect("health-ok").await.unwrap();
        let c = calls.clone();
        assert!(wait_for(move || c.load(std::sync::atomic::Ordering::SeqCst) >= 2).await);
        assert_eq!(
            mgr.views()
                .into_iter()
                .find(|v| v.id == "health-ok")
                .unwrap()
                .state,
            MachineState::Connected
        );
        mgr.disconnect("health-ok").await;
        let n = calls.load(std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), n);
        // The local Machine gets no health task.
        mgr.connect("local").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), n);
    }

    #[tokio::test]
    async fn state_changes_bypass_the_throttle() {
        let states: Arc<Mutex<Vec<MachineState>>> = Arc::default();
        let st = states.clone();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(
            d.path().join("m.json"),
            Arc::new(move |e| {
                if let UiEvent::Machine(v) = e {
                    st.lock().unwrap().push(v.state)
                }
            }),
        );
        mgr.set_state("local", MachineState::Authenticating, None);
        mgr.set_state("local", MachineState::Probing, None);
        mgr.set_state("local", MachineState::Connected, None);
        assert_eq!(
            *states.lock().unwrap(),
            [
                MachineState::Authenticating,
                MachineState::Probing,
                MachineState::Connected
            ]
        );
    }

    #[tokio::test]
    async fn an_unchanged_view_is_not_emitted_again() {
        let states: Arc<Mutex<Vec<MachineState>>> = Arc::default();
        let st = states.clone();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(
            d.path().join("m.json"),
            Arc::new(move |e| {
                if let UiEvent::Machine(v) = e {
                    st.lock().unwrap().push(v.state)
                }
            }),
        );
        mgr.set_state("local", MachineState::Probing, None);
        mgr.set_state("local", MachineState::Probing, None);
        tokio::time::sleep(std::time::Duration::from_millis(250)).await; // past any trailing emit
        mgr.set_state("local", MachineState::Probing, None);
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        mgr.set_state("local", MachineState::Connected, None);
        assert_eq!(
            *states.lock().unwrap(),
            [MachineState::Probing, MachineState::Connected]
        );
    }

    #[tokio::test]
    async fn remove_emits_nothing_for_the_removed_machine() {
        let ids: Arc<Mutex<Vec<String>>> = Arc::default();
        let rec = ids.clone();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(
            d.path().join("m.json"),
            Arc::new(move |e| {
                if let UiEvent::Machine(v) = e {
                    rec.lock().unwrap().push(v.id)
                }
            }),
        );
        mgr.add("ghost".into(), None, None).await.unwrap();
        ids.lock().unwrap().clear();
        mgr.remove("ghost").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(250)).await; // past any trailing emit
        assert!(
            !ids.lock().unwrap().contains(&"ghost".to_string()),
            "{:?}",
            ids.lock().unwrap()
        );
    }

    #[tokio::test]
    async fn startup_connects_every_enabled_ssh_machine() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("m.json");
        let cfg = |id: &str, enabled| MachineConfig {
            id: id.into(),
            label: id.into(),
            ssh_target: id.into(),
            herdr_path: None,
            enabled,
        };
        save_registry(
            &p,
            &[cfg("i9-a", true), cfg("i9-b", true), cfg("i9-off", false)],
        )
        .unwrap();
        let mgr = MachineManager::new(p, Arc::new(|_| {}));
        let calls: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        mgr.with_master_start(counting_master(calls.clone(), "ssh_auth"));
        mgr.connect_enabled_ssh().await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        let views = mgr.views();
        let state = |id: &str| {
            views
                .iter()
                .find(|v| v.id == id)
                .map(|v| (v.state, v.error.as_ref().map(|e| e.code.clone())))
        };
        assert_eq!(
            state("i9-a"),
            Some((MachineState::Error, Some("ssh_auth".into())))
        );
        assert_eq!(state("i9-off"), Some((MachineState::Disconnected, None)));
        assert_eq!(
            state("local"),
            Some((MachineState::Disconnected, None)),
            "local is connected separately"
        );
    }

    /// `pane_view` answers exactly as a lookup through `views()` does, without cloning them.
    #[tokio::test]
    async fn pane_view_matches_a_lookup_through_views() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        assert!(
            wait_for(|| mgr
                .pane_view(&PaneRef {
                    machine_id: "local".into(),
                    session: "default".into(),
                    pane_id: "w2:p1".into(),
                })
                .is_ok())
            .await
        );
        let through_views = |r: &PaneRef| -> AppResult<PaneView> {
            let views = mgr.views();
            let session = views
                .iter()
                .find(|m| m.id == r.machine_id)
                .and_then(|m| m.sessions.iter().find(|s| s.name == r.session))
                .ok_or_else(|| {
                    AppError::new(
                        "not_found",
                        format!("unknown session {}/{}", r.machine_id, r.session),
                    )
                })?;
            session
                .workspaces
                .iter()
                .flat_map(|w| &w.tabs)
                .flat_map(|t| &t.panes)
                .find(|p| p.pane_id == r.pane_id)
                .cloned()
                .ok_or_else(|| AppError::new("not_found", format!("unknown pane {}", r.pane_id)))
        };
        let cases = [
            ("local", "default", "w1:p1"),
            ("local", "default", "w2:p2"),
            ("local", "default", "w9:p9"),
            ("local", "old", "w1:p1"),
            ("local", "nope", "w1:p1"),
            ("ghost", "default", "w1:p1"),
        ];
        for (m, s, p) in cases {
            let r = PaneRef {
                machine_id: m.into(),
                session: s.into(),
                pane_id: p.into(),
            };
            let (a, b) = (mgr.pane_view(&r), through_views(&r));
            assert_eq!(format!("{a:?}"), format!("{b:?}"), "{m}/{s}/{p}");
        }
        assert!(mgr
            .pane_view(&PaneRef {
                machine_id: "local".into(),
                session: "default".into(),
                pane_id: "w1:p1".into(),
            })
            .is_ok());
    }

    /// Refetches of an unchanged snapshot emit nothing; a real change still does.
    #[tokio::test]
    async fn emits_only_changed_views() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let emits: Arc<Mutex<Vec<MachineView>>> = Arc::default();
        let ev = emits.clone();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(
            d.path().join("m.json"),
            Arc::new(move |e| {
                if let UiEvent::Machine(v) = e {
                    ev.lock().unwrap().push(v)
                }
            }),
        );
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        assert!(wait_for(|| f.calls_of("events.subscribe") >= 1).await);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        emits.lock().unwrap().clear();
        for i in 0..5 {
            let before = f.calls_of("session.snapshot");
            mgr.call(
                "local",
                "default",
                "pane.rename",
                json!({"pane_id":"w1:p1","label":format!("x{i}")}),
            )
            .await
            .unwrap();
            assert!(wait_for(|| f.calls_of("session.snapshot") > before).await);
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w2:p1","workspace_id":"w2","agent_status":"done"}),
        );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let emits = emits.lock().unwrap();
        assert_eq!(emits.len(), 1, "machine emits: {}", emits.len());
        assert_eq!(
            emits[0].sessions[0].workspaces[1].status,
            crate::herdr::types::AgentStatus::Done
        );
    }

    /// Fake transport with no sessions whose every exec first sleeps `delay_s`.
    struct SlowT {
        delay_s: &'static str,
    }
    #[async_trait::async_trait]
    impl Transport for SlowT {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let out = if argv.join(" ").contains("HERDR=") {
                "HOME=/h\nHERDR=/h/herdr\nPI_DIR=/p\nVERSION=0.9.3\nPROTOCOL=22\n"
            } else {
                "name status directory socket\n"
            };
            let script = format!("sleep {}; printf %s \"$1\"", self.delay_s);
            vec!["sh".into(), "-c".into(), script, "sh".into(), out.into()]
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            Ok(s.socket.clone().into())
        }
        async fn release_socket(&self, _: &SessionEntry) -> AppResult<()> {
            Ok(())
        }
    }

    /// Fake transport with no sessions that records the last two argv elements of each
    /// probe: the herdr override and the known path.
    /// Probe number `bad` (0-based) reports an incompatible protocol.
    struct ProbeLog {
        log: Arc<Mutex<Vec<(String, String)>>>,
        bad: Option<usize>,
    }
    #[async_trait::async_trait]
    impl Transport for ProbeLog {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let out = if argv.join(" ").contains("HERDR=") {
                let n = argv.len();
                let mut log = self.log.lock().unwrap();
                let bad = self.bad == Some(log.len());
                log.push((argv[n - 2].clone(), argv[n - 1].clone()));
                if bad {
                    "HOME=/h\nHERDR=/h/herdr\nPI_DIR=/p\nVERSION=0.9.3\nPROTOCOL=99\n"
                } else {
                    "HOME=/h\nHERDR=/h/herdr\nPI_DIR=/p\nVERSION=0.9.3\nPROTOCOL=22\n"
                }
            } else {
                "name status directory socket\n"
            };
            vec!["printf".into(), "%s".into(), out.into()]
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            Ok(s.socket.clone().into())
        }
        async fn release_socket(&self, _: &SessionEntry) -> AppResult<()> {
            Ok(())
        }
    }

    type ProbeArgs = Arc<Mutex<Vec<(String, String)>>>;

    async fn probe_log_mgr(
        bad: Option<usize>,
    ) -> (Arc<MachineManager>, ProbeArgs, tempfile::TempDir) {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let log: ProbeArgs = Arc::default();
        let l = log.clone();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(ProbeLog {
                log: l.clone(),
                bad,
            }) as Arc<dyn Transport>
        }));
        mgr.add("box".into(), None, None).await.unwrap();
        (mgr, log, d)
    }

    #[tokio::test]
    async fn failed_probe_forgets_the_known_path() {
        let (mgr, log, _d) = probe_log_mgr(Some(1)).await;
        mgr.connect("box").await.unwrap();
        assert_eq!(mgr.connect("box").await.unwrap_err().code, "incompatible");
        mgr.connect("box").await.unwrap(); // discovery again, e.g. a newer herdr earlier in PATH
        let known: Vec<String> = log.lock().unwrap().iter().map(|(_, k)| k.clone()).collect();
        assert_eq!(known, ["", "/h/herdr", ""]);
    }

    #[tokio::test]
    async fn reconnect_probe_passes_the_known_path() {
        let (mgr, log, _d) = probe_log_mgr(None).await;
        mgr.connect("box").await.unwrap();
        mgr.connect("box").await.unwrap(); // a reconnect
        mgr.update("box", Some("/o/herdr".into())).await.unwrap();
        mgr.update("box", None).await.unwrap(); // the override removed
        mgr.connect("box").await.unwrap();
        mgr.disconnect("box").await;
        mgr.connect("box").await.unwrap();
        let p = |o: &str, k: &str| (o.to_string(), k.to_string());
        assert_eq!(
            *log.lock().unwrap(),
            [
                p("", ""),
                p("", "/h/herdr"),
                p("/o/herdr", ""),
                p("", ""),
                p("", "/h/herdr"),
                p("", ""),
            ]
        );
    }

    /// Counts execs; the probe's session list exits `list_exit`.
    struct CountT {
        inner: FakeT,
        execs: Arc<std::sync::atomic::AtomicU32>,
        list_exit: i32,
    }
    #[async_trait::async_trait]
    impl Transport for CountT {
        fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
            self.execs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.list_exit != 0 && argv.join(" ").contains("HERDR=") {
                let out = format!(
                    "{PROBE_HEAD}@@SESSIONS@@\n@@SESSIONS_EXIT={}\n",
                    self.list_exit
                );
                let script = "printf %s \"$1\"; echo 'no server' >&2".to_string();
                return vec!["sh".into(), "-c".into(), script, "sh".into(), out];
            }
            self.inner.wrap(argv, tty)
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            self.inner.local_socket(s).await
        }
        async fn release_socket(&self, s: &SessionEntry) -> AppResult<()> {
            self.inner.release_socket(s).await
        }
    }

    fn count_mgr(
        list_exit: i32,
    ) -> (
        Arc<MachineManager>,
        Arc<std::sync::atomic::AtomicU32>,
        tempfile::TempDir,
    ) {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let execs: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        let e = execs.clone();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(CountT {
                inner: FakeT {
                    sock: "/nonexistent/herdr.sock".into(),
                },
                execs: e.clone(),
                list_exit,
            }) as Arc<dyn Transport>
        }));
        (mgr, execs, d)
    }

    #[tokio::test]
    async fn connect_runs_one_exec_for_probe_and_sessions() {
        let (mgr, execs, _d) = count_mgr(0);
        mgr.connect("local").await.unwrap();
        // The probe (with the session list) and the client-only check for `old`.
        assert_eq!(execs.load(std::sync::atomic::Ordering::SeqCst), 2);
        let v = mgr.views().into_iter().find(|v| v.id == "local").unwrap();
        let names: Vec<_> = v.sessions.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["default", "old"]);
    }

    #[tokio::test]
    async fn failed_session_list_in_probe_fails_connect() {
        let (mgr, _, _d) = count_mgr(1);
        let e = mgr.connect("local").await.unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("herdr_error", "session list failed: no server")
        );
        let v = mgr.views().into_iter().find(|v| v.id == "local").unwrap();
        assert_eq!(v.state, MachineState::Error);
    }

    /// One stopped Session; counts releases and forgets, each forget taking 300 ms.
    struct ExitT {
        released: Arc<std::sync::atomic::AtomicU32>,
        forgot: Arc<std::sync::atomic::AtomicU32>,
    }
    #[async_trait::async_trait]
    impl Transport for ExitT {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let list = "name status directory socket\nold stopped /y /y/herdr.sock\n";
            let out = if argv.join(" ").contains("HERDR=") {
                probe_reply(list)
            } else {
                String::new()
            };
            vec!["printf".into(), "%s".into(), out]
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            Ok(s.socket.clone().into())
        }
        async fn release_socket(&self, _: &SessionEntry) -> AppResult<()> {
            self.released
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
        async fn forget_socket(&self, _: &SessionEntry) -> AppResult<()> {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            self.forgot
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    type Counter = Arc<std::sync::atomic::AtomicU32>;

    async fn exit_mgr(ids: &[&str]) -> (Arc<MachineManager>, Counter, Counter, tempfile::TempDir) {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (released, forgot): (Counter, Counter) = Default::default();
        let (r, f) = (released.clone(), forgot.clone());
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(ExitT {
                released: r.clone(),
                forgot: f.clone(),
            }) as Arc<dyn Transport>
        }));
        for id in ids {
            mgr.add(id.to_string(), None, None).await.unwrap();
            mgr.connect(id).await.unwrap();
        }
        (mgr, released, forgot, d)
    }

    #[tokio::test]
    async fn exit_forgets_forwards_instead_of_releasing_them() {
        let (mgr, released, forgot, _d) = exit_mgr(&["box"]).await;
        mgr.disconnect_all_ssh().await;
        let n = |c: &Counter| c.load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!((n(&released), n(&forgot)), (0, 1));
        let v = mgr.views().into_iter().find(|v| v.id == "box").unwrap();
        assert_eq!(v.state, MachineState::Disconnected);
        // A plain disconnect still releases each forward.
        mgr.connect("box").await.unwrap();
        mgr.disconnect("box").await;
        assert_eq!((n(&released), n(&forgot)), (1, 1));
    }

    #[tokio::test]
    async fn exit_disconnects_machines_concurrently() {
        let (mgr, _, forgot, _d) = exit_mgr(&["box-a", "box-b"]).await;
        let t = std::time::Instant::now();
        mgr.disconnect_all_ssh().await;
        assert_eq!(forgot.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert!(
            t.elapsed() < std::time::Duration::from_millis(500),
            "{:?}",
            t.elapsed()
        );
    }

    #[tokio::test]
    async fn startup_does_not_wait_for_local() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("m.json");
        let cfg = MachineConfig {
            id: "box".into(),
            label: "box".into(),
            ssh_target: "box".into(),
            herdr_path: None,
            enabled: true,
        };
        save_registry(&p, &[cfg]).unwrap();
        let mgr = MachineManager::new(p, Arc::new(|_| {}));
        mgr.with_transport_factory(Arc::new(|c: &MachineConfig| {
            let delay_s = if c.id == LOCAL { "1" } else { "0" };
            Arc::new(SlowT { delay_s }) as Arc<dyn Transport>
        }));
        let state = |mgr: &MachineManager, id: &str| {
            mgr.views().into_iter().find(|v| v.id == id).unwrap().state
        };
        let me = mgr.clone();
        let startup = tokio::spawn(async move { me.connect_at_startup().await });
        assert!(wait_for(|| state(&mgr, "box") == MachineState::Connected).await);
        assert_ne!(state(&mgr, "local"), MachineState::Connected);
        startup.await.unwrap();
        assert_eq!(state(&mgr, "local"), MachineState::Connected);
    }

    #[tokio::test]
    async fn pane_rename_and_close_refetch_the_session() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        assert!(wait_for(|| f.calls_of("events.subscribe") >= 1).await);
        let before = f.calls_of("session.snapshot");
        mgr.call("local", "default", "pane.read", json!({"pane_id":"w1:p2"}))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(
            f.calls_of("session.snapshot"),
            before,
            "other calls do not refetch"
        );
        mgr.call(
            "local",
            "default",
            "pane.rename",
            json!({"pane_id":"w1:p1","label":"x"}),
        )
        .await
        .unwrap();
        assert!(wait_for(|| f.calls_of("session.snapshot") > before).await);
        let before = f.calls_of("session.snapshot");
        mgr.call("local", "default", "pane.close", json!({"pane_id":"w1:p2"}))
            .await
            .unwrap();
        assert!(wait_for(|| f.calls_of("session.snapshot") > before).await);
    }

    #[tokio::test]
    async fn pane_focus_is_the_apps_own_seen() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        assert!(wait_for(|| f.calls_of("events.subscribe") >= 1).await);
        let status = |pane: &str| {
            mgr.views()
                .into_iter()
                .flat_map(|m| m.sessions)
                .flat_map(|s| s.workspaces)
                .flat_map(|w| w.tabs)
                .flat_map(|t| t.panes)
                .find(|p| p.pane_id == pane)
                .map(|p| p.status)
        };
        // herdr turns w1:p1's run straight to idle; the app keeps it done until it focuses it.
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w1:p1","agent_status":"idle"}),
        );
        assert!(wait_for(|| status("w1:p1") == Some(AgentStatus::Done)).await);
        mgr.call("local", "default", "pane.focus", json!({"pane_id":"w1:p1"}))
            .await
            .unwrap();
        assert!(wait_for(|| status("w1:p1") == Some(AgentStatus::Idle)).await);
        // herdr's own done → idle only counts after the app's focus.
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w1:p2","agent_status":"done"}),
        );
        assert!(wait_for(|| status("w1:p2") == Some(AgentStatus::Done)).await);
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w1:p2","agent_status":"idle"}),
        );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(
            status("w1:p2"),
            Some(AgentStatus::Done),
            "seen elsewhere keeps done"
        );
        mgr.call("local", "default", "pane.focus", json!({"pane_id":"w1:p2"}))
            .await
            .unwrap();
        assert!(wait_for(|| status("w1:p2") == Some(AgentStatus::Idle)).await);
    }

    #[tokio::test]
    async fn disconnect_closes_the_machines_chats() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "").unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let chats = Arc::new(ChatManager::default());
        mgr.set_chat_manager(chats.clone());
        let pane = PaneRef {
            machine_id: "local".into(),
            session: "default".into(),
            pane_id: "w1:p1".into(),
        };
        let parser = crate::transcript::parser_for("claude").unwrap();
        chats.insert(
            pane.clone(),
            p.to_string_lossy().into(),
            crate::transcript::spawn_tail(
                Arc::new(LocalTransport),
                p.to_string_lossy().into(),
                parser,
                Arc::new(|_| {}),
            ),
        );
        assert!(chats.page(&pane, 0, 1).is_some());
        mgr.disconnect("local").await;
        assert!(chats.page(&pane, 0, 1).is_none());
    }

    /// Runs the transcript tail script on this machine: a tail's one transport call is its
    /// `herdr-tail` script (transcript/tail.rs `read`). The probe and session list stay
    /// scripted by `FakeT`.
    struct TailT(FakeT);
    #[async_trait::async_trait]
    impl Transport for TailT {
        fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
            if argv.join(" ").contains("herdr-tail") {
                argv.to_vec()
            } else {
                self.0.wrap(argv, tty)
            }
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            self.0.local_socket(s).await
        }
        async fn release_socket(&self, s: &SessionEntry) -> AppResult<()> {
            self.0.release_socket(s).await
        }
    }

    type AgentGet = Arc<dyn Fn() -> Result<Value, (String, String)> + Send + Sync>;

    fn pane_ref(id: &str) -> PaneRef {
        PaneRef {
            machine_id: "local".into(),
            session: "default".into(),
            pane_id: id.into(),
        }
    }

    fn fixture_snap() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap()
    }

    struct PaneMgr {
        mgr: Arc<MachineManager>,
        asked: Arc<std::sync::atomic::AtomicU32>,
        _herdr: FakeHerdr,
        _dir: tempfile::TempDir,
    }
    impl PaneMgr {
        /// `agent.get` calls for Pane w1:p1; the pi probe asks about other panes.
        fn asked(&self) -> u32 {
            self.asked.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    /// The `local` Machine connected to a herdr serving `snap` and answering `agent.get` for
    /// Pane w1:p1 with `agent_get`, once that Pane is in its view.
    async fn pane_mgr(snap: Value, agent_get: AgentGet) -> PaneMgr {
        let asked: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        let count = asked.clone();
        let herdr = FakeHerdr::start(Arc::new(move |m, p| match m {
            "session.snapshot" => Ok(json!({"type":"session_snapshot","snapshot": snap.clone()})),
            "agent.get" if p["target"] == "w1:p1" => {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                agent_get()
            }
            "agent.get" => Ok(json!({"agent": null})),
            _ => Ok(json!({"type":"ok"})),
        }));
        let dir = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(dir.path().join("m.json"), Arc::new(|_| {}));
        let sock = herdr.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(TailT(FakeT { sock: sock.clone() })) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        assert!(wait_for(|| mgr.pane_view(&pane_ref("w1:p1")).is_ok()).await);
        PaneMgr {
            mgr,
            asked,
            _herdr: herdr,
            _dir: dir,
        }
    }

    #[tokio::test]
    async fn foreground_cwd_reads_the_panes_live_snapshot() {
        let mut snap = fixture_snap();
        snap["panes"][0]["foreground_cwd"] = json!("/work/sub");
        let p = pane_mgr(snap, Arc::new(|| Ok(json!({})))).await;
        let mgr = &p.mgr;
        assert_eq!(
            mgr.foreground_cwd(&pane_ref("w1:p1")).await.as_deref(),
            Some("/work/sub")
        );
        assert_eq!(mgr.foreground_cwd(&pane_ref("w1:p2")).await, None);
        let ghost = PaneRef {
            machine_id: "ghost".into(),
            ..pane_ref("w1:p1")
        };
        assert_eq!(mgr.foreground_cwd(&ghost).await, None);
    }

    #[tokio::test]
    async fn files_root_resolves_against_the_machines_home() {
        let p = pane_mgr(fixture_snap(), Arc::new(|| Ok(json!({})))).await;
        let mgr = &p.mgr;
        assert_eq!(mgr.files_root("local", "~/proj/").unwrap(), "/h/proj");
        assert_eq!(mgr.files_root("local", "/srv").unwrap(), "/srv");
        assert_eq!(mgr.files_root("local", "rel").unwrap_err().code, "invalid");
        assert_eq!(mgr.files_root("ghost", "~").unwrap_err().code, "not_found");
    }

    #[tokio::test]
    async fn locate_pane_keeps_a_chosen_path() {
        let p = pane_mgr(
            fixture_snap(),
            Arc::new(|| Ok(json!({"agent": {"agent": "pi"}}))),
        )
        .await;
        let mgr = &p.mgr;
        let l = mgr
            .locate_pane(&pane_ref("w1:p1"), Some("/t/a.jsonl".into()))
            .await
            .unwrap();
        assert_eq!(
            l,
            Located {
                agent: "pi".into(),
                path: "/t/a.jsonl".into(),
                ambiguous: false,
                candidates: vec![],
                pending: false,
                cached: false,
            }
        );
    }

    #[tokio::test]
    async fn a_chosen_path_survives_a_failed_agent_get() {
        let p = pane_mgr(
            fixture_snap(),
            Arc::new(|| Err(("not_found".into(), "no agent".into()))),
        )
        .await;
        let mgr = &p.mgr;
        let l = mgr
            .locate_pane(&pane_ref("w1:p1"), Some("/t/a.jsonl".into()))
            .await
            .unwrap();
        assert_eq!(
            l.agent, "claude",
            "the pane's own agent: the fixture's w1:p1 runs claude"
        );
        assert_eq!(l.path, "/t/a.jsonl");
        assert!(mgr.locate_pane(&pane_ref("w1:p1"), None).await.is_err());
    }

    #[tokio::test]
    async fn locate_pane_waits_for_a_just_started_claudes_session() {
        let seen: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        let p = pane_mgr(
            fixture_snap(),
            Arc::new(move || {
                Ok(
                    if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                        json!({"agent": {"agent": "claude", "agent_session": null}})
                    } else {
                        json!({"agent": {"agent": "claude",
                        "agent_session": {"kind": "path", "value": "/t/s1.jsonl"}}})
                    },
                )
            }),
        )
        .await;
        let l = p.mgr.locate_pane(&pane_ref("w1:p1"), None).await.unwrap();
        assert_eq!(
            l.path, "/t/s1.jsonl",
            "the session herdr reported, not a guess"
        );
        assert!(!l.ambiguous);
        assert_eq!(p.asked(), 2);
    }

    #[tokio::test]
    async fn reconnect_releases_old_sockets() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let released: Arc<Mutex<Vec<String>>> = Arc::default();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (sock, rel) = (f.path.to_string_lossy().to_string(), released.clone());
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(RecT {
                inner: FakeT { sock: sock.clone() },
                released: rel.clone(),
            }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        assert!(released.lock().unwrap().is_empty());
        mgr.connect("local").await.unwrap();
        assert!(
            released.lock().unwrap().contains(&"default".to_string()),
            "{:?}",
            released.lock().unwrap()
        );
        assert_eq!(mgr.views()[0].state, MachineState::Connected);
    }
}
