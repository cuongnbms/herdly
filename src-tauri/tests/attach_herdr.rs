//! Needs a real herdr (`/opt/homebrew/bin/herdr`). Run with
//! `cargo test --test attach_herdr -- --ignored --test-threads=1`.
use herdly_lib::attach::{attach_argv, AttachEvent, AttachKey, AttachManager, Sink};
use herdly_lib::herdr::rpc;
use herdly_lib::transport::local::LocalTransport;
use herdly_lib::transport::{parse_session_list, MachineInfo, Transport};
use serde_json::json;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const HERDR: &str = "/opt/homebrew/bin/herdr";
const SESSION: &str = "herdly-test-attach";

/// Stops and deletes the test session, even when the test fails.
struct SessionGuard;
impl Drop for SessionGuard {
    fn drop(&mut self) {
        let run = |args: &[&str]| {
            let _ = Command::new(HERDR)
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        };
        run(&["--session", SESSION, "server", "stop"]);
        run(&["session", "delete", SESSION]);
    }
}

#[derive(Default)]
struct Rec {
    bytes: Mutex<Vec<u8>>,
    events: Mutex<Vec<AttachEvent>>,
}
impl Sink for Rec {
    fn data(&self, b: Vec<u8>) {
        self.bytes.lock().unwrap().extend(b)
    }
    fn event(&self, e: AttachEvent) {
        self.events.lock().unwrap().push(e)
    }
}

async fn wait_for(what: &str, cond: impl Fn() -> bool) {
    for _ in 0..150 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

fn session_socket() -> Option<PathBuf> {
    let out = Command::new(HERDR)
        .args(["session", "list"])
        .output()
        .ok()?;
    parse_session_list(&String::from_utf8_lossy(&out.stdout))
        .into_iter()
        .find(|s| s.name == SESSION)
        .map(|s| PathBuf::from(s.socket))
}

#[tokio::test]
#[ignore]
async fn attaches_echoes_and_reports_held() {
    let _guard = SessionGuard;
    Command::new(HERDR)
        .args(["--session", SESSION, "server"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn herdr server");

    let mut socket = None;
    for _ in 0..100 {
        if let Some(s) = session_socket() {
            if rpc::call(&s, "session.snapshot", json!({})).await.is_ok() {
                socket = Some(s);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let socket = socket.expect("session socket never became ready");

    rpc::call(&socket, "workspace.create", json!({"cwd": "/tmp"}))
        .await
        .expect("workspace.create");
    let snap = rpc::snapshot(&socket).await.unwrap();
    let terminal_id = snap.panes.first().expect("a pane").terminal_id.clone();

    let info = MachineInfo {
        home: "/tmp".into(),
        herdr: HERDR.into(),
        pi_dir: "/tmp".into(),
        version: "0.9.3".into(),
        protocol: 22,
    };
    let argv = LocalTransport.wrap(&attach_argv(&info, SESSION, &terminal_id, false), true);
    let key = |name: &str| AttachKey {
        machine_id: "local".into(),
        session: SESSION.into(),
        terminal_id: format!("{terminal_id}{name}"),
    };

    let m = AttachManager::new(Duration::from_secs(15));
    let rec = Arc::new(Rec::default());
    let k1 = key("");
    m.open(k1.clone(), argv.clone(), 80, 24, rec.clone())
        .unwrap();
    wait_for("Attached", || {
        rec.events.lock().unwrap().contains(&AttachEvent::Attached)
    })
    .await;
    m.write(&k1, b"echo hi-from-test\r").unwrap();
    wait_for("echo output", || {
        String::from_utf8_lossy(&rec.bytes.lock().unwrap()).contains("hi-from-test")
    })
    .await;

    // A second attach on the same terminal (different manager key) is refused.
    let rec2 = Arc::new(Rec::default());
    m.open(key("-second"), argv, 80, 24, rec2.clone()).unwrap();
    wait_for("Held", || {
        rec2.events.lock().unwrap().contains(&AttachEvent::Held)
    })
    .await;
    assert!(!rec2.events.lock().unwrap().contains(&AttachEvent::Attached));

    m.close(&k1);
    m.close(&key("-second"));
}
