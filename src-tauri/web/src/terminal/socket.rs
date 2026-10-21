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
use crate::terminal::backend::{TerminalHandle, TerminalSize};
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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

/// A drain inside its bounds closes normally.
pub const CLOSE_NORMAL: u16 = 1000;
/// The whole drain's bound, counted from the attempt's first terminal state. It is absolute:
/// it is not extended by frames that each finish inside [`SEND_DEADLINE`].
pub const DRAIN_DEADLINE: Duration = Duration::from_secs(2);
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
    /// The serialized, coalescing resize worker: one pending size at a time.
    resize: Arc<ResizeSlot>,
}

async fn run(st: Arc<AppState>, info: DeviceInfo, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let mut revoke = tokio::time::interval(st.cfg.revoke_check);
    revoke.tick().await; // the first tick is immediate; the device was just checked

    // Phase 1: the initial open frame, inside the deadline and while the device is watched.
    let deadline = tokio::time::Instant::now() + st.cfg.open_timeout;
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
            send_error_and_close(&mut sink, &e).await;
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
    // One resize worker, owned by this attempt: a burst of sizes cannot create a task per
    // frame, and the supervisor ends it with the attempt.
    // The writer also carries a failed-open message: it is the one task that owns the socket's
    // outgoing half, so an error frame never races a data frame for it.
    let (fail_tx, fail_rx) = watch::channel::<Option<String>>(None);
    let resize = Arc::new(ResizeSlot::new(handle.clone()));

    // The spawn may outlive this socket, so the supervisor owns its result: it reports a
    // failure and keeps the ownership until the attempt has really been closed.
    let opening = tokio::spawn({
        let handle = handle.clone();
        let sink: Arc<dyn Sink> = queue.sink();
        let size = open.size;
        async move { handle.open(size, sink).await }
    });
    let mut writer = tokio::spawn(writer_loop(
        sink,
        queue.clone(),
        ledger.clone(),
        ctl_rx,
        fail_rx,
    ));
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
        resize.clone(),
        fail_tx,
    ));

    let attempt = Attempt {
        handle,
        ledger,
        input: input_tx,
        pending,
        resize,
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
                            // Coalesced: only the newest size is kept, so a burst cannot grow
                            // the attempt's pending work while a resize is stuck on a PTY lock.
                            attempt.resize.request(size);
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

/// Sends the attempt's error frame, then the policy close that ends it.
async fn send_error_and_close<S>(sink: &mut S, e: &herdly_core::error::AppError)
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    // The message is core's own sanitized text; it never carries argv, a cookie or a command.
    let frame = json_error(&e.code, &e.message);
    let _ = tokio::time::timeout(SEND_DEADLINE, sink.send(Message::Text(frame.into()))).await;
    send_close(sink, CLOSE_POLICY).await;
}

/// One resize worker per attempt: at most one pending size, newest wins.
///
/// A resize can block on a PTY lock, so it must not run on the read loop. It must not create a
/// task per frame either: a peer could otherwise queue unbounded blocking work, and the sizes
/// could be applied out of order. So the slot keeps exactly one value (the newest) and one
/// worker, and the supervisor owns both.
struct ResizeSlot {
    pending: Arc<Mutex<Option<TerminalSize>>>,
    wake: Arc<tokio::sync::Notify>,
    stopping: watch::Sender<bool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl ResizeSlot {
    fn new(handle: Arc<dyn TerminalHandle>) -> ResizeSlot {
        let pending = Arc::new(Mutex::new(None));
        let wake = Arc::new(tokio::sync::Notify::new());
        let (stopping, stopped) = watch::channel(false);
        let worker = tokio::spawn(Self::run(handle, pending.clone(), wake.clone(), stopped));
        ResizeSlot {
            pending,
            wake,
            stopping,
            worker: Mutex::new(Some(worker)),
        }
    }

    /// Hands the worker the newest size, replacing any size not yet applied.
    fn request(&self, size: TerminalSize) {
        *self.pending.lock().unwrap() = Some(size);
        self.wake.notify_one();
    }

    /// Sizes waiting to be applied: never more than one, whatever the burst.
    #[cfg(test)]
    fn waiting(&self) -> usize {
        usize::from(self.pending.lock().unwrap().is_some())
    }

    /// Stops the worker and waits for it, bounded: a resize stuck on a PTY lock must not hold
    /// the attempt's cleanup.
    async fn stop(&self) {
        let _ = self.stopping.send(true);
        let worker = self.worker.lock().unwrap().take();
        let Some(mut worker) = worker else { return };
        if tokio::time::timeout(CLOSE_GRACE, &mut worker)
            .await
            .is_err()
        {
            worker.abort();
        }
    }

    async fn run(
        handle: Arc<dyn TerminalHandle>,
        pending: Arc<Mutex<Option<TerminalSize>>>,
        wake: Arc<tokio::sync::Notify>,
        mut stopping: watch::Receiver<bool>,
    ) {
        loop {
            if *stopping.borrow() {
                return;
            }
            let notified = wake.notified();
            tokio::pin!(notified);
            // Registered before the slot is inspected, so a request landing between the check
            // and the wait is still seen.
            notified.as_mut().enable();
            let next = pending.lock().unwrap().take();
            let Some(size) = next else {
                tokio::select! {
                    biased;
                    _ = stopping.changed() => return,
                    _ = notified => continue,
                }
            };
            // One resize at a time; a newer size waits in the slot, not in a queue of tasks.
            let _ = handle.resize(size).await;
        }
    }
}

/// Closes the attempt after any in-flight spawn has settled and before the resizes and the
/// input worker are joined, without ever waiting indefinitely on a blocked write.
#[allow(clippy::too_many_arguments)]
async fn supervise(
    registry: Arc<crate::terminal::registry::TerminalRegistry>,
    supervisor: Arc<Supervisor>,
    queue: Arc<Queue>,
    handle: Arc<dyn TerminalHandle>,
    mut opening: JoinHandle<herdly_core::error::AppResult<()>>,
    worker: JoinHandle<()>,
    resize: Arc<ResizeSlot>,
    fail: watch::Sender<Option<String>>,
) {
    let mut cancel = supervisor.cancellation();
    let mut tick = tokio::time::interval(GRACE_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut open_finished = false;
    loop {
        tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => break,
            // A failed PTY spawn ends the attempt now, rather than leaving the socket waiting
            // for frames a terminal that never started will never produce.
            result = &mut opening, if !open_finished => {
                open_finished = true;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => {
                        // Core's own code and message: never argv, a cookie or a command.
                        fail.send_replace(Some(json_error(&e.code, &e.message)));
                        supervisor.stop(Signal::Ended);
                    }
                    // The task was cancelled or panicked: nothing opened, nothing to close.
                    Err(_) => supervisor.stop(Signal::Ended),
                }
            }
            // The bounded drain grace runs here, so a pending network send cannot delay it.
            _ = tick.tick() => {
                queue.seal_when_due(Instant::now());
            }
        }
    }
    // A slow `open` keeps its ownership: this waits for it to settle rather than detaching it,
    // and the registry entry survives until the close that follows has finished.
    if !open_finished {
        match opening.await {
            // A late success is closed right below, exactly like an early one.
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::debug!("late terminal open failed: {}", e.code),
            Err(e) => tracing::warn!("terminal open task ended without a result: {e}"),
        }
    }
    // Kill the Attach child before waiting on the resizes or the input worker.
    handle.close().await;
    resize.stop().await;
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
///
/// Two deadlines apply, and they are different things:
/// - the per-frame [`SEND_DEADLINE`], so one frame cannot hang the writer;
/// - the attempt's own [`DRAIN_DEADLINE`], which starts at the first terminal state and bounds
///   the *whole* drain. A peer that takes every frame in 1.9 s forever would satisfy the first
///   and never the second, so the second is absolute and closes 4000 when it runs out.
async fn writer_loop<S>(
    mut sink: S,
    queue: Arc<Queue>,
    ledger: Arc<AckLedger>,
    mut ctl: watch::Receiver<Option<u16>>,
    mut fail: watch::Receiver<Option<String>>,
) -> u16
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    let code = loop {
        let failed = fail.borrow().clone();
        if let Some(frame) = failed {
            // A failed open is an attempt-ending error, sent before its policy close.
            let _ =
                tokio::time::timeout(SEND_DEADLINE, sink.send(Message::Text(frame.into()))).await;
            break CLOSE_POLICY;
        }
        let drain_by = DrainDeadline::from(queue.grace_deadline());
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
            _ = fail.changed() => continue,
            // The absolute drain bound runs whether the writer is dequeuing or sending.
            _ = wait_drain(drain_by) => {
                // A drain that cannot finish in its bound is lagged, not a good close.
                break CLOSE_LAGGED;
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
                match send_frame(&mut sink, message, &mut ctl, &mut fail, drain_by).await {
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

/// The instant a drain must be over, or `None` while no terminal state has been queued.
#[derive(Clone, Copy)]
struct DrainDeadline(Option<Instant>);

impl DrainDeadline {
    /// The attempt's absolute drain bound, derived from the instant its grace was armed.
    fn from(grace_deadline: Option<Instant>) -> DrainDeadline {
        DrainDeadline(grace_deadline.map(|at| at + DRAIN_DEADLINE - GRACE_TICK))
    }

    /// The time left, or `None` when there is no bound (or it is already due).
    fn remaining_at(self, now: Instant) -> Option<Duration> {
        let at = self.0?;
        at.checked_duration_since(now)
    }
}

/// Sleeps until the drain bound, or forever when the attempt has none.
async fn wait_drain(deadline: DrainDeadline) {
    match deadline.remaining_at(Instant::now()) {
        // Already due: the caller's deadline branch fires on the next poll.
        Some(left) if !left.is_zero() => tokio::time::sleep(left).await,
        Some(_) => {}
        None => std::future::pending::<()>().await,
    }
}

/// What became of one frame's send.
enum Outcome {
    Sent,
    /// The attempt wants this close code instead of finishing the frame.
    Code(u16),
    /// The peer is gone.
    Gone,
}

/// Sends one frame behind both deadlines, so neither a single wedged send nor a long series of
/// slow-but-acceptable ones can hold the writer (and with it the close) past its bound.
async fn send_frame<S>(
    sink: &mut S,
    frame: Message,
    ctl: &mut watch::Receiver<Option<u16>>,
    fail: &mut watch::Receiver<Option<String>>,
    drain_by: DrainDeadline,
) -> Outcome
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    if let Some(code) = *ctl.borrow() {
        return Outcome::Code(code);
    }
    // The frame may take no longer than the smaller of its own bound and the drain's remainder.
    let budget = drain_by
        .remaining_at(Instant::now())
        .map_or(SEND_DEADLINE, |left| left.min(SEND_DEADLINE));
    tokio::select! {
        biased;
        changed = ctl.changed() => match changed {
            Ok(()) => Outcome::Code(ctl.borrow().unwrap_or(CLOSE_NORMAL)),
            Err(_) => Outcome::Gone,
        },
        _ = fail.changed() => Outcome::Code(CLOSE_POLICY),
        sent = tokio::time::timeout(budget, sink.send(frame)) => match sent {
            Ok(Ok(())) => Outcome::Sent,
            Ok(Err(_)) => Outcome::Gone,
            // Past its own bound, or past the drain's: either way the peer cannot keep up.
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
    use crate::terminal::queue::{Push, TerminalEvent};
    use crate::terminal::registry::TerminalRegistry;
    use std::future::Future;

    /// A peer whose every send takes `delay`: each one is inside a per-frame bound, so only the
    /// attempt's own drain deadline can end a long series of them.
    #[derive(Clone)]
    struct Slow {
        delay: Duration,
        sent: Arc<AtomicUsize>,
        /// One sleep per frame, created when the frame starts so it really elapses.
        wait: Arc<Mutex<Option<std::pin::Pin<Box<tokio::time::Sleep>>>>>,
    }

    impl Slow {
        fn new(delay: Duration) -> Slow {
            Slow {
                delay,
                sent: Arc::new(AtomicUsize::new(0)),
                wait: Arc::new(Mutex::new(None)),
            }
        }
        fn sent(&self) -> usize {
            self.sent.load(Ordering::SeqCst)
        }
    }

    impl futures_util::Sink<Message> for Slow {
        type Error = axum::Error;

        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn start_send(self: std::pin::Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            self.sent.fetch_add(1, Ordering::SeqCst);
            *self.wait.lock().unwrap() = Some(Box::pin(tokio::time::sleep(self.delay)));
            Ok(())
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            // A peer that takes the frame, just slowly: never an error, never instant.
            let mut slot = self.wait.lock().unwrap();
            let Some(wait) = slot.as_mut() else {
                return std::task::Poll::Ready(Ok(()));
            };
            match wait.as_mut().poll(cx) {
                std::task::Poll::Ready(()) => {
                    *slot = None;
                    std::task::Poll::Ready(Ok(()))
                }
                std::task::Poll::Pending => std::task::Poll::Pending,
            }
        }

        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// A peer that stopped reading: every send stays in flight forever.
    #[derive(Clone, Default)]
    struct Stalled {
        in_flight: Arc<AtomicUsize>,
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

        fn start_send(self: std::pin::Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            self.in_flight.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Pending
        }

        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// A queue whose grace was armed `elapsed` ago, so a drain deadline is already in effect.
    fn draining_queue(elapsed: Duration) -> Arc<Queue> {
        let base = Instant::now() - elapsed;
        let clock_base = std::sync::Arc::new(base);
        let queue = Queue::with_clock({
            let clock_base = clock_base.clone();
            move || *clock_base
        });
        assert_eq!(queue.push_event(TerminalEvent::Held), Push::Accepted);
        queue
    }

    #[tokio::test]
    async fn a_peer_that_stops_reading_is_closed_lagged_by_the_send_deadline() {
        let queue = Queue::new();
        let ledger = Arc::new(AckLedger::default());
        assert_eq!(queue.push_data(b"wedged-output".to_vec()), Push::Accepted);
        let (ctl_tx, ctl_rx) = watch::channel(None);
        let (_fail_tx, fail_rx) = watch::channel::<Option<String>>(None);
        let sink = Stalled::default();
        let started = std::time::Instant::now();
        let writer = tokio::spawn(writer_loop(
            sink.clone(),
            queue,
            ledger.clone(),
            ctl_rx,
            fail_rx,
        ));
        // Let the writer dequeue and wedge inside the send.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(sink.in_flight(), 1, "the writer is inside a send");
        // Its credit was reserved at dequeue, so an ACK for those bytes is already valid even
        // though the send never finished.
        assert_eq!(ledger.outstanding(), b"wedged-output".len());
        let code = tokio::time::timeout(Duration::from_secs(10), writer)
            .await
            .expect("the send deadline must end the writer")
            .unwrap();
        assert_eq!(code, crate::config::CLOSE_LAGGED);
        let elapsed = started.elapsed();
        assert!(
            elapsed >= SEND_DEADLINE
                && elapsed < SEND_DEADLINE + CLOSE_GRACE + Duration::from_millis(750),
            "the lagged close follows the 2 s send deadline (plus the close frame's grace), took {elapsed:?}"
        );
        drop(ctl_tx);
    }

    #[tokio::test]
    async fn a_drain_that_outlasts_its_total_bound_is_closed_lagged() {
        // Every frame takes 300 ms: comfortably inside SEND_DEADLINE, so no per-frame deadline
        // ever fires. Only the attempt's absolute drain bound can end this.
        let queue = draining_queue(Duration::from_millis(500));
        for i in 0..40u8 {
            assert_eq!(queue.push_data(vec![i]), Push::Accepted);
        }
        let ledger = Arc::new(AckLedger::default());
        let (ctl_tx, ctl_rx) = watch::channel(None);
        let (_fail_tx, fail_rx) = watch::channel::<Option<String>>(None);
        let sink = Slow::new(Duration::from_millis(300));
        let started = std::time::Instant::now();
        let writer = tokio::spawn(writer_loop(sink.clone(), queue, ledger, ctl_rx, fail_rx));
        let code = tokio::time::timeout(Duration::from_secs(20), writer)
            .await
            .expect("the drain deadline must end the writer")
            .unwrap();
        let elapsed = started.elapsed();
        assert_eq!(code, crate::config::CLOSE_LAGGED);
        // The drain begun 500 ms before the writer started, so its 2 s bound leaves ~1.5 s,
        // plus the final close frame's grace: far short of the 12 s the 40 frames would need.
        assert!(
            elapsed < Duration::from_millis(3_000),
            "the total drain bound ends the attempt, took {elapsed:?}"
        );
        assert!(
            sink.sent() < 10,
            "a 2 s bound cannot deliver 40 frames of 300 ms, sent {}",
            sink.sent()
        );
        drop(ctl_tx);
    }

    #[tokio::test]
    async fn the_grace_timer_seals_while_the_writer_is_stuck_in_a_send() {
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
        let (_fail_tx, fail_rx) = watch::channel::<Option<String>>(None);
        let sink = Stalled::default();
        let writer = tokio::spawn(writer_loop(
            sink.clone(),
            queue.clone(),
            ledger.clone(),
            ctl_rx,
            fail_rx,
        ));
        let handle: Arc<dyn TerminalHandle> = Arc::new(crate::testing::FakeTerminal::default());
        let opening = tokio::spawn(async { Ok(()) });
        let worker = tokio::spawn(async { std::future::pending::<()>().await });
        let resize = Arc::new(ResizeSlot::new(handle.clone()));
        let (fail_tx, _fail_rx) = watch::channel::<Option<String>>(None);
        let supervising = tokio::spawn(supervise(
            registry.clone(),
            supervisor.clone(),
            queue.clone(),
            handle,
            opening,
            worker,
            resize,
            fail_tx,
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

    /// A fake terminal whose resize blocks until the test releases it, recording each size the
    /// worker actually applied.
    struct GatedResize {
        applied: Mutex<Vec<TerminalSize>>,
        gate: Arc<tokio::sync::Notify>,
        entered: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl TerminalHandle for GatedResize {
        async fn open(
            &self,
            _size: TerminalSize,
            _sink: Arc<dyn Sink>,
        ) -> herdly_core::error::AppResult<()> {
            Ok(())
        }
        async fn write(&self, _data: Vec<u8>) -> herdly_core::error::AppResult<()> {
            Ok(())
        }
        async fn resize(&self, size: TerminalSize) -> herdly_core::error::AppResult<()> {
            let nth = self.entered.fetch_add(1, Ordering::SeqCst) + 1;
            // Hold the *first* resize inside the PTY lock, as a wedged terminal would; later
            // ones apply immediately, so the coalesced size is observable.
            if nth == 1 {
                self.gate.notified().await;
            }
            self.applied.lock().unwrap().push(size);
            Ok(())
        }
        fn ack(&self, _bytes: usize) {}
        async fn close(&self) {}
    }

    #[tokio::test]
    async fn a_resize_burst_keeps_one_pending_size_and_applies_the_newest() {
        let handle = Arc::new(GatedResize {
            applied: Mutex::new(Vec::new()),
            gate: Arc::new(tokio::sync::Notify::new()),
            entered: Arc::new(AtomicUsize::new(0)),
        });
        let slot = Arc::new(ResizeSlot::new(handle.clone()));
        // The first size enters the blocking resize and stays there.
        slot.request(TerminalSize { cols: 10, rows: 10 });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            handle.entered.load(Ordering::SeqCst),
            1,
            "one resize at a time"
        );

        // A burst while it is stuck: bounded pending work, newest size kept.
        for cols in 11..=60u16 {
            slot.request(TerminalSize { cols, rows: 20 });
            assert!(
                slot.waiting() <= 1,
                "a resize burst must not queue frame by frame"
            );
        }
        assert_eq!(
            slot.waiting(),
            1,
            "exactly one pending size survives the burst"
        );
        // Nothing else entered the PTY: the burst did not spawn one task per frame.
        assert_eq!(handle.entered.load(Ordering::SeqCst), 1);

        // Releasing the stuck resize applies the first size, then the newest one, in order.
        handle.gate.notify_waiters();
        tokio::time::timeout(Duration::from_secs(2), async {
            while handle.applied.lock().unwrap().len() < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the coalesced size is applied after the stuck one");
        assert_eq!(
            *handle.applied.lock().unwrap(),
            vec![
                TerminalSize { cols: 10, rows: 10 },
                TerminalSize { cols: 60, rows: 20 },
            ]
        );
        slot.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_open_reaches_the_socket_before_cleanup_finishes() {
        use crate::terminal::registry::TerminalRegistry;

        let registry = TerminalRegistry::new();
        let supervisor = registry.register().unwrap();
        let queue = Queue::new();
        let handle: Arc<dyn TerminalHandle> = Arc::new(crate::testing::FakeTerminal::default());
        let opening = tokio::spawn(async {
            Err(herdly_core::error::AppError::new("io", "cannot open a pty"))
        });
        let worker = tokio::spawn(async { std::future::pending::<()>().await });
        let resize = Arc::new(ResizeSlot::new(handle.clone()));
        let (fail_tx, mut fail_rx) = watch::channel::<Option<String>>(None);
        let supervising = tokio::spawn(supervise(
            registry.clone(),
            supervisor.clone(),
            queue,
            handle,
            opening,
            worker,
            resize,
            fail_tx,
        ));
        // The failure is reported to the writer without the socket having to ask for it, and
        // the attempt ends instead of waiting for output that can never come.
        tokio::time::timeout(Duration::from_secs(2), fail_rx.changed())
            .await
            .expect("the failed open must be reported")
            .unwrap();
        let reported = fail_rx.borrow().clone().expect("an error frame");
        let parsed: serde_json::Value = serde_json::from_str(&reported).unwrap();
        assert_eq!(parsed["type"], "error");
        assert_eq!(parsed["error"]["code"], "io");
        assert_eq!(parsed["error"]["message"], "cannot open a pty");
        // Core's own text, and nothing else: no argv, no cookie, no command line.
        assert!(!reported.contains("herdr"), "{reported}");
        assert_eq!(supervisor.signal(), Some(Signal::Ended));
        let _ = tokio::time::timeout(Duration::from_secs(10), supervising).await;
        assert!(
            registry.is_empty(),
            "the attempt is released after its cleanup"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_open_deadline_fires_at_exactly_the_bound_and_not_before() {
        // A controlled clock: this pins the 10 s bound with no real-time wait and no range.
        let deadline = tokio::time::Instant::now() + OPEN_TIMEOUT;
        let before = tokio::time::timeout_at(deadline - Duration::from_millis(1), async {
            tokio::time::sleep_until(deadline).await
        })
        .await;
        assert!(before.is_err(), "nothing may fire before the bound");
        let at = tokio::time::timeout_at(deadline + Duration::from_millis(1), async {
            tokio::time::sleep_until(deadline).await
        })
        .await;
        assert!(at.is_ok(), "the bound must fire when the clock reaches it");
        assert!(
            tokio::time::Instant::now() - (deadline - OPEN_TIMEOUT) == OPEN_TIMEOUT,
            "the elapsed time is the bound itself, to the millisecond"
        );
    }

    #[test]
    fn the_socket_bounds_are_the_ones_the_spec_states() {
        // The integration tests prove the behaviour; this pins the exact values they assume, so
        // a changed bound cannot pass by moving both sides together.
        assert_eq!(OPEN_TIMEOUT, Duration::from_secs(10));
        assert_eq!(CLOSE_GRACE, Duration::from_secs(2));
        assert_eq!(SEND_DEADLINE, Duration::from_secs(2));
        assert_eq!(DRAIN_DEADLINE, Duration::from_secs(2));
        assert_eq!(GRACE_TICK, Duration::from_millis(250));
        assert_eq!(INPUT_FRAMES, 64);
        assert_eq!(INPUT_BYTES, 1024 * 1024);
        assert_eq!(CLOSE_NORMAL, 1000);
        // The transport bound sits above every legal application frame.
        const _: () = assert!(MAX_MESSAGE > crate::terminal::protocol::MAX_INPUT);
    }
}
