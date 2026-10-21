use herdly_core::transcript::ChatEvent;
use herdly_web::backend::{Backend, WebPane};
use herdly_web::testing::{pane, FakeBackend};
use std::sync::{Arc, Mutex};

#[test]
fn web_pane_round_trips_to_a_local_ref() {
    let p = pane("default", "p1");
    let r = p.to_ref();
    assert_eq!((r.machine_id.as_str(), r.session.as_str(), r.pane_id.as_str()), ("local", "default", "p1"));
    assert_eq!(WebPane::from_ref(&r), p);
}

#[tokio::test]
async fn fake_records_opens_and_replays_through_the_sink() {
    let fake = FakeBackend::default();
    let got: Arc<Mutex<Vec<String>>> = Default::default();
    let g = got.clone();
    let l = fake
        .open_chat(&pane("s", "p1"), None, Arc::new(move |e: ChatEvent| g.lock().unwrap().push(format!("{e:?}"))))
        .await
        .unwrap();
    assert_eq!(l.path, "/t/a.jsonl");
    fake.emit(&pane("s", "p1"), ChatEvent::Append { items: vec![] });
    assert_eq!(got.lock().unwrap().len(), 1);
    assert_eq!(*fake.log.lock().unwrap(), vec!["open:p1:-", "opened:p1"]);
}

#[tokio::test]
async fn open_with_a_path_echoes_it_and_keeps_the_last_sink() {
    let fake = FakeBackend::default();
    let got: Arc<Mutex<Vec<&'static str>>> = Default::default();
    let (g1, g2) = (got.clone(), got.clone());
    let p = pane("s", "p2");
    fake.open_chat(&p, Some("/t/x.jsonl".into()), Arc::new(move |_| g1.lock().unwrap().push("first")))
        .await
        .unwrap();
    let l = fake
        .open_chat(&p, Some("/t/y.jsonl".into()), Arc::new(move |_| g2.lock().unwrap().push("second")))
        .await
        .unwrap();
    assert_eq!(l.path, "/t/y.jsonl");
    fake.emit(&p, ChatEvent::Append { items: vec![] });
    assert_eq!(*got.lock().unwrap(), vec!["second"]);
    assert_eq!(fake.log.lock().unwrap()[0], "open:p2:/t/x.jsonl");
}

#[tokio::test]
async fn open_delay_sits_between_open_and_opened() {
    let fake = Arc::new(FakeBackend::default());
    *fake.open_delay.lock().unwrap() = std::time::Duration::from_millis(200);
    let f = fake.clone();
    let task = tokio::spawn(async move { f.open_chat(&pane("s", "p1"), None, Arc::new(|_| {})).await });
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    assert_eq!(*fake.log.lock().unwrap(), vec!["open:p1:-"]);
    task.await.unwrap().unwrap();
    assert_eq!(*fake.log.lock().unwrap(), vec!["open:p1:-", "opened:p1"]);
}

#[tokio::test]
async fn locate_pops_results_then_reports_not_found_and_call_records() {
    let fake = FakeBackend::default();
    fake.locate_results.lock().unwrap().push_back(Ok(herdly_web::testing::located("/t/l.jsonl")));
    assert_eq!(fake.locate(&pane("s", "p3")).await.unwrap().path, "/t/l.jsonl");
    let e = fake.locate(&pane("s", "p3")).await.unwrap_err();
    assert_eq!((e.code.as_str(), e.message.as_str()), ("not_found", "no locate result"));
    assert_eq!(fake.call("s", "pane.list", serde_json::json!({"a": 1})).await.unwrap(), serde_json::json!({}));
    assert_eq!(fake.calls.lock().unwrap()[0], ("s".to_string(), "pane.list".to_string(), serde_json::json!({"a": 1})));
}
