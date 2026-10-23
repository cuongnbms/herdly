//! Tauri commands: thin wrappers over `MachineManager`.
use crate::{
    attach::{attach_argv, AttachEvent, AttachKey, AttachManager, Sink},
    complete::{self, SlashCommand},
    error::AppError,
    files::{
        all::{self, FileList},
        edit,
        list::{self, Entry},
        paths::check_rel,
        read::{self, FileContent, FileVersion},
        transfer,
        watch::{watch_refusal, WatchEvent},
        watch_manager::{FilesWatch, WatchSink},
    },
    git::{self, DiffScope, FileDiff, GitCommit, GitCommitFile, GitRepo, GitStatus},
    html::HtmlPages,
    layout::LayoutStore,
    machines::{self, MachineManager},
    sshconfig,
    transcript::{self, ChatEvent, ChatItem, ChatManager, Located},
    transport::{self, ssh::master_argv},
    view::{MachineView, PaneRef},
};
use serde_json::Value;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

type Mgr<'a> = State<'a, Arc<MachineManager>>;

#[tauri::command]
pub async fn machines_list(mgr: Mgr<'_>) -> Result<Vec<MachineView>, AppError> {
    Ok(mgr.views())
}

#[tauri::command]
pub async fn machine_connect(mgr: Mgr<'_>, id: String) -> Result<(), AppError> {
    mgr.connect(&id).await
}

#[tauri::command]
pub async fn machine_disconnect(mgr: Mgr<'_>, id: String) -> Result<(), AppError> {
    mgr.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn machine_add(
    mgr: Mgr<'_>,
    ssh_target: String,
    label: Option<String>,
    herdr_path: Option<String>,
) -> Result<MachineView, AppError> {
    mgr.add(ssh_target, label, herdr_path).await
}

#[tauri::command]
pub async fn machine_remove(mgr: Mgr<'_>, id: String) -> Result<(), AppError> {
    mgr.remove(&id).await
}

#[tauri::command]
pub async fn machine_update(
    mgr: Mgr<'_>,
    id: String,
    herdr_path: Option<String>,
) -> Result<MachineView, AppError> {
    mgr.update(&id, herdr_path).await
}

#[tauri::command]
pub async fn machine_master_alive(mgr: Mgr<'_>, id: String) -> Result<bool, AppError> {
    Ok(mgr.master_alive(&id).await)
}

#[tauri::command]
pub async fn ssh_hosts() -> Result<Vec<String>, AppError> {
    Ok(sshconfig::read_hosts())
}

#[tauri::command]
pub async fn sessions_refresh(mgr: Mgr<'_>, machine_id: String) -> Result<(), AppError> {
    mgr.refresh_sessions(&machine_id).await
}

#[tauri::command]
pub async fn session_start(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
) -> Result<(), AppError> {
    mgr.start_session(&machine_id, &session).await
}

#[tauri::command]
pub async fn session_delete(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
) -> Result<(), AppError> {
    mgr.delete_session(&machine_id, &session).await
}

#[tauri::command]
pub async fn session_stop(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
) -> Result<(), AppError> {
    mgr.stop_session(&machine_id, &session).await
}

#[tauri::command]
pub async fn herdr_call(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
    method: String,
    params: Value,
) -> Result<Value, AppError> {
    mgr.call(&machine_id, &session, &method, params).await
}

/// Shows a desktop notification for `pane`; clicking it emits `notify://activate`.
#[tauri::command]
pub fn notify_pane(
    app: tauri::AppHandle,
    pane: crate::view::PaneRef,
    title: String,
    body: String,
    sound: String,
) -> Result<(), AppError> {
    crate::notify::show(&app, pane, title, body, sound)
}

/// Plays a notification sound once, for previewing it in Settings.
#[tauri::command]
pub fn notify_sound_preview(app: tauri::AppHandle, sound: String) -> Result<(), AppError> {
    crate::notify::preview_sound(&app, sound)
}

/// Saves a pasted image on the Machine and returns its path there. The body is the raw
/// image bytes; `x-machine-id` and `x-image-ext` headers name the Machine and file type.
#[tauri::command]
pub async fn image_save_temp(
    mgr: Mgr<'_>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, AppError> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| AppError::new("invalid", format!("missing {name} header")))
    };
    let (machine_id, ext) = (header("x-machine-id")?, header("x-image-ext")?);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new("invalid", "expected raw image bytes"));
    };
    let t = mgr.transport(&machine_id)?;
    transport::save_image_in(t.as_ref(), bytes, &ext, None).await
}

type Att<'a> = State<'a, Arc<AttachManager>>;

/// Forwards PTY output and attach events to the UI over Tauri channels.
struct ChannelSink {
    data: Channel<InvokeResponseBody>,
    events: Channel<AttachEvent>,
    /// ssh's own failure code (255) means the connection dropped, not that herdr exited.
    ssh: bool,
}

impl Sink for ChannelSink {
    fn data(&self, bytes: Vec<u8>) {
        if let Err(e) = self.data.send(InvokeResponseBody::Raw(bytes)) {
            tracing::warn!("terminal data send failed: {e}");
        }
    }
    fn event(&self, e: AttachEvent) {
        let e = match e {
            AttachEvent::Exited { code: Some(255) } if self.ssh => AttachEvent::Detached,
            other => other,
        };
        if let Err(err) = self.events.send(e) {
            tracing::warn!("terminal event send failed: {err}");
        }
    }
}

/// The interactive ssh master's PTY: output and events go to the Connect dialog, and a
/// clean exit (`ssh -f` backgrounded after authenticating) connects the Machine.
struct MasterSink {
    inner: ChannelSink,
    mgr: Arc<MachineManager>,
    machine_id: String,
}

impl Sink for MasterSink {
    fn data(&self, bytes: Vec<u8>) {
        self.inner.data(bytes);
    }
    fn event(&self, e: AttachEvent) {
        if e == (AttachEvent::Exited { code: Some(0) }) {
            let (mgr, id) = (self.mgr.clone(), self.machine_id.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(err) = mgr.connect(&id).await {
                    tracing::warn!("connect {id} after ssh auth: {err}");
                }
            });
        }
        self.inner.event(e);
    }
}

pub const SSH_MASTER_TERMINAL: &str = "ssh-master";

/// Run the interactive (non-batch) ssh master on a PTY for the Connect dialog.
#[tauri::command]
pub async fn connect_open(
    mgr: Mgr<'_>,
    att: Att<'_>,
    machine_id: String,
    cols: u16,
    rows: u16,
    data: Channel<InvokeResponseBody>,
    events: Channel<AttachEvent>,
) -> Result<(), AppError> {
    // The user is authenticating by hand: no automatic retry may race the interactive master.
    mgr.cancel_reconnect(&machine_id);
    let (ctl, target) = mgr.ssh_master(&machine_id)?;
    crate::transport::ssh::clear_stale_ctl(&ctl, &target).await;
    let argv = master_argv(&ctl, &target, false);
    let key = AttachKey {
        machine_id: machine_id.clone(),
        session: String::new(),
        terminal_id: SSH_MASTER_TERMINAL.into(),
    };
    let sink = MasterSink {
        inner: ChannelSink {
            data,
            events,
            ssh: false,
        },
        mgr: Arc::clone(&mgr),
        machine_id,
    };
    att.inner()
        .open_async(key, argv, cols, rows, Arc::new(sink))
        .await
}

fn master_key(machine_id: String) -> AttachKey {
    AttachKey {
        machine_id,
        session: String::new(),
        terminal_id: SSH_MASTER_TERMINAL.into(),
    }
}

#[tauri::command]
pub async fn connect_write(att: Att<'_>, machine_id: String, data: String) -> Result<(), AppError> {
    att.inner()
        .write_async(master_key(machine_id), data.into_bytes())
        .await
}

#[tauri::command]
pub async fn connect_ack(att: Att<'_>, machine_id: String, bytes: usize) -> Result<(), AppError> {
    att.ack(&master_key(machine_id), bytes);
    Ok(())
}

#[tauri::command]
pub async fn connect_resize(
    att: Att<'_>,
    machine_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    att.resize(&master_key(machine_id), cols, rows)
}

#[tauri::command]
pub async fn connect_close(att: Att<'_>, machine_id: String) -> Result<(), AppError> {
    att.inner().close_async(master_key(machine_id)).await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn term_open(
    mgr: Mgr<'_>,
    att: Att<'_>,
    machine_id: String,
    session: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
    takeover: bool,
    data: Channel<InvokeResponseBody>,
    events: Channel<AttachEvent>,
) -> Result<(), AppError> {
    let info = mgr.info(&machine_id)?;
    let transport = mgr.transport(&machine_id)?;
    let argv = transport.wrap(&attach_argv(&info, &session, &terminal_id, takeover), true);
    let ssh = mgr.is_ssh(&machine_id);
    let key = AttachKey {
        machine_id,
        session,
        terminal_id,
    };
    att.inner()
        .open_async(
            key,
            argv,
            cols,
            rows,
            Arc::new(ChannelSink { data, events, ssh }),
        )
        .await
}

#[tauri::command]
pub async fn term_write(att: Att<'_>, key: AttachKey, data: String) -> Result<(), AppError> {
    att.inner().write_async(key, data.into_bytes()).await
}

#[tauri::command]
pub async fn term_resize(
    att: Att<'_>,
    key: AttachKey,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    att.resize(&key, cols, rows)
}

#[tauri::command]
pub async fn term_ack(att: Att<'_>, key: AttachKey, bytes: usize) -> Result<(), AppError> {
    att.ack(&key, bytes);
    Ok(())
}

#[tauri::command]
pub async fn term_release(att: Att<'_>, key: AttachKey) -> Result<(), AppError> {
    att.inner().release_async(key).await;
    Ok(())
}

#[tauri::command]
pub async fn term_close(att: Att<'_>, key: AttachKey) -> Result<(), AppError> {
    att.inner().close_async(key).await;
    Ok(())
}

type Chats<'a> = State<'a, Arc<ChatManager>>;

/// Locates a Pane's transcript without opening it (the Terminal fallback probes with this).
#[tauri::command]
pub async fn chat_locate(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
) -> Result<Located, AppError> {
    let pane_ref = PaneRef {
        machine_id,
        session,
        pane_id,
    };
    mgr.locate_pane(&pane_ref, None).await
}

/// Forks a Transcript from before a user message, or from its newest entry on when `entry_id`
/// is absent, into a new session file on the Machine.
#[tauri::command]
pub async fn chat_fork(
    mgr: Mgr<'_>,
    machine_id: String,
    agent: String,
    path: String,
    entry_id: Option<String>,
) -> Result<transcript::fork::Forked, AppError> {
    let t = mgr.transport(&machine_id)?;
    transcript::fork::fork(&*t, &agent, &path, entry_id.as_deref()).await
}

/// Asks a side question on a fork of the Transcript, streaming its events over `events`. The
/// run ends with a `done` or `error` event, or silently when `chat_btw_cancel` stops it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn chat_btw_ask(
    mgr: Mgr<'_>,
    runs: State<'_, transcript::btw::BtwRuns>,
    machine_id: String,
    path: String,
    question: String,
    fork_id: Option<String>,
    ask_id: String,
    events: Channel<transcript::btw::BtwEvent>,
) -> Result<(), AppError> {
    let t = mgr.transport(&machine_id)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    runs.0.lock().unwrap().insert(ask_id.clone(), tx);
    let result = transcript::btw::ask(
        &*t,
        machine_id != crate::machines::LOCAL,
        "claude",
        &path,
        &question,
        fork_id.as_deref(),
        rx,
        &mut |e| {
            if let Err(err) = events.send(e) {
                tracing::debug!("btw event not delivered: {err}");
            }
        },
    )
    .await;
    runs.0.lock().unwrap().remove(&ask_id);
    result
}

/// Stops a running side question; an unknown id is fine (it already ended).
#[tauri::command]
pub async fn chat_btw_cancel(
    runs: State<'_, transcript::btw::BtwRuns>,
    ask_id: String,
) -> Result<(), AppError> {
    if let Some(tx) = runs.0.lock().unwrap().remove(&ask_id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// Deletes the fork a side question left on the Machine.
#[tauri::command]
pub async fn chat_btw_discard(
    mgr: Mgr<'_>,
    machine_id: String,
    path: String,
    fork_id: String,
) -> Result<(), AppError> {
    let t = mgr.transport(&machine_id)?;
    transcript::btw::discard(&*t, &path, &fork_id).await
}

/// The Slash commands the Agent in a Pane offers, read on the Pane's Machine.
#[tauri::command]
pub async fn complete_commands(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
) -> Result<Vec<SlashCommand>, AppError> {
    let pane_ref = PaneRef {
        machine_id,
        session,
        pane_id,
    };
    let pane = mgr.pane_view(&pane_ref)?;
    let agent = pane.agent.clone().unwrap_or_default();
    if agent.is_empty() {
        return Ok(Vec::new());
    }
    let info = mgr.info(&pane_ref.machine_id)?;
    let transport = mgr.transport(&pane_ref.machine_id)?;
    let cwd = mgr.foreground_cwd(&pane_ref).await.or(pane.cwd);
    complete::list_commands(&*transport, &agent, &info.home, cwd.as_deref()).await
}

/// The files under a Pane's working directory, read on the Pane's Machine.
#[tauri::command]
pub async fn complete_files(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
) -> Result<Vec<String>, AppError> {
    let pane_ref = PaneRef {
        machine_id,
        session,
        pane_id,
    };
    let pane = mgr.pane_view(&pane_ref)?;
    let Some(cwd) = mgr.foreground_cwd(&pane_ref).await.or(pane.cwd) else {
        return Ok(Vec::new());
    };
    let info = mgr.info(&pane_ref.machine_id)?;
    let transport = mgr.transport(&pane_ref.machine_id)?;
    complete::list_files(&*transport, &info.home, &cwd).await
}

/// The entries of `dir` (relative to a Pane's working directory, e.g. `../`), read on the Pane's Machine.
#[tauri::command]
pub async fn complete_entries(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
    dir: String,
) -> Result<Vec<String>, AppError> {
    let pane_ref = PaneRef {
        machine_id,
        session,
        pane_id,
    };
    let pane = mgr.pane_view(&pane_ref)?;
    let Some(cwd) = mgr.foreground_cwd(&pane_ref).await.or(pane.cwd) else {
        return Ok(Vec::new());
    };
    let transport = mgr.transport(&pane_ref.machine_id)?;
    complete::list_entries(&*transport, &cwd, &dir).await
}

/// The folders inside `dir` (which may start with `~`) on a Machine, for folder fields.
#[tauri::command]
pub async fn complete_dirs(
    mgr: Mgr<'_>,
    machine_id: String,
    dir: String,
) -> Result<Vec<String>, AppError> {
    let info = mgr.info(&machine_id)?;
    let transport = mgr.transport(&machine_id)?;
    complete::list_dirs(&*transport, &info.home, &dir).await
}

/// The folder and git branch of a Pane's working directory, read on the Pane's Machine.
#[tauri::command]
pub async fn chat_git_status(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
) -> Result<Option<GitStatus>, AppError> {
    let pane_ref = PaneRef {
        machine_id,
        session,
        pane_id,
    };
    let pane = mgr.pane_view(&pane_ref)?;
    let Some(cwd) = mgr.foreground_cwd(&pane_ref).await.or(pane.cwd) else {
        return Ok(None);
    };
    let transport = mgr.transport(&pane_ref.machine_id)?;
    git::git_status(&*transport, &cwd).await.map(Some)
}

#[tauri::command]
pub async fn chat_open(
    mgr: Mgr<'_>,
    chats: Chats<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
    path: Option<String>,
    events: Channel<ChatEvent>,
) -> Result<Located, AppError> {
    let pane_ref = PaneRef {
        machine_id,
        session,
        pane_id,
    };
    let sink: transcript::Sink = Arc::new(move |e: ChatEvent| {
        if let Err(err) = events.send(e) {
            tracing::warn!("chat event send failed: {err}");
        }
    });
    mgr.open_chat(&chats, &pane_ref, path, sink).await
}

#[tauri::command]
pub async fn chat_page(
    chats: Chats<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
    before: usize,
) -> Result<Vec<ChatItem>, AppError> {
    chats
        .page(
            &PaneRef {
                machine_id,
                session,
                pane_id,
            },
            before,
            transcript::CHAT_PAGE,
        )
        .ok_or_else(|| AppError::new("not_found", "no open chat for this pane"))
}

#[tauri::command]
pub async fn chat_image(
    chats: Chats<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
    r#ref: String,
) -> Result<tauri::ipc::Response, AppError> {
    chats
        .image(
            &PaneRef {
                machine_id,
                session,
                pane_id,
            },
            &r#ref,
        )
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn chat_close(
    chats: Chats<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
) -> Result<(), AppError> {
    chats.close(&PaneRef {
        machine_id,
        session,
        pane_id,
    });
    Ok(())
}

/// Installed monospace font families (empty off macOS).
#[tauri::command]
pub async fn system_fonts() -> Result<Vec<String>, AppError> {
    tokio::task::spawn_blocking(crate::fonts::installed_monospace)
        .await
        .map_err(|e| AppError::new("io", e.to_string()))
}

/// Raw bytes of `family`'s `style` face, for registering it as a web font; `not_found` when
/// the face is missing or the WebView renders it natively (see `fonts::face_file`).
#[tauri::command]
pub async fn font_face(family: String, style: String) -> Result<tauri::ipc::Response, AppError> {
    tokio::task::spawn_blocking(move || {
        let path = crate::fonts::face_file(&family, &style).ok_or_else(|| {
            AppError::new("not_found", format!("no web-loadable {family} {style}"))
        })?;
        std::fs::read(&path)
            .map(tauri::ipc::Response::new)
            .map_err(|e| AppError::new("io", e.to_string()))
    })
    .await
    .map_err(|e| AppError::new("io", e.to_string()))?
}

#[tauri::command]
pub async fn quota_fetch(
    provider: crate::quota::Provider,
) -> Result<crate::quota::QuotaOutcome, AppError> {
    Ok(crate::quota::fetch(provider).await)
}

/// The models pi can use on the Machine (`pi --list-models`).
#[tauri::command]
pub async fn pi_models_list(
    mgr: Mgr<'_>,
    machine_id: String,
) -> Result<Vec<crate::pi::PiModel>, AppError> {
    let info = mgr.info(&machine_id)?;
    if info.pi.is_empty() {
        return Err(AppError::new(
            "not_found",
            "pi was not found on this machine",
        ));
    }
    crate::pi::list_models(&*mgr.transport(&machine_id)?, &info.pi).await
}

/// The saved sidebar layout, or `null` when none was saved yet.
#[tauri::command]
pub async fn layout_load(store: State<'_, Arc<LayoutStore>>) -> Result<Option<Value>, AppError> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.load())
        .await
        .map_err(|e| AppError::new("io", e.to_string()))
}

#[tauri::command]
pub async fn layout_save(
    store: State<'_, Arc<LayoutStore>>,
    layout: Value,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.save(&layout))
        .await
        .map_err(|e| AppError::new("io", e.to_string()))?
}

/// The git repository of a Files root, with every changed entry; None outside a repository.
#[tauri::command]
pub async fn git_repo(
    mgr: Mgr<'_>,
    machine_id: String,
    dir: String,
) -> Result<Option<GitRepo>, AppError> {
    let dir = mgr.files_root(&machine_id, &dir)?;
    let t = mgr.transport(&machine_id)?;
    git::git_repo(&*t, &dir).await
}

/// A page of the commit history of the repository at a Files root.
#[tauri::command]
pub async fn git_log(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    skip: u32,
    limit: u32,
) -> Result<Vec<GitCommit>, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    git::git_log(&*t, &root, skip, limit).await
}

/// The files one commit changed.
#[tauri::command]
pub async fn git_commit_files(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    sha: String,
) -> Result<Vec<GitCommitFile>, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    git::git_commit_files(&*t, &root, &sha).await
}

/// One file's diff in one scope, capped on the Machine.
#[tauri::command]
pub async fn git_diff(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    path: String,
    orig_path: Option<String>,
    scope: DiffScope,
    untracked: bool,
) -> Result<FileDiff, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    git::git_diff(&*t, &root, &path, orig_path.as_deref(), &scope, untracked).await
}

#[tauri::command]
pub async fn files_list_dir(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    rel: String,
    hidden: Option<Vec<String>>,
) -> Result<Vec<Entry>, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    list::list_dir(&*t, &root, &rel, &hidden.unwrap_or_default()).await
}

#[tauri::command]
pub async fn files_list_all(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    hidden: Option<Vec<String>>,
) -> Result<FileList, AppError> {
    let home = mgr.info(&machine_id)?.home;
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    all::list_all(&*t, &home, &root, &hidden.unwrap_or_default()).await
}

#[tauri::command]
pub async fn files_read(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    rel: String,
) -> Result<FileContent, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    read::read_file(&*t, &root, &rel).await
}

#[tauri::command]
pub async fn files_image(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    rel: String,
) -> Result<tauri::ipc::Response, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    read::read_image(&*t, &root, &rel)
        .await
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn files_watch(
    mgr: Mgr<'_>,
    watch: State<'_, Arc<FilesWatch>>,
    machine_id: String,
    root: String,
    events: Channel<WatchEvent>,
) -> Result<u64, AppError> {
    let info = mgr.info(&machine_id)?;
    let root = mgr.files_root(&machine_id, &root)?;
    if let Some(why) = watch_refusal(&info.home, &root) {
        return Err(AppError::new("invalid", why));
    }
    let transport = mgr.transport(&machine_id)?;
    let files_watch = Arc::clone(&watch);
    // A Channel that can no longer deliver means the UI is gone: stop this watch.
    let sink = move |id: u64| -> WatchSink {
        Arc::new(move |e: WatchEvent| {
            if let Err(err) = events.send(e) {
                tracing::warn!("files watch event send failed, stopping it: {err}");
                files_watch.stop(id);
            }
        })
    };
    Ok(watch.start(transport, machine_id == machines::LOCAL, root, sink))
}

#[tauri::command]
pub fn files_unwatch(watch: State<'_, Arc<FilesWatch>>, id: u64) {
    watch.stop(id);
}

#[tauri::command]
pub fn files_html_put(pages: State<'_, Arc<HtmlPages>>, html: String, scripts: bool) -> String {
    pages.put(html, scripts)
}

#[tauri::command]
pub fn files_html_drop(pages: State<'_, Arc<HtmlPages>>, token: String) {
    pages.drop_page(&token);
}

#[tauri::command]
pub async fn files_upload(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    dest_rel: String,
    sources: Vec<String>,
) -> Result<Vec<String>, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    check_rel(&dest_rel)?;
    let sources = transfer::check_sources(&sources)?;
    let dest = transfer::join_abs(&root, &dest_rel);
    let t = mgr.transport(&machine_id)?;
    // Every name, not the tree's listing: that one hides heavy folders and is capped.
    let existing = list::list_names(&*t, &root, &dest_rel).await?;
    if machine_id == crate::machines::LOCAL {
        transfer::check_upload_into_self(std::path::Path::new(&dest), &sources)?;
    }
    tokio::task::spawn_blocking(move || transfer::upload(&*t, &dest, &existing, sources))
        .await
        .map_err(|e| AppError::new("io", e.to_string()))?
}

#[tauri::command]
pub async fn files_create(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    rel: String,
    is_dir: bool,
) -> Result<(), AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    edit::create(&*t, &root, &rel, is_dir).await
}

#[tauri::command]
pub async fn files_rename(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    rel: String,
    name: String,
) -> Result<String, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    edit::rename(&*t, &root, &rel, &name).await
}

#[tauri::command]
pub async fn files_move(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    rel: String,
    to_dir: String,
) -> Result<String, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    edit::move_to(&*t, &root, &rel, &to_dir).await
}

#[tauri::command]
pub async fn files_delete(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    rel: String,
) -> Result<(), AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    tokio::task::spawn_blocking(move || edit::delete(&*t, &root, &rel))
        .await
        .map_err(|e| AppError::new("io", e.to_string()))?
}

#[tauri::command]
pub async fn files_write(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    rel: String,
    text: String,
    expected: Option<FileVersion>,
) -> Result<FileVersion, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let t = mgr.transport(&machine_id)?;
    edit::write(&*t, &root, &rel, &text, expected).await
}

#[tauri::command]
pub async fn files_download(
    mgr: Mgr<'_>,
    machine_id: String,
    root: String,
    rel: String,
) -> Result<String, AppError> {
    let root = mgr.files_root(&machine_id, &root)?;
    let (parent, name) = transfer::download_target(&root, &rel)?;
    let downloads = transfer::downloads_dir()?;
    if machine_id == crate::machines::LOCAL {
        transfer::check_download_contains_downloads(
            &std::path::Path::new(&parent).join(&name),
            &downloads,
        )?;
    }
    let t = mgr.transport(&machine_id)?;
    let saved =
        tokio::task::spawn_blocking(move || transfer::download(&*t, &parent, &name, &downloads))
            .await
            .map_err(|e| AppError::new("io", e.to_string()))??;
    Ok(saved.to_string_lossy().into_owned())
}

/// Quits the app; the frontend calls it once unsaved Drafts are settled.
#[tauri::command]
pub fn app_quit(app: tauri::AppHandle) {
    app.exit(0)
}
