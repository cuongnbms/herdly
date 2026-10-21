//! Parse each Provider's undocumented usage response into `QuotaWindow`s.
//! Percent is always *used* percent, clamped to 0..=100.

use serde_json::Value;

use super::{Provider, QuotaWindow, FIVE_HOURS, WEEK};

/// A JSON number only; booleans, strings and null are not numbers.
fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn percent(v: &Value) -> Option<f64> {
    num(v).map(|p| p.clamp(0.0, 100.0))
}

fn secs_or_ms(n: f64) -> i64 {
    if n > 1e10 {
        n as i64
    } else {
        (n * 1000.0) as i64
    }
}

/// Epoch milliseconds from an ISO-8601 string, epoch seconds or epoch milliseconds.
pub fn parse_date(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_f64().map(secs_or_ms),
        Value::String(s) => {
            let s = s.trim();
            if let Some(n) = s.parse::<f64>().ok().filter(|n| n.is_finite()) {
                return Some(secs_or_ms(n));
            }
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|d| d.timestamp_millis())
        }
        _ => None,
    }
}

pub fn duration_label(secs: Option<u64>) -> String {
    match secs {
        None => "limit".into(),
        Some(FIVE_HOURS) => "5h".into(),
        Some(WEEK) => "week".into(),
        Some(s) if s > 0 && s % 86_400 == 0 => format!("{}d", s / 86_400),
        Some(s) if s > 0 && s % 3_600 == 0 => format!("{}h", s / 3_600),
        Some(s) => format!("{}m", s / 60),
    }
}

fn window(
    label: &str,
    pct: f64,
    resets_at: Option<i64>,
    duration_secs: Option<u64>,
) -> QuotaWindow {
    QuotaWindow {
        label: label.into(),
        used_percent: pct,
        resets_at,
        duration_secs,
    }
}

pub fn parse(provider: Provider, body: &[u8]) -> Vec<QuotaWindow> {
    let Ok(root) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    match provider {
        Provider::Claude => claude(&root),
        Provider::Codex => codex(&root),
        Provider::OpencodeGo => opencode_go(&root),
        Provider::Grok => grok(&root).into_iter().collect(),
    }
}

fn claude(root: &Value) -> Vec<QuotaWindow> {
    let from_limits: Vec<QuotaWindow> = root["limits"]
        .as_array()
        .map(|limits| {
            limits
                .iter()
                .filter_map(|l| {
                    let (label, duration) = match l["kind"].as_str()? {
                        "session" => ("5h".to_string(), FIVE_HOURS),
                        "weekly_all" => ("week".to_string(), WEEK),
                        "weekly_scoped" => {
                            let model = l["scope"]["model"]["display_name"].as_str()?;
                            (format!("week · {model}"), WEEK)
                        }
                        _ => return None,
                    };
                    let pct = percent(&l["percent"])?;
                    Some(window(
                        &label,
                        pct,
                        parse_date(&l["resets_at"]),
                        Some(duration),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    if !from_limits.is_empty() {
        return from_limits;
    }
    [("five_hour", "5h", FIVE_HOURS), ("seven_day", "week", WEEK)]
        .into_iter()
        .filter_map(|(key, label, duration)| {
            let w = &root[key];
            let pct = percent(&w["utilization"]).or_else(|| percent(&w["used_percentage"]))?;
            Some(window(
                label,
                pct,
                parse_date(&w["resets_at"]),
                Some(duration),
            ))
        })
        .collect()
}

fn codex(root: &Value) -> Vec<QuotaWindow> {
    ["primary_window", "secondary_window"]
        .into_iter()
        .filter_map(|key| {
            let w = &root["rate_limit"][key];
            let pct = percent(&w["used_percent"])?;
            let duration = num(&w["limit_window_seconds"])
                .filter(|s| *s > 0.0)
                .map(|s| s.round() as u64);
            Some(window(
                &duration_label(duration),
                pct,
                parse_date(&w["reset_at"]),
                duration,
            ))
        })
        .collect()
}

fn opencode_go(root: &Value) -> Vec<QuotaWindow> {
    [
        ("rolling", "5h", Some(FIVE_HOURS)),
        ("weekly", "week", Some(WEEK)),
        ("monthly", "month", None),
    ]
    .into_iter()
    .filter_map(|(key, label, duration)| {
        let w = &root["usage"][key];
        let pct = percent(&w["percent"])?;
        Some(window(label, pct, parse_date(&w["resetsAt"]), duration))
    })
    .collect()
}

fn grok(root: &Value) -> Option<QuotaWindow> {
    let cfg = if root["config"].is_object() {
        &root["config"]
    } else {
        root
    };
    let period = &cfg["currentPeriod"];
    let has_period = period.is_object();
    let pct = match cfg.get("creditUsagePercent") {
        Some(v) => percent(v)?,
        None if has_period => 0.0,
        None => return None,
    };
    let label = match period["type"].as_str() {
        Some("USAGE_PERIOD_TYPE_WEEKLY") => "week",
        Some("USAGE_PERIOD_TYPE_MONTHLY") => "month",
        _ => "period",
    };
    let resets_at = parse_date(&period["end"]).or_else(|| parse_date(&cfg["billingPeriodEnd"]));
    let span = |start: &Value, end: &Value| -> Option<u64> {
        let ms = parse_date(end)? - parse_date(start)?;
        (ms > 0).then(|| (ms as f64 / 1000.0).round() as u64)
    };
    let duration = span(&period["start"], &period["end"])
        .or_else(|| span(&cfg["billingPeriodStart"], &cfg["billingPeriodEnd"]));
    Some(window(label, pct, resets_at, duration))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::{Provider, QuotaWindow, FIVE_HOURS, WEEK};
    use serde_json::json;

    fn w(label: &str, pct: f64, resets_at: Option<i64>, duration_secs: Option<u64>) -> QuotaWindow {
        QuotaWindow {
            label: label.into(),
            used_percent: pct,
            resets_at,
            duration_secs,
        }
    }
    fn win(p: Provider, s: &str) -> Vec<QuotaWindow> {
        parse(p, s.as_bytes())
    }

    // Dates

    #[test]
    fn dates_iso_with_six_fraction_digits_and_offset() {
        assert_eq!(
            parse_date(&json!("2026-09-17T14:00:00.551304+00:00")),
            Some(1_789_653_600_551)
        );
    }
    #[test]
    fn dates_iso_millis_zulu_no_fraction_and_non_utc() {
        assert_eq!(
            parse_date(&json!("2026-09-17T17:23:46.966Z")),
            Some(1_789_665_826_966)
        );
        assert_eq!(
            parse_date(&json!("2026-09-22T02:00:00+00:00")),
            Some(1_790_042_400_000)
        );
        assert_eq!(
            parse_date(&json!("2026-09-17T21:00:00+07:00")),
            Some(1_789_653_600_000)
        );
    }
    #[test]
    fn dates_epoch_seconds_millis_and_numeric_strings() {
        assert_eq!(parse_date(&json!(1_790_250_529)), Some(1_790_250_529_000));
        assert_eq!(
            parse_date(&json!(1_790_250_529_000_i64)),
            Some(1_790_250_529_000)
        );
        assert_eq!(parse_date(&json!("1790250529")), Some(1_790_250_529_000));
    }
    #[test]
    fn dates_garbage_is_none() {
        assert_eq!(parse_date(&json!("soon")), None);
        assert_eq!(parse_date(&json!("")), None);
        assert_eq!(parse_date(&json!(null)), None);
        assert_eq!(parse_date(&json!(true)), None);
        assert_eq!(parse_date(&json!("NaN")), None);
        assert_eq!(parse_date(&json!("inf")), None);
    }

    // Claude

    const CLAUDE: &str = r#"
    {"five_hour":{"utilization":16.0,"resets_at":"2026-09-17T14:00:00.996301+00:00"},
     "seven_day":{"utilization":28.0,"resets_at":"2026-09-22T02:00:00.996324+00:00"},
     "seven_day_opus":null,
     "extra_usage":{"is_enabled":false,"utilization":null},
     "limits":[
      {"kind":"session","group":"session","percent":19,"severity":"normal","resets_at":"2026-09-17T14:00:00+00:00","scope":null,"is_active":false},
      {"kind":"weekly_all","group":"weekly","percent":28,"severity":"normal","resets_at":"2026-09-22T02:00:00+00:00","scope":null,"is_active":true},
      {"kind":"weekly_scoped","group":"weekly","percent":10,"severity":"normal","resets_at":"2026-09-22T01:59:59+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}
     ]}"#;

    #[test]
    fn claude_reads_limits_including_per_model_weeks() {
        assert_eq!(
            win(Provider::Claude, CLAUDE),
            vec![
                w("5h", 19.0, Some(1_789_653_600_000), Some(FIVE_HOURS)),
                w("week", 28.0, Some(1_790_042_400_000), Some(WEEK)),
                w("week · Fable", 10.0, Some(1_790_042_399_000), Some(WEEK)),
            ]
        );
    }
    #[test]
    fn claude_skips_unknown_kinds_and_scoped_without_model_name() {
        let s = r#"{"limits":[
          {"kind":"session","percent":5,"resets_at":null},
          {"kind":"daily_mystery","percent":50,"resets_at":null},
          {"kind":"weekly_scoped","percent":7,"resets_at":null,"scope":{"model":null}}]}"#;
        assert_eq!(
            win(Provider::Claude, s),
            vec![w("5h", 5.0, None, Some(FIVE_HOURS))]
        );
    }
    #[test]
    fn claude_falls_back_to_older_shape() {
        let s = r#"{"five_hour":{"utilization":16.0,"resets_at":"2026-09-17T14:00:00.996301+00:00"},
                    "seven_day":{"used_percentage":28.0,"resets_at":"2026-09-22T02:00:00.996324+00:00"}}"#;
        assert_eq!(
            win(Provider::Claude, s),
            vec![
                w("5h", 16.0, Some(1_789_653_600_996), Some(FIVE_HOURS)),
                w("week", 28.0, Some(1_790_042_400_996), Some(WEEK)),
            ]
        );
    }

    // Codex

    #[test]
    fn codex_reads_plan_window_and_ignores_additional_limits() {
        let s = r#"{"plan_type":"prolite","rate_limit":{"allowed":true,"limit_reached":false,
          "primary_window":{"used_percent":0,"limit_window_seconds":604800,"reset_after_seconds":602704,"reset_at":1790250529},
          "secondary_window":null},
          "additional_rate_limits":[{"limit_name":"GPT-5.3-Codex-Spark","rate_limit":{
          "primary_window":{"used_percent":40,"limit_window_seconds":18000,"reset_at":1789665826}}}]}"#;
        assert_eq!(
            win(Provider::Codex, s),
            vec![w("week", 0.0, Some(1_790_250_529_000), Some(WEEK))]
        );
    }
    #[test]
    fn codex_reads_both_windows() {
        let s = r#"{"rate_limit":{
          "primary_window":{"used_percent":42.5,"limit_window_seconds":18000,"reset_at":1789665826},
          "secondary_window":{"used_percent":12,"limit_window_seconds":604800,"reset_at":1790250529}}}"#;
        assert_eq!(
            win(Provider::Codex, s),
            vec![
                w("5h", 42.5, Some(1_789_665_826_000), Some(FIVE_HOURS)),
                w("week", 12.0, Some(1_790_250_529_000), Some(WEEK)),
            ]
        );
    }
    #[test]
    fn codex_keeps_any_window_length() {
        let s = r#"{"rate_limit":{
          "primary_window":{"used_percent":1,"limit_window_seconds":10800,"reset_at":1789665826},
          "secondary_window":{"used_percent":2,"reset_at":1790250529}}}"#;
        let got = win(Provider::Codex, s);
        assert_eq!(
            got.iter().map(|w| w.duration_secs).collect::<Vec<_>>(),
            vec![Some(10_800), None]
        );
        assert_eq!(
            got.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
            vec!["3h", "limit"]
        );
    }
    #[test]
    fn duration_labels() {
        assert_eq!(duration_label(Some(18_000)), "5h");
        assert_eq!(duration_label(Some(604_800)), "week");
        assert_eq!(duration_label(Some(172_800)), "2d");
        assert_eq!(duration_label(Some(10_800)), "3h");
        assert_eq!(duration_label(Some(5_400)), "90m");
        assert_eq!(duration_label(None), "limit");
    }

    // OpenCode Go

    #[test]
    fn opencode_reads_rolling_weekly_monthly() {
        let s = r#"{"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"2026-09-17T17:23:46.000Z"},
                  "weekly":{"status":"ok","percent":19,"resetsAt":"2026-09-21T00:00:00.000Z"},
                  "monthly":{"status":"rate-limited","percent":100,"resetsAt":"2026-10-17T01:46:02.000Z"}}}"#;
        assert_eq!(
            win(Provider::OpencodeGo, s),
            vec![
                w("5h", 0.0, Some(1_789_665_826_000), Some(FIVE_HOURS)),
                w("week", 19.0, Some(1_789_948_800_000), Some(WEEK)),
                w("month", 100.0, Some(1_792_201_562_000), None),
            ]
        );
    }

    // Grok

    #[test]
    fn grok_reads_weekly_credit_period() {
        let s = r#"{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-09-13T01:30:30.900554+00:00","end":"2026-09-20T01:30:30+00:00"},
          "creditUsagePercent":100.0,"onDemandCap":{"val":0},"isUnifiedBillingUser":true,
          "billingPeriodStart":"2026-09-13T01:30:30.900554+00:00","billingPeriodEnd":"2026-09-20T01:30:30.900554+00:00"}}"#;
        // Length from the period's own start to end, rounded to whole seconds.
        assert_eq!(
            win(Provider::Grok, s),
            vec![w("week", 100.0, Some(1_789_867_830_000), Some(604_799))]
        );
    }
    #[test]
    fn grok_without_percent_but_with_period_is_zero() {
        let s = r#"{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_MONTHLY","end":"2026-09-20T01:30:30+00:00"}}}"#;
        assert_eq!(
            win(Provider::Grok, s),
            vec![w("month", 0.0, Some(1_789_867_830_000), None)]
        );
    }
    #[test]
    fn grok_with_period_but_malformed_percent_has_no_window() {
        for bad in ["true", "null", "\"100\""] {
            let s = format!(
                r#"{{"config":{{"currentPeriod":{{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-09-20T01:30:30+00:00"}},"creditUsagePercent":{bad}}}}}"#
            );
            assert_eq!(win(Provider::Grok, &s), vec![], "{bad}");
        }
    }
    #[test]
    fn grok_falls_back_to_billing_period() {
        assert_eq!(
            win(
                Provider::Grok,
                r#"{"creditUsagePercent":3,"billingPeriodEnd":"2026-09-20T01:30:30Z"}"#
            ),
            vec![w("period", 3.0, Some(1_789_867_830_000), None)]
        );
        let s = r#"{"creditUsagePercent":3,"billingPeriodStart":"2026-09-13T01:30:30Z","billingPeriodEnd":"2026-09-20T01:30:30Z"}"#;
        assert_eq!(win(Provider::Grok, s)[0].duration_secs, Some(WEEK));
    }
    #[test]
    fn grok_with_neither_percent_nor_period_has_no_window() {
        assert_eq!(
            win(Provider::Grok, r#"{"config":{"prepaidBalance":{"val":0}}}"#),
            vec![]
        );
    }

    // Shared

    #[test]
    fn percent_is_clamped_and_booleans_are_not_numbers() {
        let s = r#"{"usage":{"rolling":{"percent":130,"resetsAt":null},
                  "weekly":{"percent":-4,"resetsAt":null},
                  "monthly":{"percent":true,"resetsAt":null}}}"#;
        assert_eq!(
            win(Provider::OpencodeGo, s),
            vec![
                w("5h", 100.0, None, Some(FIVE_HOURS)),
                w("week", 0.0, None, Some(WEEK)),
            ]
        );
    }
    #[test]
    fn unreadable_bodies_have_no_windows() {
        for p in Provider::ALL {
            assert_eq!(win(p, "<html>"), vec![], "{p}");
            assert_eq!(win(p, "{}"), vec![], "{p}");
        }
    }
}
