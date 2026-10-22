use futures_util::{SinkExt, StreamExt};
use herdly_web::{
    app::router,
    terminal::backend::TerminalSize,
    testing::{paired_cookie, state_with, FakeBackend, FakeTerminal},
};
use serde_json::{json, Value};
#[cfg(target_os = "linux")]
use std::time::Instant;
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
const ORIGIN: &str = "http://192.0.2.10:7380";

#[tokio::test]
async fn terminal_requires_pairing_and_origin_then_forwards_raw_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeBackend::default());
    let st = state_with(fake.clone(), dir.path(), Duration::from_millis(50));
    let cookie = paired_cookie(&st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws/terminal", listener.local_addr().unwrap());
    let app = router(st.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let request = |origin: &str, paired: bool| {
        let mut req = url.clone().into_client_request().unwrap();
        req.headers_mut().insert("origin", origin.parse().unwrap());
        if paired {
            req.headers_mut()
                .insert("cookie", format!("herdly_web={cookie}").parse().unwrap());
        }
        req
    };
    assert!(tokio_tungstenite::connect_async(request(ORIGIN, false))
        .await
        .is_err());
    assert!(
        tokio_tungstenite::connect_async(request("http://evil.example", true))
            .await
            .is_err()
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request(ORIGIN, true))
        .await
        .unwrap();
    ws.send(Message::Text(
        json!({"type":"open","pane":{"session":"s","pane_id":"p1"},"cols":80,"rows":24,"takeover":false})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let attempt = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(h) = fake.terminal_attempts.lock().unwrap().first().cloned() {
                if h.is_open() {
                    break h;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    attempt.emit_data(vec![0x1b, 0x5b, 0xff]);
    loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        {
            Message::Binary(bytes) => {
                assert_eq!(&bytes[..], &[0x1b, 0x5b, 0xff]);
                break;
            }
            Message::Text(_) => continue,
            other => panic!("{other:?}"),
        }
    }
    ws.send(Message::Text(r#"{"type":"ack","bytes":3}"#.into()))
        .await
        .unwrap();
    ws.send(Message::Binary(b"hello\r".to_vec().into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if attempt.inputs() == vec![b"hello\r".to_vec()] && attempt.acks() == vec![3] {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    ws.close(None).await.unwrap();
    st.terminals.shutdown().await;
    assert!(attempt.is_closed());
    server.abort();
}

/// The terminal route under a live server, with its own paired device and isolated state dir.
struct Server {
    _dir: tempfile::TempDir,
    fake: Arc<FakeBackend>,
    st: Arc<herdly_web::app::AppState>,
    cookie: String,
    url: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn start(revoke_check: Duration) -> Server {
        Server::start_with_timeout(revoke_check, Duration::from_secs(10)).await
    }

    /// The same server with a shortened initial-open deadline.
    async fn start_with_timeout(revoke_check: Duration, open_timeout: Duration) -> Server {
        let dir = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeBackend::default());
        let st = herdly_web::testing::state_with_open_timeout(
            fake.clone(),
            dir.path(),
            revoke_check,
            open_timeout,
        );
        let cookie = paired_cookie(&st);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws/terminal", listener.local_addr().unwrap());
        let app = router(st.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Server {
            _dir: dir,
            fake,
            st,
            cookie,
            url,
            task,
        }
    }

    async fn connect(&self) -> Ws {
        tokio_tungstenite::connect_async(self.request())
            .await
            .expect("a paired, same-origin upgrade")
            .0
    }

    fn request(&self) -> tokio_tungstenite::tungstenite::handshake::client::Request {
        let mut req = self.url.clone().into_client_request().unwrap();
        req.headers_mut().insert("origin", ORIGIN.parse().unwrap());
        req.headers_mut().insert(
            "cookie",
            format!("herdly_web={}", self.cookie).parse().unwrap(),
        );
        req
    }

    /// The attempt allocated by the `n`th `terminal` call, once its `open` has completed.
    async fn opened_attempt(&self, n: usize) -> Arc<FakeTerminal> {
        wait_until("the attempt to open", || {
            self.fake
                .terminal_attempts
                .lock()
                .unwrap()
                .get(n)
                .is_some_and(|h| h.is_open())
        })
        .await;
        self.fake.terminal_attempts.lock().unwrap()[n].clone()
    }

    fn attempt_calls(&self) -> usize {
        self.fake.terminal_attempts.lock().unwrap().len()
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Polls `cond` for up to 5 s; a failed poll is a failure, never a hang.
async fn wait_until(what: &str, cond: impl Fn() -> bool) {
    for _ in 0..500 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn next_msg<S>(ws: &mut S) -> Message
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a frame within 5 s")
            .expect("the stream stays open")
            .expect("a valid frame")
        {
            Message::Ping(_) | Message::Pong(_) => continue,
            other => return other,
        }
    }
}

/// Reads until the server ends the connection, inside 5 s.
async fn ended<S>(ws: &mut S)
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => return,
            Ok(Some(Ok(_))) => continue,
            Err(_) => panic!("the connection must end within 5 s"),
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

/// The next binary frame's bytes, unchanged.
async fn next_binary<S>(ws: &mut S) -> Vec<u8>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match next_msg(ws).await {
            Message::Binary(bytes) => return bytes.to_vec(),
            Message::Text(_) => continue,
            other => panic!("expected binary output, got {other:?}"),
        }
    }
}

/// The close code this socket ends with, as the number the Spec names. The bound is wider than
/// the open deadline, so a socket that never opened still reports its own close.
async fn close_code<S>(ws: &mut S) -> u16
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(16), ws.next())
            .await
            .expect("a close frame within 16 s")
            .expect("the stream stays open")
            .expect("a valid frame");
        match frame {
            Message::Close(Some(frame)) => return u16::from(frame.code),
            Message::Close(None) => panic!("an unexplained close frame"),
            _ => continue,
        }
    }
}

fn open_frame(session: &str, pane: &str, cols: u16, rows: u16, takeover: bool) -> Message {
    Message::Text(
        json!({"type":"open","pane":{"session":session,"pane_id":pane},"cols":cols,"rows":rows,"takeover":takeover})
            .to_string()
            .into(),
    )
}

async fn opened(server: &Server) -> (Ws, Arc<FakeTerminal>) {
    opened_nth(server, 0).await
}

/// The same, for the `n`th attempt a server allocated: two sockets are two attempts.
async fn opened_nth(server: &Server, n: usize) -> (Ws, Arc<FakeTerminal>) {
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    let attempt = server.opened_attempt(n).await;
    (ws, attempt)
}

/// Delivers `Attached` through the attempt's real sink, as core's settle does, and asserts the
/// socket forwarded it unchanged.
async fn attached(ws: &mut Ws, attempt: &FakeTerminal) {
    attempt.emit_event(herdly_core::attach::AttachEvent::Attached);
    assert_eq!(next_event(ws).await, json!({"type": "attached"}));
}

#[tokio::test]
async fn open_allocates_the_exact_pane_takeover_and_size() {
    let server = Server::start(Duration::from_secs(15)).await;
    let mut ws = server.connect().await;
    ws.send(open_frame("work", "pane-9", 100, 40, true))
        .await
        .unwrap();
    let attempt = server.opened_attempt(0).await;
    // Every argument the backend received is asserted: Session and Pane, the exact Take over
    // flag the client asked for, and the size the PTY was opened with.
    assert_eq!(
        *server.fake.terminal_calls.lock().unwrap(),
        vec![(herdly_web::testing::pane("work", "pane-9"), true)]
    );
    assert_eq!(
        attempt.sizes(),
        vec![TerminalSize {
            cols: 100,
            rows: 40
        }]
    );
    // The attempt is announced before any output, and Attached follows the handle.
    attached(&mut ws, &attempt).await;
    drop(ws);
    server.st.terminals.shutdown().await;
    assert!(attempt.is_closed());
}

#[tokio::test]
async fn a_second_open_is_refused_and_only_one_attempt_is_allocated() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (mut ws, attempt) = opened(&server).await;
    attached(&mut ws, &attempt).await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    assert_eq!(close_code(&mut ws).await, 1008);
    // One socket is one attempt: the repeated open never reached the backend.
    assert_eq!(server.attempt_calls(), 1);
    assert_eq!(attempt.close_count(), 1);
    assert_eq!(server.st.terminals.len(), 0);
}

#[tokio::test]
async fn resize_and_ack_are_routed_with_ack_after_the_bytes_were_sent() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (mut ws, attempt) = opened(&server).await;
    attached(&mut ws, &attempt).await;

    // An ACK for output the browser has not been sent is refused, not credited.
    ws.send(Message::Text(r#"{"type":"ack","bytes":1}"#.into()))
        .await
        .unwrap();
    assert_eq!(close_code(&mut ws).await, 1008);
    assert!(attempt.acks().is_empty(), "unsent bytes are never credited");

    // Resize is routed to the same attempt.
    let server = Server::start(Duration::from_secs(15)).await;
    let (mut ws, attempt) = opened(&server).await;
    attached(&mut ws, &attempt).await;
    ws.send(Message::Text(
        r#"{"type":"resize","cols":120,"rows":50}"#.into(),
    ))
    .await
    .unwrap();
    wait_until("the resize", || {
        attempt.resizes()
            == vec![TerminalSize {
                cols: 120,
                rows: 50,
            }]
    })
    .await;
    // Output first, then the ACK the browser sends after parsing it.
    attempt.emit_data(vec![0xff, 0x00, 0x1b]);
    assert_eq!(next_binary(&mut ws).await, vec![0xff, 0x00, 0x1b]);
    ws.send(Message::Text(r#"{"type":"ack","bytes":3}"#.into()))
        .await
        .unwrap();
    wait_until("the ack", || attempt.acks() == vec![3]).await;
    // A zero ACK spends nothing and is accepted, as the Spec requires.
    ws.send(Message::Text(r#"{"type":"ack","bytes":0}"#.into()))
        .await
        .unwrap();
    wait_until("the zero ack", || attempt.acks() == vec![3, 0]).await;
    drop(ws);
}

#[tokio::test]
async fn early_input_is_forwarded_and_bad_frames_close_with_their_codes() {
    let server = Server::start(Duration::from_secs(15)).await;
    let mut ws = server.connect().await;

    // A binary frame before the open frame is a protocol error, not an early write.
    ws.send(Message::Binary(b"early".to_vec().into()))
        .await
        .unwrap();
    assert_eq!(close_code(&mut ws).await, 1008);
    assert_eq!(server.attempt_calls(), 0);

    // An open with an unknown target field is refused without allocating an attempt.
    ws = server.connect().await;
    ws.send(Message::Text(
        r#"{"type":"open","pane":{"session":"s","pane_id":"p1","terminal_id":"t"},"cols":80,"rows":24,"takeover":false}"#
            .into(),
    ))
    .await
    .unwrap();
    assert_eq!(close_code(&mut ws).await, 1008);
    assert_eq!(server.attempt_calls(), 0);

    // Malformed control text and an unknown command are policy failures.
    for (n, bad) in [
        r#"{"type":"resize","cols":80"#,
        r#"{"type":"bogus"}"#,
        r#"{"type":"ack","bytes":-1}"#,
    ]
    .into_iter()
    .enumerate()
    {
        let mut ws = server.connect().await;
        ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
        let attempt = server.opened_attempt(n).await;
        attached(&mut ws, &attempt).await;
        ws.send(Message::Text(bad.into())).await.unwrap();
        assert_eq!(close_code(&mut ws).await, 1008, "{bad}");
        assert_eq!(attempt.close_count(), 1, "{bad}");
    }

    // A binary input frame over 64 KiB is oversized, and one at the bound is not.
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    let attempt = server.opened_attempt(3).await;
    attached(&mut ws, &attempt).await;
    ws.send(Message::Binary(vec![b'x'; 64 * 1024 + 1].into()))
        .await
        .unwrap();
    assert_eq!(close_code(&mut ws).await, 1009);
    assert!(
        attempt.inputs().is_empty(),
        "an oversized frame is never written"
    );

    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    let attempt = server.opened_attempt(4).await;
    // Input is forwarded while core is still settling Attached: xterm's replies must not be
    // dropped in the gap between open succeeding and the first Attached event.
    ws.send(Message::Binary(vec![b'y'; 64 * 1024].into()))
        .await
        .unwrap();
    wait_until("the settling input", || {
        attempt.inputs() == vec![vec![b'y'; 64 * 1024]]
    })
    .await;
    attached(&mut ws, &attempt).await;
    drop(ws);
}

#[tokio::test(start_paused = true)]
async fn the_open_deadline_helper_fires_at_exactly_ten_seconds_on_a_controlled_clock() {
    // M1: the *production* helper the route calls, driven by a paused clock. Nothing here waits
    // in real time, and the assertion is the exact instant, not a range: a production bound of
    // 9 s or 11 s fails it.
    use herdly_web::terminal::socket::{IdleDeadline, OPEN_TIMEOUT};
    assert_eq!(OPEN_TIMEOUT, Duration::from_secs(10), "the shipped bound");

    let armed_at = tokio::time::Instant::now();
    let deadline = IdleDeadline::at(armed_at, OPEN_TIMEOUT);
    // Not due one nanosecond before, due exactly at the bound.
    assert!(!deadline.is_due_at(armed_at + OPEN_TIMEOUT - Duration::from_nanos(1)));
    assert!(deadline.is_due_at(armed_at + OPEN_TIMEOUT));

    // The same helper's wait: it must not return before the bound, and must return at it.
    let early = tokio::time::timeout_at(
        armed_at + OPEN_TIMEOUT - Duration::from_millis(1),
        deadline.expired(),
    )
    .await;
    assert!(early.is_err(), "the deadline must not fire early");
    deadline.expired().await;
    assert_eq!(
        tokio::time::Instant::now().duration_since(armed_at),
        OPEN_TIMEOUT,
        "the helper's wait ends exactly at the production bound"
    );
}

#[tokio::test]
async fn the_route_applies_the_open_deadline_it_was_configured_with() {
    // The route on a short bound: it enforces the configured deadline rather than an unrelated
    // one. The exact 10 s production value is pinned by the paused-clock test above.
    let server =
        Server::start_with_timeout(Duration::from_secs(15), Duration::from_millis(400)).await;
    let mut ws = server.connect().await;
    let started = std::time::Instant::now();
    assert_eq!(close_code(&mut ws).await, 1008);
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(400) && waited < Duration::from_millis(2_400),
        "the socket closes at its configured open deadline, waited {waited:?}"
    );
    assert_eq!(server.attempt_calls(), 0);
    assert!(server.st.terminals.is_empty());
}

#[tokio::test]
async fn an_open_frame_is_accepted_just_before_the_deadline_and_refused_past_it() {
    // The same seam, on a real clock but a short bound: one attempt arrives in time, one does
    // not, so the deadline is exercised without a ten-second wait.
    let server =
        Server::start_with_timeout(Duration::from_secs(15), Duration::from_millis(400)).await;
    let mut in_time = server.connect().await;
    in_time
        .send(open_frame("s", "p1", 80, 24, false))
        .await
        .unwrap();
    let attempt = server.opened_attempt(0).await;
    attached(&mut in_time, &attempt).await;

    let mut too_late = server.connect().await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    too_late
        .send(open_frame("s", "p2", 80, 24, false))
        .await
        .unwrap();
    assert_eq!(close_code(&mut too_late).await, 1008);
    // The late socket never allocated an attempt.
    assert_eq!(server.attempt_calls(), 1);
    drop(in_time);
}

#[tokio::test]
async fn a_ping_is_answered_by_the_socket_layer_not_the_protocol() {
    let server = Server::start(Duration::from_secs(15)).await;
    let mut ws = server.connect().await;
    // Before the open frame, a Ping is socket-layer traffic: it must be answered, not treated
    // as a malformed first frame.
    ws.send(Message::Ping(b"probe".to_vec().into()))
        .await
        .unwrap();
    loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .expect("the socket stays open")
            .unwrap()
            .unwrap()
        {
            Message::Pong(payload) => {
                assert_eq!(&payload[..], b"probe");
                break;
            }
            Message::Close(Some(frame)) => panic!("a ping closed the socket: {frame:?}"),
            _ => continue,
        }
    }
    // The deadline still applies: a Ping does not count as an open frame.
    assert_eq!(close_code(&mut ws).await, 1008);
}

#[tokio::test]
async fn a_client_close_ends_the_attempt_and_frees_its_registration() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (mut ws, attempt) = opened(&server).await;
    attached(&mut ws, &attempt).await;
    ws.send(Message::Close(None)).await.unwrap();
    wait_until("the attempt to close", || attempt.is_closed()).await;
    wait_until("the registration to clear", || {
        server.st.terminals.is_empty()
    })
    .await;
    assert_eq!(attempt.close_count(), 1);
}

#[tokio::test]
async fn an_open_failure_reports_an_error_frame_then_closes_1008() {
    let server = Server::start(Duration::from_secs(15)).await;
    *server.fake.terminal_error.lock().unwrap() = Some(herdly_core::error::AppError::new(
        "not_found",
        "unknown pane p1",
    ));
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    let error = next_event(&mut ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["error"]["code"], "not_found");
    assert_eq!(error["error"]["message"], "unknown pane p1");
    assert_eq!(close_code(&mut ws).await, 1008);
    assert!(server.st.terminals.is_empty());
}

#[tokio::test]
async fn a_full_output_queue_closes_the_socket_lagged() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (mut ws, attempt) = opened(&server).await;
    attached(&mut ws, &attempt).await;
    // 257 frames is one past the frame bound, whatever the peer does.
    for _ in 0..257 {
        attempt.emit_data(vec![b'x']);
    }
    assert_eq!(close_code(&mut ws).await, 4000);
    wait_until("the attempt to close", || attempt.is_closed()).await;
    assert_eq!(server.st.terminals.len(), 0);
}

#[tokio::test]
async fn a_disconnect_during_a_gated_open_still_closes_the_late_open() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (attempt, open_gate) = FakeTerminal::gated();
    server.fake.script_terminal(attempt.clone());
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    // The PTY spawn is still in flight: `open` recorded its size and is waiting.
    wait_until("the pending open", || attempt.sizes().len() == 1).await;
    assert!(!attempt.is_open());
    // The browser goes away while core is still spawning.
    drop(ws);
    wait_until("the registration to be owned", || {
        server.st.terminals.len() == 1
    })
    .await;
    // The spawn completes after the socket is gone. Its Attach must be closed, not orphaned.
    drop(open_gate);
    wait_until("the late open to be closed", || attempt.is_closed()).await;
    assert_eq!(attempt.close_count(), 1);
    wait_until("the registration to clear", || {
        server.st.terminals.is_empty()
    })
    .await;
}

#[tokio::test]
async fn a_blocked_write_does_not_prevent_the_close() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (attempt, write_gate) = FakeTerminal::gated_write();
    server.fake.script_terminal(attempt.clone());
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    let attempt = server.opened_attempt(0).await;
    attached(&mut ws, &attempt).await;
    ws.send(Message::Binary(b"stuck\r".to_vec().into()))
        .await
        .unwrap();
    // The PTY write is wedged, so the input worker is parked inside it.
    wait_until("the wedged write", || {
        attempt.inputs() == vec![b"stuck\r".to_vec()]
    })
    .await;
    // The client closing must still end the attempt inside the cleanup grace.
    ws.send(Message::Close(None)).await.unwrap();
    wait_until("the attempt to close behind a blocked write", || {
        attempt.is_closed()
    })
    .await;
    assert_eq!(attempt.close_count(), 1);
    // Cleanup reached `close` while the write was still wedged: the Attach child was killed
    // (and the attempt is over) before anything waited for the input worker to finish.
    assert_eq!(
        attempt.closed_with_writes_in_flight(),
        1,
        "close must run while the write is still wedged, not after joining the worker"
    );
    drop(write_gate);
    wait_until("the registration to clear", || {
        server.st.terminals.is_empty()
    })
    .await;
}

#[tokio::test]
async fn a_revoked_device_is_closed_4401_even_while_a_write_is_pending() {
    let server = Server::start(Duration::from_millis(50)).await;
    let (attempt, write_gate) = FakeTerminal::gated_write();
    server.fake.script_terminal(attempt.clone());
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    let attempt = server.opened_attempt(0).await;
    attached(&mut ws, &attempt).await;
    ws.send(Message::Binary(b"pending\r".to_vec().into()))
        .await
        .unwrap();
    wait_until("the pending write", || !attempt.inputs().is_empty()).await;
    // Revoke the device while that write is still stuck.
    let id = herdly_web::auth::list_devices(server.st.auth.store()).unwrap()[0]
        .id
        .clone();
    herdly_web::auth::revoke(server.st.auth.store(), &id).unwrap();
    assert_eq!(close_code(&mut ws).await, 4401);
    wait_until("the attempt to close", || attempt.is_closed()).await;
    drop(write_gate);
}

#[tokio::test]
async fn closing_one_attempt_leaves_the_other_delivering() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (mut first, a) = opened(&server).await;
    attached(&mut first, &a).await;
    let (mut second, b) = opened_nth(&server, 1).await;
    attached(&mut second, &b).await;
    // Two sockets for one Pane are two independent attempts.
    assert_eq!(server.attempt_calls(), 2);
    assert_eq!(
        server.fake.terminal_calls.lock().unwrap().len(),
        2,
        "each socket allocates its own attempt"
    );

    first.send(Message::Close(None)).await.unwrap();
    wait_until("the first attempt to close", || a.is_closed()).await;
    assert_eq!(a.close_count(), 1);
    // The second attempt is untouched by the first one's cleanup.
    assert!(!b.is_closed());
    assert_eq!(b.close_count(), 0);
    b.emit_data(b"still-here".to_vec());
    assert_eq!(next_binary(&mut second).await, b"still-here".to_vec());
    drop(second);
}

#[tokio::test]
async fn registry_shutdown_closes_live_attempts_and_refuses_new_sockets() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (mut first, a) = opened(&server).await;
    attached(&mut first, &a).await;
    let (mut second, b) = opened_nth(&server, 1).await;
    attached(&mut second, &b).await;
    assert_eq!(server.st.terminals.len(), 2);

    server.st.terminals.shutdown().await;
    assert!(a.is_closed());
    assert!(b.is_closed());
    assert!(server.st.terminals.is_empty());

    // No new attempt may start once shutdown has begun: the socket is ended lagged, so the
    // browser reconnects to the next process instead of believing the lens is over.
    let call_count = server.attempt_calls();
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    assert_eq!(close_code(&mut ws).await, 4000);
    assert_eq!(server.attempt_calls(), call_count);
    drop((first, second));
}

#[tokio::test]
async fn a_terminal_event_drains_its_grace_then_closes_normally() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (mut ws, attempt) = opened(&server).await;
    attached(&mut ws, &attempt).await;
    attempt.emit_event(herdly_core::attach::AttachEvent::Exited { code: Some(7) });
    assert_eq!(
        next_event(&mut ws).await,
        json!({"type": "exited", "code": 7})
    );
    // Output may still follow a terminal event inside the 250 ms grace, and it is delivered.
    tokio::time::sleep(Duration::from_millis(50)).await;
    attempt.emit_data(b"trailing".to_vec());
    assert_eq!(next_binary(&mut ws).await, b"trailing".to_vec());
    // Once the grace has run out the attempt is sealed and drained, so the close is normal.
    assert_eq!(close_code(&mut ws).await, 1000);
    wait_until("the attempt to close", || attempt.is_closed()).await;
    assert_eq!(server.st.terminals.len(), 0);
}

#[tokio::test]
async fn input_overflow_closes_lagged_and_discards_pending_input() {
    let server = Server::start(Duration::from_secs(15)).await;
    let attempt = FakeTerminal::parking_writes();
    server.fake.script_terminal(attempt.clone());
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    let attempt = server.opened_attempt(0).await;
    attached(&mut ws, &attempt).await;
    ws.send(Message::Binary(b"one\r".to_vec().into()))
        .await
        .unwrap();
    wait_until("the first write to wedge", || attempt.inputs().len() == 1).await;
    // The worker is parked, so every later frame stays queued until the bound is crossed.
    for _ in 0..80 {
        ws.send(Message::Binary(b"x".to_vec().into()))
            .await
            .unwrap();
    }
    assert_eq!(close_code(&mut ws).await, 4000);
    wait_until("the attempt to close", || attempt.is_closed()).await;
    // Pending input was discarded: only the frame already inside the wedged write remains.
    while attempt.release_write() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(attempt.inputs(), vec![b"one\r".to_vec()]);
}

#[tokio::test]
async fn an_unread_output_queue_does_not_hide_a_close() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (mut ws, attempt) = opened(&server).await;
    attached(&mut ws, &attempt).await;
    // This peer never reads again: 200 frames of 8 KiB fill any transport buffer.
    let chunk = vec![b'x'; 8 * 1024];
    for _ in 0..200 {
        attempt.emit_data(chunk.clone());
    }
    // A client that is gone is noticed even with output still queued, so the attempt ends
    // inside the send deadline rather than at the next keepalive that never comes.
    drop(ws);
    wait_until("the attempt to close for a nonreading peer", || {
        attempt.is_closed()
    })
    .await;
    assert_eq!(server.st.terminals.len(), 0);
}

/// A real-PTY backend: the same `Core`, with the attach command pointed at a fake herdr that
/// only runs its arguments. It exercises the real `OwnedTerminal`, `AttachManager` and `pty`
/// path without needing a herdr server, and without touching any real user Session.
struct RealPtyBackend {
    views: std::sync::Mutex<Vec<herdly_core::view::MachineView>>,
    wrapper: std::path::PathBuf,
}

#[async_trait::async_trait]
impl herdly_web::backend::Backend for RealPtyBackend {
    fn views(&self) -> Vec<herdly_core::view::MachineView> {
        self.views.lock().unwrap().clone()
    }
    async fn call(
        &self,
        _session: &str,
        _method: &str,
        _params: Value,
    ) -> herdly_core::error::AppResult<Value> {
        unreachable!("the terminal socket never calls")
    }
    async fn locate(
        &self,
        _pane: &herdly_web::backend::WebPane,
    ) -> herdly_core::error::AppResult<herdly_core::transcript::Located> {
        unreachable!("the terminal lens needs no transcript")
    }
    async fn open_chat(
        &self,
        _pane: &herdly_web::backend::WebPane,
        _path: Option<String>,
        _sink: herdly_core::transcript::Sink,
    ) -> herdly_core::error::AppResult<herdly_core::transcript::Located> {
        unreachable!("the terminal socket never opens Chat")
    }
    fn page(
        &self,
        _pane: &herdly_web::backend::WebPane,
        _before: usize,
        _limit: usize,
    ) -> Option<Vec<herdly_core::transcript::ChatItem>> {
        None
    }
    fn close_chat(&self, _pane: &herdly_web::backend::WebPane) {}
    async fn terminal(
        &self,
        pane: &herdly_web::backend::WebPane,
        takeover: bool,
    ) -> herdly_core::error::AppResult<Arc<dyn herdly_web::terminal::backend::TerminalHandle>> {
        let key = herdly_web::terminal::backend::resolve_terminal(&self.views(), pane)?;
        let argv = vec![
            self.wrapper.display().to_string(),
            key.terminal_id.clone(),
            if takeover { "--takeover" } else { "" }.to_string(),
        ];
        Ok(herdly_web::terminal::backend::OwnedTerminal::new(
            key,
            argv.into_iter().filter(|a| !a.is_empty()).collect(),
        ))
    }
}

/// A shell Pane the real path can resolve, under a Session name unique to this test.
fn real_view(session: &str, terminal_id: &str) -> herdly_core::view::MachineView {
    use herdly_core::herdr::types::AgentStatus;
    use herdly_core::view::{
        MachineState, MachineView, PaneView, SessionView, TabView, WorkspaceView,
    };
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
            name: session.into(),
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
                        terminal_id: terminal_id.into(),
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

/// A live serve() over the real PTY path, plus the fixture's own state dir.
struct RealServer {
    _dir: tempfile::TempDir,
    st: Arc<herdly_web::app::AppState>,
    /// The fixture's own unique Session name.
    session: String,
    cookie: String,
    url: String,
    _task: tokio::task::JoinHandle<()>,
    /// How many `attach` children this fixture started, from its own marker file.
    starts: std::path::PathBuf,
    /// One file per started attach child, so count only this fixture's live children.
    live: std::path::PathBuf,
}

impl RealServer {
    /// How many `attach` children this fixture started, from its own marker file.
    fn attach_starts(&self) -> usize {
        std::fs::read_to_string(&self.starts)
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    /// The same, with the payload held on `gate`: it waits for the file to exist, so the test
    /// decides when the Pane starts producing output.
    async fn start_gated_at(body: &str, gate: &std::path::Path) -> RealServer {
        RealServer::start_inner(body, Some(gate)).await
    }

    /// How many `attach` children of *this* fixture are still alive. The fixture's fake herdr
    /// records its pid before it becomes the PTY child, so concurrent tests never mix theirs in.
    fn live_children(&self) -> usize {
        let Ok(entries) = std::fs::read_dir(&self.live) else {
            return 0;
        };
        entries
            .flatten()
            .filter(|e| {
                // A file named `pid-<child pid>`, written before the child became the payload.
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(pid) = name.strip_prefix("pid-") else {
                    return false;
                };
                std::path::Path::new(&format!("/proc/{pid}")).exists()
            })
            .count()
    }

    /// The PIDs of *this* fixture's live attach children, newest first not guaranteed: the
    /// fixture's own marker files are the only source, so no other test's child can appear.
    fn live_child_pids(&self) -> Vec<u32> {
        let Ok(entries) = std::fs::read_dir(&self.live) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let pid = name.strip_prefix("pid-")?.parse::<u32>().ok()?;
                std::path::Path::new(&format!("/proc/{pid}"))
                    .exists()
                    .then_some(pid)
            })
            .collect()
    }

    /// Starts the server over a fake `herdr` that runs its argv on a real PTY.
    async fn start(body: &str) -> RealServer {
        RealServer::start_inner(body, None).await
    }

    /// The one starter: `gate` is handed to the payload through its environment when present.
    async fn start_inner(body: &str, gate: Option<&std::path::Path>) -> RealServer {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("attach-starts");
        let live = dir.path().join("attach-live");
        std::fs::create_dir_all(&live).unwrap();
        let wrapper = dir.path().join("fake-herdr");
        // Records this child's pid and start before becoming the payload, so the test can tell
        // which attach children of its own are still alive. With a gate, the payload is handed
        // the gate's path so it can hold its output until the test opens it.
        let body = match gate {
            Some(g) => format!("T8_GATE='{}'; export T8_GATE; {body}", g.display()),
            None => body.to_string(),
        };
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nprintf 'start\\n' >> '{}'\necho $$ > \"{}/pid-$$\"\nexec sh -c '{}'\n",
                marker.display(),
                live.display(),
                body.replace('\'', "'\\''")
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();

        let session = format!(
            "task4-fixture-{}-{:?}",
            std::process::id(),
            dir.path().file_name()
        );
        let mut view = real_view(&session, "term_1");
        // A second Pane on another Terminal, for the isolated-attempt case.
        view.sessions[0].workspaces[0].tabs[0]
            .panes
            .push(herdly_core::view::PaneView {
                pane_id: "p2".into(),
                terminal_id: "term_2".into(),
                title: "shell".into(),
                cwd: None,
                agent: None,
                status: herdly_core::herdr::types::AgentStatus::Idle,
            });
        let backend = Arc::new(RealPtyBackend {
            views: std::sync::Mutex::new(vec![view]),
            wrapper,
        });
        let st = herdly_web::testing::state_for(backend, dir.path(), Duration::from_secs(15));
        let cookie = paired_cookie(&st);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/ws/terminal", listener.local_addr().unwrap());
        let app = router(st.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        RealServer {
            _dir: dir,
            st,
            session,
            cookie,
            url,
            _task: task,
            starts: marker,
            live,
        }
    }

    async fn connect(&self) -> Ws {
        let mut req = self.url.clone().into_client_request().unwrap();
        req.headers_mut().insert("origin", ORIGIN.parse().unwrap());
        req.headers_mut().insert(
            "cookie",
            format!("herdly_web={}", self.cookie).parse().unwrap(),
        );
        tokio_tungstenite::connect_async(req).await.unwrap().0
    }
}

#[tokio::test]
async fn a_real_pty_attempt_closes_on_client_close_leaving_no_child() {
    let server = RealServer::start("printf 'ready\\n'; exec cat").await;
    let mut ws = server.connect().await;
    ws.send(open_frame(&server.session, "p1", 80, 24, false))
        .await
        .unwrap();
    assert_eq!(next_event(&mut ws).await["type"], "attached");
    assert_eq!(server.attach_starts(), 1);
    ws.send(Message::Binary(b"hello\r".to_vec().into()))
        .await
        .unwrap();
    // A real PTY echoes the input back through the real Sink and the real queue.
    let echoed = next_binary(&mut ws).await;
    assert!(echoed.windows(5).any(|w| w == b"hello"), "{echoed:?}");
    ws.send(Message::Close(None)).await.unwrap();
    ended(&mut ws).await;
    wait_until("the registration to clear", || {
        server.st.terminals.is_empty()
    })
    .await;
    // The Attach child was terminated: no orphan is left behind.
    wait_until("the attach child to exit", || server.live_children() == 0).await;
}

#[tokio::test]
async fn a_real_pty_attempt_is_closed_when_the_server_shuts_down() {
    let server = RealServer::start("printf 'ready\\n'; exec cat").await;
    let mut ws = server.connect().await;
    ws.send(open_frame(&server.session, "p1", 80, 24, false))
        .await
        .unwrap();
    assert_eq!(next_event(&mut ws).await["type"], "attached");
    // The fixture's attach child is running before shutdown is asked for.
    wait_until("the attach child to start", || server.live_children() == 1).await;
    // Graceful shutdown closes every live attempt before the runtime ends.
    server.st.terminals.shutdown().await;
    assert!(server.st.terminals.is_empty());
    wait_until("the attach child to exit", || server.live_children() == 0).await;
    // The socket learns its attempt is over and closes normally.
    assert!(
        matches!(close_code(&mut ws).await, 1000 | 1006),
        "an ended attempt"
    );
}

#[tokio::test]
async fn a_real_pty_blocked_write_does_not_prevent_the_close() {
    // This child never reads, so the PTY's own buffer fills and the input worker wedges in a
    // real `write` on the master, exactly the way a wedged attach does.
    let server = RealServer::start("printf 'ready\\n'; exec sleep 60").await;
    let mut ws = server.connect().await;
    ws.send(open_frame(&server.session, "p1", 80, 24, false))
        .await
        .unwrap();
    assert_eq!(next_event(&mut ws).await["type"], "attached");
    // Far more than a PTY buffer, in frames the protocol allows.
    for _ in 0..6 {
        ws.send(Message::Binary(vec![b'a'; 64 * 1024].into()))
            .await
            .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    // The client goes away with the Attach's write still stuck: cleanup kills the child first
    // and never waits on that write indefinitely.
    ws.send(Message::Close(None)).await.unwrap();
    ended(&mut ws).await;
    wait_until("the registration to clear behind a blocked write", || {
        server.st.terminals.is_empty()
    })
    .await;
    wait_until("the attach child to exit", || server.live_children() == 0).await;
}

#[tokio::test]
async fn a_message_over_the_transport_bound_closes_1009() {
    let server = Server::start(Duration::from_secs(15)).await;
    let mut ws = server.connect().await;
    // Past the transport's 2 MiB message bound, so the frame never reaches `decode`: the size
    // rejection comes from the socket layer itself and must still be reported as oversized.
    let huge = format!(
        r#"{{"type":"open","pad":"{}"}}"#,
        "x".repeat(2 * 1024 * 1024)
    );
    ws.send(Message::Text(huge.into())).await.unwrap();
    assert_eq!(close_code(&mut ws).await, 1009);
    assert_eq!(server.attempt_calls(), 0);
}

#[tokio::test]
async fn a_failed_open_reports_the_error_then_closes_1008() {
    let server = Server::start(Duration::from_secs(15)).await;
    // The attempt is allocated, but its PTY spawn fails: the socket must not sit waiting for
    // output a terminal that never started cannot produce.
    server
        .fake
        .script_terminal(FakeTerminal::failing(herdly_core::error::AppError::new(
            "io",
            "cannot open a pty",
        )));
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    let error = next_event(&mut ws).await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["error"]["code"], "io");
    assert_eq!(error["error"]["message"], "cannot open a pty");
    assert_eq!(close_code(&mut ws).await, 1008);
    // The allocated attempt was closed, and its registration was released.
    let attempt = server.fake.terminal_attempts.lock().unwrap()[0].clone();
    assert!(attempt.is_closed());
    wait_until("the registration to clear", || {
        server.st.terminals.is_empty()
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn a_slow_open_keeps_its_owner_until_the_late_completion_is_closed() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (attempt, open_gate) = FakeTerminal::gated();
    server.fake.script_terminal(attempt.clone());
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    wait_until("the pending open", || attempt.sizes().len() == 1).await;
    // The client goes away while the spawn is still in flight.
    drop(ws);
    wait_until("the registration to be owned", || {
        server.st.terminals.len() == 1
    })
    .await;
    // Advance the clock far past every cleanup bound the old code applied (the 10 s open
    // timeout and the 2 s close grace): the registration must survive, because nothing may
    // report this attempt clean while its open can still create an Attach. With a paused clock
    // this costs no wall-clock time.
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(
        server.st.terminals.len(),
        1,
        "the owner must outlive a slow open, not a timeout"
    );
    assert!(!attempt.is_closed());
    // Only when the spawn completes is it closed - once - and the entry released behind it.
    drop(open_gate);
    wait_until("the late open to be closed", || attempt.is_closed()).await;
    assert_eq!(attempt.close_count(), 1);
    wait_until("the registration to clear after cleanup", || {
        server.st.terminals.is_empty()
    })
    .await;
}

#[tokio::test]
async fn a_resize_burst_through_the_socket_stays_bounded_while_the_worker_is_stuck() {
    let server = Server::start(Duration::from_secs(15)).await;
    // The first resize is wedged on a PTY lock, so every later size has to wait behind it.
    let (attempt, resize_gate) = FakeTerminal::gated_resize();
    server.fake.script_terminal(attempt.clone());
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    let attempt = server.opened_attempt(0).await;
    attached(&mut ws, &attempt).await;

    // The stuck resize, then a burst of 60 more sizes while it is still held.
    ws.send(Message::Text(
        json!({"type": "resize", "cols": 10, "rows": 20})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    wait_until("the first resize to wedge", || attempt.resizes().len() == 1).await;
    for cols in 11..=70u16 {
        ws.send(Message::Text(
            json!({"type": "resize", "cols": cols, "rows": 20})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    // Bounded while stuck: only the wedged one ever entered the PTY, and the reader kept
    // answering, so its work did not become one task per frame.
    assert_eq!(
        attempt.resizes().len(),
        1,
        "a stuck resize must not queue one job per frame: {:?}",
        attempt.resizes()
    );
    assert_eq!(
        attempt.resizes_peak(),
        1,
        "resizes are serialized, never concurrent"
    );

    // Releasing it applies the newest size, in order after the stuck one.
    drop(resize_gate);
    wait_until("the newest size to be applied", || {
        attempt
            .resizes()
            .last()
            .is_some_and(|s| *s == TerminalSize { cols: 70, rows: 20 })
    })
    .await;
    assert_eq!(
        attempt.resizes_peak(),
        1,
        "the coalesced resize is serialized too"
    );

    // Closing still ends the attempt, burst or not.
    ws.send(Message::Close(None)).await.unwrap();
    wait_until("the attempt to close", || attempt.is_closed()).await;
    assert_eq!(server.st.terminals.len(), 0);
}

#[tokio::test]
async fn a_revoked_device_is_closed_4401_during_a_gated_open_and_the_late_open_is_cleaned() {
    let server = Server::start(Duration::from_millis(50)).await;
    let (attempt, open_gate) = FakeTerminal::gated();
    server.fake.script_terminal(attempt.clone());
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    wait_until("the pending open", || attempt.sizes().len() == 1).await;
    assert!(!attempt.is_open());
    // Revoke while the PTY spawn is still in flight: 4401 must arrive before the gate opens.
    let id = herdly_web::auth::list_devices(server.st.auth.store()).unwrap()[0]
        .id
        .clone();
    herdly_web::auth::revoke(server.st.auth.store(), &id).unwrap();
    assert_eq!(close_code(&mut ws).await, 4401);
    assert!(
        !attempt.is_closed(),
        "the socket ended while its open was still pending; cleanup owns it now"
    );
    // The registration is still held while the spawn is in flight: the socket's read loop is
    // gone, so only the supervisor can still own this attempt.
    assert_eq!(
        server.st.terminals.len(),
        1,
        "revocation must leave the attempt to its supervisor, not drop it"
    );
    // Releasing the gate completes the open after the socket is gone: it is closed exactly once
    // by the retained owner, and only then is the registration released.
    drop(open_gate);
    wait_until("the late open to be closed", || attempt.is_closed()).await;
    assert_eq!(attempt.close_count(), 1);
    wait_until("the registration to clear after cleanup", || {
        server.st.terminals.is_empty()
    })
    .await;
}

/// The real `serve` path in a real child process: only that proves SIGTERM reaches the
/// signal branch and the runtime exits cleanly, rather than only that `shutdown()` works when
/// a test calls it.
///
/// This deliberately serves no Terminal attempt. Attaching one would require the real local
/// herdr to list a Session, i.e. it would touch the user's own Sessions; the "signal closes a
/// live Attach" case is left to Task 8's real serving smoke, and the ordering it depends on
/// (close the Attach before joining workers) is covered by the real-PTY shutdown test above.
#[tokio::test]
async fn sigterm_through_the_real_serve_path_exits_cleanly() {
    use tokio::io::AsyncReadExt;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("index.html"),
        "<!doctype html><title>Herdly</title>",
    )
    .unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_herdly-web"))
        .arg("serve")
        .arg("--bind")
        .arg("127.0.0.1:0")
        .arg("--static")
        .arg(dir.path())
        .arg("--state")
        .arg(dir.path().join("state"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("the server binary runs");

    // The listening line is a tracing event, so it arrives on stderr. Waiting for it means the
    // signal lands on a server that really started serving.
    let mut stdout = child.stderr.take().unwrap();
    let mut seen = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        match tokio::time::timeout(Duration::from_secs(30), stdout.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => panic!(
                "no listening line from the real server: {:?}",
                String::from_utf8_lossy(&seen)
            ),
            Ok(Ok(n)) => {
                seen.extend_from_slice(&buf[..n]);
                if String::from_utf8_lossy(&seen)
                    .lines()
                    .any(|l| l.contains("herdly-web listening on"))
                {
                    break;
                }
            }
        }
    }

    let pid = child.id().expect("a child pid");
    // SAFETY: `pid` is this test's own freshly spawned child, and SIGTERM is the signal under
    // test. Nothing else in the process tree is signalled.
    let sent = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    assert_eq!(sent, 0, "the signal was delivered");
    let status = tokio::time::timeout(Duration::from_secs(60), child.wait())
        .await
        .expect("a signalled server exits rather than hanging")
        .unwrap();
    assert!(
        status.success(),
        "a graceful shutdown exits cleanly, not by the default handler: {status:?}"
    );
}

#[tokio::test]
async fn a_failed_open_whose_spawn_fails_after_a_client_disconnect_is_closed_exactly_once() {
    // The client goes away while the spawn is in flight, and that spawn then *fails*. The
    // attempt is still owned: it is closed exactly once, before its registration clears.
    let server = Server::start(Duration::from_secs(15)).await;
    let (attempt, open_gate) = FakeTerminal::gated();
    *attempt.pending_open_failure().lock().unwrap() =
        Some(herdly_core::error::AppError::new("io", "cannot open a pty"));
    server.fake.script_terminal(attempt.clone());
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p1", 80, 24, false)).await.unwrap();
    wait_until("the pending open", || attempt.sizes().len() == 1).await;
    // The browser goes away while core is still spawning, and the spawn then fails.
    drop(ws);
    wait_until("the registration to be owned", || {
        server.st.terminals.len() == 1
    })
    .await;
    drop(open_gate);
    // The failure must not leave the attempt unowned or half-closed.
    wait_until("the failed attempt to be closed", || attempt.is_closed()).await;
    assert_eq!(attempt.close_count(), 1, "closed exactly once");
    wait_until("the registration to clear after cleanup", || {
        server.st.terminals.is_empty()
    })
    .await;
}

#[tokio::test]
async fn a_client_close_during_a_failing_open_completes_the_handshake_and_cleans_up() {
    // Once the server has read WS Close, application data is no longer legal. Hold open
    // completion until the reply arrives to force that reader-first schedule.
    let server = Server::start(Duration::from_secs(15)).await;
    let (failing, gate) = FakeTerminal::gated();
    *failing.pending_open_failure().lock().unwrap() =
        Some(herdly_core::error::AppError::new("io", "cannot open a pty"));
    server.fake.script_terminal(failing.clone());
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p2", 80, 24, false)).await.unwrap();
    wait_until("the pending open", || failing.sizes().len() == 1).await;
    ws.send(Message::Close(None)).await.unwrap();
    assert!(
        matches!(next_msg(&mut ws).await, Message::Close(None)),
        "the server echoes the client's close, not a new application close code"
    );
    assert_eq!(
        server.st.terminals.len(),
        1,
        "the pending open remains owned"
    );
    assert!(!failing.is_closed(), "cleanup must await the pending open");
    drop(gate);
    wait_until("the failed attempt to be closed", || failing.is_closed()).await;
    assert_eq!(failing.close_count(), 1);
    wait_until("the registration to clear after cleanup", || {
        server.st.terminals.is_empty()
    })
    .await;
}

#[tokio::test]
async fn a_failed_gated_open_delivers_the_error_then_1008_to_a_live_peer() {
    let server = Server::start(Duration::from_secs(15)).await;
    let (failing, gate) = FakeTerminal::gated();
    *failing.pending_open_failure().lock().unwrap() =
        Some(herdly_core::error::AppError::new("io", "cannot open a pty"));
    server.fake.script_terminal(failing.clone());
    let mut ws = server.connect().await;
    ws.send(open_frame("s", "p2", 80, 24, false)).await.unwrap();
    wait_until("the pending open", || failing.sizes().len() == 1).await;
    // Keep the transport Active: only now is error-frame delivery a valid requirement.
    drop(gate);
    assert_eq!(
        next_event(&mut ws).await,
        json!({
            "type": "error", "error": {"code": "io", "message": "cannot open a pty"}
        })
    );
    assert_eq!(close_code(&mut ws).await, 1008);
    wait_until("the failed attempt to be closed", || failing.is_closed()).await;
    assert_eq!(failing.close_count(), 1);
    wait_until("the registration to clear after cleanup", || {
        server.st.terminals.is_empty()
    })
    .await;
}

/// A Pane that waits for the test's gate, then writes 4 MiB through the shell builtin
/// `printf`, so the test can watch it stall inside its own write. The 64 KiB line is built once
/// into a variable (no pipeline writes into the PTY), which leaves that `printf` as the only
/// blocking call.
#[cfg(target_os = "linux")]
const GATED_FLOOD_SCRIPT: &str = r#"printf 'READY\n'
BIG=$(dd if=/dev/zero bs=65536 count=1 2>/dev/null | tr '\0' 'x')
while [ ! -f "$T8_GATE" ]; do
  sleep 0.02
done
i=0
while [ $i -lt 64 ]; do
  printf '%s' "$BIG"
  i=$((i+1))
done
printf '\nTOTAL:4194304\n'
exit 0
"#;

/// What the Pane script intends to write before its own trailer.
#[cfg(target_os = "linux")]
const FLOOD_BYTES: usize = 64 * 65536;

/// Core's pause threshold (`HIGH_WATER` in `core/src/attach.rs`): past this many unacknowledged
/// bytes the attach reader stops forwarding until an ACK brings the debt back down.
#[cfg(target_os = "linux")]
const HIGH_WATER: usize = 1 << 20;

/// The other two core constants this test reasons with: the debt a paused reader must be brought
/// *under* before it forwards again (`LOW_WATER`), and the largest read it forwards per batch,
/// which is the most it can overshoot a threshold by (`READ_CHUNK`). Both are mirror images of
/// `core/src/attach.rs`, used only to bound what a pause can mean.
#[cfg(target_os = "linux")]
const LOW_WATER: usize = 512 * 1024;
#[cfg(target_os = "linux")]
const READ_CHUNK: usize = 64 * 1024;

/// Bytes `pid` has written so far, from `/proc/<pid>/io`. A writer blocked on a full PTY has
/// written less than it means to; that is what makes "paused reader" observable rather than
/// assumed.
#[cfg(target_os = "linux")]
fn written_bytes(pid: u32) -> Option<u64> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/io")).ok()?;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("wchar: ") {
            return v.trim().parse().ok();
        }
    }
    None
}

/// What the reading task saw, in the order the socket produced it.
#[cfg(target_os = "linux")]
#[derive(Debug)]
enum Wire {
    Data,
    Event(Value),
    Closed(Option<u16>),
}

/// Measures a pause from outside the code under test: two consecutive stable samples of the
/// wire count above `floor` while a Pane that has already written at least `min_written` bytes of
/// its own output has also gone quiet. Every part matters — a finished Pane is quiet too, a Pane
/// between writes looks briefly quiet, and without `min_written` the bytes an attempt emits before
/// it is Attached would let a "pause" be reported before the flood had even started. Both numbers
/// are read from outside the code under test: the socket's own frames, and the Pane's
/// `/proc/<pid>/io`.
#[cfg(target_os = "linux")]
async fn wait_paused(
    wire: &std::sync::atomic::AtomicUsize,
    child: u32,
    floor: usize,
    min_written: u64,
    deadline: Instant,
) -> Option<(usize, u64, Duration)> {
    let started = Instant::now();
    let mut last: Option<(usize, u64)> = None;
    while Instant::now() < deadline {
        let sample = (
            wire.load(std::sync::atomic::Ordering::SeqCst),
            written_bytes(child).unwrap_or(u64::MAX),
        );
        if sample.0 > floor && sample.1 >= min_written && last == Some(sample) {
            return Some((sample.0, sample.1, started.elapsed()));
        }
        if !std::path::Path::new(&format!("/proc/{child}")).exists() {
            return None;
        }
        last = Some(sample);
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    None
}

/// A real PTY whose writer is still blocked in its own write when this test releases its exit,
/// underneath a reader that has been paused on unacknowledged credit twice.
///
/// The recorder owns the socket from the attempt's **first** frame, so the bytes the Pane writes
/// before `Attached` are part of the wire count too: the peer is exposed to them, and core charges
/// them to the same debt. What the count measures is the total the peer has been handed; what an
/// ACK discharges is exactly the total that ACK names, so the bytes forwarded after it are the
/// difference between two measured totals, never core's private debt.
///
/// The `Data` notifications are deliberately withheld until after the second pause has been
/// observed: that makes the schedule where this task looks at the resumed reader only *after* it
/// has already stopped again a schedule this test forces, rather than a race it hopes to miss.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_real_pty_that_exits_while_its_reader_is_paused_past_the_high_water() {
    let dir = tempfile::tempdir().unwrap();
    let gate = dir.path().join("go");
    let server = RealServer::start_gated_at(GATED_FLOOD_SCRIPT, &gate).await;
    let mut ws = server.connect().await;
    ws.send(open_frame(&server.session, "p1", 80, 24, false))
        .await
        .unwrap();

    // Two halves, so no read is ever cancelled mid-frame: the reading task owns the stream, this
    // test owns the sink it sends ACKs on. Every binary frame is counted from the first one on,
    // including the ones that arrive before `Attached`: nothing here is thrown away by a helper
    // waiting for an event.
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Wire>();
    let wire_total = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = wire_total.clone();
    let hold_data = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let held = hold_data.clone();
    let reader = tokio::spawn(async move {
        loop {
            match stream.next().await {
                Some(Ok(Message::Binary(data))) => {
                    // Counted on arrival, never on delivery to this test: the count is the wire,
                    // not how fast the test task keeps up.
                    counter.fetch_add(data.len(), std::sync::atomic::Ordering::SeqCst);
                    if !held.load(std::sync::atomic::Ordering::SeqCst) {
                        let _ = tx.send(Wire::Data);
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    let e: Value = serde_json::from_str(&text).unwrap();
                    let _ = tx.send(Wire::Event(e));
                }
                Some(Ok(Message::Close(frame))) => {
                    let _ = tx.send(Wire::Closed(frame.map(|f| u16::from(f.code))));
                    return;
                }
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => {
                    let _ = tx.send(Wire::Closed(None));
                    return;
                }
            }
        }
    });

    // `Attached` comes through the recorder, so it is ordered behind every byte that preceded it.
    let attach_by = Instant::now() + Duration::from_secs(10);
    loop {
        let left = attach_by.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Some(Wire::Event(e))) if e["type"] == "attached" => break,
            Ok(Some(Wire::Data)) | Ok(Some(Wire::Event(_))) => continue,
            Ok(Some(Wire::Closed(code))) => {
                panic!("the attempt closed {code:?} before it was Attached")
            }
            Ok(None) => panic!("the attempt ended before it was Attached"),
            Err(_) => panic!("no Attached within 10 s"),
        }
    }
    // The Pane's `READY` is written before the flood gate, so a recorder that starts counting
    // only once `Attached` has been read would still be at zero here.
    let wire_at_attach = wire_total.load(std::sync::atomic::Ordering::SeqCst);
    assert!(
        wire_at_attach > 0,
        "the wire count must include the attempt's startup output, not start after Attached: \
         {wire_at_attach} bytes counted when Attached arrived"
    );
    wait_until("the attach child to start", || server.live_children() == 1).await;
    let child = server.live_child_pids()[0];

    // Release the flood and never acknowledge: the state a slow or absent browser leaves the
    // attach reader in. The bound is absolute and is never reset by the frames that keep coming.
    std::fs::write(&gate, b"go").unwrap();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(120);

    // --- 1. the reader really pauses, past core's high water mark ----------------------
    let (wire_1, written_1, paused_1) =
        wait_paused(&wire_total, child, 0, READ_CHUNK as u64, deadline)
            .await
            .unwrap_or_else(|| {
                panic!(
                    "the reader never paused: {} bytes on the wire, Pane wrote {} after {:?}",
                    wire_total.load(std::sync::atomic::Ordering::SeqCst),
                    written_bytes(child).unwrap_or(u64::MAX),
                    started.elapsed()
                )
            });
    eprintln!(
        "SLOWACK2: paused at {wire_1} bytes on the wire, Pane wrote {written_1} of {FLOOD_BYTES} \
         at {paused_1:?} (core high water {HIGH_WATER})"
    );
    // Nothing has been acknowledged, so all of those bytes are unacknowledged credit: core
    // stops only past its own threshold, so reaching the wire count above proves the pause.
    assert!(
        wire_1 >= HIGH_WATER,
        "core pauses only past its {HIGH_WATER}-byte high water mark; only {wire_1} bytes reached this socket"
    );
    // ...and the Pane still holds output it already produced and still wants to write.
    assert!(
        (written_1 as usize) < FLOOD_BYTES,
        "a paused reader cannot have taken the whole flood: the Pane wrote all {FLOOD_BYTES} bytes"
    );

    // Nothing was acknowledged, so all of those bytes are outstanding credit; a reader that
    // stops only past its threshold cannot have stopped under it. The other side of the bound
    // matters too: core forwards at most one read chunk past the threshold, so the wire count
    // pins the pause to that boundary instead of any large number.
    assert!(
        wire_1 <= HIGH_WATER + READ_CHUNK,
        "a paused reader stops within one read chunk of {HIGH_WATER}; {wire_1} bytes crossed the wire"
    );

    // --- 2. what the reader is waiting for is credit, not a dead peer -----------------
    // Acknowledging exactly what crossed the wire ends the pause: the reader forwards again and
    // then pauses a *second* time, a threshold of *new* credit later. A reader that had stopped
    // for any other reason (EOF, a wedged sink, a lost child) would not resume on an ACK.
    sink.send(Message::Text(
        json!({"type": "ack", "bytes": wire_1}).to_string().into(),
    ))
    .await
    .unwrap();

    // --- 3. the second pause is detected from the pre-ACK baseline --------------------
    // The floor is the wire total *before* the ACK, never a snapshot taken after it. The reading
    // task owns the socket and runs on its own, so by the time this task looks it may already have
    // consumed the whole next threshold and stopped again; a pause that has already happened is
    // still a pause, and its position is necessarily above the acknowledged one. `Data`
    // notifications are still withheld here, so this task provably has not kept up with the
    // reader and nothing below depends on it doing so.
    let second_pause = wait_paused(&wire_total, child, wire_1, READ_CHUNK as u64, deadline).await;
    hold_data.store(false, std::sync::atomic::Ordering::SeqCst);
    let (wire_2, written_2, paused_2) = second_pause.unwrap_or_else(|| {
        let mut closed = None;
        while let Ok(msg) = rx.try_recv() {
            if let Wire::Closed(code) = msg {
                closed = Some(code);
            }
        }
        panic!(
            "the reader did not pause again after the ACK for {wire_1} bytes: {} bytes on the \
             wire, Pane wrote {}, socket closed {closed:?}",
            wire_total.load(std::sync::atomic::Ordering::SeqCst),
            written_bytes(child).unwrap_or(u64::MAX)
        )
    });
    // The bytes forwarded in the second round only: the credit the reader spent after that ACK.
    let after_ack = wire_2 - wire_1;
    eprintln!(
        "SLOWACK2: paused again at {wire_2} bytes on the wire, {after_ack} of them after the ACK \
         for {wire_1}, Pane wrote {written_2} of {FLOOD_BYTES} at {paused_2:?}"
    );
    // A pause is a threshold away from the acknowledged position, not just "quiet later": the
    // resume loop leaves a debt under `LOW_WATER`, and the reader stops again only past
    // `HIGH_WATER`, so the second round must forward more than their difference, and cannot
    // overshoot by more than one read chunk. This bounds the observable wire delta; it does not
    // claim to read core's private debt.
    assert!(
        after_ack > HIGH_WATER - LOW_WATER,
        "after an ACK for {wire_1} bytes the reader must forward more than {} bytes of new \
         credit before pausing; only {after_ack} crossed the wire ({wire_2} in total)",
        HIGH_WATER - LOW_WATER
    );
    assert!(
        after_ack <= HIGH_WATER + READ_CHUNK,
        "the second pause lands within one read chunk of {HIGH_WATER} past the acknowledged \
         position; {after_ack} bytes were forwarded after it ({wire_2} in total)"
    );
    assert!(
        (written_2 as usize) < FLOOD_BYTES,
        "the Pane must still be blocked in its own write when its exit is released"
    );
    // The Pane is SIGKILLed where it stands, blocked inside its own write, so it exits underneath
    // a paused reader. The signal goes to this fixture's own attach child, taken from its own
    // marker file.
    unsafe { libc::kill(child as i32, libc::SIGKILL) };

    let mut exited = None;
    let mut code = None;
    while Instant::now() < deadline && (exited.is_none() || code.is_none()) {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, rx.recv()).await {
            Ok(Some(Wire::Event(e))) if e["type"] == "exited" => exited = exited.or(Some(e)),
            Ok(Some(Wire::Event(_))) => continue,
            Ok(Some(Wire::Closed(c))) => code = code.or(Some(c)),
            Ok(Some(Wire::Data)) => continue,
            Ok(None) => break,
            Err(_) => panic!("the exit is not reported inside the bound: {wire_2} bytes unacked"),
        }
    }
    let exited = exited.expect("an exited PTY under a paused reader reports it");
    assert_eq!(exited["type"], "exited", "{exited}");
    // The server seals and closes by itself: this client never sends Close, so a server that
    // waited for its peer would never end the attempt.
    assert_eq!(
        code.expect("the attempt ends itself after the exit"),
        Some(1000),
        "an exited PTY ends as a normal close, {wire_2} bytes unacked"
    );
    // Bounded completion, no ACK for the paused bytes, and no claim about retaining all output.
    assert!(
        started.elapsed() < Duration::from_secs(60),
        "the whole run took {:?}",
        started.elapsed()
    );
    eprintln!("SLOWACK2: closed 1000 at {:?}", started.elapsed());
    reader.abort();
    wait_until("the attach child to exit", || server.live_children() == 0).await;
}
