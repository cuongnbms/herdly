//! The `/ws/terminal` socket: one Terminal Attach per connection, owned end to end.
//!
//! One socket is one attempt. The client sends exactly one `open` frame inside
//! [`OPEN_TIMEOUT`]; after that, binary frames are raw input and text frames are control
//! (`resize`, `ack`, `close`). Invalid frames close with 1008, oversized ones with 1009, a
//! revoked device with 4401, an input queue overflow with 4000, and a good drain with 1000.
//!
//! Ownership never belongs to the socket task alone. [`supervise`] runs as its own task and
//! owns the handle: it waits for the attempt to end (the socket's own first signal, cancellation
//! or registry shutdown) while running the terminal-state grace timer, then closes the Attach
//! after any in-flight `open` has settled, kills the input worker, and only then releases the
//! registration. The socket task holds a guard whose `drop` asks the supervisor to stop, so a
//! socket cancelled at any await - including in the middle of a `spawn_blocking` PTY spawn -
//! never leaves a child Attach behind.
use crate::app::AppState;
use crate::auth::DeviceInfo;
use crate::config::{CLOSE_LAGGED, CLOSE_REVOKED};
use crate::terminal::backend::TerminalHandle;
use crate::terminal::protocol::{decode, Command, CLOSE_OVERSIZED, CLOSE_POLICY};
use crate::terminal::queue::{AckLedger, Frame, Queue, Stop};
use crate::terminal::registry::{Signal, Supervisor};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::Extension;
use futures_util::{SinkExt, StreamExt};
use herdly_core::attach::Sink;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

/// A drain inside its bounds closes normally.
pub const CLOSE_NORMAL: u16 = 1000;
/// The initial open frame must arrive within this long of the upgrade.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the final close frame may take to reach a peer.
pub const CLOSE_GRACE: Duration = Duration::from_secs(2);
/// One frame's send deadline: a peer that cannot take it is lagged, never waited on.
pub const SEND_DEADLINE: Duration = Duration::from_secs(2);
/// The supervisor's tick: how often the terminal-state grace is checked while draining.
pub const GRACE_TICK: Duration = Duration::from_millis(250);
/// Input frames serialized through the write worker.
pub const INPUT_FRAMES: usize = 64;
/// Input bytes accepted but not yet written to the PTY.
pub const INPUT_BYTES: usize = 1024 * 1024;
/// The transport's message bound, above every legal application frame: a frame past it is one
/// the transport refuses itself, so its close code is chosen here (see [`oversize`]).
pub const MAX_MESSAGE: usize = 2 * 1024 * 1024;

/// Mounted behind the Origin and cookie middleware, so a refused request never upgrades.
pub async fn ws_handler(
    State(st): State<Arc<AppState>>,
    Extension(info): Extension<DeviceInfo>,
    ws: WebSocketUpgrade,
) -> Response {
    // Explicit message limits before the upgrade: nothing past them is buffered.
    let ws = ws.max_message_size(MAX_MESSAGE).max_frame_size(MAX_MESSAGE);
    if st.terminals.is_shutting_down() {
        // Authenticated, but no attempt may start while the process is ending. 4000 asks the
        // browser to reconnect rather than treating this attempt as finished.
        return ws.on_upgrade(|mut socket| async move {
            let _ = send_close(&mut socket, CLOSE_LAGGED).await;
        });
    }
    ws.on_upgrade(move |socket| run(st, info, socket))
}

/// Whether the transport refused a frame for its size, before it ever reached [`decode`].
fn oversize(err: &axum::Error) -> bool {
    // tungstenite reports a capacity failure as "Space limit exceeded: Message too long: …".
    let text = err.to_string();
    text.contains("Message too long") || text.contains("Space limit exceeded")
}

/// Asks the writer for the first close code this attempt wants. The first request wins.
fn request_close(ctl: &watch::Sender<Option<u16>>, code: u16) {
    ctl.send_if_modified(|cur| {
        if cur.is_none() {
            *cur = Some(code);
            true
        } else {
            false
        }
    });
}

async fn send_close<S>(sink: &mut S, code: u16)
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let close = Message::Close(Some(CloseFrame {
        code,
        reason: "".into(),
    }));
    let _ = tokio::time::timeout(CLOSE_GRACE, sink.send(close)).await;
}

/// Asks the supervisor to stop this attempt even when the socket task is cancelled outright.
struct StopOnDrop(Arc<Supervisor>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        // First signal wins, so a code the read loop already chose is not overwritten here.
        self.0.stop(Signal::Ended);
    }
}

/// Resolves once the attempt has been asked to stop.
async fn cancelled(rx: &mut watch::Receiver<bool>) {
    while !*rx.borrow() {
        if rx.changed().await.is_err() {
            return;
        }
    }
}

/// What the read loop routes frames to once the attempt exists.
struct Attempt {
    handle: Arc<dyn TerminalHandle>,
    ledger: Arc<AckLedger>,
    input: mpsc::Sender<Vec<u8>>,
    /// Input bytes accepted but not yet written to the PTY: the byte half of the input bound.
    pending: Arc<AtomicUsize>,
}

async fn run(st: Arc<AppState>, info: DeviceInfo, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let mut revoke = tokio::time::interval(st.cfg.revoke_check);
    revoke.tick().await; // the first tick is immediate; the device was just checked

    // Phase 1: the initial open frame, inside the deadline and while the device is watched.
    let deadline = tokio::time::Instant::now() + OPEN_TIMEOUT;
    let open = loop {
        tokio::select! {
            biased;
            _ = revoke.tick() => {
                if !device_live(&st, &info).await {
                    send_close(&mut sink, CLOSE_REVOKED).await;
                    return;
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                // The client never said what to attach to: an incomplete attempt, which the
                // browser must not retry blindly.
                send_close(&mut sink, CLOSE_POLICY).await;
                return;
            }
            msg = stream.next() => {
                let msg = match msg {
                    None => return,
                    Some(Err(e)) => {
                        send_close(&mut sink, if oversize(&e) { CLOSE_OVERSIZED } else { CLOSE_NORMAL }).await;
                        return;
                    }
                    Some(Ok(msg)) => msg,
                };
                // Ping/Pong/Close belong to the socket layer, never to `decode`.
                match msg {
                    Message::Ping(_) | Message::Pong(_) => continue,
                    Message::Close(_) => return,
                    other => match decode(other) {
                        Ok(Command::Open(r)) => break r,
                        // Any other frame before the first open, including a second open, is a
                        // protocol error: one socket is one attempt.
                        Ok(_) => {
                            send_close(&mut sink, CLOSE_POLICY).await;
                            return;
                        }
                        Err(code) => {
                            send_close(&mut sink, code).await;
                            return;
                        }
                    },
                }
            }
        }
    };

    // The backend resolves the Pane; nothing browser-supplied reaches the Attach command.
    let handle = match st.backend.terminal(&open.pane, open.takeover).await {
        Ok(h) => h,
        Err(e) => {
            // An application error frame ends this attempt: only a manual Reattach may retry.
            let frame = json_error(&e.code, &e.message);
            let _ =
                tokio::time::timeout(SEND_DEADLINE, sink.send(Message::Text(frame.into()))).await;
            send_close(&mut sink, CLOSE_POLICY).await;
            return;
        }
    };

    // Registration is the one synchronous decision about shutdown, and nothing awaits between
    // it and the supervisor being in place.
    let Some(supervisor) = st.terminals.register() else {
        // The attempt was allocated but may not be registered, so it is closed right here.
        send_close(&mut sink, CLOSE_LAGGED).await;
        let _ = tokio::time::timeout(CLOSE_GRACE, handle.close()).await;
        return;
    };
    // Declared before every other binding, so the supervisor is still registered while the
    // rest of this attempt's state is dropped, and is told to clean up afterwards.
    let _stop = StopOnDrop(supervisor.clone());
    let mut cancel_rx = supervisor.cancellation();

    let queue = Queue::new();
    let ledger = Arc::new(AckLedger::default());
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(INPUT_FRAMES);
    let pending = Arc::new(AtomicUsize::new(0));
    let (ctl_tx, ctl_rx) = watch::channel::<Option<u16>>(None);

    // The spawn may outlive this socket's cancellation, so the supervisor owns its result and
    // closes the handle only after it settles.
    let opening = tokio::spawn({
        let handle = handle.clone();
        let sink: Arc<dyn Sink> = queue.sink();
        let size = open.size;
        async move { handle.open(size, sink).await }
    });
    let mut writer = tokio::spawn(writer_loop(sink, queue.clone(), ledger.clone(), ctl_rx));
    let worker = tokio::spawn(input_loop(
        handle.clone(),
        pending.clone(),
        input_rx,
        supervisor.cancellation(),
    ));
    let _supervisor = tokio::spawn(supervise(
        st.terminals.clone(),
        supervisor.clone(),
        queue.clone(),
        handle.clone(),
        opening,
        worker,
    ));

    let attempt = Attempt {
        handle,
        ledger,
        input: input_tx,
        pending,
    };

    // Phase 2: reads, revocation, cancellation and writer termination, concurrently.
    let mut writer_done = false;
    loop {
        tokio::select! {
            biased;
            _ = cancelled(&mut cancel_rx) => {
                let code = supervisor
                    .signal()
                    .and_then(|s| s.close_code())
                    .unwrap_or(CLOSE_NORMAL);
                request_close(&ctl_tx, code);
                break;
            }
            _ = &mut writer => {
                writer_done = true;
                break;
            }
            _ = revoke.tick() => {
                if !device_live(&st, &info).await {
                    // Stop first: the Attach is closed before the writer is joined.
                    supervisor.stop(Signal::Ended);
                    request_close(&ctl_tx, CLOSE_REVOKED);
                    break;
                }
            }
            msg = stream.next() => {
                let msg = match msg {
                    None => break,
                    Some(Err(e)) => {
                        request_close(&ctl_tx, if oversize(&e) { CLOSE_OVERSIZED } else { CLOSE_NORMAL });
                        break;
                    }
                    Some(Ok(msg)) => msg,
                };
                match msg {
                    Message::Ping(_) | Message::Pong(_) => continue,
                    Message::Close(_) => {
                        request_close(&ctl_tx, CLOSE_NORMAL);
                        break;
                    }
                    other => match decode(other) {
                        Ok(Command::Input(bytes)) => {
                            let len = bytes.len();
                            // Both bounds are checked before anything is queued: input is
                            // never buffered past them, and an overflow closes lagged.
                            let too_much =
                                attempt.pending.load(Ordering::SeqCst) + len > INPUT_BYTES
                                    || attempt.input.try_send(bytes).is_err();
                            if too_much {
                                supervisor.stop(Signal::InputOverflow);
                                request_close(&ctl_tx, CLOSE_LAGGED);
                                break;
                            }
                            attempt.pending.fetch_add(len, Ordering::SeqCst);
                        }
                        Ok(Command::Resize(size)) => {
                            // A resize can block on a PTY lock: it must not stall this loop.
                            let handle = attempt.handle.clone();
                            tokio::spawn(async move {
                                let _ = handle.resize(size).await;
                            });
                        }
                        Ok(Command::Ack(bytes)) => match attempt.ledger.ack(bytes) {
                            // Only credit the attempt really sent reaches its handle.
                            Ok(()) => attempt.handle.ack(bytes),
                            Err(code) => {
                                request_close(&ctl_tx, code);
                                break;
                            }
                        },
                        Ok(Command::Close) => {
                            request_close(&ctl_tx, CLOSE_NORMAL);
                            break;
                        }
                        // One socket is one attempt: a repeated open is a protocol error.
                        Ok(Command::Open(_)) => {
                            request_close(&ctl_tx, CLOSE_POLICY);
                            break;
                        }
                        Err(code) => {
                            request_close(&ctl_tx, code);
                            break;
                        }
                    },
                }
            }
        }
    }

    // A reader that ended without choosing a code (the peer simply went away) still owes the
    // writer an end, or it would wait for frames that can never come.
    request_close(&ctl_tx, CLOSE_NORMAL);
    // The socket is over, so the Attach must not outlive it: close it before waiting on the
    // writer, whose peer may be slow to take the final frames.
    supervisor.stop(Signal::Ended);
    // The writer sends the close frame and ends; keep its control channel alive until then.
    if !writer_done
        && tokio::time::timeout(CLOSE_GRACE + SEND_DEADLINE, &mut writer)
            .await
            .is_err()
    {
        writer.abort();
    }
    drop(attempt);
}

/// Closes the attempt after any in-flight spawn has settled and before the input worker is
/// joined, without ever waiting indefinitely on a blocked write.
async fn supervise(
    registry: Arc<crate::terminal::registry::TerminalRegistry>,
    supervisor: Arc<Supervisor>,
    queue: Arc<Queue>,
    handle: Arc<dyn TerminalHandle>,
    opening: JoinHandle<herdly_core::error::AppResult<()>>,
    worker: JoinHandle<()>,
) {
    let mut cancel = supervisor.cancellation();
    let mut tick = tokio::time::interval(GRACE_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            // The bounded drain grace runs here, so a pending network send cannot delay it.
            _ = tick.tick() => {
                queue.seal_when_due(Instant::now());
            }
        }
    }

    // An `open` still spawning would create its Attach after this close and leave a child
    // nobody owns, so wait for it to settle first.
    if tokio::time::timeout(OPEN_TIMEOUT, opening).await.is_err() {
        tracing::warn!("terminal open did not settle before cleanup");
    }
    // Kill the Attach child before waiting on the input worker.
    if tokio::time::timeout(CLOSE_GRACE, handle.close())
        .await
        .is_err()
    {
        tracing::warn!("terminal close exceeded its grace");
    }
    let mut worker = worker;
    if tokio::time::timeout(CLOSE_GRACE, &mut worker)
        .await
        .is_err()
    {
        // A blocked PTY write must never hold cleanup open.
        worker.abort();
    }
    registry.finish(&supervisor);
}

/// Serializes input into the PTY, discarding anything not yet written when the attempt ends.
async fn input_loop(
    handle: Arc<dyn TerminalHandle>,
    pending: Arc<AtomicUsize>,
    mut input: mpsc::Receiver<Vec<u8>>,
    mut cancel: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => return,
            next = input.recv() => match next {
                None => return,
                Some(bytes) => {
                    let len = bytes.len();
                    let _ = handle.write(bytes).await;
                    pending.fetch_sub(len, Ordering::SeqCst);
                }
            },
        }
    }
}

/// Sends the attempt's frames in queue order, reserving wire credit before each send, and ends
/// with the close code the attempt earned.
async fn writer_loop<S>(
    mut sink: S,
    queue: Arc<Queue>,
    ledger: Arc<AckLedger>,
    mut ctl: watch::Receiver<Option<u16>>,
) -> u16
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let code = loop {
        tokio::select! {
            biased;
            changed = ctl.changed() => {
                if changed.is_err() {
                    // Nobody can ask for a code any more; the peer is gone either way.
                    send_close(&mut sink, CLOSE_NORMAL).await;
                    return CLOSE_NORMAL;
                }
                if let Some(code) = *ctl.borrow() {
                    break code;
                }
            }
            frame = queue.next_for_send(&ledger) => {
                let message = match frame {
                    Ok(Frame::Binary(bytes)) => Message::Binary(bytes.into()),
                    Ok(Frame::Event(event)) => {
                        let text = serde_json::to_string(&event).expect("an event always serializes");
                        Message::Text(text.into())
                    }
                    // A sealed, drained attempt is a good close; lost bytes are not.
                    Err(Stop::Sealed) => break CLOSE_NORMAL,
                    Err(Stop::Overflow) => break CLOSE_LAGGED,
                };
                match send_frame(&mut sink, message, &mut ctl).await {
                    Outcome::Sent => {}
                    Outcome::Code(code) => break code,
                    Outcome::Gone => return CLOSE_NORMAL,
                }
            }
        }
    };
    send_close(&mut sink, code).await;
    code
}

/// What became of one frame's send.
enum Outcome {
    Sent,
    /// The attempt wants this close code instead of finishing the frame.
    Code(u16),
    /// The peer is gone.
    Gone,
}

/// Sends one frame behind a deadline: a peer that stopped reading cannot hold the writer, and
/// with it the close, forever.
async fn send_frame<S>(
    sink: &mut S,
    frame: Message,
    ctl: &mut watch::Receiver<Option<u16>>,
) -> Outcome
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    if let Some(code) = *ctl.borrow() {
        return Outcome::Code(code);
    }
    tokio::select! {
        biased;
        changed = ctl.changed() => match changed {
            Ok(()) => Outcome::Code(ctl.borrow().unwrap_or(CLOSE_NORMAL)),
            Err(_) => Outcome::Gone,
        },
        sent = tokio::time::timeout(SEND_DEADLINE, sink.send(frame)) => match sent {
            Ok(Ok(())) => Outcome::Sent,
            Ok(Err(_)) => Outcome::Gone,
            // A peer that cannot take a frame inside the drain deadline is lagged.
            Err(_) => Outcome::Code(CLOSE_LAGGED),
        },
    }
}

/// Whether the socket's device is still paired.
async fn device_live(st: &Arc<AppState>, info: &DeviceInfo) -> bool {
    let auth = st.auth.clone();
    let id = info.device_id.clone();
    // `is_live` may re-read `devices.json`: keep it off the runtime.
    tokio::task::spawn_blocking(move || auth.is_live(&id))
        .await
        .unwrap_or(true)
}

fn json_error(code: &str, message: &str) -> String {
    serde_json::json!({"type": "error", "error": {"code": code, "message": message}}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A peer that stopped reading: every send is accepted into the buffer but never flushed.
    #[derive(Clone, Default)]
    struct Stalled {
        in_flight: Arc<AtomicUsize>,
        buffered: Arc<Mutex<Vec<Message>>>,
    }

    impl Stalled {
        fn in_flight(&self) -> usize {
            self.in_flight.load(Ordering::SeqCst)
        }
    }

    impl futures_util::Sink<Message> for Stalled {
        type Error = axum::Error;

        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn start_send(self: std::pin::Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.in_flight.fetch_add(1, Ordering::SeqCst);
            self.buffered.lock().unwrap().push(item);
            Ok(())
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            // Exactly the wedged network send: the bytes never reach the peer.
            std::task::Poll::Pending
        }

        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Pending
        }
    }

    #[tokio::test]
    async fn a_peer_that_stops_reading_is_closed_lagged_by_the_send_deadline() {
        let queue = Queue::new();
        let ledger = Arc::new(AckLedger::default());
        assert_eq!(
            queue.push_data(b"wedged-output".to_vec()),
            crate::terminal::queue::Push::Accepted
        );
        let (ctl_tx, ctl_rx) = watch::channel(None);
        let sink = Stalled::default();
        let started = std::time::Instant::now();
        let writer = tokio::spawn(writer_loop(sink.clone(), queue, ledger.clone(), ctl_rx));
        // Let the writer dequeue and wedge inside the send.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(sink.in_flight(), 1, "the writer is inside a send");
        // Its credit was reserved at dequeue, so an ACK for those bytes is already valid even
        // though the send never finished.
        assert_eq!(ledger.outstanding(), b"wedged-output".len());
        // Nothing else ends this attempt: the per-frame deadline alone must.
        let code = tokio::time::timeout(Duration::from_secs(10), writer)
            .await
            .expect("the send deadline must end the writer")
            .unwrap();
        assert_eq!(code, crate::config::CLOSE_LAGGED);
        // The frame's own deadline is what ends the wait (a peer that never reads waits
        // forever without it), and the final close frame's grace adds a bounded second wait.
        let elapsed = started.elapsed();
        assert!(
            elapsed >= SEND_DEADLINE
                && elapsed < SEND_DEADLINE + CLOSE_GRACE + Duration::from_millis(750),
            "the lagged close follows the 2 s send deadline, took {elapsed:?}"
        );
        drop(ctl_tx);
    }

    #[tokio::test]
    async fn the_grace_timer_seals_while_the_writer_is_stuck_in_a_send() {
        use crate::terminal::queue::{Push, TerminalEvent};
        use crate::terminal::registry::TerminalRegistry;

        let registry = TerminalRegistry::new();
        let supervisor = registry.register().unwrap();
        let queue = Queue::new();
        // The terminal state is queued first: its grace is armed now, and its event is the
        // frame the writer would send. Output behind it keeps the queue non-empty.
        assert_eq!(queue.push_event(TerminalEvent::Held), Push::Accepted);
        let deadline = queue
            .grace_deadline()
            .expect("a terminal state arms the grace");
        assert_eq!(queue.push_data(b"output".to_vec()), Push::Accepted);

        let ledger = Arc::new(AckLedger::default());
        let (ctl_tx, ctl_rx) = watch::channel(None);
        let sink = Stalled::default();
        let writer = tokio::spawn(writer_loop(
            sink.clone(),
            queue.clone(),
            ledger.clone(),
            ctl_rx,
        ));
        // A handle that never finishes closing keeps the supervisor's cleanup off this path.
        let handle: Arc<dyn TerminalHandle> = Arc::new(crate::testing::FakeTerminal::default());
        let opening = tokio::spawn(async { Ok(()) });
        let worker = tokio::spawn(async { std::future::pending::<()>().await });
        let supervising = tokio::spawn(supervise(
            registry.clone(),
            supervisor.clone(),
            queue.clone(),
            handle,
            opening,
            worker,
        ));

        // The writer is wedged inside its first send and cannot reach the event or the seal.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(sink.in_flight(), 1, "the writer never got a frame out");
        assert!(!queue.is_sealed(), "the grace has not run out yet");

        // The supervisor's 250 ms tick seals the attempt while that send is still pending.
        tokio::time::timeout(Duration::from_secs(2), async {
            while !queue.is_sealed() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the grace timer must not wait for the pending send");
        assert!(
            Instant::now() >= deadline,
            "it sealed no earlier than the grace deadline"
        );
        assert_eq!(
            sink.in_flight(),
            1,
            "sealing waited for nothing on the wire"
        );

        drop(ctl_tx);
        let _ = writer.await;
        supervisor.stop(Signal::Ended);
        let _ = tokio::time::timeout(Duration::from_secs(10), supervising).await;
        assert!(registry.is_empty());
    }

    #[test]
    fn the_socket_bounds_are_the_ones_the_spec_states() {
        // The integration tests prove the behaviour; this pins the exact values they assume, so
        // a changed bound cannot pass by moving both sides together.
        assert_eq!(OPEN_TIMEOUT, Duration::from_secs(10));
        assert_eq!(CLOSE_GRACE, Duration::from_secs(2));
        assert_eq!(SEND_DEADLINE, Duration::from_secs(2));
        assert_eq!(GRACE_TICK, Duration::from_millis(250));
        assert_eq!(INPUT_FRAMES, 64);
        assert_eq!(INPUT_BYTES, 1024 * 1024);
        assert_eq!(CLOSE_NORMAL, 1000);
        // The transport bound sits above every legal application frame.
        const _: () = assert!(MAX_MESSAGE > crate::terminal::protocol::MAX_INPUT);
    }
}
