//! Pages served on the `herdly-html` scheme: the File viewer stores a file's HTML under a
//! token and the iframe loads `herdly-html://localhost/<token>`. Scripts is fixed per stored
//! page, so the policy it was stored with is the one it is served with (ADR-0009).

use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::http::{header, Method, Response, StatusCode};

pub const MAX_PAGES: usize = 16;

pub const CSP_OFF: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'";
pub const CSP_ON: &str = "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

struct Page {
    html: String,
    scripts: bool,
}

/// Stored pages, oldest first; storing past `MAX_PAGES` evicts the oldest.
#[derive(Default)]
pub struct HtmlPages(Mutex<VecDeque<(String, Page)>>);

impl HtmlPages {
    pub fn put(&self, html: String, scripts: bool) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mut pages = self.0.lock().unwrap_or_else(|e| e.into_inner());
        pages.push_back((token.clone(), Page { html, scripts }));
        while pages.len() > MAX_PAGES {
            pages.pop_front();
        }
        token
    }

    pub fn drop_page(&self, token: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(t, _)| t != token);
    }

    /// `path` is the request URI's path: `/` and a stored token, nothing else, on GET. It never
    /// carries the query, so Scripts comes only from the page as it was stored.
    pub fn respond(&self, method: &Method, path: &str) -> Response<Vec<u8>> {
        let found = (method == Method::GET)
            .then(|| path.strip_prefix('/'))
            .flatten()
            .and_then(|token| {
                let pages = self.0.lock().unwrap_or_else(|e| e.into_inner());
                pages
                    .iter()
                    .find(|(t, _)| t == token)
                    .map(|(_, p)| (p.html.clone(), p.scripts))
            });
        match found {
            Some((html, scripts)) => Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(
                    header::CONTENT_SECURITY_POLICY,
                    if scripts { CSP_ON } else { CSP_OFF },
                )
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .header(header::CACHE_CONTROL, "no-store")
                .body(html.into_bytes())
                .unwrap(),
            None => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Vec::new())
                .unwrap(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::{Method, Response};

    fn header<'a>(r: &'a Response<Vec<u8>>, name: &str) -> &'a str {
        r.headers().get(name).unwrap().to_str().unwrap()
    }

    #[test]
    fn policies_are_the_specs() {
        assert_eq!(
            CSP_OFF,
            "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'"
        );
        assert_eq!(
            CSP_ON,
            "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        );
    }

    #[test]
    fn serves_a_stored_page_with_the_policy_it_was_stored_with() {
        let pages = HtmlPages::default();
        let off = pages.put("<p>off</p>".into(), false);
        let on = pages.put("<p>on</p>".into(), true);

        let r = pages.respond(&Method::GET, &format!("/{off}"));
        assert_eq!(r.status(), 200);
        assert_eq!(r.body(), b"<p>off</p>");
        assert_eq!(header(&r, "content-type"), "text/html; charset=utf-8");
        assert_eq!(header(&r, "content-security-policy"), CSP_OFF);
        assert_eq!(header(&r, "x-content-type-options"), "nosniff");
        assert_eq!(header(&r, "cache-control"), "no-store");

        let r = pages.respond(&Method::GET, &format!("/{on}"));
        assert_eq!(r.body(), b"<p>on</p>");
        assert_eq!(header(&r, "content-security-policy"), CSP_ON);
    }

    #[test]
    fn tokens_are_distinct_32_hex_digits() {
        let pages = HtmlPages::default();
        let (a, b) = (pages.put("a".into(), false), pages.put("a".into(), false));
        assert_ne!(a, b);
        for t in [&a, &b] {
            assert_eq!(t.len(), 32);
            assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn anything_but_a_get_of_a_stored_token_is_404() {
        let pages = HtmlPages::default();
        let t = pages.put("<p>x</p>".into(), true);
        for (method, path) in [
            (Method::POST, format!("/{t}")),
            (Method::GET, "/".to_string()),
            (Method::GET, format!("/{t}/style.css")),
            (Method::GET, "/00000000000000000000000000000000".to_string()),
        ] {
            let r = pages.respond(&method, &path);
            assert_eq!(r.status(), 404, "{method} {path}");
            assert!(r.body().is_empty());
        }
    }

    #[test]
    fn a_dropped_page_is_404_and_dropping_twice_is_fine() {
        let pages = HtmlPages::default();
        let t = pages.put("<p>x</p>".into(), false);
        pages.drop_page(&t);
        pages.drop_page(&t);
        assert_eq!(pages.respond(&Method::GET, &format!("/{t}")).status(), 404);
    }

    #[test]
    fn storing_past_the_limit_evicts_the_oldest() {
        let pages = HtmlPages::default();
        let tokens: Vec<String> = (0..=MAX_PAGES)
            .map(|i| pages.put(format!("{i}"), false))
            .collect();
        assert_eq!(
            pages
                .respond(&Method::GET, &format!("/{}", tokens[0]))
                .status(),
            404
        );
        for t in &tokens[1..] {
            assert_eq!(pages.respond(&Method::GET, &format!("/{t}")).status(), 200);
        }
    }

    #[test]
    fn a_poisoned_lock_still_serves() {
        let pages = HtmlPages::default();
        let t = pages.put("<p>x</p>".into(), false);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = pages.0.lock().unwrap();
            panic!("poison");
        }));
        assert!(pages.0.is_poisoned());
        assert_eq!(pages.respond(&Method::GET, &format!("/{t}")).status(), 200);
        pages.drop_page(&t);
        let u = pages.put("<p>y</p>".into(), true);
        assert_eq!(pages.respond(&Method::GET, &format!("/{u}")).status(), 200);
    }
}
