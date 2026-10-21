//! Provider usage quotas for the Agent Dashboard.

use serde::{Deserialize, Serialize};

pub mod credentials;
pub mod outcome;
pub mod parsers;
pub mod requests;

/// Window length of a five-hour limit, in seconds.
pub const FIVE_HOURS: u64 = 18_000;
/// Window length of a weekly limit, in seconds.
pub const WEEK: u64 = 604_800;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Claude,
    Codex,
    OpencodeGo,
    Grok,
}

impl Provider {
    /// Display order everywhere.
    pub const ALL: [Provider; 4] = [
        Provider::Claude,
        Provider::Codex,
        Provider::OpencodeGo,
        Provider::Grok,
    ];
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::OpencodeGo => "opencodeGo",
            Provider::Grok => "grok",
        })
    }
}

/// One usage limit of a Provider. `resets_at` is epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
    pub duration_secs: Option<u64>,
}

/// Result of one quota fetch. Provider-side conditions are outcomes, never errors.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum QuotaOutcome {
    Ok {
        windows: Vec<QuotaWindow>,
        fetched_at: i64,
    },
    NotSignedIn,
    SignInExpired,
    NoSubscription,
    RateLimited {
        until: i64,
    },
    Failed {
        reason: String,
    },
}

/// Fetch one Provider's usage. Never errors: every condition is a `QuotaOutcome`.
pub async fn fetch(provider: Provider) -> QuotaOutcome {
    let outcome = fetch_inner(provider).await;
    tracing::info!("quota {provider}: {}", outcome.log_line());
    outcome
}

async fn fetch_inner(provider: Provider) -> QuotaOutcome {
    let cred = match credentials::read(provider).await {
        Ok(cred) => cred,
        Err(outcome) => return outcome,
    };
    let req = requests::request(provider, &cred);
    let network_error = || QuotaOutcome::Failed {
        reason: "network error".into(),
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    else {
        return network_error();
    };
    let mut builder = client.get(req.url);
    for (name, value) in req.headers {
        builder = builder.header(name, value);
    }
    let Ok(response) = builder.send().await else {
        return network_error();
    };
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let Ok(body) = response.bytes().await else {
        return network_error();
    };
    outcome::classify(
        provider,
        status,
        &body,
        retry_after.as_deref(),
        chrono::Utc::now().timestamp_millis(),
    )
}
