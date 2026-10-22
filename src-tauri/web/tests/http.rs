use axum::body::Body;
use axum::http::{Request, StatusCode};
use herdly_web::app::router;
use herdly_web::testing::{paired_cookie, send, state, FakeBackend};
use serde_json::{json, Value};
use std::sync::Arc;

const ORIGIN: &str = "http://192.0.2.10:7380";

fn setup() -> (tempfile::TempDir, Arc<FakeBackend>, axum::Router, String) {
    let d = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeBackend::default());
    let st = state(fake.clone(), d.path());
    let cookie = paired_cookie(&st);
    (d, fake, router(st), cookie)
}

fn post(path: &str, cookie: Option<&str>, origin: Option<&str>, body: Value) -> Request<Body> {
    let mut b = Request::post(path).header("content-type", "application/json");
    if let Some(c) = cookie {
        b = b.header("cookie", format!("herdly_web={c}"));
    }
    if let Some(o) = origin {
        b = b.header("origin", o);
    }
    b.body(Body::from(body.to_string())).unwrap()
}

fn get(path: &str, cookie: Option<&str>) -> Request<Body> {
    let mut b = Request::get(path);
    if let Some(c) = cookie {
        b = b.header("cookie", format!("herdly_web={c}"));
    }
    b.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn api_needs_a_paired_cookie() {
    let (_d, _f, app, cookie) = setup();
    let (s, _, body) = send(&app, get("/api/machines", None)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        json!({"code": "unauthorized", "message": "not paired"})
    );
    assert_eq!(
        send(&app, get("/api/machines", Some("wrong"))).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(&app, get("/api/machines", Some(&cookie))).await.0,
        StatusCode::OK
    );
    let (s, _, body) = send(&app, get("/api/me", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK);
    assert!(serde_json::from_str::<Value>(&body).unwrap()["device_id"].is_string());
}

#[tokio::test]
async fn a_post_from_another_origin_is_refused_before_any_herdr_call() {
    let (_d, fake, app, cookie) = setup();
    let body = json!({"session": "s", "pane_id": "p1", "text": "rm -rf"});
    let (s, _, _) = send(
        &app,
        post(
            "/api/pane/prompt",
            Some(&cookie),
            Some("http://evil.example"),
            body.clone(),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(
        send(&app, post("/api/pane/prompt", Some(&cookie), None, body))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert!(fake.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn tab_create_targets_the_workspace_without_stealing_desktop_focus() {
    let (_d, fake, app, cookie) = setup();
    let created = json!({"tab_id": "t-new", "root_pane": {"pane_id": "p-new"}});
    *fake.call_result.lock().unwrap() = Some(Ok(created.clone()));
    let (status, _, body) = send(
        &app,
        post(
            "/api/tab/create",
            Some(&cookie),
            Some(ORIGIN),
            json!({"session": "dev", "workspace_id": "w2"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), created);
    assert_eq!(
        *fake.calls.lock().unwrap(),
        vec![(
            "dev".into(),
            "tab.create".into(),
            json!({"workspace_id": "w2", "focus": false})
        )]
    );
}

#[tokio::test]
async fn tab_close_targets_the_tab_and_propagates_herdr_failure() {
    let (_d, fake, app, cookie) = setup();
    *fake.call_result.lock().unwrap() = Some(Err(herdly_core::error::AppError::new(
        "herdr_error",
        "cannot close",
    )));
    let (status, _, body) = send(
        &app,
        post(
            "/api/tab/close",
            Some(&cookie),
            Some(ORIGIN),
            json!({"session": "other", "tab_id": "t2"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        json!({"code": "herdr_error", "message": "cannot close"})
    );
    assert_eq!(
        *fake.calls.lock().unwrap(),
        vec![("other".into(), "tab.close".into(), json!({"tab_id": "t2"}))]
    );
    *fake.call_result.lock().unwrap() = Some(Ok(json!({})));
    let (status, _, body) = send(
        &app,
        post(
            "/api/tab/close",
            Some(&cookie),
            Some(ORIGIN),
            json!({"session": "other", "tab_id": "t2"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({}));
}

#[tokio::test]
async fn tab_routes_require_pairing_origin_and_typed_bodies() {
    let (_d, fake, app, cookie) = setup();
    for (path, body) in [
        (
            "/api/tab/create",
            json!({"session": "dev", "workspace_id": "w1"}),
        ),
        ("/api/tab/close", json!({"session": "dev", "tab_id": "t1"})),
    ] {
        for origin in [None, Some("http://evil.example")] {
            assert_eq!(
                send(&app, post(path, Some(&cookie), origin, body.clone()))
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );
        }
        for auth in [None, Some("invalid-cookie")] {
            assert_eq!(
                send(&app, post(path, auth, Some(ORIGIN), body.clone()))
                    .await
                    .0,
                StatusCode::UNAUTHORIZED
            );
        }
        let (status, _, response) = send(
            &app,
            post(path, Some(&cookie), Some(ORIGIN), json!({"session": "dev"})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap()["code"],
            "invalid"
        );
    }
    assert!(fake.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pane_routes_build_the_herdr_calls() {
    let (_d, fake, app, cookie) = setup();
    let c = Some(cookie.as_str());
    let o = Some(ORIGIN);
    send(
        &app,
        post(
            "/api/pane/prompt",
            c,
            o,
            json!({"session": "s", "pane_id": "p1", "text": "hi"}),
        ),
    )
    .await;
    send(
        &app,
        post(
            "/api/pane/keys",
            c,
            o,
            json!({"session": "s", "pane_id": "p1", "keys": ["esc"]}),
        ),
    )
    .await;
    send(
        &app,
        post(
            "/api/pane/text",
            c,
            o,
            json!({"session": "s", "pane_id": "p1", "text": "x"}),
        ),
    )
    .await;
    send(
        &app,
        post(
            "/api/pane/read",
            c,
            o,
            json!({"session": "s", "pane_id": "p1"}),
        ),
    )
    .await;
    assert_eq!(
        *fake.calls.lock().unwrap(),
        vec![
            (
                "s".into(),
                "agent.prompt".into(),
                json!({"target": "p1", "text": "hi"})
            ),
            (
                "s".into(),
                "agent.send_keys".into(),
                json!({"target": "p1", "keys": ["esc"]})
            ),
            (
                "s".into(),
                "pane.send_text".into(),
                json!({"pane_id": "p1", "text": "x"})
            ),
            (
                "s".into(),
                "pane.read".into(),
                json!({"pane_id": "p1", "source": "visible", "format": "text", "strip_ansi": true})
            ),
        ]
    );
}

#[tokio::test]
async fn read_returns_text_from_either_shape() {
    let (_d, fake, app, cookie) = setup();
    for (reply, want) in [
        (json!({"text": "A"}), "A"),
        (json!({"read": {"text": "B"}}), "B"),
        (json!({}), ""),
    ] {
        *fake.call_result.lock().unwrap() = Some(Ok(reply));
        let (s, _, body) = send(
            &app,
            post(
                "/api/pane/read",
                Some(&cookie),
                Some(ORIGIN),
                json!({"session": "s", "pane_id": "p1"}),
            ),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({"text": want})
        );
    }
}

#[tokio::test]
async fn herdr_errors_map_to_statuses() {
    let (_d, fake, app, cookie) = setup();
    *fake.call_result.lock().unwrap() = Some(Err(herdly_core::error::AppError::new(
        "herdr_error",
        "boom",
    )));
    let (s, _, body) = send(
        &app,
        post(
            "/api/pane/keys",
            Some(&cookie),
            Some(ORIGIN),
            json!({"session": "s", "pane_id": "p1", "keys": ["esc"]}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_GATEWAY);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"],
        "herdr_error"
    );
}

#[tokio::test]
async fn chat_page_caps_the_limit_and_404s_without_an_open_chat() {
    let (_d, fake, app, cookie) = setup();
    let (s, _, _) = send(
        &app,
        get(
            "/api/chat/page?session=s&pane_id=p1&before=500&limit=1000",
            Some(&cookie),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    *fake.page_result.lock().unwrap() = Some(vec![]);
    let (s, _, body) = send(
        &app,
        get(
            "/api/chat/page?session=s&pane_id=p1&before=500&limit=1000",
            Some(&cookie),
        ),
    )
    .await;
    assert_eq!((s, body.as_str()), (StatusCode::OK, "[]"));
    assert_eq!(fake.pages.lock().unwrap().last().unwrap().2, 200);
}

#[tokio::test]
async fn pairing_sets_the_cookie_once() {
    let d = tempfile::tempdir().unwrap();
    let st = state(Arc::new(FakeBackend::default()), d.path());
    let token =
        herdly_web::auth::start_pairing(st.auth.store(), herdly_web::config::now_secs()).unwrap();
    let app = router(st);
    let (s, h, _) = send(&app, get(&format!("/pair?t={token}"), None)).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert_eq!(h["location"], "/");
    let c = h["set-cookie"].to_str().unwrap();
    for part in [
        "herdly_web=",
        "HttpOnly",
        "SameSite=Strict",
        "Path=/",
        "Max-Age=31536000",
    ] {
        assert!(c.contains(part), "{c}");
    }
    let (s, _, body) = send(&app, get(&format!("/pair?t={token}"), None)).await;
    assert_eq!(
        (s, body.as_str()),
        (StatusCode::FORBIDDEN, "pairing link expired or used")
    );
}

#[tokio::test]
async fn static_files_carry_cache_and_security_headers() {
    let (_d, _f, app, _c) = setup();
    let (s, h, body) = send(&app, get("/", None)).await;
    assert_eq!(s, StatusCode::OK);
    assert!(body.contains("<title>Herdly</title>"));
    assert_eq!(h["cache-control"], "no-cache");
    assert_eq!(h["x-content-type-options"], "nosniff");
    // The approved CSP change adds inline styles for xterm and nothing else: the exact string
    // replaces the pre-lens one, and the directives below it are asserted one by one.
    assert_eq!(
        h["content-security-policy"],
        "default-src 'self'; connect-src 'self' ws://192.0.2.10:7380; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'"
    );
    let csp = h["content-security-policy"].to_str().unwrap();
    let directives: Vec<&str> = csp.split(';').map(|d| d.trim()).collect();
    let directive = |name: &str| {
        directives
            .iter()
            .find(|d| d.split_whitespace().next() == Some(name))
            .unwrap_or_else(|| panic!("{name} is missing from {csp}"))
    };
    assert_eq!(*directive("style-src"), "style-src 'self' 'unsafe-inline'");
    assert_eq!(*directive("default-src"), "default-src 'self'");
    assert_eq!(*directive("img-src"), "img-src 'self' data:");
    assert_eq!(*directive("object-src"), "object-src 'none'");
    assert_eq!(*directive("base-uri"), "base-uri 'none'");
    assert_eq!(
        *directive("connect-src"),
        "connect-src 'self' ws://192.0.2.10:7380"
    );
    // No script or eval relaxation, whatever the style directive allows.
    assert!(!csp.contains("script-src"), "{csp}");
    assert!(!csp.contains("unsafe-eval"), "{csp}");
    assert!(!csp.contains("'unsafe-inline' 'unsafe-inline'"), "{csp}");
    // Inline styles are only allowed for styles: the default source stays 'self'.
    assert!(
        !csp.split(';')
            .any(|d| d.contains("default-src") && d.contains("unsafe-inline")),
        "{csp}"
    );
    let (s, h, _) = send(&app, get("/assets/app-1a2b.js", None)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h["cache-control"], "public, max-age=31536000, immutable");
    assert_eq!(h["content-type"], "text/javascript");
    assert_eq!(
        send(&app, get("/assets/../../state/devices.json", None))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (s, _, body) = send(&app, get("/some/route", None)).await;
    assert_eq!(s, StatusCode::OK);
    assert!(body.contains("<title>Herdly</title>"));
}

#[tokio::test]
async fn bodies_over_one_mib_are_refused() {
    let (_d, fake, app, cookie) = setup();
    let big = "x".repeat(1024 * 1024 + 1);
    let (s, _, _) = send(
        &app,
        post(
            "/api/pane/prompt",
            Some(&cookie),
            Some(ORIGIN),
            json!({"session": "s", "pane_id": "p1", "text": big}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(fake.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn percent_encoded_traversal_is_refused_too() {
    let (_d, _f, app, _c) = setup();
    for p in [
        "/assets/%2e%2e/%2e%2e/state/devices.json",
        "/assets/..%2f..%2fstate/devices.json",
        "/%2e%2e/state/devices.json",
    ] {
        let (s, _, body) = send(&app, get(p, None)).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{p}");
        assert!(!body.contains("cookie_sha256"), "{p}");
    }
}

#[tokio::test]
async fn origin_is_checked_before_the_cookie_and_only_on_posts() {
    let (_d, fake, app, cookie) = setup();
    let body = json!({"session": "s", "pane_id": "p1", "text": "hi"});
    // Wrong origin and no cookie: 403 (Origin first), not 401.
    let (s, _, b) = send(
        &app,
        post(
            "/api/pane/prompt",
            None,
            Some("http://evil.example"),
            body.clone(),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(
        serde_json::from_str::<Value>(&b).unwrap(),
        json!({"code": "forbidden", "message": "bad origin"})
    );
    // Right origin and no cookie: 401.
    assert_eq!(
        send(
            &app,
            post("/api/pane/prompt", None, Some(ORIGIN), body.clone())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        send(
            &app,
            post(
                "/api/pane/prompt",
                Some("wrong"),
                Some(ORIGIN),
                body.clone()
            )
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert!(fake.calls.lock().unwrap().is_empty());
    // A GET with a foreign Origin only needs the cookie.
    let mut req = Request::get("/api/me").header("cookie", format!("herdly_web={cookie}"));
    req = req.header("origin", "http://evil.example");
    assert_eq!(
        send(&app, req.body(Body::empty()).unwrap()).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_malformed_body_is_an_invalid_app_error() {
    let (_d, fake, app, cookie) = setup();
    let req = Request::post("/api/pane/keys")
        .header("content-type", "application/json")
        .header("cookie", format!("herdly_web={cookie}"))
        .header("origin", ORIGIN)
        .body(Body::from(r#"{"session": "s"}"#))
        .unwrap();
    let (s, _, body) = send(&app, req).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["code"],
        "invalid"
    );
    assert!(fake.calls.lock().unwrap().is_empty());
}
