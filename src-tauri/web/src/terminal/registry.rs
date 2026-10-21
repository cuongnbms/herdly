//! The set of live Terminal attempts, owned by the application rather than by a socket task.
//!
//! A socket task can be cancelled at any await while its Attach spawn is still running. The
//! handle would then be dropped without `close`, leaving a `herdr terminal attach` child
//! behind. So cleanup is registered here, on the supervisor that owns it, and removed only
//! once cleanup has genuinely finished - after a late `open` has settled and after `close` has
//! returned, never on a timeout that only detached the work. Shutdown walks the same list: no
//! attempt is left with an open Attach, and no new attempt starts once shutdown has begun.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, watch};

/// The longest `shutdown` waits for one attempt before reporting it as still unfinished.
///
/// This bounds the *shutdown call*, not the attempt: an attempt whose cleanup is still running
/// keeps its registration, so a later shutdown pass still finds it. Nothing claims a timed-out
/// attempt is clean.
pub const JOIN_TIMEOUT: Duration = Duration::from_secs(15);

/// Why a supervisor is being asked to clean up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    /// The input queue overflowed: close lagged, discarding pending input.
    InputOverflow,
    /// The attempt ended on its own terms.
    Ended,
    /// The process is shutting down (SIGINT/SIGTERM, or a test's `shutdown()`).
    Shutdown,
}

impl Signal {
    /// The close code the socket sends for this signal, when it has one of its own.
    pub fn close_code(self) -> Option<u16> {
        match self {
            Signal::InputOverflow => Some(crate::config::CLOSE_LAGGED),
            Signal::Ended | Signal::Shutdown => None,
        }
    }
}

/// One live attempt's cleanup owner.
pub struct Supervisor {
    id: u64,
    cancel: watch::Sender<bool>,
    signal: Mutex<Option<Signal>>,
    joined: Mutex<Option<oneshot::Receiver<()>>>,
    /// Shutdown's receiver for "cleanup really finished"; taken by `shutdown`.
    shutdown: Mutex<Option<oneshot::Receiver<()>>>,
    /// The receiver `register` created: holding it keeps `stop` from ever finding "no
    /// receivers", so a stop that lands before anyone subscribes is still durable.
    _initial: Mutex<watch::Receiver<bool>>,
}

impl Supervisor {
    /// Asks the supervisor to end the attempt. The first signal wins, so a lagged close is
    /// never overwritten by a later normal end.
    pub fn stop(&self, signal: Signal) {
        {
            let mut first = self.signal.lock().unwrap();
            if first.is_none() {
                *first = Some(signal);
            }
        }
        // `send_replace` stores the value even with no current receiver, so a subscriber that
        // arrives later still observes `true`; a plain `send` would drop it on the floor.
        self.cancel.send_replace(true);
    }

    /// The signal that started cleanup, if any.
    pub fn signal(&self) -> Option<Signal> {
        *self.signal.lock().unwrap()
    }

    /// Whether the attempt has already been asked to stop.
    pub fn is_stopped(&self) -> bool {
        *self.cancel.borrow()
    }

    /// Receivers observe `true` once this attempt is being stopped, including a stop that
    /// happened before this subscription.
    pub fn cancellation(&self) -> watch::Receiver<bool> {
        self.cancel.subscribe()
    }

    /// Resolves once cleanup has finished, bounded by [`JOIN_TIMEOUT`] so a caller cannot hang;
    /// a timed-out attempt stays registered, so this is not a claim that it is clean.
    pub async fn join(&self) {
        let rx = self.joined.lock().unwrap().take();
        let Some(rx) = rx else { return };
        if tokio::time::timeout(JOIN_TIMEOUT, rx).await.is_err() {
            tracing::warn!("terminal attempt cleanup still running after the join timeout");
        }
    }
}

struct Entry {
    supervisor: Arc<Supervisor>,
    /// Dropped when cleanup finishes, resolving every `Supervisor::join`.
    _done: Option<oneshot::Sender<()>>,
    /// Signalled by `finish`, so `shutdown` waits for real cleanup and not for a timeout.
    shutdown: Option<oneshot::Sender<()>>,
}

/// Every attempt between its registration and its finished cleanup.
pub struct TerminalRegistry {
    next: AtomicU64,
    shutting_down: AtomicBool,
    entries: Mutex<Vec<Entry>>,
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        TerminalRegistry {
            next: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            entries: Mutex::new(Vec::new()),
        }
    }
}

impl TerminalRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(TerminalRegistry::default())
    }

    /// Whether shutdown has begun; no new attempt may start after it has.
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Refuses every later attempt. Synchronous, so a caller can stop accepting before it
    /// awaits any cleanup.
    pub fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
    }

    /// Registers a new attempt, or refuses it because shutdown has begun.
    pub fn register(self: &Arc<Self>) -> Option<Arc<Supervisor>> {
        let mut entries = self.entries.lock().unwrap();
        // Checked under the same lock `shutdown` takes, so a registration never races past it.
        if self.shutting_down.load(Ordering::SeqCst) {
            return None;
        }
        let (cancel, initial) = watch::channel(false);
        let (done, joined) = oneshot::channel();
        let (shutdown, shut) = oneshot::channel();
        let supervisor = Arc::new(Supervisor {
            id: self.next.fetch_add(1, Ordering::Relaxed),
            cancel,
            signal: Mutex::new(None),
            joined: Mutex::new(Some(joined)),
            shutdown: Mutex::new(Some(shut)),
            _initial: Mutex::new(initial),
        });
        entries.push(Entry {
            supervisor: supervisor.clone(),
            _done: Some(done),
            shutdown: Some(shutdown),
        });
        Some(supervisor)
    }

    /// Records that an attempt's cleanup has finished and forgets it.
    ///
    /// The supervisor calls this only after a late `open` settled and `close` returned, so a
    /// removed entry really is clean.
    pub fn finish(&self, supervisor: &Arc<Supervisor>) {
        let mut entries = self.entries.lock().unwrap();
        let Some(index) = entries
            .iter()
            .position(|e| e.supervisor.id == supervisor.id)
        else {
            return;
        };
        let mut entry = entries.remove(index);
        // Told explicitly rather than by dropping: `shutdown` must see a success, not the
        // cancellation a dropped sender reports.
        if let Some(done) = entry.shutdown.take() {
            let _ = done.send(());
        }
        // Dropping the entry then resolves every `join`.
        drop(entry);
    }

    /// Attempts registered but not yet fully cleaned up.
    pub fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Stops accepting attempts and ends every registered one, waiting for their cleanup.
    pub async fn shutdown(&self) {
        self.begin_shutdown();
        let mut waits: Vec<oneshot::Receiver<()>> = {
            let mut entries = self.entries.lock().unwrap();
            let mut supers: Vec<Arc<Supervisor>> = Vec::new();
            let mut waits: Vec<oneshot::Receiver<()>> = Vec::new();
            for e in entries.iter_mut() {
                if let Some(rx) = e.supervisor.shutdown.lock().unwrap().take() {
                    supers.push(e.supervisor.clone());
                    waits.push(rx);
                }
            }
            for s in &supers {
                s.stop(Signal::Shutdown);
            }
            waits
        };
        for rx in waits.drain(..) {
            // The attempt keeps its registration if this times out, so nothing is reported
            // clean before its close really finished.
            if tokio::time::timeout(JOIN_TIMEOUT, rx).await.is_err() {
                tracing::warn!("terminal attempt cleanup still running at shutdown");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_supervisor_keeps_the_first_signal_and_refuses_nothing_early() {
        let registry = TerminalRegistry::new();
        let s = registry.register().unwrap();
        assert_eq!(registry.len(), 1);
        let mut cancel = s.cancellation();
        assert!(!*cancel.borrow());

        // The first signal wins: a normal end does not overwrite a lagged close.
        s.stop(Signal::InputOverflow);
        s.stop(Signal::Ended);
        assert_eq!(s.signal(), Some(Signal::InputOverflow));
        assert_eq!(Signal::InputOverflow.close_code(), Some(4000));
        assert_eq!(Signal::Ended.close_code(), None);
        assert_eq!(Signal::Shutdown.close_code(), None);
        cancel.changed().await.unwrap();
        assert!(*cancel.borrow());

        // Nothing is joined until cleanup reports itself finished.
        registry.finish(&s);
        assert!(registry.is_empty());
        s.join().await;
    }

    #[tokio::test]
    async fn a_stop_before_the_first_subscription_is_still_observed() {
        let registry = TerminalRegistry::new();
        let s = registry.register().unwrap();
        // No receiver exists beyond the one `register` kept: this is exactly the window in
        // which a plain `send` would have dropped the cancellation.
        s.stop(Signal::Shutdown);
        assert!(s.is_stopped());
        let late = s.cancellation();
        // A subscriber that arrives after the stop reads the stored `true` immediately, so the
        // `cancelled` wait returns without ever parking. (Tokio's `changed` reports only
        // changes a receiver has not seen, so it is `borrow` that carries this case.)
        assert!(*late.borrow(), "a late subscriber must see the stop");
        let mut late = late;
        // The same wait the supervisor uses: `borrow` first, so it returns instead of parking.
        let seen = tokio::time::timeout(Duration::from_millis(100), async {
            while !*late.borrow() {
                late.changed().await.unwrap();
            }
        })
        .await;
        assert!(
            seen.is_ok(),
            "waiting for cancellation returns at once after a stop"
        );
        assert_eq!(s.signal(), Some(Signal::Shutdown));
        registry.finish(&s);
    }

    #[tokio::test]
    async fn shutdown_refuses_new_attempts_and_waits_for_the_ones_it_has() {
        let registry = TerminalRegistry::new();
        let first = registry.register().unwrap();
        let second = registry.register().unwrap();
        assert_eq!(registry.len(), 2);

        // Cleanup is driven by the owning supervisor; shutdown must not return before it.
        let stopper = tokio::spawn({
            let registry = registry.clone();
            let (first, second) = (first.clone(), second.clone());
            async move {
                registry.shutdown().await;
                // Late registrations are refused because shutdown began.
                assert!(registry.register().is_none());
                (first, second)
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!stopper.is_finished(), "shutdown waits for cleanup");
        assert_eq!(first.signal(), Some(Signal::Shutdown));
        assert_eq!(second.signal(), Some(Signal::Shutdown));
        registry.finish(&first);
        registry.finish(&second);
        let (first, second) = stopper.await.unwrap();
        assert_eq!(registry.len(), 0);
        first.join().await;
        second.join().await;
    }

    #[tokio::test]
    async fn a_stop_that_races_the_first_subscription_is_never_lost() {
        // The window I3 names: register, then stop, then subscribe - with the stop landing on
        // another thread. Every round must still end cancelled.
        for _ in 0..100 {
            let registry = TerminalRegistry::new();
            let s = registry.register().unwrap();
            let stopper = {
                let s = s.clone();
                std::thread::spawn(move || s.stop(Signal::Shutdown))
            };
            let mut rx = s.cancellation();
            stopper.join().unwrap();
            assert!(
                *rx.borrow()
                    || tokio::time::timeout(Duration::from_millis(50), rx.changed())
                        .await
                        .is_ok(),
                "a stop before the first subscription must not be lost"
            );
            assert!(*rx.borrow());
            registry.finish(&s);
        }
    }
}
