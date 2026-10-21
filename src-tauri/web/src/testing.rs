//! A scripted `Backend` for tests.
use crate::app::{AppState, Config};
use crate::auth::{complete_pairing, start_pairing, Auth};
use crate::backend::{Backend, ChatSink, WebPane};
use crate::chat::ChatHub;
use crate::config::{now_secs, REVOKE_CHECK};
use crate::hub::Hub;
use crate::store::Store;
use async_trait::async_trait;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use herdly_core::error::{AppError, AppResult};
use herdly_core::transcript::{ChatEvent, ChatItem, Located};
use herdly_core::view::MachineView;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
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
}

/// An `AppState` over `backend` with a static bundle and a state dir under `dir`.
pub fn state(backend: Arc<FakeBackend>, dir: &Path) -> Arc<AppState> {
    state_with(backend, dir, REVOKE_CHECK)
}

/// Like `state`, with the interval at which an open socket re-checks its device.
pub fn state_with(backend: Arc<FakeBackend>, dir: &Path, revoke_check: Duration) -> Arc<AppState> {
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
        },
        hub,
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
