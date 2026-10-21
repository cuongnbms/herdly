//! A scripted `Backend` for tests.
use crate::app::{AppState, Config};
use crate::auth::{complete_pairing, start_pairing, Auth};
use crate::backend::{Backend, ChatSink, WebPane};
use crate::chat::ChatHub;
use crate::config::{now_secs, REVOKE_CHECK};
use crate::hub::Hub;
use crate::store::Store;
use crate::terminal::backend::{TerminalHandle, TerminalSize};
use crate::terminal::registry::TerminalRegistry;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use herdly_core::attach::{AttachEvent, Sink};
use herdly_core::error::{AppError, AppResult};
use herdly_core::transcript::{ChatEvent, ChatItem, Located};
use herdly_core::view::MachineView;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tower::ServiceExt;

#[derive(Default)]
pub struct FakeBackend {
    pub views: Mutex<Vec<MachineView>>,
    pub calls: Mutex<Vec<(String, String, Value)>>,
    pub call_result: Mutex<Option<AppResult<Value>>>,
    pub log: Mutex<Vec<String>>,
    pub open_results: Mutex<VecDeque<AppResult<Located>>>,
    pub open_delay: Mutex<Duration>,
    pub locate_results: Mutex<VecDeque<AppResult<Located>>>,
    pub sinks: Mutex<HashMap<WebPane, ChatSink>>,
    pub page_result: Mutex<Option<Vec<ChatItem>>>,
    pub pages: Mutex<Vec<(WebPane, usize, usize)>>,
    /// Handles a test scripted in advance; each allocation consumes one, once.
    pub scripted_terminals: Mutex<VecDeque<Arc<FakeTerminal>>>,
    /// Every allocated attempt, in order and append-only: one per `terminal` call.
    pub terminal_attempts: Mutex<Vec<Arc<FakeTerminal>>>,
    /// Every `terminal` call's full arguments, in order.
    pub terminal_calls: Mutex<Vec<(WebPane, bool)>>,
    /// When set, `terminal` fails with it (a resolution failure).
    pub terminal_error: Mutex<Option<AppError>>,
}

impl FakeBackend {
    /// Scripts the handle the next `terminal` call hands out; each scripted handle is consumed
    /// once, so later calls get fresh ones.
    pub fn script_terminal(&self, terminal: Arc<FakeTerminal>) {
        self.scripted_terminals.lock().unwrap().push_back(terminal);
    }
}

pub fn located(path: &str) -> Located {
    Located {
        agent: "claude".into(),
        path: path.into(),
        ambiguous: false,
        candidates: vec![],
        pending: false,
        cached: false,
    }
}

pub fn pane(session: &str, id: &str) -> WebPane {
    WebPane {
        session: session.into(),
        pane_id: id.into(),
    }
}

impl FakeBackend {
    /// Calls the last sink given for `pane`; a Pane never opened is ignored.
    pub fn emit(&self, pane: &WebPane, ev: ChatEvent) {
        let sink = self.sinks.lock().unwrap().get(pane).cloned();
        if let Some(sink) = sink {
            sink(ev);
        }
    }
}

/// What a test observed of one Terminal attempt. Only the OS/network boundary is replaced:
/// bytes and events still reach the real `Sink` the socket gave `open`.
#[derive(Default)]
pub struct FakeTerminal {
    /// The attempt was allocated and has not been closed.
    closed: Mutex<bool>,
    opened: Mutex<bool>,
    sizes: Mutex<Vec<TerminalSize>>,
    resizes: Mutex<Vec<TerminalSize>>,
    inputs: Mutex<Vec<Vec<u8>>>,
    acks: Mutex<Vec<usize>>,
    closes: Mutex<usize>,
    /// The sink `open` captured, so the test can deliver as the PTY would.
    sink: Mutex<Option<Arc<dyn Sink>>>,
    /// Held until a test releases it, to model a spawn that blocks.
    open_gate: Mutex<Option<oneshot::Receiver<()>>>,
    /// Held until a test releases it, to model a write stuck behind a wedged PTY.
    write_gate: Mutex<Option<oneshot::Receiver<()>>>,
    /// Inputs the PTY is still stuck behind, oldest first: the first receives the next
    /// [`FakeTerminal::release_write`].
    waiting_writes: Mutex<VecDeque<oneshot::Sender<()>>>,
    /// When set, every write parks until a test releases it, the way a wedged PTY holds each
    /// write in turn.
    park_writes: Mutex<bool>,
    /// Resizes currently inside `resize`; a value above one would mean unserialized resizes.
    resizes_in_flight: AtomicUsize,
    /// The highest `resizes_in_flight` ever observed, for asserting the worker serializes.
    resizes_peak: AtomicUsize,
    /// Held while set, to model a resize stuck on a PTY lock.
    resize_gate: Mutex<Option<oneshot::Receiver<()>>>,
    /// Writes currently inside `write`: 0 means the input worker is not stuck in one.
    writes_in_flight: AtomicUsize,
    /// The in-flight write count observed at `close`, so a test can show cleanup arrived while
    /// a write was still stuck, i.e. before anything waited for the worker.
    closed_with_writes_in_flight: AtomicUsize,
    open_fails: Mutex<Option<AppError>>,
}

impl FakeTerminal {
    /// A Terminal whose `open` blocks until the returned sender is dropped.
    pub fn gated() -> (Arc<FakeTerminal>, oneshot::Sender<()>) {
        let (tx, rx) = oneshot::channel();
        let terminal = Arc::new(FakeTerminal {
            open_gate: Mutex::new(Some(rx)),
            ..Default::default()
        });
        (terminal, tx)
    }

    /// A Terminal whose `write` records its input and then waits until the returned sender is
    /// dropped, the way a PTY write blocks behind a wedged terminal. Only the first write waits.
    pub fn gated_write() -> (Arc<FakeTerminal>, oneshot::Sender<()>) {
        let (tx, rx) = oneshot::channel();
        let terminal = Arc::new(FakeTerminal {
            write_gate: Mutex::new(Some(rx)),
            ..Default::default()
        });
        (terminal, tx)
    }

    /// A Terminal whose every `write` parks until [`FakeTerminal::release_write`], so a test
    /// can hold the input worker while more frames arrive.
    pub fn parking_writes() -> Arc<FakeTerminal> {
        let terminal = FakeTerminal::default();
        *terminal.park_writes.lock().unwrap() = true;
        Arc::new(terminal)
    }

    /// A Terminal whose first `resize` blocks until the returned sender is dropped, so a test
    /// can hold the resize worker while a burst of sizes arrives behind it.
    pub fn gated_resize() -> (Arc<FakeTerminal>, oneshot::Sender<()>) {
        let (tx, rx) = oneshot::channel();
        let terminal = Arc::new(FakeTerminal {
            resize_gate: Mutex::new(Some(rx)),
            ..Default::default()
        });
        (terminal, tx)
    }

    /// A Terminal whose `open` fails with `e`.
    pub fn failing(e: AppError) -> Arc<FakeTerminal> {
        Arc::new(FakeTerminal {
            open_fails: Mutex::new(Some(e)),
            ..Default::default()
        })
    }

    pub fn inputs(&self) -> Vec<Vec<u8>> {
        self.inputs.lock().unwrap().clone()
    }
    pub fn acks(&self) -> Vec<usize> {
        self.acks.lock().unwrap().clone()
    }
    pub fn sizes(&self) -> Vec<TerminalSize> {
        self.sizes.lock().unwrap().clone()
    }
    pub fn resizes(&self) -> Vec<TerminalSize> {
        self.resizes.lock().unwrap().clone()
    }
    pub fn is_open(&self) -> bool {
        *self.opened.lock().unwrap() && !self.is_closed()
    }
    pub fn is_closed(&self) -> bool {
        *self.closed.lock().unwrap()
    }

    /// Releases the oldest parked write, the way a wedged PTY finally accepting bytes would.
    /// `false` when nothing is waiting.
    pub fn release_write(&self) -> bool {
        let next = self.waiting_writes.lock().unwrap().pop_front();
        match next {
            Some(tx) => tx.send(()).is_ok(),
            None => false,
        }
    }
    pub fn close_count(&self) -> usize {
        *self.closes.lock().unwrap()
    }
    /// How many writes were still inside `write` when `close` ran.
    pub fn closed_with_writes_in_flight(&self) -> usize {
        self.closed_with_writes_in_flight.load(Ordering::SeqCst)
    }
    /// The most resizes that were ever inside `resize` at once: 1 means serialized.
    pub fn resizes_peak(&self) -> usize {
        self.resizes_peak.load(Ordering::SeqCst)
    }

    /// The failure this attempt will report when its `open` finishes, so a test can combine a
    /// gated spawn with a failing one.
    pub fn pending_open_failure(&self) -> &Mutex<Option<AppError>> {
        &self.open_fails
    }

    /// Delivers output through the real sink, as the PTY reader would.
    pub fn emit_data(&self, bytes: Vec<u8>) {
        let sink = self.sink.lock().unwrap().clone();
        if let Some(sink) = sink {
            sink.data(bytes);
        }
    }

    /// Delivers a Terminal event through the real sink.
    pub fn emit_event(&self, e: AttachEvent) {
        let sink = self.sink.lock().unwrap().clone();
        if let Some(sink) = sink {
            sink.event(e);
        }
    }
}

#[async_trait]
impl TerminalHandle for FakeTerminal {
    async fn open(&self, size: TerminalSize, sink: Arc<dyn Sink>) -> AppResult<()> {
        self.sizes.lock().unwrap().push(size);
        *self.sink.lock().unwrap() = Some(sink);
        let gate = self.open_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            let _ = gate.await;
        }
        if let Some(e) = self.open_fails.lock().unwrap().take() {
            return Err(e);
        }
        *self.opened.lock().unwrap() = true;
        Ok(())
    }

    async fn write(&self, data: Vec<u8>) -> AppResult<()> {
        if self.is_closed() {
            return Err(AppError::new("not_found", "terminal is closed"));
        }
        // Recorded before any wait, so a test can assert what was attempted while it is stuck.
        self.inputs.lock().unwrap().push(data);
        self.writes_in_flight.fetch_add(1, Ordering::SeqCst);
        let gate = self.write_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            let _ = gate.await;
            self.writes_in_flight.fetch_sub(1, Ordering::SeqCst);
            return Ok(());
        }
        // A parking terminal holds each write until the test releases it, so a socket's input
        // worker really wedges; otherwise a write returns as soon as it is recorded.
        if *self.park_writes.lock().unwrap() {
            let (tx, rx) = oneshot::channel();
            self.waiting_writes.lock().unwrap().push_back(tx);
            let _ = rx.await;
        }
        self.writes_in_flight.fetch_sub(1, Ordering::SeqCst);
        Ok(())
    }

    async fn resize(&self, size: TerminalSize) -> AppResult<()> {
        if self.is_closed() {
            return Err(AppError::new("not_found", "terminal is closed"));
        }
        let now = self.resizes_in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.resizes_peak.fetch_max(now, Ordering::SeqCst);
        self.resizes.lock().unwrap().push(size);
        let gate = self.resize_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            let _ = gate.await;
        }
        self.resizes_in_flight.fetch_sub(1, Ordering::SeqCst);
        Ok(())
    }

    fn ack(&self, bytes: usize) {
        self.acks.lock().unwrap().push(bytes);
    }

    async fn close(&self) {
        self.closed_with_writes_in_flight.store(
            self.writes_in_flight.load(Ordering::SeqCst),
            Ordering::SeqCst,
        );
        *self.closes.lock().unwrap() += 1;
        *self.closed.lock().unwrap() = true;
    }
}

#[async_trait]
impl Backend for FakeBackend {
    fn views(&self) -> Vec<MachineView> {
        self.views.lock().unwrap().clone()
    }

    async fn call(&self, session: &str, method: &str, params: Value) -> AppResult<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((session.into(), method.into(), params));
        self.call_result
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| Ok(json!({})))
    }

    async fn locate(&self, pane: &WebPane) -> AppResult<Located> {
        self.log
            .lock()
            .unwrap()
            .push(format!("locate:{}", pane.pane_id));
        self.locate_results
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(AppError::new("not_found", "no locate result")))
    }

    async fn open_chat(
        &self,
        pane: &WebPane,
        path: Option<String>,
        sink: ChatSink,
    ) -> AppResult<Located> {
        self.log.lock().unwrap().push(format!(
            "open:{}:{}",
            pane.pane_id,
            path.as_deref().unwrap_or("-")
        ));
        self.sinks.lock().unwrap().insert(pane.clone(), sink);
        let delay = *self.open_delay.lock().unwrap();
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let result = self
            .open_results
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Ok(located(path.as_deref().unwrap_or("/t/a.jsonl"))));
        self.log
            .lock()
            .unwrap()
            .push(format!("opened:{}", pane.pane_id));
        result
    }

    fn page(&self, pane: &WebPane, before: usize, limit: usize) -> Option<Vec<ChatItem>> {
        self.pages
            .lock()
            .unwrap()
            .push((pane.clone(), before, limit));
        self.page_result.lock().unwrap().clone()
    }

    fn close_chat(&self, pane: &WebPane) {
        self.log
            .lock()
            .unwrap()
            .push(format!("close:{}", pane.pane_id));
    }

    async fn terminal(&self, pane: &WebPane, takeover: bool) -> AppResult<Arc<dyn TerminalHandle>> {
        self.log
            .lock()
            .unwrap()
            .push(format!("terminal:{}:{takeover}", pane.pane_id));
        self.terminal_calls
            .lock()
            .unwrap()
            .push((pane.clone(), takeover));
        // A scripted attempt can refuse the allocation, as resolution does.
        if let Some(e) = self.terminal_error.lock().unwrap().clone() {
            return Err(e);
        }
        // One call is one attempt: a scripted handle is consumed once, otherwise this is a
        // fresh one. Both are appended to the history, which is never popped.
        let terminal = match self.scripted_terminals.lock().unwrap().pop_front() {
            Some(t) => t,
            None => Arc::new(FakeTerminal::default()),
        };
        self.terminal_attempts
            .lock()
            .unwrap()
            .push(terminal.clone());
        Ok(terminal)
    }
}

/// An `AppState` over `backend` with a static bundle and a state dir under `dir`.
pub fn state(backend: Arc<FakeBackend>, dir: &Path) -> Arc<AppState> {
    state_with(backend, dir, REVOKE_CHECK)
}

/// Like `state`, with the interval at which an open socket re-checks its device.
pub fn state_with(backend: Arc<FakeBackend>, dir: &Path, revoke_check: Duration) -> Arc<AppState> {
    state_for(backend, dir, revoke_check)
}

/// Like `state_with`, with a shortened initial-open deadline for the route's own deadline test.
pub fn state_with_open_timeout(
    backend: Arc<FakeBackend>,
    dir: &Path,
    revoke_check: Duration,
    open_timeout: Duration,
) -> Arc<AppState> {
    state_tuned(backend, dir, revoke_check, open_timeout)
}

/// An `AppState` over any backend: the real-PTY tests need one that is not the fake.
pub fn state_for(backend: Arc<dyn Backend>, dir: &Path, revoke_check: Duration) -> Arc<AppState> {
    state_tuned(
        backend,
        dir,
        revoke_check,
        crate::terminal::socket::OPEN_TIMEOUT,
    )
}

fn state_tuned(
    backend: Arc<dyn Backend>,
    dir: &Path,
    revoke_check: Duration,
    open_timeout: Duration,
) -> Arc<AppState> {
    let dist = dir.join("dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(
        dist.join("index.html"),
        "<!doctype html><title>Herdly</title>",
    )
    .unwrap();
    std::fs::write(dist.join("assets/app-1a2b.js"), "console.log(1)").unwrap();
    let store = Store::open(&dir.join("state")).unwrap();
    // The status receiver is dropped: tests that need statuses build their own `Hub`.
    let (hub, _statuses) = Hub::new();
    Arc::new(AppState {
        chats: ChatHub::new(backend.clone()),
        backend,
        auth: Arc::new(Auth::new(store)),
        cfg: Config {
            origin: "http://192.0.2.10:7380".into(),
            static_dir: dist,
            revoke_check,
            open_timeout,
        },
        hub,
        terminals: TerminalRegistry::new(),
    })
}

/// Pairs a fresh device through the state's store and returns its cookie value.
pub fn paired_cookie(state: &AppState) -> String {
    let now = now_secs();
    let token = start_pairing(state.auth.store(), now).unwrap();
    complete_pairing(state.auth.store(), &token, "test-agent", now)
        .unwrap()
        .1
}

pub async fn send(app: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, String) {
    let res = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (
        parts.status,
        parts.headers,
        String::from_utf8_lossy(&bytes).into_owned(),
    )
}
