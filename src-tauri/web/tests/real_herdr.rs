#![cfg(unix)]
use herdly_web::cli::{build_serve, ServeArgs};
use std::time::Duration;

#[tokio::test]
#[ignore]
async fn lists_a_running_session_of_the_local_herdr() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("index.html"), "x").unwrap();
    let args = ServeArgs {
        bind: "127.0.0.1:0".into(),
        origin: None,
        static_dir: Some(d.path().to_path_buf()),
        state: Some(d.path().join("st")),
    };
    let (listener, st) = build_serve(&args).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cookie = herdly_web::testing::paired_cookie(&st);
    tokio::spawn(async move {
        axum::serve(listener, herdly_web::app::router(st))
            .await
            .unwrap()
    });
    let url = format!("http://{addr}/api/machines");
    for _ in 0..60 {
        let out = tokio::process::Command::new("curl")
            .args(["-s", "-H", &format!("cookie: herdly_web={cookie}"), &url])
            .output()
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
        if v[0]["sessions"]
            .as_array()
            .is_some_and(|s| s.iter().any(|s| s["running"] == true))
        {
            assert_eq!(v[0]["id"], "local");
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("no running Session listed within 15 s");
}
