//! Owned Terminal handles and the authoritative local Pane -> Terminal mapping.
use crate::backend::WebPane;
use async_trait::async_trait;
use herdly_core::attach::{attach_argv, AttachKey, AttachManager, Sink};
use herdly_core::error::{AppError, AppResult};
use herdly_core::machines::LOCAL;
use herdly_core::transport::{MachineInfo, Transport};
use herdly_core::view::{MachineState, MachineView};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// A Terminal's character grid, as the browser reports it.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

/// One Terminal Attach, owned by one web Terminal socket.
///
/// `open` must run at most once per handle: a handle is one attempt, so a retry or a Take
/// over allocates a new one rather than reopening this. `close` is idempotent.
#[async_trait]
pub trait TerminalHandle: Send + Sync {
    async fn open(&self, size: TerminalSize, sink: Arc<dyn Sink>) -> AppResult<()>;
    async fn write(&self, data: Vec<u8>) -> AppResult<()>;
    async fn resize(&self, size: TerminalSize) -> AppResult<()>;
    fn ack(&self, bytes: usize);
    async fn close(&self);
}

/// A `TerminalHandle` over a dedicated `AttachManager` and exactly one `AttachKey`.
///
/// The dedicated manager is the ownership policy: two handles for the same Terminal never
/// share an entry, so a later handle's open cannot replace an earlier one's sink, and closing
/// one attempt cannot touch another's Attach. Exclusivity across handles and desktop
/// processes stays herdr's job.
pub struct OwnedTerminal {
    mgr: Arc<AttachManager>,
    key: AttachKey,
    argv: Vec<String>,
    /// Set by the first `open`, which is the only one this attempt gets.
    opened: AtomicBool,
}

impl OwnedTerminal {
    /// No PTY work happens here: nothing is spawned until `open`.
    pub fn new(key: AttachKey, argv: Vec<String>) -> Arc<OwnedTerminal> {
        // Web sockets close explicitly; core's idle release is a desktop policy.
        Arc::new(OwnedTerminal {
            mgr: AttachManager::new(Duration::ZERO),
            key,
            argv,
            opened: AtomicBool::new(false),
        })
    }
}

#[async_trait]
impl TerminalHandle for OwnedTerminal {
    async fn open(&self, size: TerminalSize, sink: Arc<dyn Sink>) -> AppResult<()> {
        // A handle is one attempt: a retry or a Take over allocates another one.
        if self.opened.swap(true, Ordering::SeqCst) {
            return Err(AppError::new(
                "conflict",
                "this terminal attempt is already open",
            ));
        }
        self.mgr
            .open_async(
                self.key.clone(),
                self.argv.clone(),
                size.cols,
                size.rows,
                sink,
            )
            .await
    }

    async fn write(&self, data: Vec<u8>) -> AppResult<()> {
        self.mgr.write_async(self.key.clone(), data).await
    }

    async fn resize(&self, size: TerminalSize) -> AppResult<()> {
        // A resize can block on the PTY lock, so it stays off the runtime's workers.
        let mgr = self.mgr.clone();
        let key = self.key.clone();
        tokio::task::spawn_blocking(move || mgr.resize(&key, size.cols, size.rows))
            .await
            .map_err(|e| AppError::new("io", format!("terminal resize task failed: {e}")))?
    }

    fn ack(&self, bytes: usize) {
        self.mgr.ack(&self.key, bytes);
    }

    async fn close(&self) {
        self.mgr.close_async(self.key.clone()).await;
    }
}

/// Resolves a web Pane to the Terminal it is showing right now.
///
/// The local Machine's views are the only authority: a browser never names a Machine, a
/// Terminal or an argv. A Pane that is no longer there fails here rather than attaching to
/// whatever the Terminal used to be.
pub fn resolve_terminal(views: &[MachineView], pane: &WebPane) -> AppResult<AttachKey> {
    let machine = views
        .iter()
        .find(|m| m.id == LOCAL)
        .ok_or_else(|| AppError::new("not_found", "the local machine is not connected"))?;
    if machine.state != MachineState::Connected {
        return Err(AppError::new(
            "not_found",
            "the local machine is not connected",
        ));
    }
    let session = machine
        .sessions
        .iter()
        .find(|s| s.name == pane.session)
        .ok_or_else(|| AppError::new("not_found", format!("unknown session {}", pane.session)))?;
    if !session.running {
        return Err(AppError::new(
            "not_found",
            format!("session {} is not running", pane.session),
        ));
    }
    // A Pane shown in two Workspaces has two owners, so neither is authoritative.
    let shown: Vec<&_> = session
        .workspaces
        .iter()
        .flat_map(|w| &w.tabs)
        .flat_map(|t| &t.panes)
        .filter(|p| p.pane_id == pane.pane_id)
        .collect();
    let pane_view = match shown.as_slice() {
        [] => None,
        [only] => Some(*only),
        _ => {
            return Err(AppError::new(
                "conflict",
                format!("pane {} is shown in more than one workspace", pane.pane_id),
            ))
        }
    }
    .ok_or_else(|| AppError::new("not_found", format!("unknown pane {}", pane.pane_id)))?;
    if pane_view.terminal_id.is_empty() {
        return Err(AppError::new(
            "not_found",
            format!("pane {} has no terminal", pane.pane_id),
        ));
    }
    Ok(AttachKey {
        machine_id: LOCAL.into(),
        session: pane.session.clone(),
        terminal_id: pane_view.terminal_id.clone(),
    })
}

/// The command that attaches `key` on this Machine, built the way desktop `term_open` builds
/// it: core's `attach_argv` wrapped by the Machine's own transport with a pty requested. The
/// browser contributes no part of it.
pub(crate) fn attach_command(
    info: &MachineInfo,
    transport: &dyn Transport,
    key: &AttachKey,
    takeover: bool,
) -> Vec<String> {
    let argv = attach_argv(info, &key.session, &key.terminal_id, takeover);
    transport.wrap(&argv, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use herdly_core::herdr::types::AgentStatus;
    use herdly_core::view::{MachineState, PaneView, SessionView, TabView, WorkspaceView};

    fn shell_view() -> MachineView {
        MachineView {
            id: "local".into(),
            label: "local".into(),
            kind: "local".into(),
            state: MachineState::Connected,
            error: None,
            version: None,
            pi_agent_dir: None,
            has_pi: false,
            status: AgentStatus::Idle,
            sessions: vec![SessionView {
                name: "work".into(),
                running: true,
                status: AgentStatus::Idle,
                error: None,
                workspaces: vec![WorkspaceView {
                    workspace_id: "w1".into(),
                    label: "one".into(),
                    number: 1,
                    status: AgentStatus::Idle,
                    tabs: vec![TabView {
                        tab_id: "t1".into(),
                        label: "shell".into(),
                        number: 1,
                        status: AgentStatus::Idle,
                        panes: vec![PaneView {
                            pane_id: "p1".into(),
                            terminal_id: "term_7".into(),
                            title: "shell".into(),
                            cwd: None,
                            agent: None,
                            status: AgentStatus::Idle,
                        }],
                    }],
                }],
            }],
        }
    }

    #[test]
    fn resolves_shell_without_chat_and_rejects_stale_targets() {
        let p = WebPane {
            session: "work".into(),
            pane_id: "p1".into(),
        };
        let mut m = shell_view();
        assert_eq!(
            resolve_terminal(&[m.clone()], &p).unwrap(),
            AttachKey {
                machine_id: "local".into(),
                session: "work".into(),
                terminal_id: "term_7".into(),
            }
        );
        m.sessions[0].running = false;
        assert!(resolve_terminal(&[m.clone()], &p).is_err());
        m.sessions[0].running = true;
        m.id = "remote".into();
        assert!(resolve_terminal(&[m], &p).is_err());
        assert!(resolve_terminal(&[], &p).is_err());
    }

    #[test]
    fn rejects_a_pane_the_local_views_do_not_show() {
        let p = WebPane {
            session: "work".into(),
            pane_id: "p9".into(),
        };
        let e = resolve_terminal(&[shell_view()], &p).unwrap_err();
        assert_eq!(e.code, "not_found");
        assert_eq!(e.message, "unknown pane p9");
    }

    #[test]
    fn rejects_a_pane_whose_terminal_is_empty() {
        let p = WebPane {
            session: "work".into(),
            pane_id: "p1".into(),
        };
        let mut m = shell_view();
        m.sessions[0].workspaces[0].tabs[0].panes[0].terminal_id = String::new();
        let e = resolve_terminal(&[m], &p).unwrap_err();
        assert_eq!(e.code, "not_found");
        assert_eq!(e.message, "pane p1 has no terminal");
    }

    #[test]
    fn rejects_a_disconnected_local_machine() {
        let p = WebPane {
            session: "work".into(),
            pane_id: "p1".into(),
        };
        let mut m = shell_view();
        m.state = MachineState::Disconnected;
        let e = resolve_terminal(&[m], &p).unwrap_err();
        assert_eq!(e.code, "not_found");
        assert_eq!(e.message, "the local machine is not connected");
    }

    #[test]
    fn rejects_a_pane_that_two_workspaces_both_show() {
        let p = WebPane {
            session: "work".into(),
            pane_id: "p1".into(),
        };
        let mut m = shell_view();
        let mut duplicate = m.sessions[0].workspaces[0].clone();
        duplicate.workspace_id = "w2".into();
        duplicate.number = 2;
        duplicate.tabs[0].panes[0].terminal_id = "term_other".into();
        m.sessions[0].workspaces.push(duplicate);
        let e = resolve_terminal(&[m], &p).unwrap_err();
        assert_eq!(e.code, "conflict");
        assert_eq!(e.message, "pane p1 is shown in more than one workspace");
    }

    use herdly_core::attach::AttachEvent;
    use crate::backend::Backend;
    use herdly_core::machines::MachineManager;
    use std::sync::Mutex;
    use std::time::Duration;

    /// Collects what a handle delivers, as the socket's queue would.
    #[derive(Default)]
    struct Rec {
        bytes: Mutex<Vec<u8>>,
        events: Mutex<Vec<AttachEvent>>,
    }

    impl Rec {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.bytes.lock().unwrap()).into_owned()
        }
        fn events(&self) -> Vec<AttachEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl Sink for Rec {
        fn data(&self, bytes: Vec<u8>) {
            self.bytes.lock().unwrap().extend(bytes);
        }
        fn event(&self, e: AttachEvent) {
            self.events.lock().unwrap().push(e);
        }
    }

    fn key(terminal: &str) -> AttachKey {
        AttachKey {
            machine_id: "local".into(),
            session: "web-test".into(),
            terminal_id: terminal.into(),
        }
    }

    fn sh(cmd: &str) -> Vec<String> {
        vec!["sh".into(), "-c".into(), cmd.into()]
    }

    /// Polls `cond` for up to 5s; a failed poll is a failure, never a hang.
    async fn wait_for(what: &str, cond: impl Fn() -> bool) {
        for _ in 0..200 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting for {what}");
    }

    /// Closes `handle` even when the test fails or times out, from a helper thread so a
    /// wedged reader cannot hang the suite.
    struct Cleanup(Arc<dyn TerminalHandle>);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let handle = self.0.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(handle.close());
                let _ = tx.send(());
            });
            assert!(
                rx.recv_timeout(Duration::from_secs(5)).is_ok(),
                "close must not hang"
            );
        }
    }

    fn owned(terminal: &str, argv: Vec<String>) -> (Arc<dyn TerminalHandle>, Cleanup) {
        let handle: Arc<dyn TerminalHandle> = OwnedTerminal::new(key(terminal), argv);
        let cleanup = Cleanup(handle.clone());
        (handle, cleanup)
    }

    #[tokio::test]
    async fn owned_handle_opens_writes_resizes_and_detaches_once() {
        let (handle, _cleanup) = owned(
            "term_w",
            sh("read line; printf 'got:%s\\n' \"$line\"; while :; do stty size; sleep 0.1; done"),
        );
        let rec = Arc::new(Rec::default());
        handle
            .open(TerminalSize { cols: 91, rows: 33 }, rec.clone())
            .await
            .unwrap();
        handle.write(b"hello\n".to_vec()).await.unwrap();
        wait_for("got:hello", || rec.text().contains("got:hello")).await;
        // The PTY really starts at the size the browser asked for, not a default.
        wait_for("33 91", || rec.text().contains("33 91")).await;
        handle
            .resize(TerminalSize {
                cols: 100,
                rows: 40,
            })
            .await
            .unwrap();
        wait_for("40 100", || rec.text().contains("40 100")).await;
        handle.close().await;
        wait_for("Detached", || {
            rec.events().contains(&AttachEvent::Detached)
        })
        .await;
        // A second close is harmless: still exactly one Detached.
        handle.close().await;
        let detached = rec
            .events()
            .into_iter()
            .filter(|e| *e == AttachEvent::Detached)
            .count();
        assert_eq!(detached, 1);
    }

    #[tokio::test]
    async fn a_handle_opens_only_once() {
        let (handle, _cleanup) = owned("term_once", sh("echo first; sleep 30"));
        let rec = Arc::new(Rec::default());
        let size = TerminalSize { cols: 80, rows: 24 };
        handle.open(size, rec.clone()).await.unwrap();
        wait_for("first output", || rec.text().contains("first")).await;
        // Reopening would hand this attempt's Attach a different sink behind its back.
        let e = handle.open(size, Arc::new(Rec::default())).await.unwrap_err();
        assert_eq!(e.code, "conflict");
        assert_eq!(e.message, "this terminal attempt is already open");
        // The first attempt still owns its child.
        handle.write(b"echo kept\n".to_vec()).await.unwrap();
        wait_for("kept", || rec.text().contains("kept")).await;
    }

    #[tokio::test]
    async fn closing_one_handle_leaves_another_delivering() {
        let (first, _first_cleanup) = owned("term_iso", sh("echo first; sleep 30"));
        let (second, _second_cleanup) = owned("term_iso", sh("echo second; sleep 30"));
        let (a, b) = (Arc::new(Rec::default()), Arc::new(Rec::default()));
        let size = TerminalSize { cols: 80, rows: 24 };
        first.open(size, a.clone()).await.unwrap();
        second.open(size, b.clone()).await.unwrap();
        wait_for("first output", || a.text().contains("first")).await;
        wait_for("second output", || b.text().contains("second")).await;
        first.close().await;
        wait_for("first Detached", || {
            a.events().contains(&AttachEvent::Detached)
        })
        .await;
        // The second attempt keeps its own child: same Terminal, separate ownership.
        assert!(!b.events().contains(&AttachEvent::Detached));
        second.write(b"echo more\n".to_vec()).await.unwrap();
        wait_for("second still delivering", || {
            b.text().matches("more").count() >= 1
        })
        .await;
        assert!(!b.events().contains(&AttachEvent::Detached));
    }

    #[tokio::test]
    async fn a_failed_attach_reports_and_leaves_no_child_or_handle() {
        let size = TerminalSize { cols: 80, rows: 24 };
        // A program that cannot run at all: the failure must reach the caller.
        let (missing, _cleanup) = owned("term_missing", vec!["/nonexistent/herdr".into()]);
        let rec = Arc::new(Rec::default());
        let e = missing.open(size, rec.clone()).await.unwrap_err();
        assert_eq!(e.code, "io");
        // Nothing half-open is retained behind the failure.
        assert_eq!(
            missing.write(b"x".to_vec()).await.unwrap_err().code,
            "not_found"
        );
        assert_eq!(missing.resize(size).await.unwrap_err().code, "not_found");
        missing.ack(1);
        missing.close().await;
        assert!(rec.events().is_empty());

        // A command that runs and fails: its child is gone and no attach is retained.
        let (failing, _cleanup) = owned("term_exit", sh(r#"printf 'pid:%s\n' "$$"; exit 7"#));
        let rec = Arc::new(Rec::default());
        failing.open(size, rec.clone()).await.unwrap();
        wait_for("Exited", || {
            rec.events().contains(&AttachEvent::Exited { code: Some(7) })
        })
        .await;
        let text = rec.text();
        let pid = text
            .split("pid:")
            .nth(1)
            .and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next())
            .expect("the child printed its pid")
            .to_string();
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "the exited attach child must not be left behind"
        );
        assert_eq!(
            failing.write(b"x".to_vec()).await.unwrap_err().code,
            "not_found"
        );
        failing.close().await;
        assert!(!rec.events().contains(&AttachEvent::Detached));
    }

    /// Scripts one transport: records what it wrapped and with which tty request.
    struct Recording(Mutex<Vec<(Vec<String>, bool)>>);

    #[async_trait]
    impl Transport for Recording {
        fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
            self.0.lock().unwrap().push((argv.to_vec(), tty));
            let mut wrapped = vec!["wrap".to_string()];
            wrapped.extend(argv.iter().cloned());
            wrapped
        }
        async fn local_socket(
            &self,
            _session: &herdly_core::transport::SessionEntry,
        ) -> AppResult<std::path::PathBuf> {
            Err(AppError::new("io", "not used"))
        }
        async fn release_socket(
            &self,
            _session: &herdly_core::transport::SessionEntry,
        ) -> AppResult<()> {
            Ok(())
        }
    }

    #[test]
    fn attach_command_reuses_core_argv_and_the_machine_transport() {
        let info = MachineInfo {
            home: "/h".into(),
            herdr: "/h/herdr".into(),
            pi_dir: "/p".into(),
            agent_dir: "/h/.pi/agent".into(),
            pi: String::new(),
            version: "0.9.3".into(),
            protocol: 22,
        };
        let transport = Recording(Mutex::new(Vec::new()));
        let plain = attach_command(&info, &transport, &key("term_7"), false);
        let taking = attach_command(&info, &transport, &key("term_7"), true);
        // The browser names neither the Machine nor the Terminal, so the argv is herdr's own.
        assert_eq!(
            plain,
            vec![
                "wrap",
                "/h/herdr",
                "--session",
                "web-test",
                "terminal",
                "attach",
                "term_7"
            ]
        );
        assert_eq!(taking.last().map(String::as_str), Some("--takeover"));
        // A pty is requested both times: the attach needs one.
        let recorded = transport.0.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        assert!(recorded.iter().all(|(_, tty)| *tty));
        assert!(!recorded[0].0.contains(&"--takeover".to_string()));
        assert!(recorded[1].0.contains(&"--takeover".to_string()));
    }

    #[tokio::test]
    async fn allocation_spawns_nothing_until_open() {
        let handle = OwnedTerminal::new(key("term_lazy"), sh("echo must-not-run; sleep 30"));
        let size = TerminalSize { cols: 80, rows: 24 };
        // Nothing is attached, so nothing can be written, resized or acknowledged yet.
        assert_eq!(handle.write(b"x".to_vec()).await.unwrap_err().code, "not_found");
        assert_eq!(handle.resize(size).await.unwrap_err().code, "not_found");
        handle.ack(4);
        handle.close().await;
        // The command never ran: a real child would have kept the handle's key attached.
        assert_eq!(handle.write(b"x".to_vec()).await.unwrap_err().code, "not_found");
    }

    #[tokio::test]
    async fn core_terminal_rejects_a_pane_the_local_views_do_not_hold() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(dir.path().join("machines.json"), Arc::new(|_| {}));
        let core = crate::backend::Core {
            mgr,
            chats: Arc::new(herdly_core::transcript::ChatManager::default()),
        };
        let e = match core
            .terminal(&WebPane { session: "work".into(), pane_id: "p1".into() }, false)
            .await
        {
            Ok(_) => panic!("a Pane the local views do not hold must not allocate"),
            Err(e) => e,
        };
        assert_eq!(e.code, "not_found");
        assert_eq!(e.message, "the local machine is not connected");
    }
}
