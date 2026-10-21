//! The static bundle: mapped under `static_dir`, never outside it.
use crate::app::AppState;
use axum::extract::State;
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const NO_CACHE: &str = "no-cache";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Percent-decodes `s`; `None` when an escape is malformed or the result is not UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The relative path segments of a request path, or `None` when it could leave `static_dir`.
fn safe_segments(raw_path: &str) -> Option<Vec<String>> {
    let decoded = percent_decode(raw_path)?;
    let mut segs = Vec::new();
    for s in decoded.split('/') {
        if s.is_empty() || s == "." {
            continue;
        }
        if s == ".." || s.contains(['\\', '\0']) {
            return None;
        }
        segs.push(s.to_string());
    }
    Some(segs)
}

fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

async fn read_file(path: &Path) -> Option<Vec<u8>> {
    match tokio::fs::metadata(path).await {
        Ok(m) if m.is_file() => tokio::fs::read(path).await.ok(),
        _ => None,
    }
}

fn file_response(path: &Path, bytes: Vec<u8>, cache: &'static str) -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static(content_type(path)),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
        ],
        bytes,
    )
        .into_response()
}

pub async fn serve(State(st): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return not_found();
    }
    let Some(segs) = safe_segments(uri.path()) else {
        return not_found();
    };
    let root = &st.cfg.static_dir;
    let index = root.join("index.html");
    if !segs.is_empty() {
        let path: PathBuf = segs.iter().fold(root.clone(), |p, s| p.join(s));
        if path != index {
            if let Some(bytes) = read_file(&path).await {
                let cache = if segs[0] == "assets" {
                    IMMUTABLE
                } else {
                    NO_CACHE
                };
                return file_response(&path, bytes, cache);
            }
        }
    }
    match read_file(&index).await {
        Some(bytes) => file_response(&index, bytes, NO_CACHE),
        None => not_found(),
    }
}
