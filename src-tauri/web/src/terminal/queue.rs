//! The attempt's ACK ledger and its bounded output queue.
use herdly_core::attach::{AttachEvent, Sink};
use serde::Serialize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Close code for a frame this protocol does not accept.
pub const CLOSE_POLICY: u16 = 1008;

/// The peer's acknowledgement position for one connection.
#[derive(Debug, Default)]
pub struct AckLedger {
    /// Output bytes handed to the writer so far, in total.
    sent: AtomicUsize,
    /// Output bytes the peer has acknowledged so far, in total.
    acked: AtomicUsize,
}

impl AckLedger {
    /// Reserves `bytes` of wire credit: call before the writer exposes those bytes to the
    /// peer, never after.
    pub fn sent(&self, bytes: usize) {
        // Saturating: an absurd total is a closed connection, not a wrapped counter.
        let _ = self
            .sent
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_add(bytes))
            });
    }

    /// Discharges `bytes` the peer reports it has parsed.
    ///
    /// The peer may acknowledge at most what was sent and not already acknowledged, so a
    /// malformed ACK cannot exceed flow control or discharge output it has not received. An
    /// ACK of zero spends nothing and is refused only for being over the bound, i.e. never.
    pub fn ack(&self, bytes: usize) -> Result<(), u16> {
        let mut current = self.acked.load(Ordering::SeqCst);
        loop {
            let outstanding = self.sent.load(Ordering::SeqCst).saturating_sub(current);
            if bytes > outstanding {
                return Err(CLOSE_POLICY);
            }
            if bytes == 0 {
                return Ok(());
            }
            match self.acked.compare_exchange(
                current,
                current + bytes,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Ok(()),
                Err(seen) => current = seen,
            }
        }
    }

    /// Output bytes the peer has been sent but not yet acknowledged.
    pub fn outstanding(&self) -> usize {
        self.sent
            .load(Ordering::SeqCst)
            .saturating_sub(self.acked.load(Ordering::SeqCst))
    }
}

/// A queue holds at most this many bytes of terminal output.
pub const MAX_QUEUED_BYTES: usize = 2 * 1024 * 1024;
/// A queue holds at most this many frames, output and state together.
pub const MAX_QUEUED_FRAMES: usize = 256;
/// How long output is still accepted after a terminal state, before the queue is sealed.
pub const TERMINAL_GRACE: Duration = Duration::from_millis(250);

/// One frame on its way to the peer.
#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
    Binary(Vec<u8>),
    Event(TerminalEvent),
}

/// A server text event, exactly as the Spec spells it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalEvent {
    Attached,
    Held,
    Exited { code: Option<i32> },
    Detached,
}

impl TerminalEvent {
    /// Whether this event ends the attempt's usable life.
    pub fn is_terminal(&self) -> bool {
        !matches!(self, TerminalEvent::Attached)
    }
}

/// What became of one enqueue attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Push {
    /// Queued: the writer will deliver it in order.
    Accepted,
    /// The attempt is sealed; best-effort output arriving after the drain is discarded.
    Sealed,
    /// The attempt outgrew its bounds: the socket must close lagged, not drop this quietly.
    Overflow,
}

pub struct Queue {
    state: std::sync::Mutex<State>,
    notify: tokio::sync::Notify,
    clock: Box<dyn Fn() -> Instant + Send + Sync>,
}

struct State {
    frames: std::collections::VecDeque<Frame>,
    /// Terminal output bytes queued: the byte half of the bound.
    bytes: usize,
    sealed: bool,
    /// Set once a callback found the attempt out of bounds: the socket closes lagged.
    overflowed: bool,
    /// When the attempt's first terminal state was queued: arms the bounded drain grace.
    terminal_at: Option<std::time::Instant>,
}

impl Queue {
    pub fn new() -> std::sync::Arc<Queue> {
        Queue::with_clock(Instant::now)
    }

    /// A queue whose grace is counted on `clock`: the test seam for time, nothing else.
    pub fn with_clock(
        clock: impl Fn() -> Instant + Send + Sync + 'static,
    ) -> std::sync::Arc<Queue> {
        std::sync::Arc::new(Queue {
            state: std::sync::Mutex::new(State {
                frames: std::collections::VecDeque::new(),
                bytes: 0,
                sealed: false,
                overflowed: false,
                terminal_at: None,
            }),
            notify: tokio::sync::Notify::new(),
            clock: Box::new(clock),
        })
    }

    /// Queues terminal output bytes unchanged: a chunk may end mid-UTF-8 sequence.
    pub fn push_data(&self, bytes: Vec<u8>) -> Push {
        self.push(Frame::Binary(bytes))
    }

    /// Queues one state frame; a terminal state also arms the drain grace.
    pub fn push_event(&self, event: TerminalEvent) -> Push {
        self.push(Frame::Event(event))
    }

    fn push(&self, frame: Frame) -> Push {
        let mut st = self.state.lock().unwrap();
        if st.sealed {
            return Push::Sealed;
        }
        let bytes = match &frame {
            Frame::Binary(bytes) => bytes.len(),
            Frame::Event(_) => 0,
        };
        // Neither bound may be exceeded, and an overflow is reported, never a silent drop.
        if st.frames.len() >= MAX_QUEUED_FRAMES || st.bytes.saturating_add(bytes) > MAX_QUEUED_BYTES
        {
            st.overflowed = true;
            return Push::Overflow;
        }
        st.bytes += bytes;
        if let Frame::Event(e) = &frame {
            if e.is_terminal() {
                st.terminal_at.get_or_insert_with(|| (self.clock)());
            }
        }
        st.frames.push_back(frame);
        drop(st);
        self.notify.notify_one();
        Push::Accepted
    }

    /// Whether this attempt has outgrown its bounds.
    ///
    /// The socket asks after every frame it drains: a queue only overflows while it holds
    /// frames, so a single writer polling between frames cannot miss it.
    pub fn overflowed(&self) -> bool {
        self.state.lock().unwrap().overflowed
    }

    /// Seals the queue against further callbacks. Frames already accepted still drain.
    pub fn seal(&self) {
        let mut st = self.state.lock().unwrap();
        st.sealed = true;
        drop(st);
        self.notify.notify_one();
    }

    pub fn is_sealed(&self) -> bool {
        self.state.lock().unwrap().sealed
    }

    /// The instant the attempt must be sealed at, if a terminal state has been queued.
    ///
    /// The grace is counted from the first terminal frame, so a Held/Exited that arrives
    /// before trailing output still leaves the same fixed window for that output.
    pub fn grace_deadline(&self) -> Option<Instant> {
        self.state
            .lock()
            .unwrap()
            .terminal_at
            .map(|at| at + TERMINAL_GRACE)
    }

    /// Seals the attempt once its grace has run out; `true` when it just sealed it.
    pub fn seal_when_due(&self, now: Instant) -> bool {
        let mut st = self.state.lock().unwrap();
        if st.sealed {
            return false;
        }
        let Some(at) = st.terminal_at else {
            return false;
        };
        if now < at + TERMINAL_GRACE {
            return false;
        }
        st.sealed = true;
        drop(st);
        self.notify.notify_one();
        true
    }

    /// The core `Sink` this attempt's Attach delivers into.
    ///
    /// Both callbacks are synchronous and non-blocking: they take a short-lived mutex and
    /// return. Core calls them from its own reader and exit-watcher threads, so nothing here
    /// may await the runtime, and no callback may be held behind a pending network send.
    pub fn sink(self: &Arc<Self>) -> Arc<dyn Sink> {
        Arc::new(Adapter {
            queue: self.clone(),
        })
    }

    /// The next frame for the writer, reserving its wire credit first.
    ///
    /// Credit is reserved *here*, before the caller hands the bytes to the socket: the peer
    /// is about to be exposed to them, so an ACK may never wait for that send to finish, and
    /// frames still sitting in this queue are never counted as credit the peer could spend.
    /// `None` once the queue is sealed and drained.
    pub async fn next_for_send(&self, ledger: &AckLedger) -> Option<Frame> {
        let frame = self.next().await;
        if let Some(Frame::Binary(bytes)) = &frame {
            ledger.sent(bytes.len());
        }
        frame
    }

    /// The next frame in queue order, or `None` once the queue is sealed and drained.
    pub async fn next(&self) -> Option<Frame> {
        loop {
            let notified = self.notify.notified();
            {
                let mut st = self.state.lock().unwrap();
                if let Some(frame) = st.frames.pop_front() {
                    if let Frame::Binary(bytes) = &frame {
                        st.bytes = st.bytes.saturating_sub(bytes.len());
                    }
                    return Some(frame);
                }
                if st.sealed {
                    return None;
                }
            }
            notified.await;
        }
    }
}

/// The `Sink` a Terminal attempt delivers into: core's callbacks, queued for the writer.
struct Adapter {
    queue: Arc<Queue>,
}

impl Sink for Adapter {
    fn data(&self, bytes: Vec<u8>) {
        // A refused or overflowing callback is recorded by the queue; the socket polls the
        // queue's outcome, so a lost frame is never reported to the peer as delivered.
        let _ = self.queue.push_data(bytes);
    }

    fn event(&self, e: AttachEvent) {
        let _ = self.queue.push_event(event_of(e));
    }
}

/// Core's event as the wire spells it.
fn event_of(e: AttachEvent) -> TerminalEvent {
    match e {
        AttachEvent::Attached => TerminalEvent::Attached,
        AttachEvent::Held => TerminalEvent::Held,
        AttachEvent::Exited { code } => TerminalEvent::Exited { code },
        AttachEvent::Detached => TerminalEvent::Detached,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn ack_cannot_spend_unsent_or_already_acked_output() {
        let l = AckLedger::default();
        assert_eq!(l.ack(1), Err(1008));
        l.sent(5);
        assert_eq!(l.ack(2), Ok(()));
        assert_eq!(l.ack(4), Err(1008));
        assert_eq!(l.ack(3), Ok(()));
        assert_eq!(l.ack(1), Err(1008));
    }

    #[test]
    fn a_zero_ack_is_a_no_op_and_an_exact_ack_empties_the_ledger() {
        let l = AckLedger::default();
        // Only an ACK exceeding what was sent is rejected; one that spends nothing is not
        // malformed, so it must not close the connection.
        assert_eq!(l.ack(0), Ok(()));
        assert_eq!(l.outstanding(), 0);
        l.sent(7);
        assert_eq!(l.ack(0), Ok(()));
        assert_eq!(l.outstanding(), 7);
        assert_eq!(l.ack(7), Ok(()));
        assert_eq!(l.outstanding(), 0);
        assert_eq!(l.ack(1), Err(1008));
        assert_eq!(l.outstanding(), 0);
    }

    #[tokio::test]
    async fn frames_arrive_in_the_order_the_attempt_produced_them() {
        let q = Queue::new();
        assert_eq!(q.push_data(b"out-1".to_vec()), Push::Accepted);
        assert_eq!(
            q.push_event(TerminalEvent::Exited { code: Some(0) }),
            Push::Accepted
        );
        assert_eq!(q.push_data(b"out-2".to_vec()), Push::Accepted);
        q.seal();
        let mut frames = Vec::new();
        while let Some(frame) = q.next().await {
            frames.push(frame);
        }
        assert_eq!(
            frames,
            vec![
                Frame::Binary(b"out-1".to_vec()),
                Frame::Event(TerminalEvent::Exited { code: Some(0) }),
                Frame::Binary(b"out-2".to_vec()),
            ]
        );
    }

    #[tokio::test]
    async fn overflows_only_past_two_mib_and_256_frames() {
        let q = Queue::new();
        // Exactly 2 MiB in any frame split is still inside the byte bound.
        for _ in 0..8 {
            assert_eq!(q.push_data(vec![b'x'; 256 * 1024]), Push::Accepted);
        }
        // One more byte is not.
        assert_eq!(q.push_data(vec![b'x'; 1]), Push::Overflow);
        q.seal();
        while q.next().await.is_some() {}

        let q = Queue::new();
        for _ in 0..MAX_QUEUED_FRAMES {
            assert_eq!(q.push_data(Vec::new()), Push::Accepted);
        }
        // State frames share the frame bound: 256 frames is the limit, whatever their kind.
        assert_eq!(q.push_event(TerminalEvent::Attached), Push::Overflow);
        q.seal();
        while q.next().await.is_some() {}
    }

    #[tokio::test]
    async fn sealing_refuses_late_callbacks_and_still_delivers_accepted_frames() {
        let q = Queue::new();
        assert_eq!(q.push_data(b"before".to_vec()), Push::Accepted);
        q.seal();
        // A callback racing the seal must learn it was refused, never receive Accepted.
        assert_eq!(q.push_data(b"after".to_vec()), Push::Sealed);
        assert_eq!(q.push_event(TerminalEvent::Detached), Push::Sealed);
        assert!(q.is_sealed());
        // Output accepted before the seal is not thrown away by it.
        assert_eq!(q.next().await, Some(Frame::Binary(b"before".to_vec())));
        assert_eq!(q.next().await, None);
    }

    #[test]
    fn a_terminal_state_arms_the_bounded_grace_and_a_preceding_state_does_not() {
        use std::sync::atomic::{AtomicU64, Ordering};
        // Only time is faked here: the queue's own logic runs unchanged.
        let base = Instant::now();
        let now = Arc::new(AtomicU64::new(0));
        let q = Queue::with_clock({
            let now = now.clone();
            move || base + Duration::from_millis(now.load(Ordering::SeqCst))
        });
        let at = |ms: u64| base + Duration::from_millis(ms);

        // Attached alone never seals the attempt: a live terminal keeps streaming.
        assert_eq!(q.push_event(TerminalEvent::Attached), Push::Accepted);
        assert_eq!(q.grace_deadline(), None);
        assert_eq!(q.push_data(b"still live".to_vec()), Push::Accepted);

        // The first terminal state starts the clock at that moment.
        now.store(1000, Ordering::SeqCst);
        assert_eq!(q.push_event(TerminalEvent::Held), Push::Accepted);
        assert_eq!(q.grace_deadline(), Some(at(1250)));

        // Trailing output in the window is still accepted, and a second terminal state does
        // not extend the window the first one started.
        now.store(1200, Ordering::SeqCst);
        assert_eq!(q.push_data(b"trailing".to_vec()), Push::Accepted);
        assert_eq!(q.push_event(TerminalEvent::Detached), Push::Accepted);
        assert_eq!(q.grace_deadline(), Some(at(1250)));

        // Nothing seals before the deadline, even if the writer is still draining.
        assert!(!q.seal_when_due(at(1249)));
        assert!(!q.is_sealed());
        // At the deadline it seals exactly once, against any further callbacks.
        assert!(q.seal_when_due(at(1250)));
        assert!(q.is_sealed());
        assert!(!q.seal_when_due(at(9999)));
        assert_eq!(q.push_data(b"too late".to_vec()), Push::Sealed);
        // Grace expiry is not an overflow: the socket closes normally after a good drain.
        assert!(!q.overflowed());
    }

    #[tokio::test]
    async fn a_full_queue_is_sticky_and_never_looks_like_success() {
        let q = Queue::new();
        assert!(!q.overflowed());
        for _ in 0..MAX_QUEUED_FRAMES {
            assert_eq!(q.push_data(vec![b'x']), Push::Accepted);
        }
        assert!(!q.overflowed());
        assert_eq!(q.push_data(b"one too many".to_vec()), Push::Overflow);
        // Sticky: draining frames must not hide a failed callback afterwards.
        assert!(q.overflowed());
        assert!(q.next().await.is_some());
        assert!(q.overflowed());
        q.seal();
        while q.next().await.is_some() {}
        assert!(q.overflowed());
    }

    #[tokio::test]
    async fn sealing_while_output_is_delivered_loses_and_duplicates_nothing() {
        // Far under both bounds, so the only thing under test is the seal: nothing here can
        // overflow. Both sides hand off through channels instead of racing on timing.
        const FRAMES: u32 = 50;
        let q = Queue::new();
        let (pushed, wait_pushed) = std::sync::mpsc::channel::<()>();
        let (sealed, wait_sealed) = std::sync::mpsc::channel::<()>();
        // Core's reader delivers, then meets the seal the socket applies mid-stream.
        let producer = {
            let q = q.clone();
            std::thread::spawn(move || {
                for i in 0..FRAMES {
                    assert_eq!(q.push_data(i.to_le_bytes().to_vec()), Push::Accepted);
                }
                pushed.send(()).unwrap();
                wait_sealed.recv().unwrap();
                // This is the callback that races the seal: it must be refused, not queued.
                q.push_data(b"after-seal".to_vec())
            })
        };
        wait_pushed.recv_timeout(Duration::from_secs(5)).unwrap();

        let mut drained = Vec::new();
        for _ in 0..FRAMES {
            match q.next().await {
                Some(Frame::Binary(bytes)) => {
                    drained.push(u32::from_le_bytes(bytes.as_slice().try_into().unwrap()))
                }
                other => panic!("the producer queued {FRAMES} frames, got {other:?}"),
            }
        }
        // Nothing arrives twice or out of order on the way to the writer.
        assert_eq!(drained, (0..FRAMES).collect::<Vec<_>>());

        q.seal();
        sealed.send(()).unwrap();
        assert_eq!(producer.join().unwrap(), Push::Sealed);
        // Accepted output is not thrown away by the seal, and the refused frame is not sent.
        assert_eq!(q.next().await, None);
        assert_eq!(drained.len(), FRAMES as usize);
    }

    #[test]
    fn events_serialize_the_way_the_spec_spells_them() {
        let text = |e: TerminalEvent| serde_json::to_string(&e).unwrap();
        assert_eq!(text(TerminalEvent::Attached), r#"{"type":"attached"}"#);
        assert_eq!(text(TerminalEvent::Held), r#"{"type":"held"}"#);
        assert_eq!(text(TerminalEvent::Detached), r#"{"type":"detached"}"#);
        // The exit code may be absent; the event still is.
        assert_eq!(
            text(TerminalEvent::Exited { code: Some(0) }),
            r#"{"type":"exited","code":0}"#
        );
        assert_eq!(
            text(TerminalEvent::Exited { code: None }),
            r#"{"type":"exited","code":null}"#
        );
    }

    #[test]
    fn a_full_queue_tells_a_core_thread_immediately_instead_of_blocking_it() {
        let q = Queue::new();
        for _ in 0..MAX_QUEUED_FRAMES {
            assert_eq!(q.push_data(b"x".to_vec()), Push::Accepted);
        }
        // A core reader thread, with no Tokio runtime to wait on, calls straight into the
        // adapter. An overflow that blocked on the runtime (or on the writer) would hang here.
        let (tx, rx) = std::sync::mpsc::channel();
        let sink = q.sink();
        std::thread::spawn(move || {
            sink.data(b"one too many".to_vec());
            sink.event(AttachEvent::Exited { code: Some(0) });
            let _ = tx.send(());
        });
        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "the Sink callback must return without waiting on the runtime"
        );
        assert!(q.overflowed());
    }

    #[tokio::test]
    async fn the_adapter_queues_core_callbacks_and_keeps_their_events() {
        use herdly_core::attach::{AttachEvent, Sink};
        let q = Queue::new();
        let sink: Arc<dyn Sink> = q.sink();
        // Callbacks arrive on a core reader/exit-watcher thread, never on this runtime.
        let feeder = {
            let sink = sink.clone();
            std::thread::spawn(move || {
                sink.event(AttachEvent::Attached);
                sink.data(vec![0xff, 0x1b, 0x00]);
                sink.event(AttachEvent::Held);
                // The second byte of "é": a chunk that starts inside a character.
                sink.data(vec!["é".as_bytes()[1]]);
            })
        };
        feeder.join().unwrap();

        q.seal();
        let mut frames = Vec::new();
        while let Some(frame) = q.next().await {
            frames.push(frame);
        }
        assert_eq!(
            frames,
            vec![
                Frame::Event(TerminalEvent::Attached),
                // Output bytes are forwarded untouched: not one byte of this chunk is UTF-8.
                Frame::Binary(vec![0xff, 0x1b, 0x00]),
                Frame::Event(TerminalEvent::Held),
                Frame::Binary(vec![0xa9]),
            ]
        );
    }

    #[tokio::test]
    async fn credit_is_reserved_at_dequeue_so_an_ack_never_waits_on_the_send() {
        let q = Queue::new();
        let ledger = AckLedger::default();
        assert_eq!(q.push_data(b"12345".to_vec()), Push::Accepted);
        // Still queued, so still unsent: the peer cannot spend it, even though it exists.
        assert_eq!(ledger.ack(5), Err(1008));
        assert_eq!(ledger.outstanding(), 0);

        // The writer takes the frame. Its credit exists now, *before* any socket send, so the
        // ACK arriving while that send is still pending is honoured instead of blocking.
        let frame = q.next_for_send(&ledger).await;
        assert_eq!(frame, Some(Frame::Binary(b"12345".to_vec())));
        assert_eq!(ledger.outstanding(), 5);
        assert_eq!(ledger.ack(5), Ok(()));
        assert_eq!(ledger.outstanding(), 0);
        // Past what was sent: still refused, so a malformed ACK cannot bypass flow control.
        assert_eq!(ledger.ack(1), Err(1008));

        // State frames carry no terminal bytes and therefore reserve no credit.
        assert_eq!(q.push_event(TerminalEvent::Attached), Push::Accepted);
        assert_eq!(
            q.next_for_send(&ledger).await,
            Some(Frame::Event(TerminalEvent::Attached))
        );
        assert_eq!(ledger.outstanding(), 0);
    }
}
