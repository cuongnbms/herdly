use futures_util::{SinkExt, StreamExt};
use herdly_web::app::router;
use herdly_web::testing::{paired_cookie, state_with, FakeBackend};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::frame::coding::CloseCode, Message,
};

async fn serve(
    revoke_check: Duration,
) -> (
    tempfile::TempDir,
    Arc<FakeBackend>,
    Arc<herdly_web::app::AppState>,
    String,
    String,
) {
    let d = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeBackend::default());
    let st = state_with(fake.clone(), d.path(), revoke_check);
    let cookie = paired_cookie(&st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(st.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (d, fake, st, cookie, format!("ws://{addr}/ws"))
}

fn request(
    url: &str,
    cookie: Option<&str>,
    origin: &str,
) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    let mut r = url.into_client_request().unwrap();
    r.headers_mut().insert("origin", origin.parse().unwrap());
    if let Some(c) = cookie {
        r.headers_mut()
            .insert("cookie", format!("herdly_web={c}").parse().unwrap());
    }
    r
}

const ORIGIN: &str = "http://192.0.2.10:7380";

async fn next_json<
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
>(
    s: &mut S,
) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(2), s.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        {
            Message::Text(t) => return serde_json::from_str(&t).unwrap(),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn upgrade_needs_origin_and_cookie() {
    let (_d, _f, _st, cookie, url) = serve(Duration::from_secs(15)).await;
    assert!(
        tokio_tungstenite::connect_async(request(&url, Some(&cookie), "http://evil.example"))
            .await
            .is_err()
    );
    assert!(
        tokio_tungstenite::connect_async(request(&url, None, ORIGIN))
            .await
            .is_err()
    );
    assert!(
        tokio_tungstenite::connect_async(request(&url, Some(&cookie), ORIGIN))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn first_frame_is_the_machines_snapshot_then_subscribe_brings_chat_frames() {
    let (_d, fake, _st, cookie, url) = serve(Duration::from_secs(15)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(request(&url, Some(&cookie), ORIGIN))
        .await
        .unwrap();
    let first = next_json(&mut ws).await;
    assert_eq!(first, json!({"type": "machines", "views": []}));
    ws.send(Message::Text(
        json!({"type": "subscribe", "pane": {"session": "s", "pane_id": "p1"}})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    assert_eq!(next_json(&mut ws).await["type"], "chat_opened");
    ws.send(Message::Text(
        json!({"type": "unsubscribe", "pane": {"session": "s", "pane_id": "p1"}})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.log.lock().unwrap().last().unwrap(), "close:p1");
}

#[tokio::test]
async fn closing_the_socket_releases_its_chats() {
    let (_d, fake, _st, cookie, url) = serve(Duration::from_secs(15)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(request(&url, Some(&cookie), ORIGIN))
        .await
        .unwrap();
    next_json(&mut ws).await;
    ws.send(Message::Text(
        json!({"type": "subscribe", "pane": {"session": "s", "pane_id": "p1"}})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    next_json(&mut ws).await;
    drop(ws);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fake.log.lock().unwrap().last().unwrap(), "close:p1");
}

#[tokio::test]
async fn a_lagging_socket_is_closed_with_4000() {
    let (_d, _f, st, cookie, url) = serve(Duration::from_secs(15)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(request(&url, Some(&cookie), ORIGIN))
        .await
        .unwrap();
    next_json(&mut ws).await;
    let big: Arc<str> = Arc::from(
        format!(
            "{{\"type\":\"machine\",\"pad\":\"{}\"}}",
            "x".repeat(64 * 1024)
        )
        .as_str(),
    );
    for _ in 0..5000 {
        st.hub.send_frame(big.clone());
    }
    let code = loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Close(Some(f)))) => break f.code,
            Some(Ok(_)) => continue,
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(code, CloseCode::Library(4000));
}

#[tokio::test]
async fn a_revoked_device_is_closed_with_4401() {
    let (_d, _f, st, cookie, url) = serve(Duration::from_millis(100)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(request(&url, Some(&cookie), ORIGIN))
        .await
        .unwrap();
    next_json(&mut ws).await;
    let id = herdly_web::auth::list_devices(st.auth.store()).unwrap()[0]
        .id
        .clone();
    std::thread::sleep(Duration::from_millis(20));
    herdly_web::auth::revoke(st.auth.store(), &id).unwrap();
    let code = loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
        {
            Some(Ok(Message::Close(Some(f)))) => break f.code,
            Some(Ok(_)) => continue,
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(code, CloseCode::Library(4401));
}
