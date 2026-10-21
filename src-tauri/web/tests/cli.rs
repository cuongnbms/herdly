use herdly_web::cli::{build_serve, origin_for, state_dir, ServeArgs};
use std::path::PathBuf;

fn args(bind: &str, static_dir: Option<PathBuf>, state: PathBuf) -> ServeArgs {
    ServeArgs {
        bind: bind.into(),
        origin: None,
        static_dir,
        state: Some(state),
    }
}

#[test]
fn origin_defaults_to_the_bind_address() {
    assert_eq!(
        origin_for("192.0.2.10:7380", None),
        "http://192.0.2.10:7380"
    );
    assert_eq!(
        origin_for("192.0.2.10:7380", Some("http://devbox:7380".into())),
        "http://devbox:7380"
    );
}

#[test]
fn state_dir_falls_back_to_local_state_under_home() {
    std::env::remove_var("XDG_STATE_HOME");
    std::env::set_var("HOME", "/home/u");
    assert_eq!(
        state_dir(None),
        PathBuf::from("/home/u/.local/state/herdly-web")
    );
    std::env::set_var("XDG_STATE_HOME", "/x");
    assert_eq!(state_dir(None), PathBuf::from("/x/herdly-web"));
    assert_eq!(state_dir(Some("/s".into())), PathBuf::from("/s"));
}

#[tokio::test]
async fn serve_refuses_a_missing_static_dir() {
    let d = tempfile::tempdir().unwrap();
    let err = build_serve(&args("127.0.0.1:0", None, d.path().join("st")))
        .await
        .err()
        .unwrap();
    assert_eq!(err, "--static is required");
    let err = build_serve(&args(
        "127.0.0.1:0",
        Some(d.path().to_path_buf()),
        d.path().join("st"),
    ))
    .await
    .err()
    .unwrap();
    assert_eq!(err, format!("{} has no index.html", d.path().display()));
}

#[tokio::test]
async fn serve_refuses_an_address_it_cannot_bind() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("index.html"), "x").unwrap();
    let err = build_serve(&args(
        "10.255.255.254:7380",
        Some(d.path().to_path_buf()),
        d.path().join("st"),
    ))
    .await
    .err()
    .unwrap();
    assert!(
        err.starts_with("cannot bind 10.255.255.254:7380: "),
        "{err}"
    );
}

#[test]
fn the_binary_exits_1_with_its_reason() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_herdly-web"))
        .args([
            "serve",
            "--bind",
            "127.0.0.1:0",
            "--state",
            "/tmp/herdly-web-test-state",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr).trim_end(),
        "herdly-web: --static is required"
    );
}
