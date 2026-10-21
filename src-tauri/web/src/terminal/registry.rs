//! The set of live Terminal attempts, owned by the application rather than by a socket task.
//!
//! A socket task can be cancelled at any await while its Attach spawn is still running. The
//! handle would then be dropped without `close`, leaving a `herdr terminal attach` child
//! behind. So cleanup is registered here, on the supervisor that owns it, and removed only
//! once cleanup has finished. Shutdown walks the same list: no attempt is left with an open
//! Attach, and no new attempt starts once shutdown has begun.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, watch};

/// How long shutdown waits for one attempt's cleanup before moving on.
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
        // Also wakes a socket that is only reading.
        let _ = self.cancel.send(true);
    }

    /// The signal that started cleanup, if any.
    pub fn signal(&self) -> Option<Signal> {
        *self.signal.lock().unwrap()
    }

    /// Receivers observe `true` once this attempt is being stopped.
    pub fn cancellation(&self) -> watch::Receiver<bool> {
        self.cancel.subscribe()
    }

    /// Resolves once cleanup has finished, or after [`JOIN_TIMEOUT`] if it never does.
    pub async fn join(&self) {
        let rx = self.joined.lock().unwrap().take();
        let Some(rx) = rx else { return };
        if tokio::time::timeout(JOIN_TIMEOUT, rx).await.is_err() {
            tracing::warn!("terminal attempt cleanup exceeded its join timeout");
        }
    }
}

struct Entry {
    supervisor: Arc<Supervisor>,
    /// Dropped when cleanup finishes, resolving every `Supervisor::join`.
    _done: Option<oneshot::Sender<()>>,
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

    /// Registers a new attempt, or refuses it because shutdown has begun.
    pub fn register(self: &Arc<Self>) -> Option<Arc<Supervisor>> {
        let mut entries = self.entries.lock().unwrap();
        // Checked under the same lock `shutdown` takes, so a registration never races past it.
        if self.shutting_down.load(Ordering::SeqCst) {
            return None;
        }
        let (cancel, _) = watch::channel(false);
        let (done, joined) = oneshot::channel();
        let supervisor = Arc::new(Supervisor {
            id: self.next.fetch_add(1, Ordering::Relaxed),
            cancel,
            signal: Mutex::new(None),
            joined: Mutex::new(Some(joined)),
        });
        entries.push(Entry {
            supervisor: supervisor.clone(),
            _done: Some(done),
        });
        Some(supervisor)
    }

    /// Records that an attempt's cleanup has finished and forgets it.
    pub fn finish(&self, supervisor: &Arc<Supervisor>) {
        let done = {
            let mut entries = self.entries.lock().unwrap();
            entries
                .iter()
                .position(|e| e.supervisor.id == supervisor.id)
                .map(|i| entries.remove(i))
        };
        drop(done);
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
        self.shutting_down.store(true, Ordering::SeqCst);
        let stops: Vec<Arc<Supervisor>> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.supervisor.clone())
            .collect();
        for s in &stops {
            s.stop(Signal::Shutdown);
        }
        for s in stops {
            s.join().await;
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
}
