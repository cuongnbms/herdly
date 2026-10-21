//! What the server needs from herdly-core, as a trait so tests can fake it.
use async_trait::async_trait;
use herdly_core::error::AppResult;
use herdly_core::machines::{MachineManager, LOCAL};
use herdly_core::transcript::{ChatItem, ChatManager, Located};
use herdly_core::view::{MachineView, PaneRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

/// A Pane as the web client names it; the Machine is always the local one.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WebPane {
    pub session: String,
    pub pane_id: String,
}

impl WebPane {
    pub fn to_ref(&self) -> PaneRef {
        PaneRef {
            machine_id: LOCAL.to_string(),
            session: self.session.clone(),
            pane_id: self.pane_id.clone(),
        }
    }

    pub fn from_ref(r: &PaneRef) -> WebPane {
        WebPane {
            session: r.session.clone(),
            pane_id: r.pane_id.clone(),
        }
    }
}

pub type ChatSink = herdly_core::transcript::Sink;

#[async_trait]
pub trait Backend: Send + Sync + 'static {
    fn views(&self) -> Vec<MachineView>;
    async fn call(&self, session: &str, method: &str, params: Value) -> AppResult<Value>;
    async fn locate(&self, pane: &WebPane) -> AppResult<Located>;
    async fn open_chat(
        &self,
        pane: &WebPane,
        path: Option<String>,
        sink: ChatSink,
    ) -> AppResult<Located>;
    fn page(&self, pane: &WebPane, before: usize, limit: usize) -> Option<Vec<ChatItem>>;
    fn close_chat(&self, pane: &WebPane);
}

/// The real backend: herdly-core's managers.
pub struct Core {
    pub mgr: Arc<MachineManager>,
    pub chats: Arc<ChatManager>,
}

#[async_trait]
impl Backend for Core {
    fn views(&self) -> Vec<MachineView> {
        self.mgr.views()
    }

    async fn call(&self, session: &str, method: &str, params: Value) -> AppResult<Value> {
        self.mgr.call(LOCAL, session, method, params).await
    }

    async fn locate(&self, pane: &WebPane) -> AppResult<Located> {
        self.mgr.locate_pane(&pane.to_ref(), None).await
    }

    async fn open_chat(
        &self,
        pane: &WebPane,
        path: Option<String>,
        sink: ChatSink,
    ) -> AppResult<Located> {
        self.mgr
            .open_chat(&self.chats, &pane.to_ref(), path, sink)
            .await
    }

    fn page(&self, pane: &WebPane, before: usize, limit: usize) -> Option<Vec<ChatItem>> {
        self.chats.page(&pane.to_ref(), before, limit)
    }

    fn close_chat(&self, pane: &WebPane) {
        self.chats.close(&pane.to_ref());
    }
}
