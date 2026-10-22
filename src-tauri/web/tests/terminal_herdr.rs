//! Live verification against a real, isolated `herdr` and the real server.
//!
//! These tests are opt-in (`#[ignore]`) because they need a `herdr` binary and they spawn a
//! real herdr server per fixture. Run them with:
//!
//! ```sh
//! cargo test --manifest-path src-tauri/Cargo.toml -p herdly-web \
//!   --test terminal_herdr -- --ignored --test-threads=1
//! ```
//!
//! Isolation: every fixture creates its own temporary `HOME`, `XDG_CONFIG_HOME` and
//! `XDG_STATE_HOME`, so the herdr binary finds no Session of the user's and starts a server
//! of its own for a Session name unique to this test. The process-wide environment is set to
//! those directories for the duration of the test binary, and every child is spawned with an
//! explicit environment, never the inherited one. A fixture's `Drop` kills only the server it
//! started (process group), stops and deletes only its own Session, and removes its own
//! directories; the user's Session, server and service are never named or signalled.
//!
//! The binary is `HERDR_TEST_BIN` when set, otherwise `herdr` from `PATH`.
#![cfg(unix)]

use futures_util::{SinkExt, StreamExt};
use herdly_web::app::router;
use herdly_web::cli::build_serve;
use herdly_web::cli::ServeArgs;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The environment every fixture, child and herdr server shares.
struct Shared {
    root: PathBuf,
    env: HashMap<String, String>,
    herdr: PathBuf,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

/// The herdr binary under test: `HERDR_TEST_BIN`, else `herdr` on `PATH`.
fn herdr_bin() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HERDR_TEST_BIN").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join("herdr"))
        .find(|c| c.is_file())
}

/// Creates the one temporary root this test binary works in and points the process at it.
///
/// `herdr` resolves its configuration and Session sockets from these variables; pointing them
/// at a fresh directory is what keeps the user's own server and Sessions out of reach.
fn shared() -> &'static Shared {
    SHARED.get_or_init(|| {
        let herdr = match herdr_bin() {
            Some(p) => p,
            None => {
                eprintln!("SKIP: no herdr binary (set HERDR_TEST_BIN or put herdr on PATH)");
                std::process::exit(0);
            }
        };
        let root = std::env::temp_dir().join(format!("herdr-web-task8-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["config", "state", "home/.local/bin", "tmp"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        // The probe looks for herdr on PATH first and in ~/.local/bin last; provide both.
        let _ = std::os::unix::fs::symlink(&herdr, root.join("home/.local/bin/herdr"));
        let mut env = HashMap::new();
        for (k, v) in [
            ("HOME", root.join("home")),
            ("XDG_CONFIG_HOME", root.join("config")),
            ("XDG_STATE_HOME", root.join("state")),
            ("TMPDIR", root.join("tmp")),
            ("TERM", PathBuf::from("xterm-256color")),
            ("LANG", PathBuf::from("C.UTF-8")),
        ] {
            env.insert(k.into(), v.to_string_lossy().into_owned());
        }
        // A PATH with herdr and nothing of the interactive shell's environment: the herdr
        // server a probe starts must be found again, and no HERDR_* variable may point a child
        // at the user's running server.
        env.insert(
            "PATH".into(),
            format!("{}:/usr/bin:/bin", root.join("home/.local/bin").display()),
        );
        for (k, v) in &env {
            std::env::set_var(k, v);
        }
        for (k, _) in std::env::vars() {
            if k.starts_with("HERDR_") {
                std::env::remove_var(k);
            }
        }
        Shared { root, env, herdr }
    })
}

/// Removes this binary's temporary root when the test binary exits, including on failure.
extern "C" fn remove_root() {
    if let Some(shared) = SHARED.get() {
        let _ = std::fs::remove_dir_all(&shared.root);
    }
}

fn install_cleanup_hook() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        // SAFETY: `remove_root` reads only a `OnceLock` and removes a path; it runs at exit.
        unsafe { libc::atexit(remove_root) };
    });
}

/// A `Command` for `herdr` with the fixture environment and no inherited `HERDR_*` variables.
fn herdr(shared: &Shared, args: &[&str]) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(&shared.herdr);
    c.args(args).env_clear().envs(&shared.env);
    c
}

/// Runs `herdr …` to completion inside a deadline and returns its stdout.
async fn herdr_out(shared: &Shared, args: &[&str]) -> String {
    let out = tokio::time::timeout(Duration::from_secs(60), herdr(shared, args).output())
        .await
        .unwrap_or_else(|_| panic!("herdr {args:?} within 60 s"))
        .unwrap_or_else(|e| panic!("herdr {args:?}: {e}"));
    assert!(
        out.status.success(),
        "herdr {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Polls `cond` for up to `secs`; a failed poll is a failure, never a hang.
async fn wait_for(what: &str, secs: u64, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Polls an async condition; same deadline rule.
async fn wait_for_async<F, Fut>(what: &str, secs: u64, mut cond: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if cond().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Every process whose command line is `herdr … terminal attach <terminal_id>` for `session`.
///
/// Scoped by both the unique Session name and the Terminal id, so it can only ever match the
/// attach children of the fixture that asked.
fn attach_children(session: &str, terminal_id: &str) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().parse::<u32>().ok())
        .filter(|pid| {
            let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
                return false;
            };
            let args: Vec<String> = raw
                .split(|b| *b == 0)
                .filter(|a| !a.is_empty())
                .map(|a| String::from_utf8_lossy(a).into_owned())
                .collect();
            let session_arg = args
                .windows(2)
                .any(|w| w[0] == "--session" && w[1] == session);
            let attach = args
                .windows(2)
                .any(|w| w[0] == "attach" && w[1] == terminal_id);
            session_arg && attach
        })
        .collect()
}

/// Strips terminal control sequences from what the terminal received, so a text marker can be
/// matched across the cursor-positioning sequences the PTY's redraw interleaves with it.
///
/// This is a display-side normalisation only: the bytes asserted on are the ones the real
/// attach child sent over the real socket.
fn plain(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        // CSI: ESC [ … final byte in @A-Z[\]^_`a-z{|}~
        if bytes.get(i + 1) == Some(&b'[') {
            let mut j = i + 2;
            while j < bytes.len() && !(0x40..=0x7e).contains(&bytes[j]) {
                j += 1;
            }
            i = (j + 1).min(bytes.len());
            continue;
        }
        // OSC: ESC ] … BEL or ESC \
        if bytes.get(i + 1) == Some(&b']') {
            let mut j = i + 2;
            while j < bytes.len() {
                if bytes[j] == 0x07 {
                    j += 1;
                    break;
                }
                if bytes[j] == 0x1b && bytes.get(j + 1) == Some(&b'\\') {
                    j += 2;
                    break;
                }
                j += 1;
            }
            i = j.min(bytes.len());
            continue;
        }
        // Two-byte escapes (charset designators, keypad modes, …).
        i += 2;
    }
    String::from_utf8_lossy(&out).replace("\r\n", "\n")
}

/// A real herdr Session in its own temporary herdr directories, and its own shell Pane.
struct Fixture {
    shared: &'static Shared,
    dir: tempfile::TempDir,
    session: String,
    /// A token only this fixture's Pane knows, so its fatal output cannot be guessed.
    token: String,
    pane_id: String,
    terminal_id: String,
    server: std::process::Child,
    next_marker: u32,
}

impl Fixture {
    /// Starts a headless herdr server for a new Session and runs the marker script in a Pane.
    async fn start(tag: &str) -> Fixture {
        let shared = shared();
        install_cleanup_hook();
        let dir = tempfile::Builder::new()
            .prefix("herdr-fixture-")
            .tempdir_in(&shared.root)
            .unwrap();
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let session = format!("herdly-web-t8-{}-{}-{}", std::process::id(), n, tag);
        let token = format!("T8FATAL{}{n}", std::process::id());

        let log = std::fs::File::create(dir.path().join("herdr-server.log")).unwrap();
        let mut server = std::process::Command::new(&shared.herdr);
        server
            .args(["--session", &session, "server"])
            .env_clear()
            .envs(&shared.env)
            .stdin(Stdio::null())
            .stdout(log.try_clone().unwrap())
            .stderr(log);
        // Its own process group: the fixture's cleanup can end the server and everything it
        // started without ever reaching another process.
        unsafe {
            use std::os::unix::process::CommandExt;
            server.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let server = server.spawn().expect("the herdr server starts");

        let mut fixture = Fixture {
            shared,
            dir,
            session,
            token,
            pane_id: String::new(),
            terminal_id: String::new(),
            server,
            next_marker: 0,
        };
        // The Session is running once its socket answers `api snapshot`.
        wait_for_async("the fixture Session to run", 60, || async {
            let out = herdr(
                fixture.shared,
                &["--session", &fixture.session, "api", "snapshot"],
            )
            .output()
            .await;
            out.is_ok_and(|o| o.status.success())
        })
        .await;

        let cwd = fixture.dir.path().join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let script = fixture.dir.path().join("pane.sh");
        // A line handler: `size` reports the real PTY grid, the fatal trigger makes the Pane exit
        // with a known code, and anything else is echoed back with a `GOT` prefix. The trigger is
        // only reachable from inside the attach, never from the CLI the bootstrap uses.
        std::fs::write(
            &script,
            "while IFS= read -r line; do\n  case \"$line\" in\n    size) set -- $(stty size); printf 'SIZE:%s:%s\\n' \"$1\" \"$2\" ;;\n    panic-now) printf 'FATAL:%s\\n' \"$T8_TOKEN\"; exit 9 ;;\n    *) printf 'GOT:%s\\n' \"$line\" ;;\n  esac\ndone\n",
        )
        .unwrap();
        let created = herdr_out(
            fixture.shared,
            &[
                "--session",
                &fixture.session,
                "workspace",
                "create",
                "--cwd",
                &cwd.display().to_string(),
                "--env",
                "SHELL=/bin/sh",
                "--env",
                "PS1=$ ",
                "--env",
                &format!("T8_TOKEN={}", fixture.token),
                "--no-focus",
            ],
        )
        .await;
        let created: Value = serde_json::from_str(&created).unwrap();
        fixture.pane_id = created["result"]["root_pane"]["pane_id"]
            .as_str()
            .unwrap()
            .to_string();
        fixture.terminal_id = created["result"]["root_pane"]["terminal_id"]
            .as_str()
            .unwrap()
            .to_string();

        // Replace the Pane's shell with the marker script, then prove it reads input before any
        // socket attaches: `pane run` types into the Pane, and only the script answers "GOT".
        fixture
            .run_pane(format!("exec sh '{}'", script.display()))
            .await;
        fixture.run_pane("BOOT".to_string()).await;
        wait_for_async("the marker script to answer", 60, || async {
            fixture.read_pane().await.contains("GOT:BOOT")
        })
        .await;
        fixture
    }

    /// Types `command` into the fixture Pane through the real herdr CLI.
    async fn run_pane(&self, command: String) {
        herdr_out(
            self.shared,
            &[
                "--session",
                &self.session,
                "pane",
                "run",
                &self.pane_id,
                &command,
            ],
        )
        .await;
    }

    /// The Pane's recent output, as herdr renders it.
    async fn read_pane(&self) -> String {
        let out = herdr(
            self.shared,
            &[
                "--session",
                &self.session,
                "pane",
                "read",
                &self.pane_id,
                "--source",
                "recent-unwrapped",
                "--lines",
                "40",
            ],
        )
        .output()
        .await
        .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A marker unique to this fixture and attempt, so stale output cannot satisfy an assertion.
    fn marker(&mut self, label: &str) -> String {
        self.next_marker += 1;
        format!(
            "MARK_{}_{}_{}",
            label.to_uppercase().replace(['-', ' '], "_"),
            std::process::id(),
            self.next_marker
        )
    }

    /// A web server over the *real* backend, paired to a fresh device.
    async fn web(&self) -> Web {
        let static_dir = self.dir.path().join("dist");
        std::fs::create_dir_all(&static_dir).unwrap();
        std::fs::write(
            static_dir.join("index.html"),
            "<!doctype html><title>Herdly</title>",
        )
        .unwrap();
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = probe.local_addr().unwrap();
        drop(probe);
        let args = ServeArgs {
            bind: addr.to_string(),
            origin: Some(format!("http://{addr}")),
            static_dir: Some(static_dir),
            state: Some(self.dir.path().join("web-state")),
        };
        let (listener, st) = build_serve(&args).await.expect("the real server serves");
        let origin = format!("http://{addr}");
        let cookie = herdly_web::testing::paired_cookie(&st);
        let app = router(st.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        // The backend resolves Panes from its own Machine views: wait until the fixture Session
        // and its Pane are what the server sees, not a stale empty view.
        let panes = (self.pane_id.clone(), self.terminal_id.clone());
        wait_for_async("the server to see the fixture Pane", 60, || async {
            let views = st.backend.views();
            views.iter().any(|m| {
                m.id == "local"
                    && m.sessions.iter().any(|s| {
                        s.name == self.session
                            && s.workspaces.iter().any(|w| {
                                w.tabs.iter().any(|t| {
                                    t.panes
                                        .iter()
                                        .any(|p| p.pane_id == panes.0 && p.terminal_id == panes.1)
                                })
                            })
                    })
            })
        })
        .await;
        Web {
            st,
            url: format!("ws://{addr}/ws/terminal"),
            origin,
            cookie,
        }
    }

    fn attach_children(&self) -> Vec<u32> {
        attach_children(&self.session, &self.terminal_id)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Only this fixture's own process group: SIGKILL after a short grace, then reap.
        let pid = self.server.id() as i32;
        // SAFETY: `pid` is this fixture's own server child, started as its own group leader.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        let _ = self.server.wait();
        // `session stop` then `delete` clean up the Session directory this fixture created.
        for args in [
            vec!["--session", &self.session, "session", "stop"],
            vec!["--session", &self.session, "session", "delete"],
        ] {
            let mut c = std::process::Command::new(&self.shared.herdr);
            c.args(&args)
                .env_clear()
                .envs(&self.shared.env)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if let Ok(mut child) = c.spawn() {
                let _ = child.wait();
            }
        }
    }
}

/// A live web server over the real herdr, with its own paired device.
struct Web {
    st: std::sync::Arc<herdly_web::app::AppState>,
    url: String,
    origin: String,
    cookie: String,
}

impl Web {
    async fn connect(&self) -> Ws {
        let mut req = self.url.clone().into_client_request().unwrap();
        req.headers_mut()
            .insert("origin", self.origin.parse().unwrap());
        req.headers_mut().insert(
            "cookie",
            format!("herdly_web={}", self.cookie).parse().unwrap(),
        );
        tokio_tungstenite::connect_async(req).await.unwrap().0
    }
}

fn open_frame(session: &str, pane: &str, cols: u16, rows: u16, takeover: bool) -> Message {
    Message::Text(
        json!({"type":"open","pane":{"session":session,"pane_id":pane},"cols":cols,"rows":rows,"takeover":takeover})
            .to_string()
            .into(),
    )
}

async fn next_msg<S>(ws: &mut S) -> Message
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(30), ws.next())
            .await
            .expect("a frame within 30 s")
            .expect("the stream stays open")
            .expect("a valid frame")
        {
            Message::Ping(_) | Message::Pong(_) => continue,
            other => return other,
        }
    }
}

/// The next text event, as parsed JSON.
async fn next_event<S>(ws: &mut S) -> Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match next_msg(ws).await {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Binary(_) => continue,
            other => panic!("expected a text event, got {other:?}"),
        }
    }
}

async fn next_event_of<S>(ws: &mut S, kind: &str) -> Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    for _ in 0..40 {
        let e = next_event(ws).await;
        if e["type"] == kind {
            return e;
        }
    }
    panic!("no {kind} event arrived");
}

/// Reads output until its plain text satisfies `done`, acknowledging every frame it consumes so
/// flow control stays honest, and returns the accumulated plain text.
async fn read_until<S>(ws: &mut S, what: &str, mut done: impl FnMut(&str) -> bool) -> String
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message>
        + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::fmt::Debug,
{
    let mut bytes = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;
        match msg {
            Ok(Some(Ok(Message::Binary(data)))) => {
                let n = data.len();
                bytes.extend_from_slice(&data);
                ws.send(Message::Text(
                    json!({"type":"ack","bytes":n}).to_string().into(),
                ))
                .await
                .unwrap();
                let text = plain(&bytes);
                if done(&text) {
                    return text;
                }
            }
            Ok(Some(Ok(Message::Text(_)))) => {
                let text = plain(&bytes);
                if done(&text) {
                    return text;
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(other) => panic!("the stream ended while waiting for {what}: {other:?}"),
            Err(_) => break,
        }
    }
    panic!("timed out waiting for {what} in {:?}", plain(&bytes));
}

/// Reads until the server ends the connection, inside 30 s.
async fn ended<S>(ws: &mut S)
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(30), ws.next()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => return,
            Ok(Some(Ok(_))) => continue,
            Err(_) => panic!("the connection must end within 30 s"),
        }
    }
}

/// Sends `input` and waits for the Pane script's `GOT <input>` line.
async fn expect_echo(ws: &mut Ws, input: &str) {
    ws.send(Message::Binary(format!("{input}\r").into_bytes().into()))
        .await
        .unwrap();
    let wanted = format!("GOT:{input}");
    read_until(ws, &wanted, |text| text.contains(&wanted)).await;
}

// ---------------------------------------------------------------- Step 1: the live regression

/// The tracer: a real attach on a real herdr delivers a marker this test just chose, and the
/// same fixture rejects a Pane id that does not exist. The wrong-id case is what stops the
/// success from being "matched some old output".
#[tokio::test]
#[ignore]
async fn a_live_attach_delivers_a_fresh_marker_and_a_wrong_pane_is_an_error() {
    let mut fx = Fixture::start("tracer").await;
    let web = fx.web().await;
    let mut ws = web.connect().await;
    ws.send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
        .await
        .unwrap();
    let attached = next_event_of(&mut ws, "attached").await;
    assert_eq!(attached["type"], "attached");

    let marker = fx.marker("one");
    expect_echo(&mut ws, &marker).await;
    // The attach child is the real herdr CLI attaching this Terminal, and nothing else is.
    assert_eq!(fx.attach_children().len(), 1, "one real attach child");
    ws.send(Message::Close(None)).await.unwrap();
    ended(&mut ws).await;
    // The close ends this attempt's own attach child; the Pane process itself is untouched.
    wait_for("the attach child to exit", 30, || {
        fx.attach_children().is_empty()
    })
    .await;

    // Same Session, a Pane that does not exist: an application error, not an attach.
    let mut bad = web.connect().await;
    bad.send(open_frame(&fx.session, "p9999", 80, 24, false))
        .await
        .unwrap();
    let e = next_event(&mut bad).await;
    assert_eq!(e["type"], "error", "{e}");
    assert_eq!(e["error"]["code"], "not_found", "{e}");
    ended(&mut bad).await;
    assert!(
        fx.attach_children().is_empty(),
        "no child for a rejected Pane"
    );
    let _ = &web.st;
}

// ------------------------------------- Step 2: real exclusivity, takeover, ownership and sizing

/// A second normal attach is refused by herdr itself and reported as `held`; an explicit
/// takeover then wins the Terminal, and the first client's attempt ends.
#[tokio::test]
#[ignore]
async fn a_second_normal_attach_is_held_and_an_explicit_takeover_wins() {
    let fx = Fixture::start("takeover").await;
    let web = fx.web().await;

    let mut first = web.connect().await;
    first
        .send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
        .await
        .unwrap();
    assert_eq!(
        next_event_of(&mut first, "attached").await["type"],
        "attached"
    );
    wait_for("the first attach child", 30, || {
        fx.attach_children().len() == 1
    })
    .await;

    let mut second = web.connect().await;
    second
        .send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
        .await
        .unwrap();
    assert_eq!(
        next_event_of(&mut second, "held").await["type"],
        "held",
        "herdr refuses a second normal attach"
    );
    ended(&mut second).await;

    let mut taking = web.connect().await;
    taking
        .send(open_frame(&fx.session, &fx.pane_id, 80, 24, true))
        .await
        .unwrap();
    assert_eq!(
        next_event_of(&mut taking, "attached").await["type"],
        "attached"
    );
    // The displaced attach ends: herdr reports it, the socket closes it.
    ended(&mut first).await;
    assert_eq!(
        fx.attach_children().len(),
        1,
        "only the takeover child remains"
    );
    taking.send(Message::Close(None)).await.unwrap();
    ended(&mut taking).await;
    wait_for("the takeover child to exit", 30, || {
        fx.attach_children().is_empty()
    })
    .await;
}

/// The Pane's own process survives the web socket: a second normal attach after the first socket
/// closed finds the Pane still running and still answering.
#[tokio::test]
#[ignore]
async fn closing_the_web_socket_leaves_the_pane_process_alive() {
    let mut fx = Fixture::start("survive").await;
    let web = fx.web().await;

    let mut first = web.connect().await;
    first
        .send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
        .await
        .unwrap();
    assert_eq!(
        next_event_of(&mut first, "attached").await["type"],
        "attached"
    );
    let before = fx.marker("before");
    expect_echo(&mut first, &before).await;
    // Release the Terminal so the Pane is free again; the Pane process must still be there.
    first.send(Message::Close(None)).await.unwrap();
    ended(&mut first).await;
    wait_for("the first attach child to exit", 30, || {
        fx.attach_children().is_empty()
    })
    .await;

    let mut second = web.connect().await;
    second
        .send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
        .await
        .unwrap();
    assert_eq!(
        next_event_of(&mut second, "attached").await["type"],
        "attached"
    );
    let after = fx.marker("after");
    expect_echo(&mut second, &after).await;
    second.send(Message::Close(None)).await.unwrap();
    ended(&mut second).await;
}

/// A resize over the socket changes the real PTY grid, as the Pane's own `stty size` reports it.
#[tokio::test]
#[ignore]
async fn a_resize_changes_the_real_terminal_dimensions() {
    let fx = Fixture::start("resize").await;
    let web = fx.web().await;
    let mut ws = web.connect().await;
    ws.send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
        .await
        .unwrap();
    assert_eq!(next_event_of(&mut ws, "attached").await["type"], "attached");

    // The initial grid is the one the open frame asked for.
    ws.send(Message::Binary(b"size\r".to_vec().into()))
        .await
        .unwrap();
    read_until(&mut ws, "SIZE:24:80", |t| t.contains("SIZE:24:80")).await;

    ws.send(Message::Text(
        json!({"type":"resize","cols":100,"rows":40})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    // The resize frame and the input frame travel on separate workers, and the Pane's own
    // `stty size` is the only authority on which grid it really has: ask again until the PTY
    // reports the new one, rather than assuming one ordering.
    let mut seen = String::new();
    for _ in 0..20 {
        ws.send(Message::Binary(b"size\r".to_vec().into()))
            .await
            .unwrap();
        seen = read_until(&mut ws, "a size report", |t| t.contains("SIZE:")).await;
        if seen.contains("SIZE:40:100") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(
        seen.contains("SIZE:40:100"),
        "the real PTY must take the new grid: {:?}",
        seen.lines().rev().take(4).collect::<Vec<_>>()
    );
    ws.send(Message::Close(None)).await.unwrap();
    ended(&mut ws).await;
}

/// A Pane that exits sends `exited` with the Pane's real exit code, and its attach child goes
/// with it. The Pane's last output still reaches the browser before the socket ends.
#[tokio::test]
#[ignore]
async fn a_pane_that_exits_reports_its_code_and_still_delivers_its_last_output() {
    let fx = Fixture::start("exit").await;
    let web = fx.web().await;
    let mut ws = web.connect().await;
    ws.send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
        .await
        .unwrap();
    assert_eq!(next_event_of(&mut ws, "attached").await["type"], "attached");

    ws.send(Message::Binary(b"panic-now\r".to_vec().into()))
        .await
        .unwrap();
    let mut bytes = Vec::new();
    let mut exited = None;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && exited.is_none() {
        match tokio::time::timeout(Duration::from_secs(10), ws.next()).await {
            Ok(Some(Ok(Message::Binary(data)))) => {
                let n = data.len();
                bytes.extend_from_slice(&data);
                ws.send(Message::Text(
                    json!({"type":"ack","bytes":n}).to_string().into(),
                ))
                .await
                .unwrap();
            }
            Ok(Some(Ok(Message::Text(text)))) => {
                let e: Value = serde_json::from_str(&text).unwrap();
                if e["type"] == "exited" {
                    exited = Some(e);
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(other) => panic!("the socket ended before the exit event: {other:?}"),
            Err(_) => panic!("no exit event within 60 s"),
        }
    }
    let exited = exited.expect("the attempt reports the Pane's exit");
    assert_eq!(exited["type"], "exited", "{exited}");
    // The code is the attach CLI's own exit status, which is what core reports (it waits on the
    // attach child, not on the Pane). Measured against herdr 0.9.5: the CLI exits 1 whatever the
    // Pane's process returns, so the browser must be told that, never a fabricated Pane code.
    assert!(exited["code"].is_number(), "a code is reported: {exited}");
    eprintln!(
        "NOTE: herdr 0.9.5 attach exit status for a Pane exit: {}",
        exited["code"]
    );
    // The Pane's fatal line was delivered, not swallowed by the exit.
    let text = plain(&bytes);
    assert!(text.contains(&format!("FATAL:{}", fx.token)), "{text:?}");
    ended(&mut ws).await;
    wait_for("the attach child to exit", 30, || {
        fx.attach_children().is_empty()
    })
    .await;
}

/// Runs the fixture's web server as a real `herdly-web serve` child process.
///
/// The guard kills its own child on every exit path, including a panic or a timeout before the
/// `SIGTERM` case reaches its assertions, so a failed run can never leave a server behind.
struct Served {
    child: std::process::Child,
    addr: String,
    origin: String,
    cookie: String,
    log: PathBuf,
}

impl Drop for Served {
    fn drop(&mut self) {
        // Only this fixture's own child, and only if it is still there.
        if self.child.try_wait().ok().flatten().is_none() {
            // SAFETY: `pid` is this test's own freshly spawned child.
            unsafe {
                libc::kill(self.child.id() as i32, libc::SIGKILL);
            }
            let _ = self.child.wait();
        }
    }
}

impl Served {
    /// Starts `herdly-web serve` on a free loopback port over the fixture's temporary state,
    /// and pairs this fixture's device through the real `pair` command and `/pair` route.
    async fn start(fx: &Fixture) -> Served {
        let shared = fx.shared;
        let state = fx.dir.path().join("served-state");
        let static_dir = fx.dir.path().join("served-dist");
        std::fs::create_dir_all(&static_dir).unwrap();
        std::fs::write(
            static_dir.join("index.html"),
            "<!doctype html><title>Herdly</title>",
        )
        .unwrap();
        // A free port, taken and released so `serve` can have it.
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = probe.local_addr().unwrap().to_string();
        drop(probe);
        let log = fx.dir.path().join("served.log");
        let out = std::fs::File::create(&log).unwrap();
        let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_herdly-web"));
        child
            .args([
                "serve",
                "--bind",
                &addr,
                "--origin",
                &format!("http://{addr}"),
                "--static",
                &static_dir.display().to_string(),
                "--state",
                &state.display().to_string(),
            ])
            .env_clear()
            .envs(&shared.env)
            .env("RUST_LOG", "info")
            .stdin(Stdio::null())
            .stdout(out.try_clone().unwrap())
            .stderr(out);
        let child = child.spawn().expect("the real server starts");
        let origin = format!("http://{addr}");
        wait_for_async("the served process to listen", 60, || {
            let addr = format!("{addr}/api/me");
            async move {
                tokio::net::TcpStream::connect(&addr.replace("/api/me", ""))
                    .await
                    .is_ok()
            }
        })
        .await;
        // Pair this fixture's device with the real CLI and the real /pair route.
        let pairing = herdr_out_bytes(
            &shared.env,
            env!("CARGO_BIN_EXE_herdly-web"),
            &[
                "pair",
                "--bind",
                &addr,
                "--origin",
                &origin,
                "--state",
                &state.display().to_string(),
            ],
        )
        .await;
        let url = String::from_utf8_lossy(&pairing)
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        let token = url.split("t=").nth(1).expect("a pairing link").to_string();
        let cookie = cookie_of(&http_get(&format!("{origin}/pair?t={token}"), None).await)
            .expect("the pairing route hands out a cookie");
        // The served process connects to its own Machine asynchronously: wait until the real
        // `/api/machines` route shows the fixture Pane, so the first open cannot race it.
        let wanted = format!("\"pane_id\":\"{}\"", fx.pane_id);
        let mut ready = false;
        for _ in 0..240 {
            let body = http_get(&format!("{origin}/api/machines"), Some(&cookie)).await;
            if body.contains(&wanted) {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        assert!(
            ready,
            "the served process never listed the fixture Pane; log: {}",
            std::fs::read_to_string(&log).unwrap_or_default()
        );
        Served {
            child,
            addr,
            origin,
            cookie,
            log,
        }
    }

    async fn connect(&self) -> Ws {
        let mut req = format!("ws://{}/ws/terminal", self.addr)
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("origin", self.origin.parse().unwrap());
        req.headers_mut().insert(
            "cookie",
            format!("herdly_web={}", self.cookie).parse().unwrap(),
        );
        tokio_tungstenite::connect_async(req).await.unwrap().0
    }

    /// Sends SIGTERM to this fixture's own served child, as a service manager would.
    fn sigterm(&self) -> i32 {
        let pid = self.child.id() as i32;
        // SAFETY: `pid` is this test's own freshly spawned child.
        unsafe { libc::kill(pid, libc::SIGTERM) }
    }
}

/// Runs a binary to completion with the fixture environment and returns its stdout.
async fn herdr_out_bytes(env: &HashMap<String, String>, program: &str, args: &[&str]) -> Vec<u8> {
    let out = tokio::process::Command::new(program)
        .args(args)
        .env_clear()
        .envs(env)
        .output()
        .await
        .unwrap();
    assert!(
        out.status.success(),
        "{program} {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

/// A minimal HTTP GET: the response head and body, as one string.
async fn http_get(url: &str, cookie: Option<&str>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rest = url.strip_prefix("http://").expect("an http url");
    let (host, path) = rest.split_once('/').unwrap();
    let mut stream = tokio::net::TcpStream::connect(host).await.expect("connect");
    let auth = match cookie {
        Some(c) => format!("Cookie: herdly_web={c}\r\n"),
        None => String::new(),
    };
    stream
        .write_all(
            format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\n{auth}Connection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut res = Vec::new();
    stream.read_to_end(&mut res).await.unwrap();
    String::from_utf8_lossy(&res).into_owned()
}

/// The `herdly_web` cookie a pairing GET set.
fn cookie_of(res: &str) -> Option<String> {
    let line = res
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))?;
    let value = line.split_once(':')?.1.trim().split(';').next()?;
    value
        .trim()
        .strip_prefix("herdly_web=")
        .map(|v| v.to_string())
}

/// A real SIGTERM to a serving process, with an Attach live at that moment: the process must
/// close its own attach child and exit cleanly. Task 4 proved the signal reaches the shutdown
/// branch and that shutdown closes a registered attempt, but never both through a real process.
#[tokio::test]
#[ignore]
async fn a_real_sigterm_with_a_live_attach_closes_the_child_and_exits_cleanly() {
    let mut fx = Fixture::start("sigterm").await;
    let mut served = Served::start(&fx).await;
    let mut ws = served.connect().await;
    ws.send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
        .await
        .unwrap();
    assert_eq!(next_event_of(&mut ws, "attached").await["type"], "attached");
    // The attach really is live: it answers a marker chosen right now.
    let marker = fx.marker("live");
    expect_echo(&mut ws, &marker).await;
    wait_for("the live attach child", 30, || {
        fx.attach_children().len() == 1
    })
    .await;

    assert_eq!(served.sigterm(), 0, "SIGTERM reached the served process");

    // The attach child the server owned must be gone, and the process must exit successfully.
    let status = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let exited = served
                .child
                .try_wait()
                .unwrap_or_else(|e| panic!("wait on the served child: {e}"));
            if let Some(status) = exited {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("a signalled server exits rather than hanging");
    let log = std::fs::read_to_string(&served.log).unwrap_or_default();
    assert!(
        status.success(),
        "the real serve path exits cleanly on SIGTERM: {status:?}; log: {log}"
    );
    // The graceful branch really ran: it is the line `serve_until_signalled` logs before it
    // closes live attempts, so this is not the default signal disposition exiting cleanly.
    assert!(
        log.contains("shutting down: closing live terminal attempts"),
        "the SIGTERM branch ran, not the default handler: {log}"
    );
    wait_for("the attach child to be gone", 30, || {
        fx.attach_children().is_empty()
    })
    .await;
    // The attempt ended through the app, not through the socket dying with the process: a
    // graceful shutdown closes every live attempt, so the browser receives a normal 1000 close.
    // If the process simply exited, the connection would be reset (1006) instead.
    let mut close = None;
    for _ in 0..40 {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Close(Some(frame))))) => {
                close = Some(u16::from(frame.code));
                break;
            }
            Ok(Some(Ok(_))) => continue,
            Ok(None) | Ok(Some(Err(_))) => break,
            Err(_) => break,
        }
    }
    assert_eq!(
        close,
        Some(1000),
        "a graceful shutdown closes the live attempt normally, not by the process dying"
    );
    let after = fx.marker("alive");
    fx.run_pane(after.clone()).await;
    let wanted = format!("GOT:{after}");
    let mut answered = false;
    for _ in 0..120 {
        if fx.read_pane().await.contains(&wanted) {
            answered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(
        answered,
        "the Pane process must survive the server: {wanted}"
    );
}

/// A socket that goes away while its attach is still settling leaves no attach child behind and
/// no registration: the cancellation path really ends the child it started.
#[tokio::test]
#[ignore]
async fn a_cancelled_pending_open_leaves_no_attach_child_or_registration() {
    let fx = Fixture::start("cancel").await;
    let web = fx.web().await;
    {
        let mut ws = web.connect().await;
        ws.send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
            .await
            .unwrap();
        // Gone before `attached`: this attempt may never hand a Terminal to anyone.
        ws.send(Message::Close(None)).await.unwrap();
        ended(&mut ws).await;
    }
    wait_for("the registration to clear", 30, || {
        web.st.terminals.is_empty()
    })
    .await;
    wait_for("no attach child to survive", 30, || {
        fx.attach_children().is_empty()
    })
    .await;
    // The Terminal is free again: a normal attach works straight away.
    let mut ws = web.connect().await;
    ws.send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
        .await
        .unwrap();
    assert_eq!(next_event_of(&mut ws, "attached").await["type"], "attached");
    ws.send(Message::Close(None)).await.unwrap();
    ended(&mut ws).await;
}

/// The first client's cleanup runs after a second client already owns the Terminal, and it must
/// not end the replacement: only its own attach child goes.
#[tokio::test]
#[ignore]
async fn a_delayed_cleanup_of_the_first_attempt_cannot_kill_the_replacement() {
    let mut fx = Fixture::start("generation").await;
    let web = fx.web().await;

    let mut first = web.connect().await;
    first
        .send(open_frame(&fx.session, &fx.pane_id, 80, 24, false))
        .await
        .unwrap();
    assert_eq!(
        next_event_of(&mut first, "attached").await["type"],
        "attached"
    );
    fc_marker(&mut fx, &mut first, "first").await;

    // Explicit takeover while the first socket is still open: herdr ends the first attach and
    // the replacement owns the Terminal.
    let mut second = web.connect().await;
    second
        .send(open_frame(&fx.session, &fx.pane_id, 80, 24, true))
        .await
        .unwrap();
    assert_eq!(
        next_event_of(&mut second, "attached").await["type"],
        "attached"
    );
    ended(&mut first).await;
    // The first attempt's cleanup has to be finished for its registration to be gone, which is
    // what makes this "delayed cleanup after the replacement exists".
    wait_for("the first registration to clear", 30, || {
        web.st.terminals.len() == 1
    })
    .await;
    assert_eq!(
        fx.attach_children().len(),
        1,
        "only the replacement remains"
    );

    let after = fx.marker("replacement");
    let wanted = format!("GOT:{after}");
    second
        .send(Message::Binary(format!("{after}\r").into_bytes().into()))
        .await
        .unwrap();
    read_until(&mut second, &wanted, |t| t.contains(&wanted)).await;
    second.send(Message::Close(None)).await.unwrap();
    ended(&mut second).await;
}

/// Sends a fresh marker through `ws` and waits for the Pane script's answer.
async fn fc_marker(fx: &mut Fixture, ws: &mut Ws, label: &str) {
    let marker = fx.marker(label);
    let wanted = format!("GOT:{marker}");
    ws.send(Message::Binary(format!("{marker}\r").into_bytes().into()))
        .await
        .unwrap();
    read_until(ws, &wanted, |t| t.contains(&wanted)).await;
}
