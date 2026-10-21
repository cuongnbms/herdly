use herdly_core::transcript::ChatEvent;
use herdly_web::backend::{Backend, WebPane};
use herdly_web::testing::{pane, FakeBackend};
use std::sync::{Arc, Mutex};

#[test]
fn web_pane_round_trips_to_a_local_ref() {
    let p = pane("default", "p1");
    let r = p.to_ref();
    assert_eq!(
        (
            r.machine_id.as_str(),
            r.session.as_str(),
            r.pane_id.as_str()
        ),
        ("local", "default", "p1")
    );
    assert_eq!(WebPane::from_ref(&r), p);
}

#[tokio::test]
async fn fake_records_opens_and_replays_through_the_sink() {
    let fake = FakeBackend::default();
    let got: Arc<Mutex<Vec<String>>> = Default::default();
    let g = got.clone();
    let l = fake
        .open_chat(
            &pane("s", "p1"),
            None,
            Arc::new(move |e: ChatEvent| g.lock().unwrap().push(format!("{e:?}"))),
        )
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
    fake.open_chat(
        &p,
        Some("/t/x.jsonl".into()),
        Arc::new(move |_| g1.lock().unwrap().push("first")),
    )
    .await
    .unwrap();
    let l = fake
        .open_chat(
            &p,
            Some("/t/y.jsonl".into()),
            Arc::new(move |_| g2.lock().unwrap().push("second")),
        )
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
    let task =
        tokio::spawn(async move { f.open_chat(&pane("s", "p1"), None, Arc::new(|_| {})).await });
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    assert_eq!(*fake.log.lock().unwrap(), vec!["open:p1:-"]);
    task.await.unwrap().unwrap();
    assert_eq!(*fake.log.lock().unwrap(), vec!["open:p1:-", "opened:p1"]);
}

#[tokio::test]
async fn locate_pops_results_then_reports_not_found_and_call_records() {
    let fake = FakeBackend::default();
    fake.locate_results
        .lock()
        .unwrap()
        .push_back(Ok(herdly_web::testing::located("/t/l.jsonl")));
    assert_eq!(
        fake.locate(&pane("s", "p3")).await.unwrap().path,
        "/t/l.jsonl"
    );
    let e = fake.locate(&pane("s", "p3")).await.unwrap_err();
    assert_eq!(
        (e.code.as_str(), e.message.as_str()),
        ("not_found", "no locate result")
    );
    assert_eq!(
        fake.call("s", "pane.list", serde_json::json!({"a": 1}))
            .await
            .unwrap(),
        serde_json::json!({})
    );
    assert_eq!(
        fake.calls.lock().unwrap()[0],
        (
            "s".to_string(),
            "pane.list".to_string(),
            serde_json::json!({"a": 1})
        )
    );
}

#[tokio::test]
async fn fake_terminal_delivers_through_the_sink_and_records_every_call() {
    use herdly_core::attach::{AttachEvent, Sink};
    use herdly_web::terminal::backend::TerminalSize;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Rec {
        bytes: Mutex<Vec<u8>>,
        events: Mutex<Vec<AttachEvent>>,
    }
    impl Sink for Rec {
        fn data(&self, b: Vec<u8>) {
            self.bytes.lock().unwrap().extend(b);
        }
        fn event(&self, e: AttachEvent) {
            self.events.lock().unwrap().push(e);
        }
    }

    let fake = FakeBackend::default();
    let handle = fake.terminal(&pane("s", "p1"), true).await.unwrap();
    assert_eq!(*fake.log.lock().unwrap(), vec!["terminal:p1:true"]);
    let rec = Arc::new(Rec::default());
    handle
        .open(TerminalSize { cols: 91, rows: 33 }, rec.clone())
        .await
        .unwrap();
    handle.write(b"hello\r".to_vec()).await.unwrap();
    handle
        .resize(TerminalSize {
            cols: 40,
            rows: 100,
        })
        .await
        .unwrap();
    handle.ack(3);
    handle.close().await;

    let attempt = fake.terminal_attempts.lock().unwrap()[0].clone();
    assert_eq!(attempt.sizes(), vec![TerminalSize { cols: 91, rows: 33 }]);
    assert_eq!(attempt.resizes(), vec![TerminalSize { cols: 40, rows: 100 }]);
    assert_eq!(attempt.inputs(), vec![b"hello\r".to_vec()]);
    assert_eq!(attempt.acks(), vec![3]);
    assert_eq!(attempt.close_count(), 1);
    assert!(attempt.is_closed());

    // Output and events go to the real Sink the handle opened with.
    attempt.emit_data(vec![0x1b, 0x5b, 0xff]);
    attempt.emit_event(AttachEvent::Attached);
    assert_eq!(*rec.bytes.lock().unwrap(), vec![0x1b, 0x5b, 0xff]);
    assert_eq!(*rec.events.lock().unwrap(), vec![AttachEvent::Attached]);
}

#[tokio::test]
async fn fake_terminal_allocates_a_new_attempt_each_time() {
    use herdly_core::attach::{AttachEvent, Sink};
    use herdly_web::terminal::backend::TerminalSize;

    #[derive(Default)]
    struct Rec;
    impl Sink for Rec {
        fn data(&self, _b: Vec<u8>) {}
        fn event(&self, _e: AttachEvent) {}
    }

    let fake = FakeBackend::default();
    let size = TerminalSize { cols: 80, rows: 24 };
    let first = fake.terminal(&pane("s", "p1"), false).await.unwrap();
    let second = fake.terminal(&pane("s", "p1"), false).await.unwrap();
    let history = fake.terminal_attempts.lock().unwrap().clone();
    assert_eq!(history.len(), 2, "each call must append its own attempt");
    // Two independent attempts for one Terminal: separate state and history.
    first.open(size, Arc::new(Rec)).await.unwrap();
    second.open(size, Arc::new(Rec)).await.unwrap();
    first.write(b"only-first\r".to_vec()).await.unwrap();
    assert_eq!(history[0].inputs(), vec![b"only-first\r".to_vec()]);
    assert!(history[1].inputs().is_empty(), "attempts must not share input");
    first.close().await;
    assert!(history[0].is_closed());
    assert!(
        !history[1].is_closed(),
        "closing one attempt must not close the other"
    );
    assert_eq!(history[1].close_count(), 0);
    // The second attempt still accepts input after the first one closed.
    second.write(b"still-second\r".to_vec()).await.unwrap();
    assert_eq!(history[1].inputs(), vec![b"still-second\r".to_vec()]);
}

#[tokio::test]
async fn fake_terminal_write_can_be_gated_and_records_before_waiting() {
    use herdly_core::attach::{AttachEvent, Sink};
    use herdly_web::terminal::backend::TerminalSize;

    #[derive(Default)]
    struct Rec;
    impl Sink for Rec {
        fn data(&self, _b: Vec<u8>) {}
        fn event(&self, _e: AttachEvent) {}
    }

    let fake = FakeBackend::default();
    let (attempt, write_gate) = herdly_web::testing::FakeTerminal::gated_write();
    fake.script_terminal(attempt.clone());
    let handle = fake.terminal(&pane("s", "p1"), false).await.unwrap();
    let size = TerminalSize { cols: 80, rows: 24 };
    handle.open(size, Arc::new(Rec)).await.unwrap();

    // The write hangs where a wedged PTY write would.
    let mut pending = tokio::spawn({
        let handle = handle.clone();
        async move { handle.write(b"stuck\r".to_vec()).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!pending.is_finished(), "a gated write must stay pending");
    // The argument is recorded before the wait, so a test can assert what was attempted.
    assert_eq!(attempt.inputs(), vec![b"stuck\r".to_vec()]);

    drop(write_gate);
    tokio::time::timeout(std::time::Duration::from_secs(2), &mut pending)
        .await
        .expect("the write must finish once the gate is released")
        .unwrap()
        .unwrap();
    assert_eq!(attempt.inputs(), vec![b"stuck\r".to_vec()]);
    handle.close().await;
    // A pending write does not block closing the attempt.
    assert!(attempt.is_closed());
}

#[tokio::test]
async fn fake_terminal_consumes_each_scripted_handle_once() {
    let fake = FakeBackend::default();
    let (scripted, _open_gate) = herdly_web::testing::FakeTerminal::gated();
    fake.script_terminal(scripted.clone());
    let first = fake.terminal(&pane("s", "p1"), false).await.unwrap();
    let second = fake.terminal(&pane("s", "p1"), false).await.unwrap();
    let history = fake.terminal_attempts.lock().unwrap().clone();
    assert_eq!(history.len(), 2);
    // The scripted handle is handed out once, not again to every later attempt.
    assert!(Arc::ptr_eq(&history[0], &scripted));
    assert!(!Arc::ptr_eq(&history[1], &scripted));
    assert!(!Arc::ptr_eq(&history[0], &history[1]));
    drop((first, second));
}

#[tokio::test]
async fn fake_terminal_records_every_allocation_argument() {
    let fake = FakeBackend::default();
    fake.terminal(&pane("s", "p1"), false).await.unwrap();
    fake.terminal(&pane("other", "p1"), true).await.unwrap();
    // Same Pane ID in two Sessions must stay distinguishable, as the route tests need.
    assert_eq!(
        *fake.terminal_calls.lock().unwrap(),
        vec![
            (pane("s", "p1"), false),
            (pane("other", "p1"), true),
        ]
    );
    assert_eq!(
        *fake.log.lock().unwrap(),
        vec!["terminal:p1:false", "terminal:p1:true"]
    );
}
