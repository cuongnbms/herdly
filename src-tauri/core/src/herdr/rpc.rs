//! Socket RPC client and event subscription for herdr.
use super::codec::{decode_frame, encode_request, Frame};
use super::types::{EventFrame, Snapshot};
use crate::error::{AppError, AppResult};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{unix::OwnedReadHalf, UnixStream},
    sync::mpsc,
    task::JoinHandle,
    time::timeout,
};

const RPC_TIMEOUT: Duration = Duration::from_secs(10);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Event name forwarded in place of a subscription frame that could not be decoded.
pub const UNDECODABLE: &str = "__undecodable";

/// Message prefix of the error for a peer that closes before answering.
const CLOSED_EARLY: &str = "connection closed before response to";

/// True when `e` says the peer closed or reset the connection before any response
/// (as a forwarded socket does when sshd refuses the forward), as opposed to a connect failure.
pub fn closed_early(e: &AppError) -> bool {
    e.code == "io"
        && (e.message.starts_with(CLOSED_EARLY)
            || e.message.contains("Connection reset")
            || e.message.contains("Broken pipe"))
}

fn timeout_err(method: &str) -> AppError {
    AppError::new("timeout", format!("{method} took longer than 10s"))
}

/// Connect, send one request and return the lines reader plus the request id.
async fn open(
    socket: &Path,
    method: &str,
    params: &Value,
) -> AppResult<(
    tokio::io::Lines<BufReader<OwnedReadHalf>>,
    String,
    tokio::net::unix::OwnedWriteHalf,
)> {
    let stream = UnixStream::connect(socket).await?;
    let (r, mut w) = stream.into_split();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
    w.write_all(encode_request(&id, method, params).as_bytes())
        .await?;
    Ok((BufReader::new(r).lines(), id, w))
}

/// Read lines until the response for `id`; events and other ids are skipped.
async fn read_response(
    lines: &mut tokio::io::Lines<BufReader<OwnedReadHalf>>,
    id: &str,
    method: &str,
) -> AppResult<Value> {
    loop {
        let Some(line) = lines.next_line().await? else {
            return Err(AppError::new("io", format!("{CLOSED_EARLY} {method}")));
        };
        match decode_frame(&line)? {
            Frame::Result { id: rid, result } if rid == id => return Ok(result),
            Frame::Error {
                id: rid, message, ..
            } if rid == id => return Err(AppError::new("herdr_error", message)),
            _ => {}
        }
    }
}

/// One request on a fresh connection (herdr closes the socket after one response, so a
/// connection cannot be reused). 10 s timeout covers connect, write and read.
pub async fn call(socket: &Path, method: &str, params: Value) -> AppResult<Value> {
    let fut = async {
        let (mut lines, id, _w) = open(socket, method, &params).await?;
        read_response(&mut lines, &id, method).await
    };
    timeout(RPC_TIMEOUT, fut)
        .await
        .map_err(|_| timeout_err(method))?
}

pub async fn snapshot(socket: &Path) -> AppResult<Snapshot> {
    let result = call(socket, "session.snapshot", json!({})).await?;
    let snap = result
        .get("snapshot")
        .cloned()
        .ok_or_else(|| AppError::new("protocol", "session.snapshot result has no snapshot"))?;
    serde_json::from_value(snap)
        .map_err(|e| AppError::new("protocol", format!("invalid snapshot: {e}")))
}

/// Live event stream. Dropping it aborts the reader task; `rx` yields `None` when the socket closes.
pub struct Subscription {
    pub rx: mpsc::Receiver<EventFrame>,
    task: JoinHandle<()>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn subscribe(socket: &Path, subscriptions: Vec<Value>) -> AppResult<Subscription> {
    let method = "events.subscribe";
    let params = json!({ "subscriptions": subscriptions });
    let fut = async {
        let (mut lines, id, w) = open(socket, method, &params).await?;
        read_response(&mut lines, &id, method).await?;
        Ok::<_, AppError>((lines, w))
    };
    let (mut lines, w) = timeout(RPC_TIMEOUT, fut)
        .await
        .map_err(|_| timeout_err(method))??;
    let (tx, rx) = mpsc::channel(256);
    let task = tokio::spawn(async move {
        let _w = w; // keep the write half open for the life of the stream
        while let Ok(Some(line)) = lines.next_line().await {
            match decode_frame(&line) {
                Ok(Frame::Event(e)) => {
                    if tx.send(e).await.is_err() {
                        return;
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    // We cannot tell what we missed: the watcher refetches on any unknown event.
                    tracing::warn!("undecodable herdr frame, asking for a refetch: {e}");
                    let ev = EventFrame {
                        event: UNDECODABLE.into(),
                        data: Value::Null,
                    };
                    if tx.send(ev).await.is_err() {
                        return;
                    }
                }
            }
        }
    });
    Ok(Subscription { rx, task })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::fake::FakeHerdr;
    use serde_json::json;
    use std::sync::Arc;

    #[tokio::test]
    async fn call_returns_result() {
        let f = FakeHerdr::start(Arc::new(|m, p| {
            assert_eq!(m, "agent.get");
            Ok(json!({"type":"agent_info","agent":{"pane_id": p["target"]}}))
        }));
        let r = call(&f.path, "agent.get", json!({"target":"w1:p1"}))
            .await
            .unwrap();
        assert_eq!(r["agent"]["pane_id"], "w1:p1");
    }
    #[tokio::test]
    async fn call_maps_herdr_errors() {
        let f = FakeHerdr::start(Arc::new(|_, _| Err(("not_found".into(), "no pane".into()))));
        let e = call(&f.path, "pane.close", json!({"pane_id":"x"}))
            .await
            .unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("herdr_error", "no pane")
        );
    }
    #[tokio::test]
    async fn eof_before_response_is_closed_early_but_connect_failure_is_not() {
        let d = tempfile::Builder::new()
            .prefix("hr")
            .tempdir_in("/tmp")
            .unwrap();
        let sock = d.path().join("c.sock");
        let l = tokio::net::UnixListener::bind(&sock).unwrap();
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                drop(s);
            }
        });
        assert!(closed_early(
            &call(&sock, "session.snapshot", json!({}))
                .await
                .unwrap_err()
        ));
        let missing = call(
            std::path::Path::new("/tmp/definitely-not-here.sock"),
            "x",
            json!({}),
        )
        .await
        .unwrap_err();
        assert!(!closed_early(&missing));
    }
    #[tokio::test]
    async fn undecodable_subscription_frame_is_forwarded_as_a_synthetic_event() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let d = tempfile::Builder::new()
            .prefix("hr")
            .tempdir_in("/tmp")
            .unwrap();
        let sock = d.path().join("u.sock");
        let l = tokio::net::UnixListener::bind(&sock).unwrap();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let (r, mut w) = s.into_split();
            let line = BufReader::new(r)
                .lines()
                .next_line()
                .await
                .unwrap()
                .unwrap();
            let id = serde_json::from_str::<Value>(&line).unwrap()["id"].clone();
            let started = json!({"id": id, "result": {"type": "subscription_started"}});
            w.write_all(
                format!(
                    "{started}\nnot json at all\n{}\n",
                    json!({"event":"pane_created","data":{}})
                )
                .as_bytes(),
            )
            .await
            .unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        });
        let mut sub = subscribe(&sock, vec![json!({"type":"pane.created"})])
            .await
            .unwrap();
        assert_eq!(sub.rx.recv().await.unwrap().event, UNDECODABLE);
        assert_eq!(
            sub.rx.recv().await.unwrap().event,
            "pane_created",
            "later frames still arrive"
        );
    }
    #[tokio::test]
    async fn missing_socket_is_io_error() {
        let e = call(
            std::path::Path::new("/tmp/definitely-not-here.sock"),
            "x",
            json!({}),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, "io");
    }
    #[tokio::test]
    async fn snapshot_unwraps_payload() {
        let snap: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |_, _| {
            Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
        }));
        assert_eq!(snapshot(&f.path).await.unwrap().panes.len(), 4);
    }
    #[tokio::test]
    async fn subscription_streams_events_then_ends() {
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({}))));
        let mut sub = subscribe(&f.path, vec![json!({"type":"pane.created"})])
            .await
            .unwrap();
        f.emit("pane_created", json!({"pane_id":"w1:p3"}));
        let e = sub.rx.recv().await.unwrap();
        assert_eq!(
            (e.event.as_str(), e.data["pane_id"].as_str()),
            ("pane_created", Some("w1:p3"))
        );
        f.close_subscriptions();
        assert!(sub.rx.recv().await.is_none());
    }
}
