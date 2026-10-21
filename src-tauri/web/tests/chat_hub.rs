use herdly_core::herdr::types::AgentStatus;
use herdly_core::transcript::{ChatEvent, ChatItem, Located};
use herdly_core::view::PaneStatusEvent;
use herdly_web::chat::ChatHub;
use herdly_web::testing::{located, pane, FakeBackend};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

fn hub() -> (Arc<FakeBackend>, Arc<ChatHub>) {
    let fake = Arc::new(FakeBackend::default());
    (fake.clone(), ChatHub::new(fake))
}

async fn next(rx: &mut Receiver<Arc<str>>) -> Value {
    let f = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    serde_json::from_str(&f).unwrap()
}

#[tokio::test]
async fn first_subscriber_opens_with_no_path_and_gets_chat_opened() {
    let (fake, hub) = hub();
    let mut rx = hub.subscribe(1, pane("s", "p1")).await;
    let f = next(&mut rx).await;
    assert_eq!(f["type"], "chat_opened");
    assert_eq!(
        f["pane"],
        serde_json::json!({"session": "s", "pane_id": "p1"})
    );
    assert_eq!(f["located"]["path"], "/t/a.jsonl");
    assert_eq!(*fake.log.lock().unwrap(), vec!["open:p1:-", "opened:p1"]);
}

#[tokio::test]
async fn chat_events_reach_every_subscriber_as_chat_frames() {
    let (fake, hub) = hub();
    let mut a = hub.subscribe(1, pane("s", "p1")).await;
    let mut b = hub.subscribe(2, pane("s", "p1")).await;
    while next(&mut a).await["type"] != "chat_opened" {}
    fake.emit(
        &pane("s", "p1"),
        ChatEvent::Append {
            items: vec![ChatItem::System {
                text: "hi".into(),
                ts: None,
            }],
        },
    );
    for rx in [&mut a, &mut b] {
        loop {
            let f = next(rx).await;
            if f["type"] == "chat" {
                assert_eq!(f["event"]["type"], "append");
                assert_eq!(f["event"]["items"][0]["text"], "hi");
                break;
            }
        }
    }
}

#[tokio::test]
async fn a_second_subscriber_reopens_on_the_known_path() {
    let (fake, hub) = hub();
    let _a = hub.subscribe(1, pane("s", "p1")).await;
    let _b = hub.subscribe(2, pane("s", "p1")).await;
    assert_eq!(
        *fake.log.lock().unwrap(),
        vec!["open:p1:-", "opened:p1", "open:p1:/t/a.jsonl", "opened:p1"]
    );
}

#[tokio::test]
async fn the_same_socket_subscribing_twice_counts_once() {
    let (fake, hub) = hub();
    let _a = hub.subscribe(1, pane("s", "p1")).await;
    let _a2 = hub.subscribe(1, pane("s", "p1")).await;
    hub.unsubscribe(1, &pane("s", "p1")).await;
    assert_eq!(fake.log.lock().unwrap().last().unwrap(), "close:p1");
}

#[tokio::test]
async fn the_last_subscriber_leaving_closes_the_tail() {
    let (fake, hub) = hub();
    let _a = hub.subscribe(1, pane("s", "p1")).await;
    let _b = hub.subscribe(2, pane("s", "p1")).await;
    hub.unsubscribe(1, &pane("s", "p1")).await;
    assert!(!fake
        .log
        .lock()
        .unwrap()
        .iter()
        .any(|l| l.starts_with("close")));
    hub.drop_socket(2).await;
    assert_eq!(fake.log.lock().unwrap().last().unwrap(), "close:p1");
}

#[tokio::test]
async fn open_and_close_of_one_pane_never_overlap() {
    let (fake, hub) = hub();
    *fake.open_delay.lock().unwrap() = Duration::from_millis(100);
    let h = hub.clone();
    let opening = tokio::spawn(async move { h.subscribe(1, pane("s", "p1")).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    hub.drop_socket(1).await;
    opening.await.unwrap();
    assert_eq!(
        *fake.log.lock().unwrap(),
        vec!["open:p1:-", "opened:p1", "close:p1"]
    );
}

#[tokio::test]
async fn cached_open_with_moved_transcript_reopens_on_fresh_path() {
    let (fake, hub) = hub();
    fake.open_results.lock().unwrap().push_back(Ok(Located {
        cached: true,
        ..located("/t/old.jsonl")
    }));
    fake.locate_results
        .lock()
        .unwrap()
        .push_back(Ok(located("/t/new.jsonl")));
    let mut rx = hub.subscribe(1, pane("s", "p1")).await;
    let mut paths = vec![];
    while paths.len() < 2 {
        let f = next(&mut rx).await;
        if f["type"] == "chat_opened" {
            paths.push(f["located"]["path"].as_str().unwrap().to_string());
        }
    }
    assert_eq!(paths, vec!["/t/old.jsonl", "/t/new.jsonl"]);
    assert!(fake
        .log
        .lock()
        .unwrap()
        .contains(&"open:p1:/t/new.jsonl".to_string()));
}

#[tokio::test]
async fn a_pending_transcript_is_located_again_on_a_status_event() {
    let (fake, hub) = hub();
    fake.open_results.lock().unwrap().push_back(Ok(Located {
        pending: true,
        ..located("/t/p.jsonl")
    }));
    fake.locate_results
        .lock()
        .unwrap()
        .push_back(Ok(located("/t/p.jsonl")));
    let _rx = hub.subscribe(1, pane("s", "p1")).await;
    hub.on_status(&PaneStatusEvent {
        pane: pane("s", "p1").to_ref(),
        status: AgentStatus::Working,
        previous: AgentStatus::Idle,
        title: "t".into(),
    })
    .await;
    let log = fake.log.lock().unwrap().clone();
    assert!(log.contains(&"locate:p1".to_string()));
    assert_eq!(log.iter().filter(|l| l.starts_with("open:p1")).count(), 2);
}

#[tokio::test]
async fn a_failed_open_sends_chat_error_and_a_retry_opens_again() {
    let (fake, hub) = hub();
    fake.open_results
        .lock()
        .unwrap()
        .push_back(Err(herdly_core::error::AppError::new(
            "not_found",
            "no transcript",
        )));
    let mut rx = hub.subscribe(1, pane("s", "p1")).await;
    let f = next(&mut rx).await;
    assert_eq!(f["type"], "chat_error");
    assert_eq!(f["error"]["code"], "not_found");
    let mut rx2 = hub.subscribe(1, pane("s", "p1")).await;
    assert_eq!(next(&mut rx2).await["type"], "chat_opened");
    hub.drop_socket(1).await;
    assert_eq!(fake.log.lock().unwrap().last().unwrap(), "close:p1");
}

fn status(p: &str) -> PaneStatusEvent {
    PaneStatusEvent {
        pane: pane("s", p).to_ref(),
        status: AgentStatus::Working,
        previous: AgentStatus::Idle,
        title: "t".into(),
    }
}

fn locates(fake: &FakeBackend) -> usize {
    fake.log
        .lock()
        .unwrap()
        .iter()
        .filter(|l| l.starts_with("locate"))
        .count()
}

#[tokio::test]
async fn a_still_pending_transcript_is_located_once_more_after_the_retry_delay() {
    let (fake, hub) = hub();
    let pending = Located {
        pending: true,
        ..located("/t/p.jsonl")
    };
    fake.open_results
        .lock()
        .unwrap()
        .push_back(Ok(pending.clone()));
    fake.locate_results.lock().unwrap().push_back(Ok(pending));
    fake.locate_results
        .lock()
        .unwrap()
        .push_back(Ok(located("/t/p.jsonl")));
    let mut rx = hub.subscribe(1, pane("s", "p1")).await;
    hub.on_status(&status("p1")).await;
    assert_eq!(locates(&fake), 1);
    tokio::time::sleep(Duration::from_millis(1700)).await;
    assert_eq!(locates(&fake), 2);
    let mut opened = 0;
    while let Ok(Ok(f)) = tokio::time::timeout(Duration::from_millis(50), rx.recv()).await {
        if serde_json::from_str::<Value>(&f).unwrap()["type"] == "chat_opened" {
            opened += 1;
        }
    }
    assert_eq!(opened, 2);
}

#[tokio::test]
async fn the_delayed_retry_does_nothing_when_the_entry_is_gone() {
    let (fake, hub) = hub();
    let pending = Located {
        pending: true,
        ..located("/t/p.jsonl")
    };
    fake.open_results
        .lock()
        .unwrap()
        .push_back(Ok(pending.clone()));
    fake.locate_results.lock().unwrap().push_back(Ok(pending));
    let _rx = hub.subscribe(1, pane("s", "p1")).await;
    hub.on_status(&status("p1")).await;
    hub.drop_socket(1).await;
    tokio::time::sleep(Duration::from_millis(1700)).await;
    assert_eq!(locates(&fake), 1);
    hub.on_status(&status("other")).await;
    assert_eq!(locates(&fake), 1);
}

#[tokio::test]
async fn a_stale_waiter_never_closes_the_replacement_entry_mid_open() {
    let (fake, hub) = hub();
    *fake.open_delay.lock().unwrap() = Duration::from_millis(100);
    let ms = |n| tokio::time::sleep(Duration::from_millis(n));
    // Socket 1's open holds entry E1's gate.
    let h = hub.clone();
    let first = tokio::spawn(async move { h.subscribe(1, pane("s", "p1")).await });
    ms(10).await;
    // Queued behind it on E1's gate: finish A (socket 1 leaves) ...
    let h = hub.clone();
    let a = tokio::spawn(async move { h.drop_socket(1).await });
    ms(10).await;
    // ... then socket 3, which on waking finds E1 gone and, in the same poll,
    // creates E2 with a slow open while socket 3 leaves again ...
    let h = hub.clone();
    let t = tokio::spawn(async move {
        let _ = h.subscribe(3, pane("s", "p1")).await;
        tokio::join!(h.subscribe(3, pane("s", "p1")), h.drop_socket(3));
    });
    ms(10).await;
    // ... and finish B (socket 3 left), queued on E1's gate behind socket 3.
    let h = hub.clone();
    let b = tokio::spawn(async move { h.drop_socket(3).await });
    first.await.unwrap();
    for j in [a, t, b] {
        j.await.unwrap();
    }
    ms(300).await;
    let log = fake.log.lock().unwrap().clone();
    assert_eq!(
        log,
        vec![
            "open:p1:-",
            "opened:p1",
            "close:p1",
            "open:p1:-",
            "opened:p1",
            "close:p1"
        ]
    );
}
