//! The `/ws` socket: hub frames and Chat frames out, subscribe frames in.
//!
//! One writer task owns the sink and drains a bounded mpsc. Forwarding tasks (the event hub
//! and one per subscribed Pane) feed that mpsc with `try_send`; a lagged receiver or a full
//! mpsc asks the writer to close with 4000. The revoke ticker asks for 4401. However the
//! socket ends, every task is aborted and the Chat hub drops the socket.
use crate::app::AppState;
use crate::auth::DeviceInfo;
use crate::backend::WebPane;
use crate::chat::SocketId;
use crate::config::{CHANNEL_CAP, CLOSE_LAGGED, CLOSE_REVOKED};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::Extension;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;

static NEXT_SOCKET: AtomicU64 = AtomicU64::new(1);

/// How long the writer waits for a dead peer to take the close frame.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Incoming {
    Subscribe { pane: WebPane },
    Unsubscribe { pane: WebPane },
}

/// First request wins: the first close code asked for is the one sent.
struct Closer(watch::Sender<Option<u16>>);

impl Closer {
    fn close(&self, code: u16) {
        self.0.send_if_modified(|c| {
            let first = c.is_none();
            if first {
                *c = Some(code);
            }
            first
        });
    }
}

/// Mounted behind the Origin and cookie middleware, so a refused request never upgrades.
pub async fn ws_handler(
    State(st): State<Arc<AppState>>,
    Extension(info): Extension<DeviceInfo>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| run(st, info, socket))
}

async fn run(st: Arc<AppState>, info: DeviceInfo, socket: WebSocket) {
    let id: SocketId = NEXT_SOCKET.fetch_add(1, Ordering::Relaxed);
    let (sink, mut stream) = socket.split();
    let (out_tx, out_rx) = mpsc::channel::<Arc<str>>(CHANNEL_CAP);
    let (closer, closed) = watch::channel(None);
    let closer = Arc::new(Closer(closer));

    // Subscribe before the snapshot so no event falls between the two.
    let hub_rx = st.hub.subscribe();
    let snapshot = json!({"type": "machines", "views": st.backend.views()}).to_string();
    let _ = out_tx.try_send(Arc::from(snapshot));

    let mut writer = tokio::spawn(write_loop(sink, out_rx, closed));
    let mut tasks = vec![tokio::spawn(pump(hub_rx, out_tx.clone(), closer.clone()))];
    tasks.push(tokio::spawn(revoke_loop(
        st.clone(),
        info.device_id,
        closer.clone(),
    )));
    let mut panes: HashMap<WebPane, JoinHandle<()>> = HashMap::new();

    loop {
        let msg = tokio::select! {
            _ = &mut writer => break,
            m = stream.next() => m,
        };
        let text = match msg {
            Some(Ok(Message::Text(t))) => t,
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
            Some(Ok(_)) => continue,
        };
        match serde_json::from_str::<Incoming>(&text) {
            Ok(Incoming::Subscribe { pane }) => {
                if let Some(old) = panes.remove(&pane) {
                    old.abort();
                }
                let rx = st.chats.subscribe(id, pane.clone()).await;
                let task = tokio::spawn(pump(rx, out_tx.clone(), closer.clone()));
                panes.insert(pane, task);
            }
            Ok(Incoming::Unsubscribe { pane }) => {
                if let Some(task) = panes.remove(&pane) {
                    task.abort();
                }
                st.chats.unsubscribe(id, &pane).await;
            }
            Err(_) => {}
        }
    }

    writer.abort();
    for t in tasks.into_iter().chain(panes.into_values()) {
        t.abort();
    }
    st.chats.drop_socket(id).await;
}

/// Forwards one broadcast receiver into the socket's queue.
async fn pump(
    mut rx: broadcast::Receiver<Arc<str>>,
    out: mpsc::Sender<Arc<str>>,
    closer: Arc<Closer>,
) {
    loop {
        match rx.recv().await {
            Ok(frame) => match out.try_send(frame) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    closer.close(CLOSE_LAGGED);
                    return;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => return,
            },
            Err(broadcast::error::RecvError::Lagged(_)) => {
                closer.close(CLOSE_LAGGED);
                return;
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// Closes the socket with 4401 once its device is no longer paired.
async fn revoke_loop(st: Arc<AppState>, device_id: String, closer: Arc<Closer>) {
    let mut tick = tokio::time::interval(st.cfg.revoke_check);
    tick.tick().await; // the first tick is immediate; the device was just checked
    loop {
        tick.tick().await;
        let auth = st.auth.clone();
        let id = device_id.clone();
        // `is_live` may re-read `devices.json`: keep it off the runtime.
        let live = tokio::task::spawn_blocking(move || auth.is_live(&id))
            .await
            .unwrap_or(true);
        if !live {
            closer.close(CLOSE_REVOKED);
            return;
        }
    }
}

async fn write_loop(
    mut sink: SplitSink<WebSocket, Message>,
    mut out: mpsc::Receiver<Arc<str>>,
    mut closed: watch::Receiver<Option<u16>>,
) {
    let code = loop {
        tokio::select! {
            biased;
            _ = closed.changed() => break (*closed.borrow()).unwrap_or(CLOSE_LAGGED),
            frame = out.recv() => {
                let Some(frame) = frame else { return };
                // A peer that stopped reading must not hide a close request behind this send.
                tokio::select! {
                    biased;
                    _ = closed.changed() => break (*closed.borrow()).unwrap_or(CLOSE_LAGGED),
                    sent = sink.send(Message::Text(frame.to_string().into())) => {
                        if sent.is_err() {
                            return;
                        }
                    }
                }
            }
        }
    };
    let close = Message::Close(Some(CloseFrame {
        code,
        reason: "".into(),
    }));
    let _ = tokio::time::timeout(CLOSE_GRACE, sink.send(close)).await;
}
