//! A scripted `Backend` for tests.
use crate::backend::{Backend, ChatSink, WebPane};
use async_trait::async_trait;
use herdly_core::error::{AppError, AppResult};
use herdly_core::transcript::{ChatEvent, ChatItem, Located};
use herdly_core::view::MachineView;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

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
    WebPane { session: session.into(), pane_id: id.into() }
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
        self.calls.lock().unwrap().push((session.into(), method.into(), params));
        self.call_result.lock().unwrap().clone().unwrap_or_else(|| Ok(json!({})))
    }

    async fn locate(&self, pane: &WebPane) -> AppResult<Located> {
        self.log.lock().unwrap().push(format!("locate:{}", pane.pane_id));
        self.locate_results
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err(AppError::new("not_found", "no locate result")))
    }

    async fn open_chat(&self, pane: &WebPane, path: Option<String>, sink: ChatSink) -> AppResult<Located> {
        self.log
            .lock()
            .unwrap()
            .push(format!("open:{}:{}", pane.pane_id, path.as_deref().unwrap_or("-")));
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
        self.log.lock().unwrap().push(format!("opened:{}", pane.pane_id));
        result
    }

    fn page(&self, pane: &WebPane, before: usize, limit: usize) -> Option<Vec<ChatItem>> {
        self.pages.lock().unwrap().push((pane.clone(), before, limit));
        self.page_result.lock().unwrap().clone()
    }

    fn close_chat(&self, pane: &WebPane) {
        self.log.lock().unwrap().push(format!("close:{}", pane.pane_id));
    }
}
