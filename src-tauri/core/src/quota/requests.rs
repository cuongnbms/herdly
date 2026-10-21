//! Usage requests per Provider: GET, bearer token, JSON. Sent by `quota::fetch`.

use super::{credentials::Credential, Provider};

pub struct Request {
    pub url: &'static str,
    pub headers: Vec<(&'static str, String)>,
}

pub fn request(provider: Provider, cred: &Credential) -> Request {
    let mut headers = vec![
        ("Authorization", format!("Bearer {}", cred.token)),
        ("Accept", "application/json".to_string()),
    ];
    let url = match provider {
        Provider::Claude => {
            headers.push(("anthropic-beta", "oauth-2025-04-20".into()));
            headers.push(("User-Agent", "claude-code/2.1.0".into()));
            "https://api.anthropic.com/api/oauth/usage"
        }
        Provider::Codex => {
            headers.push(("User-Agent", "codex-cli".into()));
            headers.push(("OpenAI-Beta", "codex-1".into()));
            headers.push(("originator", "Codex Desktop".into()));
            if let Some(id) = &cred.account_id {
                headers.push(("ChatGPT-Account-Id", id.clone()));
            }
            "https://chatgpt.com/backend-api/wham/usage"
        }
        Provider::OpencodeGo => "https://opencode.ai/zen/go/v1/usage",
        Provider::Grok => {
            headers.push(("X-XAI-Token-Auth", "xai-grok-cli".into()));
            if let Some(id) = &cred.account_id {
                headers.push(("x-userid", id.clone()));
            }
            "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
        }
    };
    Request { url, headers }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::{credentials::Credential, Provider};

    fn c(token: &str, account: Option<&str>) -> Credential {
        Credential {
            token: token.into(),
            account_id: account.map(Into::into),
        }
    }
    fn h<'a>(r: &'a Request, name: &str) -> Option<&'a str> {
        r.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn claude() {
        let r = request(Provider::Claude, &c("t", None));
        assert_eq!(r.url, "https://api.anthropic.com/api/oauth/usage");
        assert_eq!(h(&r, "Authorization"), Some("Bearer t"));
        assert_eq!(h(&r, "Accept"), Some("application/json"));
        assert_eq!(h(&r, "anthropic-beta"), Some("oauth-2025-04-20"));
        assert_eq!(h(&r, "User-Agent"), Some("claude-code/2.1.0"));
    }
    #[test]
    fn codex_sends_account_when_present() {
        let r = request(Provider::Codex, &c("t", Some("acct")));
        assert_eq!(r.url, "https://chatgpt.com/backend-api/wham/usage");
        assert_eq!(h(&r, "Authorization"), Some("Bearer t"));
        assert_eq!(h(&r, "User-Agent"), Some("codex-cli"));
        assert_eq!(h(&r, "OpenAI-Beta"), Some("codex-1"));
        assert_eq!(h(&r, "originator"), Some("Codex Desktop"));
        assert_eq!(h(&r, "ChatGPT-Account-Id"), Some("acct"));
        assert_eq!(
            h(
                &request(Provider::Codex, &c("t", None)),
                "ChatGPT-Account-Id"
            ),
            None
        );
    }
    #[test]
    fn opencode_go() {
        let r = request(Provider::OpencodeGo, &c("k", None));
        assert_eq!(r.url, "https://opencode.ai/zen/go/v1/usage");
        assert_eq!(h(&r, "Authorization"), Some("Bearer k"));
    }
    #[test]
    fn grok_sends_user_when_present() {
        let r = request(Provider::Grok, &c("k", Some("u1")));
        assert_eq!(
            r.url,
            "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
        );
        assert_eq!(h(&r, "Authorization"), Some("Bearer k"));
        assert_eq!(h(&r, "X-XAI-Token-Auth"), Some("xai-grok-cli"));
        assert_eq!(h(&r, "Accept"), Some("application/json"));
        assert_eq!(h(&r, "x-userid"), Some("u1"));
        assert_eq!(h(&request(Provider::Grok, &c("k", None)), "x-userid"), None);
    }
}
