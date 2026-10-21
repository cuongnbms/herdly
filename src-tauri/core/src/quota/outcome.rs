//! Turns an HTTP response from a usage endpoint into a `QuotaOutcome`.

use super::{parsers, Provider, QuotaOutcome};

const DEFAULT_RETRY_SECS: i64 = 15 * 60;
const MAX_RETRY_SECS: i64 = 60 * 60;

/// Classify a usage response. `now_ms` is epoch milliseconds.
pub fn classify(
    provider: Provider,
    status: u16,
    body: &[u8],
    retry_after: Option<&str>,
    now_ms: i64,
) -> QuotaOutcome {
    match status {
        200 => {
            let windows = parsers::parse(provider, body);
            if windows.is_empty() {
                QuotaOutcome::Failed {
                    reason: "unreadable response".into(),
                }
            } else {
                QuotaOutcome::Ok {
                    windows,
                    fetched_at: now_ms,
                }
            }
        }
        403 if provider == Provider::OpencodeGo && is_entitlement_error(body) => {
            QuotaOutcome::NoSubscription
        }
        401 | 403 => QuotaOutcome::SignInExpired,
        429 => QuotaOutcome::RateLimited {
            until: now_ms + retry_secs(retry_after) * 1000,
        },
        _ => QuotaOutcome::Failed {
            reason: format!("HTTP {status}"),
        },
    }
}

fn is_entitlement_error(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["type"].as_str().map(|t| t == "EntitlementError"))
        .unwrap_or(false)
}

/// Retry-After as positive integer seconds; anything else falls back to the default.
fn retry_secs(header: Option<&str>) -> i64 {
    header
        .and_then(|h| h.trim().parse::<i64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(DEFAULT_RETRY_SECS)
        .min(MAX_RETRY_SECS)
}

impl QuotaOutcome {
    /// One-line summary for the log. Carries nothing from a token or a response body.
    pub fn log_line(&self) -> String {
        match self {
            QuotaOutcome::Ok { windows, .. } => format!("ok, {} window(s)", windows.len()),
            QuotaOutcome::NotSignedIn => "not signed in".into(),
            QuotaOutcome::SignInExpired => "sign-in expired".into(),
            QuotaOutcome::NoSubscription => "no subscription".into(),
            QuotaOutcome::RateLimited { until } => format!("rate limited until {until}"),
            QuotaOutcome::Failed { reason } => format!("failed: {reason}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::{Provider, QuotaOutcome, QuotaWindow, WEEK};

    const NOW: i64 = 1_789_650_000_000;
    fn cl(p: Provider, status: u16, body: &str, retry_after: Option<&str>) -> QuotaOutcome {
        classify(p, status, body.as_bytes(), retry_after, NOW)
    }

    #[test]
    fn ok_200_with_windows() {
        assert_eq!(
            cl(
                Provider::OpencodeGo,
                200,
                r#"{"usage":{"weekly":{"percent":19,"resetsAt":null}}}"#,
                None
            ),
            QuotaOutcome::Ok {
                windows: vec![QuotaWindow {
                    label: "week".into(),
                    used_percent: 19.0,
                    resets_at: None,
                    duration_secs: Some(WEEK)
                }],
                fetched_at: NOW,
            }
        );
    }
    #[test]
    fn ok_200_with_nothing_readable_fails() {
        assert_eq!(
            cl(Provider::Claude, 200, "{}", None),
            QuotaOutcome::Failed {
                reason: "unreadable response".into()
            }
        );
    }
    #[test]
    fn unauthorized_is_expired_sign_in() {
        for p in Provider::ALL {
            assert_eq!(cl(p, 401, "", None), QuotaOutcome::SignInExpired, "{p}");
            assert_eq!(cl(p, 403, "", None), QuotaOutcome::SignInExpired, "{p}");
        }
    }
    #[test]
    fn opencode_without_go_subscription() {
        let body = r#"{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}"#;
        assert_eq!(
            cl(Provider::OpencodeGo, 403, body, None),
            QuotaOutcome::NoSubscription
        );
        assert_eq!(
            cl(Provider::Grok, 403, body, None),
            QuotaOutcome::SignInExpired
        );
    }
    #[test]
    fn rate_limited_honours_retry_after() {
        assert_eq!(
            cl(Provider::Claude, 429, "", Some("120")),
            QuotaOutcome::RateLimited {
                until: NOW + 120_000
            }
        );
    }
    #[test]
    fn rate_limited_defaults_and_caps() {
        let default = QuotaOutcome::RateLimited {
            until: NOW + 15 * 60_000,
        };
        assert_eq!(cl(Provider::Claude, 429, "", None), default);
        assert_eq!(
            cl(
                Provider::Claude,
                429,
                "",
                Some("Wed, 21 Oct 2026 07:28:00 GMT")
            ),
            default
        );
        assert_eq!(cl(Provider::Claude, 429, "", Some("0")), default);
        assert_eq!(
            cl(Provider::Claude, 429, "", Some("86400")),
            QuotaOutcome::RateLimited {
                until: NOW + 60 * 60_000
            }
        );
    }
    #[test]
    fn other_status_fails_with_it() {
        assert_eq!(
            cl(Provider::Codex, 500, "", None),
            QuotaOutcome::Failed {
                reason: "HTTP 500".into()
            }
        );
        assert_eq!(
            cl(Provider::Grok, 404, "", None),
            QuotaOutcome::Failed {
                reason: "HTTP 404".into()
            }
        );
    }
    #[test]
    fn log_lines_carry_nothing_from_the_body() {
        let ent =
            r#"{"type":"error","error":{"type":"EntitlementError","message":"token sk-abc123"}}"#;
        assert_eq!(
            cl(Provider::Grok, 500, "sk-abc123", None).log_line(),
            "failed: HTTP 500"
        );
        assert_eq!(
            cl(Provider::Claude, 200, "sk-abc123", None).log_line(),
            "failed: unreadable response"
        );
        assert_eq!(
            cl(Provider::OpencodeGo, 403, ent, None).log_line(),
            "no subscription"
        );
        assert_eq!(
            cl(Provider::Claude, 401, "", None).log_line(),
            "sign-in expired"
        );
        assert_eq!(
            cl(
                Provider::OpencodeGo,
                200,
                r#"{"usage":{"weekly":{"percent":19}}}"#,
                None
            )
            .log_line(),
            "ok, 1 window(s)"
        );
        assert_eq!(
            cl(Provider::Claude, 429, "", None).log_line(),
            format!("rate limited until {}", NOW + 15 * 60_000)
        );
        assert_eq!(QuotaOutcome::NotSignedIn.log_line(), "not signed in");
    }
    #[test]
    fn serializes_camel_case_tagged() {
        let ok = QuotaOutcome::Ok {
            windows: vec![QuotaWindow {
                label: "5h".into(),
                used_percent: 19.0,
                resets_at: Some(1),
                duration_secs: Some(18_000),
            }],
            fetched_at: 2,
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({
                "kind": "ok", "fetchedAt": 2,
                "windows": [{"label": "5h", "usedPercent": 19.0, "resetsAt": 1, "durationSecs": 18000}]
            })
        );
        assert_eq!(
            serde_json::to_value(QuotaOutcome::NotSignedIn).unwrap(),
            serde_json::json!({"kind": "notSignedIn"})
        );
        assert_eq!(
            serde_json::to_value(QuotaOutcome::RateLimited { until: 5 }).unwrap(),
            serde_json::json!({"kind": "rateLimited", "until": 5})
        );
        assert_eq!(
            serde_json::from_value::<Provider>(serde_json::json!("opencodeGo")).unwrap(),
            Provider::OpencodeGo
        );
    }
}
