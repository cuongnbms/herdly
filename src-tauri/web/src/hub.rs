//! Event hub: core `UiEvent`s become shared JSON frames for every socket.
//!
//! Each event is serialised once into an `Arc<str>` and broadcast. `PaneStatus`
//! events also go down an mpsc so `forward_statuses` can wake the Chat hub.
use crate::chat::ChatHub;
use crate::config::CHANNEL_CAP;
use herdly_core::machines::{Emit, UiEvent, LOCAL};
use herdly_core::view::PaneStatusEvent;
use serde_json::json;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

pub struct Hub {
    frames: broadcast::Sender<Arc<str>>,
    statuses: mpsc::UnboundedSender<PaneStatusEvent>,
}

impl Hub {
    pub fn new() -> (Arc<Hub>, mpsc::UnboundedReceiver<PaneStatusEvent>) {
        let (statuses, rx) = mpsc::unbounded_channel();
        let hub = Hub {
            frames: broadcast::channel(CHANNEL_CAP).0,
            statuses,
        };
        (Arc::new(hub), rx)
    }

    /// The callback core calls for every `UiEvent`.
    pub fn emit(self: &Arc<Self>) -> Emit {
        let hub = self.clone();
        Arc::new(move |ev| match ev {
            UiEvent::Machine(v) => {
                hub.send_frame(Arc::from(json!({"type": "machine", "view": v}).to_string()));
            }
            UiEvent::PaneStatus(e) => {
                hub.send_frame(Arc::from(
                    json!({"type": "pane_status", "ev": e}).to_string(),
                ));
                let _ = hub.statuses.send(e);
            }
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> {
        self.frames.subscribe()
    }

    /// Puts a ready frame on the channel (no receivers is fine).
    pub fn send_frame(&self, frame: Arc<str>) {
        let _ = self.frames.send(frame);
    }
}

/// Feeds Pane status changes to the Chat hub. Herdly Web has only the `local` Machine, and
/// `ChatHub::on_status` drops `machine_id`, so events of any other Machine are skipped.
pub async fn forward_statuses(
    mut rx: mpsc::UnboundedReceiver<PaneStatusEvent>,
    chats: Arc<ChatHub>,
) {
    while let Some(ev) = rx.recv().await {
        if ev.pane.machine_id == LOCAL {
            chats.on_status(&ev).await;
        }
    }
}
