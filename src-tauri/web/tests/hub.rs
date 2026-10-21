use herdly_core::herdr::types::AgentStatus;
use herdly_core::machines::UiEvent;
use herdly_core::transcript::Located;
use herdly_core::view::{PaneRef, PaneStatusEvent};
use herdly_web::chat::ChatHub;
use herdly_web::hub::{forward_statuses, Hub};
use herdly_web::testing::{pane, FakeBackend};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

fn status(machine: &str, pane_id: &str) -> PaneStatusEvent {
    PaneStatusEvent {
        pane: PaneRef {
            machine_id: machine.into(),
            session: "s".into(),
            pane_id: pane_id.into(),
        },
        status: AgentStatus::Working,
        previous: AgentStatus::Idle,
        title: "t".into(),
    }
}

#[tokio::test]
async fn a_pane_status_becomes_one_frame_and_one_forwarded_event() {
    let (hub, mut statuses) = Hub::new();
    let mut rx = hub.subscribe();
    hub.emit()(UiEvent::PaneStatus(status("local", "p1")));
    let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(frame["type"], "pane_status");
    assert_eq!(
        frame["ev"],
        json!({"pane": {"machine_id": "local", "session": "s", "pane_id": "p1"},
               "status": "working", "previous": "idle", "title": "t"})
    );
    assert_eq!(statuses.recv().await.unwrap(), status("local", "p1"));
}

#[tokio::test]
async fn only_local_statuses_reach_the_chat_hub() {
    let fake = Arc::new(FakeBackend::default());
    // The open leaves the Pane pending, so a status for it triggers a locate.
    fake.open_results.lock().unwrap().push_back(Ok(Located {
        pending: true,
        ..herdly_web::testing::located("/t/a.jsonl")
    }));
    let chats = ChatHub::new(fake.clone());
    chats.subscribe(1, pane("s", "p1")).await;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(forward_statuses(rx, chats));

    tx.send(status("remote", "p1")).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!fake.log.lock().unwrap().iter().any(|l| l == "locate:p1"));

    tx.send(status("local", "p1")).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(fake.log.lock().unwrap().iter().any(|l| l == "locate:p1"));
}
