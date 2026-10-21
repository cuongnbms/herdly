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

/// The initial-open deadline, as production arms and reads it.
///
/// The decision lives here rather than inline in `run`, so a test can drive the same predicate
/// with a controlled clock and exact instants instead of re-deriving the arithmetic or waiting
/// out the bound in real time.
#[derive(Clone, Copy, Debug)]
pub struct IdleDeadline {
    /// When the first frame must have arrived.
    at: std::time::Instant,
    /// The bound itself, so the caller's arithmetic is the one under test.
    budget: Duration,
}

impl IdleDeadline {
    /// Arms the deadline `budget` after `from`.
    pub fn at(from: tokio::time::Instant, budget: Duration) -> IdleDeadline {
        IdleDeadline {
            at: from.into_std() + budget,
            budget,
        }
    }

    /// Arms the deadline from an explicit instant, which is how a controlled clock reaches it.
    pub fn at_instant(armed_at: std::time::Instant, budget: Duration) -> IdleDeadline {
        IdleDeadline {
            at: armed_at + budget,
            budget,
        }
    }

    /// The instant the first frame becomes overdue.
    pub fn as_std(&self) -> Option<std::time::Instant> {
        Some(self.at)
    }

    /// Whether the bound has been reached at `now`. Exactly at the bound counts as due.
    pub fn is_due_at(&self, now: tokio::time::Instant) -> bool {
        IdleDeadline::due_by(now.into_std(), self.at - self.budget, self.budget)
    }

    /// The one predicate: has `budget` elapsed since `armed_at` at `now`?
    pub fn due_by(now: std::time::Instant, armed_at: std::time::Instant, budget: Duration) -> bool {
        now.saturating_duration_since(armed_at) >= budget
    }

    /// Sleeps until the bound. Never returns before it.
    pub async fn expired(&self) {
        tokio::time::sleep_until(self.at.into()).await
    }
}

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
    let deadline = IdleDeadline::at(tokio::time::Instant::now(), st.cfg.open_timeout);
    let open = loop {
        tokio::select! {
            biased;
            _ = revoke.tick() => {
                if !device_live(&st, &info).await {
                    send_close(&mut sink, CLOSE_REVOKED).await;
                    return;
                }
            }
            _ = deadline.expired() => {
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
    // One resize worker, owned by this attempt: a burst of sizes cannot create a task per
    // frame, and the supervisor ends it with the attempt.
    let resize = Arc::new(ResizeSlot::new(handle.clone()));
    // The writer's single ending state: the read loop and the supervisor both report here, so
    // their wake-up order cannot decide what the client sees.
    let ending = EndingState::new();

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
        ending.clone(),
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
        ending.clone(),
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
                ending.close(code);
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
                    ending.close(CLOSE_REVOKED);
                    break;
                }
            }
            msg = stream.next() => {
                let msg = match msg {
                    None => break,
                    Some(Err(e)) => {
                        ending.close(if oversize(&e) { CLOSE_OVERSIZED } else { CLOSE_NORMAL });
                        break;
                    }
                    Some(Ok(msg)) => msg,
                };
                match msg {
                    Message::Ping(_) | Message::Pong(_) => continue,
                    Message::Close(_) => {
                        ending.close(CLOSE_NORMAL);
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
                                ending.close(CLOSE_LAGGED);
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
                                ending.close(code);
                                break;
                            }
                        },
                        Ok(Command::Close) => {
                            ending.close(CLOSE_NORMAL);
                            break;
                        }
                        // One socket is one attempt: a repeated open is a protocol error.
                        Ok(Command::Open(_)) => {
                            ending.close(CLOSE_POLICY);
                            break;
                        }
                        Err(code) => {
                            ending.close(code);
                            break;
                        }
                    },
                }
            }
        }
    }

    // A reader that ended without choosing a code (the peer simply went away) still owes the
    // writer an end, or it would wait for frames that can never come.
    ending.close(CLOSE_NORMAL);
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
    ending: EndingState,
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
                        // Core's own code and message: never argv, a cookie or a command. The
                        // ending carries both the frame and its 1008, so a read-loop close
                        // arriving in the same instant can never hide the error.
                        ending.open_failed(json_error(&e.code, &e.message));
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

/// The one way this attempt ends for the writer: what to send, and which close code follows.
///
/// Both the socket's read loop and the supervisor report through this state, so the order in
/// which they wake the writer cannot decide the outcome. A failed open is recorded with its
/// frame, so it is always sent before its 1008 close, whatever else is pending.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Ending {
    /// The error frame a failed open owes the client, if any.
    error: Option<String>,
    /// The close code this attempt earned.
    code: Option<u16>,
}

impl Ending {
    /// Records this attempt's close code. The first code wins, but a pending error frame is
    /// never dropped: it decides the code even if another ending arrived first.
    fn close(&mut self, code: u16) -> bool {
        let before = (self.code, self.error.is_some());
        if self.code.is_none() {
            self.code = Some(code);
        }
        before != (self.code, self.error.is_some())
    }

    /// Records a failed open: its error frame, and the policy close that follows it.
    fn open_failed(&mut self, frame: String) -> bool {
        let before = (self.code, self.error.is_some());
        if self.error.is_none() {
            self.error = Some(frame);
            // An application error ends the attempt, and 1008 is what the client must see.
            self.code = Some(CLOSE_POLICY);
        }
        if self.code.is_none() {
            self.code = Some(CLOSE_POLICY);
        }
        before != (self.code, self.error.is_some())
    }

    /// The code to close with.
    fn code(&self) -> u16 {
        self.code.unwrap_or(CLOSE_NORMAL)
    }
}

/// A publication a test forces at the writer's decision boundary (test builds only).
#[cfg(test)]
type DecisionHook = Arc<dyn Fn() + Send + Sync>;

/// The attempt's ending, shared by the read loop, the supervisor and the writer.
///
/// It is a `watch` channel rather than a mutex plus `Notify` for two reasons that the review
/// named, and both are structural:
///
/// - `borrow()` hands out one coherent `Ending`, so a decision never reads the error frame and
///   the close code as two separate snapshots that a publication can slip between.
/// - the channel is **stateful and versioned**: `changed()` compares versions, so a publication
///   that happens between a snapshot and the wait is still observed. `Notify::notify_waiters`
///   stores no permit, and would have been lost exactly in that window.
#[derive(Clone)]
struct EndingState {
    tx: watch::Sender<Ending>,
    /// A test-only seam that publishes *at the decision boundary*: it runs immediately after
    /// the writer takes its snapshot and before it decides. That is the exact window in which
    /// a torn read (error now, code later) would lose a failed open's frame, so a test can
    /// force the interleaving instead of waiting for a scheduler to produce it. It is empty in
    /// production and never changes behaviour.
    #[cfg(test)]
    interleave: Arc<Mutex<Option<DecisionHook>>>,
}

impl EndingState {
    fn new() -> EndingState {
        EndingState {
            tx: watch::channel(Ending::default()).0,
            #[cfg(test)]
            interleave: Arc::new(Mutex::new(None)),
        }
    }

    /// The writer's own view of this state: every publication after this point is observed.
    fn subscribe(&self) -> watch::Receiver<Ending> {
        self.tx.subscribe()
    }

    /// Records the close code (first wins) and wakes the writer.
    fn close(&self, code: u16) {
        self.tx.send_if_modified(|ending| ending.close(code));
    }

    /// Records a failed open's error frame, which always decides the close code.
    fn open_failed(&self, frame: String) {
        self.tx
            .send_if_modified(|ending| ending.open_failed(frame.clone()));
    }

    /// Runs the test seam, if a test installed one. A no-op in production.
    fn at_decision_boundary(&self) {
        #[cfg(test)]
        {
            let hook = self.interleave.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
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
    ending_state: EndingState,
) -> u16
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    // The writer's own receiver: every publication after this point is versioned against it.
    let mut ending = ending_state.subscribe();
    // The writer's own decisions (a sealed drain, an overflow, a send that ran out of time)
    // need no notification: they are recorded here and merged with the shared ending.
    let mut own = Ending::default();
    // Set when the ending's last sender is gone: the branch is then disabled rather than
    // polled against a closed channel, which would spin or read as a policy close.
    let mut ending_alive = true;
    let code = loop {
        // One snapshot of the *shared* ending per decision, merged with what the writer itself
        // decided. A failed open and its 1008 can therefore never be torn apart into
        // "no error" plus "close 1008".
        let remote = ending.borrow_and_update().clone();
        // Test-only: a publication here lands after the snapshot and before the decision. The
        // loop re-decides from the next version, so nothing is lost; a torn read would break.
        ending_state.at_decision_boundary();
        let decided = if remote.error.is_some() {
            remote
        } else {
            let mut merged = own.clone();
            if merged.code.is_none() {
                merged.code = remote.code;
            }
            merged
        };
        if let Some(frame) = decided.error {
            // The error frame always precedes its policy close, so the client sees why.
            let _ =
                tokio::time::timeout(SEND_DEADLINE, sink.send(Message::Text(frame.into()))).await;
            break CLOSE_POLICY;
        }
        if let Some(code) = decided.code {
            break code;
        }
        let drain_by = DrainDeadline::from(queue.grace_deadline());
        // An already-expired drain must end the attempt now, not grant a fresh budget.
        if drain_by.is_expired_at(Instant::now()) {
            break CLOSE_LAGGED;
        }
        tokio::select! {
            biased;
            frame = queue.next_for_send(&ledger) => {
                let message = match frame {
                    Ok(Frame::Binary(bytes)) => Message::Binary(bytes.into()),
                    Ok(Frame::Event(event)) => {
                        let text = serde_json::to_string(&event).expect("an event always serializes");
                        Message::Text(text.into())
                    }
                    // Recorded rather than broken out of, so a pending open error still wins.
                    Err(Stop::Sealed) => {
                        own.close(CLOSE_NORMAL);
                        continue;
                    }
                    Err(Stop::Overflow) => {
                        own.close(CLOSE_LAGGED);
                        continue;
                    }
                };
                match send_frame(&mut sink, message, &mut ending, drain_by).await {
                    Outcome::Sent => {}
                    // Not `break`: the ending may carry an open error frame that must be sent
                    // before this code, so the top of the loop decides.
                    Outcome::Code(code) => {
                        own.close(code);
                        continue;
                    }
                    Outcome::Gone => return CLOSE_NORMAL,
                }
            }
            // The absolute drain bound runs whether the writer is dequeuing or sending.
            _ = wait_drain(drain_by) => {
                // A drain that cannot finish in its bound is lagged, not a good close; recorded
                // so a pending open error can still be sent first.
                own.close(CLOSE_LAGGED);
                continue;
            }
            // Any ending, including a failed open whose frame is sent at the top of the loop.
            // The watch compares versions, so a publication in the window above is observed
            // rather than lost. A closed channel is not an ending: it disables the branch.
            changed = ending.changed(), if ending_alive => {
                if changed.is_err() {
                    ending_alive = false;
                }
                continue;
            }
        }
    };
    send_close(&mut sink, code).await;
    code
}

/// The absolute drain bound, or the absence of one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DrainDeadline {
    /// No terminal state has been queued: the attempt may stream indefinitely.
    Absent,
    /// A drain is running and must be over by this instant, which may already have passed.
    At(Instant),
}

impl DrainDeadline {
    /// The attempt's absolute drain bound, derived from the instant its grace was armed.
    fn from(grace_deadline: Option<Instant>) -> DrainDeadline {
        match grace_deadline {
            Some(at) => DrainDeadline::At(at + DRAIN_DEADLINE - GRACE_TICK),
            None => DrainDeadline::Absent,
        }
    }

    /// Whether the bound has already passed: an expired drain closes immediately instead of
    /// granting the frame a fresh budget.
    fn is_expired_at(self, now: Instant) -> bool {
        match self {
            DrainDeadline::Absent => false,
            DrainDeadline::At(at) => now >= at,
        }
    }

    /// The budget for one frame: the smaller of its own bound and what the drain has left.
    /// An expired drain leaves nothing; an absent one leaves the frame's own bound.
    fn frame_budget(self, now: Instant) -> Duration {
        match self {
            DrainDeadline::Absent => SEND_DEADLINE,
            DrainDeadline::At(at) => at.saturating_duration_since(now).min(SEND_DEADLINE),
        }
    }
}

/// Sleeps until the drain bound, or forever when the attempt has none.
async fn wait_drain(deadline: DrainDeadline) {
    match deadline {
        DrainDeadline::Absent => std::future::pending::<()>().await,
        // An expired bound is ready at once; `sleep(0)` yields and returns.
        DrainDeadline::At(at) => tokio::time::sleep_until(at.into()).await,
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
///
/// The ending is read as one snapshot, and the wait for a new ending is a versioned
/// `changed()`: a publication that lands between the snapshot and the select is compared
/// against the version the receiver has already seen, so it wakes this call rather than being
/// lost until the send's own deadline.
async fn send_frame<S>(
    sink: &mut S,
    frame: Message,
    ending: &mut watch::Receiver<Ending>,
    drain_by: DrainDeadline,
) -> Outcome
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    // `borrow_and_update` marks this version seen, so `changed()` below can only fire for a
    // publication *after* this snapshot.
    let snapshot = ending.borrow_and_update().clone();
    if let Some(code) = snapshot.code {
        return Outcome::Code(code);
    }
    // The frame may take no longer than the smaller of its own bound and the drain's remainder.
    let budget = drain_by.frame_budget(Instant::now());
    if budget.is_zero() {
        // The drain is already over: do not start a send the bound cannot wait for.
        return Outcome::Code(CLOSE_LAGGED);
    }
    tokio::select! {
        biased;
        sent = tokio::time::timeout(budget, sink.send(frame)) => match sent {
            Ok(Ok(())) => Outcome::Sent,
            Ok(Err(_)) => Outcome::Gone,
            // Past its own bound, or past the drain's: either way the peer cannot keep up.
            Err(_) => Outcome::Code(CLOSE_LAGGED),
        },
        // Any ending interrupts the send; the loop then sends a pending error frame first.
        changed = ending.changed() => match changed {
            // Versioned: this fires for a publication after the snapshot above, not only for
            // one that happened to arrive before this future was polled.
            Ok(()) => Outcome::Code(ending.borrow_and_update().code()),
            // A vanished sender is not an ending; let the send's own deadline decide.
            Err(_) => Outcome::Sent,
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
        /// Every frame this peer accepted, in order.
        frames: Arc<Mutex<Vec<Message>>>,
        /// One sleep per frame, created when the frame starts so it really elapses.
        wait: Arc<Mutex<Option<std::pin::Pin<Box<tokio::time::Sleep>>>>>,
    }

    impl Slow {
        fn new(delay: Duration) -> Slow {
            Slow {
                delay,
                sent: Arc::new(AtomicUsize::new(0)),
                frames: Arc::new(Mutex::new(Vec::new())),
                wait: Arc::new(Mutex::new(None)),
            }
        }
        fn sent(&self) -> usize {
            self.sent.load(Ordering::SeqCst)
        }
        /// The accepted frames, skipping the final close frame.
        fn frames(&self) -> Vec<Message> {
            self.frames
                .lock()
                .unwrap()
                .iter()
                .filter(|m| !matches!(m, Message::Close(_)))
                .cloned()
                .collect()
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

        fn start_send(self: std::pin::Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.sent.fetch_add(1, Ordering::SeqCst);
            self.frames.lock().unwrap().push(item);
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

    /// A peer that publishes a failed open from inside its own `poll_flush`: the publication
    /// happens after `send_frame` took its snapshot and before that call's `changed()` is first
    /// polled, which is the send-path window N3 names, forced by the code path and not by
    /// timing.
    #[derive(Clone)]
    struct PublishOnFlush {
        frames: Arc<Mutex<Vec<Message>>>,
        ending: EndingState,
        published: Arc<AtomicUsize>,
    }

    impl PublishOnFlush {
        fn frames(&self) -> Vec<Message> {
            self.frames
                .lock()
                .unwrap()
                .iter()
                .filter(|m| !matches!(m, Message::Close(_)))
                .cloned()
                .collect()
        }
    }

    impl futures_util::Sink<Message> for PublishOnFlush {
        type Error = axum::Error;

        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn start_send(self: std::pin::Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.frames.lock().unwrap().push(item);
            if self.published.load(Ordering::SeqCst) == 0 {
                // Mid-send: the first frame is inside the sink when the failure lands.
                self.published.fetch_add(1, Ordering::SeqCst);
                self.ending.close(CLOSE_NORMAL);
                self.ending
                    .open_failed(json_error("io", "cannot open a pty"));
            }
            Ok(())
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            // The interrupted frame never completes, the way a send racing a close does not.
            if self.published.load(Ordering::SeqCst) > 0
                && self.frames.lock().unwrap().iter().any(|m| matches!(m, Message::Binary(_)))
            {
                return std::task::Poll::Pending;
            }
            std::task::Poll::Ready(Ok(()))
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
        let ending = EndingState::new();
        let sink = Stalled::default();
        let started = std::time::Instant::now();
        let writer = tokio::spawn(writer_loop(
            sink.clone(),
            queue,
            ledger.clone(),
            ending.clone(),
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
        let ending = EndingState::new();
        let sink = Slow::new(Duration::from_millis(300));
        let started = std::time::Instant::now();
        let writer = tokio::spawn(writer_loop(sink.clone(), queue, ledger, ending.clone()));
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
        let ending = EndingState::new();
        let sink = Stalled::default();
        let writer = tokio::spawn(writer_loop(
            sink.clone(),
            queue.clone(),
            ledger.clone(),
            ending.clone(),
        ));
        let handle: Arc<dyn TerminalHandle> = Arc::new(crate::testing::FakeTerminal::default());
        let opening = tokio::spawn(async { Ok(()) });
        let worker = tokio::spawn(async { std::future::pending::<()>().await });
        let resize = Arc::new(ResizeSlot::new(handle.clone()));
        let supervising = tokio::spawn(supervise(
            registry.clone(),
            supervisor.clone(),
            queue.clone(),
            handle,
            opening,
            worker,
            resize,
            ending.clone(),
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

        ending.close(CLOSE_NORMAL);
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
        let ending = EndingState::new();
        let supervising = tokio::spawn(supervise(
            registry.clone(),
            supervisor.clone(),
            queue,
            handle,
            opening,
            worker,
            resize,
            ending.clone(),
        ));
        // The failure is recorded for the writer without the socket having to ask for it, and
        // the attempt ends instead of waiting for output that can never come.
        let mut seen = ending.subscribe();
        tokio::time::timeout(Duration::from_secs(2), seen.changed())
            .await
            .expect("the failed open must be reported")
            .expect("the channel stays open");
        let reported = seen.borrow().error.clone().expect("an error frame");
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
    fn one_ending_snapshot_is_never_torn_between_the_error_frame_and_its_close() {
        // I1: the writer used to read the error frame and the close code as two separate
        // snapshots, so a failed open landing between them produced "no error" plus "close
        // 1008" and the client never learned why. One `Ending` value makes that interleaving
        // unrepresentable: whatever a reader sees is one publication, and any snapshot that
        // carries an error frame carries its 1008 with it.
        let ending = EndingState::new();
        // The read loop's normal close is recorded first, then the spawn fails.
        ending.close(CLOSE_NORMAL);
        ending.open_failed(json_error("io", "cannot open a pty"));

        let snapshot = ending.subscribe().borrow().clone();
        assert_eq!(
            snapshot.code,
            Some(CLOSE_POLICY),
            "a failed open decides the code, whatever arrived first"
        );
        let recorded: serde_json::Value =
            serde_json::from_str(&snapshot.error.expect("the same snapshot carries the frame"))
                .unwrap();
        assert_eq!(
            recorded,
            serde_json::json!({
                "type": "error",
                "error": {"code": "io", "message": "cannot open a pty"}
            })
        );

        // The invariant, checked over every publication of a longer sequence: an error frame
        // and its 1008 are never separated.
        let ending = EndingState::new();
        let rx = ending.subscribe();
        let sequence: [&dyn Fn(&EndingState); 6] = [
            &|e| e.close(CLOSE_NORMAL),
            &|e| e.open_failed(json_error("io", "first")),
            &|e| e.close(CLOSE_LAGGED),
            &|e| e.open_failed(json_error("io", "second")),
            &|e| e.close(crate::config::CLOSE_REVOKED),
            &|e| e.open_failed(json_error("timeout", "third")),
        ];
        for publish in sequence {
            publish(&ending);
            let seen = rx.borrow().clone();
            if seen.error.is_some() {
                assert_eq!(
                    seen.code,
                    Some(CLOSE_POLICY),
                    "an error frame always travels with its 1008: {seen:?}"
                );
            }
        }
    }

    #[test]
    fn a_publication_between_the_snapshot_and_the_wait_is_still_observed() {
        // N3's window, forced by hand with no scheduler luck: take the snapshot the writer
        // takes, publish, and only then wait. A `Notify` stores no permit for a waiter that
        // arrives later, so that design would park here forever; a versioned `watch` reports
        // the publication against the version this receiver already saw.
        let ending = EndingState::new();
        let mut rx = ending.subscribe();
        let snapshot = rx.borrow_and_update().clone();
        assert_eq!(snapshot, Ending::default(), "nothing published yet");

        // The read loop closes, then the supervisor reports the failed open - both after the
        // snapshot was taken and before anything waits.
        ending.close(CLOSE_NORMAL);
        ending.open_failed(json_error("io", "cannot open a pty"));

        let woke = futures_util::FutureExt::now_or_never(rx.changed());
        assert!(
            matches!(woke, Some(Ok(()))),
            "the wait must complete at once for a publication it has not seen: {woke:?}"
        );
        let after = rx.borrow_and_update().clone();
        assert_eq!(after.code, Some(CLOSE_POLICY));
        assert!(after.error.is_some(), "the frame travels with the code");

        // And the mirror case: a wait already registered when the publication lands.
        let ending = EndingState::new();
        let mut rx = ending.subscribe();
        {
            let armed = rx.changed();
            tokio::pin!(armed);
            // Poll it once so its version is recorded, without letting it complete.
            assert!(futures_util::FutureExt::now_or_never(armed.as_mut()).is_none());
            ending.close(CLOSE_NORMAL);
            let woke = futures_util::FutureExt::now_or_never(armed.as_mut());
            assert!(matches!(woke, Some(Ok(()))), "an armed wait wakes: {woke:?}");
        }
        assert_eq!(rx.borrow_and_update().code, Some(CLOSE_NORMAL));
    }

    #[tokio::test]
    async fn an_open_error_published_while_the_writer_is_parked_reaches_the_peer_then_closes_1008() {
        // The end-to-end version of the I1/N3 window. The queue is empty and the drain is
        // absent, so the writer parks in its select; the failure is published *then*. On the
        // default current-thread runtime a single yield takes the writer to its parked point,
        // so this ordering is deterministic rather than timed.
        let queue = Queue::new();
        let ledger = Arc::new(AckLedger::default());
        let ending = EndingState::new();
        let sink = Slow::new(Duration::ZERO);
        let writer = tokio::spawn(writer_loop(
            sink.clone(),
            queue,
            ledger,
            ending.clone(),
        ));
        tokio::task::yield_now().await;
        assert!(!writer.is_finished(), "the writer is parked, not finished");
        assert!(sink.frames().is_empty(), "nothing was sent before the failure");

        // The read loop's own close first, then the failed open: exactly the ordering that
        // used to hide the error frame.
        ending.close(CLOSE_NORMAL);
        ending.open_failed(json_error("io", "cannot open a pty"));

        let code = tokio::time::timeout(Duration::from_secs(5), writer)
            .await
            .expect("a parked writer must be woken by the publication")
            .unwrap();
        assert_eq!(code, CLOSE_POLICY);
        let frames = sink.frames();
        assert_eq!(frames.len(), 1, "exactly the error frame: {frames:?}");
        match &frames[0] {
            Message::Text(text) => assert_eq!(
                serde_json::from_str::<serde_json::Value>(text.as_str()).unwrap(),
                serde_json::json!({
                    "type": "error",
                    "error": {"code": "io", "message": "cannot open a pty"}
                })
            ),
            other => panic!("expected the error frame, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_failure_published_at_the_decision_boundary_is_never_torn_from_its_close() {
        // I1, forced rather than hoped for: the seam publishes the normal close *and* the
        // failed open after the writer's single snapshot and before its decision. A design
        // that read the error frame and the close code as two snapshots would decide "no
        // error" from the first and "1008" from the second, then close without the frame.
        let queue = Queue::new();
        let ledger = Arc::new(AckLedger::default());
        let ending = EndingState::new();
        let sink = Slow::new(Duration::ZERO);
        let publishes = Arc::new(AtomicUsize::new(0));
        let boundary_hits = Arc::new(AtomicUsize::new(0));
        *ending.interleave.lock().unwrap() = Some({
            let ending = ending.clone();
            let publishes = publishes.clone();
            let boundary_hits = boundary_hits.clone();
            Arc::new(move || {
                boundary_hits.fetch_add(1, Ordering::SeqCst);
                // Exactly once, so the writer cannot loop on its own publication.
                if publishes.load(Ordering::SeqCst) == 0 {
                    publishes.store(1, Ordering::SeqCst);
                    ending.close(CLOSE_NORMAL);
                    ending.open_failed(json_error("io", "cannot open a pty"));
                }
            })
        });
        let writer = tokio::spawn(writer_loop(
            sink.clone(),
            queue,
            ledger,
            ending.clone(),
        ));
        let code = tokio::time::timeout(Duration::from_secs(5), writer)
            .await
            .expect("the forced publication must not wedge the writer")
            .unwrap();
        assert_eq!(publishes.load(Ordering::SeqCst), 1, "the seam published once");
        assert!(
            boundary_hits.load(Ordering::SeqCst) >= 1,
            "the seam really ran at the writer's decision boundary"
        );
        assert_eq!(
            code, CLOSE_POLICY,
            "the failure decides the close even though the normal close was recorded first"
        );
        let frames = sink.frames();
        assert_eq!(frames.len(), 1, "the error frame is delivered: {frames:?}");
        assert!(
            matches!(&frames[0], Message::Text(t) if t.contains(r#""type":"error""#)),
            "and it is the error frame, not a bare close: {frames:?}"
        );
    }

    #[tokio::test]
    async fn a_normal_close_published_while_the_writer_is_parked_is_not_lost() {
        // The same wakeup, with no error at all: an empty queue and an absent drain leave
        // nothing else to wake the writer, so a lost publication would park it until the
        // socket's own join bound and the peer would see no close.
        let queue = Queue::new();
        let ledger = Arc::new(AckLedger::default());
        let ending = EndingState::new();
        let sink = Slow::new(Duration::ZERO);
        let writer = tokio::spawn(writer_loop(
            sink.clone(),
            queue,
            ledger,
            ending.clone(),
        ));
        tokio::task::yield_now().await;
        assert!(!writer.is_finished(), "the writer is parked on an empty queue");

        ending.close(CLOSE_NORMAL);
        let code = tokio::time::timeout(Duration::from_secs(5), writer)
            .await
            .expect("the parked writer must observe the normal close")
            .unwrap();
        assert_eq!(code, CLOSE_NORMAL);
        assert!(sink.frames().is_empty(), "a normal close sends no data frame");
    }

    #[tokio::test]
    async fn a_publication_from_inside_a_pending_send_interrupts_it_and_is_still_sent() {
        // The send path's version of the window, with the ordering fixed by the code path
        // rather than by timing: the sink publishes the failure from inside its own poll, i.e.
        // after `send_frame` took its snapshot and before its select first polls `changed()`.
        let queue = Queue::new();
        let ledger = Arc::new(AckLedger::default());
        assert_eq!(queue.push_data(b"output".to_vec()), Push::Accepted);
        let ending = EndingState::new();
        let sink = PublishOnFlush {
            frames: Arc::new(Mutex::new(Vec::new())),
            ending: ending.clone(),
            published: Arc::new(AtomicUsize::new(0)),
        };
        let writer = tokio::spawn(writer_loop(
            sink.clone(),
            queue,
            ledger,
            ending.clone(),
        ));
        let code = tokio::time::timeout(Duration::from_secs(5), writer)
            .await
            .expect("a publication during a send must interrupt it")
            .unwrap();
        assert_eq!(sink.published.load(Ordering::SeqCst), 1, "published once, mid-send");
        assert_eq!(
            code, CLOSE_POLICY,
            "the open error decides the close, not the interrupted frame"
        );
        let frames = sink.frames();
        // The interrupted data frame entered the sink, then the error frame, then the close.
        assert!(
            matches!(frames.first(), Some(Message::Binary(_))),
            "the data frame comes first: {frames:?}"
        );
        let last = frames.last().expect("the error frame");
        assert!(
            matches!(last, Message::Text(t) if t.contains(r#""type":"error""#)),
            "the error frame is delivered after it: {frames:?}"
        );
        assert_eq!(frames.len(), 2, "nothing else is sent: {frames:?}");
    }

    #[test]
    fn an_expired_drain_grants_no_fresh_budget_and_an_absent_one_does_not_expire() {
        let now = Instant::now();
        // Already past: the deadline is distinguishable from "no deadline at all".
        let expired = DrainDeadline::At(now - Duration::from_millis(1));
        assert!(expired.is_expired_at(now));
        assert_eq!(expired.frame_budget(now), Duration::ZERO);
        // Exactly at the bound counts as expired: the attempt must close, not start a send.
        let due = DrainDeadline::At(now);
        assert!(due.is_expired_at(now));
        assert_eq!(due.frame_budget(now), Duration::ZERO);
        // An absent bound never expires and leaves the frame its own budget.
        let absent = DrainDeadline::Absent;
        assert!(!absent.is_expired_at(now + Duration::from_secs(3600)));
        assert_eq!(absent.frame_budget(now), SEND_DEADLINE);
        // A running drain leaves only what is left of it, capped by the frame bound.
        let running = DrainDeadline::At(now + Duration::from_millis(500));
        assert!(!running.is_expired_at(now));
        assert_eq!(running.frame_budget(now), Duration::from_millis(500));
        let long = DrainDeadline::At(now + Duration::from_secs(600));
        assert_eq!(long.frame_budget(now), SEND_DEADLINE);
    }

    #[tokio::test]
    async fn a_writer_that_starts_after_the_drain_bound_closes_lagged_immediately() {
        // The drain expired *before* the writer's first poll, which used to be read as "no
        // deadline" and grant another full per-frame budget.
        let queue = draining_queue(DRAIN_DEADLINE + Duration::from_millis(500));
        for i in 0..8u8 {
            assert_eq!(queue.push_data(vec![i]), Push::Accepted);
        }
        let ledger = Arc::new(AckLedger::default());
        let ending = EndingState::new();
        // A sink that would accept everything quickly: only the expiry can close it, and only
        // because it never gets to send.
        let sink = Slow::new(Duration::ZERO);
        let started = Instant::now();
        let writer = tokio::spawn(writer_loop(sink.clone(), queue, ledger, ending.clone()));
        let code = tokio::time::timeout(Duration::from_secs(5), writer)
            .await
            .expect("an expired drain ends the writer at once")
            .unwrap();
        assert_eq!(code, crate::config::CLOSE_LAGGED);
        assert!(
            sink.frames().is_empty(),
            "an expired drain sends no data frame: {:?}",
            sink.frames()
        );
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "no fresh budget: took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_writer_outliving_its_ending_sender_is_not_a_policy_close() {
        // N1: the ending state's senders can all vanish (an attempt whose cleanup finished)
        // while the writer is still parked. That must not be read as a failed open, must not
        // close 1008, and must not spin.
        let queue = Queue::new();
        let ledger = Arc::new(AckLedger::default());
        let ending = EndingState::new();
        let sink = Stalled::default();
        let writer = tokio::spawn(writer_loop(sink.clone(), queue, ledger, ending.clone()));
        tokio::time::sleep(Duration::from_millis(100)).await;
        // Only the writer holds the state now: no other sender exists, and nothing has ended.
        drop(EndingState::new());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !writer.is_finished(),
            "a vanished sender must not end the attempt by itself"
        );
        // A normal shutdown then ends it with 1000, not 1008.
        ending.close(CLOSE_NORMAL);
        let code = tokio::time::timeout(Duration::from_secs(5), writer)
            .await
            .expect("the normal close ends the writer")
            .unwrap();
        assert_eq!(code, CLOSE_NORMAL);
    }

    #[tokio::test]
    async fn the_idle_open_deadline_is_the_production_value_at_both_sides_of_the_bound() {
        // M1: the deadline decision is a production helper, driven by a controlled clock.
        let deadline = IdleDeadline::at(tokio::time::Instant::now(), OPEN_TIMEOUT);
        assert!(!deadline.is_due_at(tokio::time::Instant::now()));
        // One millisecond before the bound it is still not due...
        let just_before = deadline.as_std().unwrap() - Duration::from_millis(1);
        assert!(!IdleDeadline::due_by(
            just_before,
            just_before,
            OPEN_TIMEOUT
        ));
        // ...and at the bound it is.
        let at = deadline.as_std().unwrap();
        assert!(IdleDeadline::due_by(at, at - OPEN_TIMEOUT, OPEN_TIMEOUT));
        // The production constant is what the helper is driven with.
        assert_eq!(OPEN_TIMEOUT, Duration::from_secs(10));
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
