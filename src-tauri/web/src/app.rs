//! Router state and the Origin, cookie and response-header middleware.
use crate::api;
use crate::auth::{complete_pairing, Auth, DeviceInfo};
use crate::backend::Backend;
use crate::chat::ChatHub;
use crate::config::{now_secs, BODY_LIMIT, COOKIE_MAX_AGE, COOKIE_NAME};
use crate::error::{forbidden, unauthorized, ApiError};
use crate::hub::Hub;
use crate::static_files;
use crate::terminal::{registry::TerminalRegistry, socket};
use crate::ws;
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::Router;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub struct Config {
    /// The one Origin allowed on POST and `/ws`, e.g. `http://192.0.2.10:7380`.
    pub origin: String,
    pub static_dir: PathBuf,
    /// How often an open `/ws` checks that its device is still paired.
    pub revoke_check: Duration,
}

pub struct AppState {
    pub backend: Arc<dyn Backend>,
    pub auth: Arc<Auth>,
    pub cfg: Config,
    pub hub: Arc<Hub>,
    pub chats: Arc<ChatHub>,
    /// Every live Terminal attempt: owned cleanup and graceful shutdown.
    pub terminals: Arc<TerminalRegistry>,
}

pub fn router(state: Arc<AppState>) -> Router {
    let reads = Router::new()
        .route("/api/me", get(api::me))
        .route("/api/machines", get(api::machines))
        .route("/api/chat/page", get(api::chat_page));
    // Layers added last run first: Origin (403), then the cookie (401).
    let writes = Router::new()
        .route("/api/pane/read", post(api::pane_read))
        .route("/api/pane/prompt", post(api::pane_prompt))
        .route("/api/pane/keys", post(api::pane_keys))
        .route("/api/pane/text", post(api::pane_text))
        .route("/ws", get(ws::ws_handler))
        .route("/ws/terminal", get(socket::ws_handler))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_cookie,
        ))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_origin,
        ));
    let guarded_reads = reads.route_layer(middleware::from_fn_with_state(
        state.clone(),
        require_cookie,
    ));
    Router::new()
        .route("/pair", get(pair))
        .merge(guarded_reads)
        .merge(writes)
        .fallback(static_files::serve)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .with_state(state)
}

/// The value of cookie `name` in the request's `Cookie` headers.
fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|kv| {
            let (k, v) = kv.trim().split_once('=')?;
            (k == name).then(|| v.to_string())
        })
}

/// The host and port of the configured Origin (`http://h:p` gives `h:p`).
pub fn origin_authority(origin: &str) -> &str {
    origin.split_once("://").map_or(origin, |(_, rest)| rest)
}

async fn require_origin(
    State(st): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let ok = req
        .headers()
        .get(header::ORIGIN)
        .is_some_and(|o| o.as_bytes() == st.cfg.origin.as_bytes());
    if !ok {
        return Err(forbidden("bad origin"));
    }
    Ok(next.run(req).await)
}

async fn require_cookie(
    State(st): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let cookie = cookie_value(req.headers(), COOKIE_NAME).ok_or_else(unauthorized)?;
    // `check` takes a std Mutex and may fsync a `last_seen` write: keep it off the runtime.
    let auth = st.auth.clone();
    let info = tokio::task::spawn_blocking(move || auth.check(&cookie, now_secs()))
        .await
        .ok()
        .flatten()
        .ok_or_else(unauthorized)?;
    req.extensions_mut().insert::<DeviceInfo>(info);
    Ok(next.run(req).await)
}

async fn security_headers(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    let is_html = h
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"));
    if is_html {
        // Inline *styles* only, for xterm's runtime-generated styles and style attributes.
        // Scripts, frames, objects and connections keep their existing restrictions.
        let csp = format!(
            "default-src 'self'; connect-src 'self' ws://{}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'",
            origin_authority(&st.cfg.origin)
        );
        if let Ok(v) = HeaderValue::from_str(&csp) {
            h.insert(header::CONTENT_SECURITY_POLICY, v);
        }
    }
    res
}

async fn pair(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let denied = || {
        (
            StatusCode::FORBIDDEN,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "pairing link expired or used",
        )
            .into_response()
    };
    let Some(token) = q.get("t").cloned() else {
        return denied();
    };
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let auth = st.auth.clone();
    let done = tokio::task::spawn_blocking(move || {
        complete_pairing(auth.store(), &token, &ua, now_secs())
    })
    .await;
    let Ok(Ok((_, cookie))) = done else {
        return denied();
    };
    let set = format!(
        "{COOKIE_NAME}={cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age={COOKIE_MAX_AGE}"
    );
    let mut res = Redirect::to("/").into_response();
    if let Ok(v) = HeaderValue::from_str(&set) {
        res.headers_mut().insert(header::SET_COOKIE, v);
    }
    res
}
