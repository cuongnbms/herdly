//! Chat hub: one core Chat tail per Pane, fanned out to many sockets.
//!
//! Every open and close of a Pane runs under that Pane's gate (a tokio mutex),
//! so a close racing an open never leaves an orphan tail. The map lock is a std
//! mutex and is never held across an `.await`.
use crate::backend::{Backend, ChatSink, WebPane};
use crate::config::{CHANNEL_CAP, PENDING_RETRY};
use herdly_core::error::AppError;
use herdly_core::transcript::Located;
use herdly_core::view::PaneStatusEvent;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, Mutex as AsyncMutex};

pub type SocketId = u64;

struct Entry {
    tx: broadcast::Sender<Arc<str>>,
    subs: HashSet<SocketId>,
    located: Option<Located>,
    /// An open succeeded, so a tail exists that `close_chat` must end.
    opened: bool,
    gate: Arc<AsyncMutex<()>>,
}

pub struct ChatHub {
    backend: Arc<dyn Backend>,
    entries: Mutex<HashMap<WebPane, Entry>>,
}

fn frame(v: serde_json::Value) -> Arc<str> {
    Arc::from(v.to_string())
}

impl ChatHub {
    pub fn new(backend: Arc<dyn Backend>) -> Arc<ChatHub> {
        Arc::new(ChatHub {
            backend,
            entries: Mutex::new(HashMap::new()),
        })
    }

    pub async fn subscribe(
        self: &Arc<Self>,
        sock: SocketId,
        pane: WebPane,
    ) -> broadcast::Receiver<Arc<str>> {
        let (rx, gate) = {
            let mut map = self.entries.lock().unwrap();
            let e = map.entry(pane.clone()).or_insert_with(|| Entry {
                tx: broadcast::channel(CHANNEL_CAP).0,
                subs: HashSet::new(),
                located: None,
                opened: false,
                gate: Arc::new(AsyncMutex::new(())),
            });
            let rx = e.tx.subscribe();
            e.subs.insert(sock);
            (rx, e.gate.clone())
        };
        let _g = gate.lock().await;
        // The socket may have left while this open waited for the gate.
        let path = {
            let map = self.entries.lock().unwrap();
            match map.get(&pane) {
                Some(e) if Arc::ptr_eq(&e.gate, &gate) && e.subs.contains(&sock) => {
                    Some(e.located.as_ref().map(|l| l.path.clone()))
                }
                _ => None,
            }
        };
        if let Some(path) = path {
            self.open_locked(&pane, path).await;
        }
        rx
    }

    pub async fn unsubscribe(self: &Arc<Self>, sock: SocketId, pane: &WebPane) {
        let emptied = {
            let mut map = self.entries.lock().unwrap();
            match map.get_mut(pane) {
                Some(e) => e.subs.remove(&sock) && e.subs.is_empty(),
                None => false,
            }
        };
        if emptied {
            self.finish(pane).await;
        }
    }

    pub async fn drop_socket(self: &Arc<Self>, sock: SocketId) {
        let emptied: Vec<WebPane> = {
            let mut map = self.entries.lock().unwrap();
            map.iter_mut()
                .filter_map(|(p, e)| (e.subs.remove(&sock) && e.subs.is_empty()).then(|| p.clone()))
                .collect()
        };
        for pane in emptied {
            self.finish(&pane).await;
        }
    }

    pub async fn on_status(self: &Arc<Self>, ev: &PaneStatusEvent) {
        let pane = WebPane::from_ref(&ev.pane);
        if self.check_pending(&pane).await {
            let hub = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(PENDING_RETRY).await;
                hub.check_pending(&pane).await;
            });
        }
    }

    /// Locate a pending Pane again; true when it is still pending afterwards.
    async fn check_pending(&self, pane: &WebPane) -> bool {
        let gate = match self.entries.lock().unwrap().get(pane) {
            Some(e) if e.located.as_ref().is_some_and(|l| l.pending) => e.gate.clone(),
            _ => return false,
        };
        let _g = gate.lock().await;
        // Re-read under the gate: the entry may be gone or settled by now.
        let current = match self.entries.lock().unwrap().get(pane) {
            Some(e) if Arc::ptr_eq(&e.gate, &gate) => e.located.clone(),
            _ => return false,
        };
        let Some(current) = current.filter(|l| l.pending) else {
            return false;
        };
        match self.backend.locate(pane).await {
            Ok(fresh) if !fresh.pending || fresh.path != current.path => {
                let pending = fresh.pending;
                self.open_locked(pane, Some(fresh.path)).await;
                pending
            }
            Ok(_) => true,
            Err(_) => false,
        }
    }

    /// The last subscriber left: close the tail and drop the entry, unless a socket came back.
    async fn finish(&self, pane: &WebPane) {
        let gate = match self.entries.lock().unwrap().get(pane) {
            Some(e) => e.gate.clone(),
            None => return,
        };
        let _g = gate.lock().await;
        let mut map = self.entries.lock().unwrap();
        if map
            .get(pane)
            .is_some_and(|e| Arc::ptr_eq(&e.gate, &gate) && e.subs.is_empty())
        {
            let e = map.remove(pane).unwrap();
            // Under the map lock so a fresh entry's open cannot slip in before this close.
            if e.opened {
                self.backend.close_chat(pane);
            }
        }
    }

    /// Open the tail and announce it. The caller holds the Pane's gate.
    async fn open_locked(&self, pane: &WebPane, path: Option<String>) {
        let Some(tx) = self.entries.lock().unwrap().get(pane).map(|e| e.tx.clone()) else {
            return;
        };
        let sink: ChatSink = {
            let tx = tx.clone();
            let pane = pane.clone();
            Arc::new(move |ev| {
                let _ = tx.send(frame(json!({"type": "chat", "pane": pane, "event": ev})));
            })
        };
        let requested_none = path.is_none();
        let mut result = self.backend.open_chat(pane, path, sink.clone()).await;
        if let Ok(first) = &result {
            self.settle(pane, &tx, first);
            if first.cached && requested_none {
                if let Ok(fresh) = self.backend.locate(pane).await {
                    if fresh.path != first.path {
                        result = self.backend.open_chat(pane, Some(fresh.path), sink).await;
                        if let Ok(second) = &result {
                            self.settle(pane, &tx, second);
                        }
                    }
                }
            }
        }
        if let Err(err) = result {
            self.send_error(&tx, pane, &err);
        }
    }

    fn settle(&self, pane: &WebPane, tx: &broadcast::Sender<Arc<str>>, loc: &Located) {
        if let Some(e) = self.entries.lock().unwrap().get_mut(pane) {
            e.located = Some(loc.clone());
            e.opened = true;
        }
        let _ = tx.send(frame(
            json!({"type": "chat_opened", "pane": pane, "located": loc}),
        ));
    }

    fn send_error(&self, tx: &broadcast::Sender<Arc<str>>, pane: &WebPane, err: &AppError) {
        let _ = tx.send(frame(
            json!({"type": "chat_error", "pane": pane, "error": err}),
        ));
    }
}
