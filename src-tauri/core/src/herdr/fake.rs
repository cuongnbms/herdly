//! Minimal in-process herdr socket for tests.
use super::types::EventFrame;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    sync::broadcast,
};

pub type Handler = Arc<dyn Fn(&str, &Value) -> Result<Value, (String, String)> + Send + Sync>;

pub struct FakeHerdr {
    pub path: PathBuf,
    _dir: tempfile::TempDir,
    events: broadcast::Sender<Option<EventFrame>>,
    pub calls: Arc<Mutex<Vec<(String, Value)>>>,
}

impl FakeHerdr {
    pub fn start(handler: Handler) -> FakeHerdr {
        let dir = tempfile::Builder::new()
            .prefix("hf")
            .tempdir_in("/tmp")
            .unwrap();
        let path = dir.path().join("h.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let (events, _) = broadcast::channel::<Option<EventFrame>>(256);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (ev, c) = (events.clone(), calls.clone());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (handler, ev, c) = (handler.clone(), ev.clone(), c.clone());
                tokio::spawn(async move {
                    let (r, mut w) = stream.into_split();
                    let mut lines = BufReader::new(r).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let req: Value = serde_json::from_str(&line).unwrap();
                        let (id, method) = (
                            req["id"].clone(),
                            req["method"].as_str().unwrap().to_string(),
                        );
                        c.lock()
                            .unwrap()
                            .push((method.clone(), req["params"].clone()));
                        if method == "events.subscribe" {
                            let mut rx = ev.subscribe();
                            let started =
                                json!({"id": id, "result": {"type": "subscription_started"}});
                            w.write_all(format!("{started}\n").as_bytes())
                                .await
                                .unwrap();
                            while let Ok(item) = rx.recv().await {
                                match item {
                                    Some(e) => {
                                        let f = json!({"event": e.event, "data": e.data});
                                        if w.write_all(format!("{f}\n").as_bytes()).await.is_err() {
                                            return;
                                        }
                                    }
                                    None => return, // close all subscriptions
                                }
                            }
                            return;
                        }
                        let frame = match handler(&method, &req["params"]) {
                            Ok(result) => json!({"id": id, "result": result}),
                            Err((code, message)) => {
                                json!({"id": id, "error": {"code": code, "message": message}})
                            }
                        };
                        w.write_all(format!("{frame}\n").as_bytes()).await.unwrap();
                    }
                });
            }
        });
        FakeHerdr {
            path,
            _dir: dir,
            events,
            calls,
        }
    }
    pub fn emit(&self, event: &str, data: Value) {
        let _ = self.events.send(Some(EventFrame {
            event: event.into(),
            data,
        }));
    }
    pub fn close_subscriptions(&self) {
        let _ = self.events.send(None);
    }
    pub fn calls_of(&self, method: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == method)
            .count()
    }
}
