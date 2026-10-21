//! Read-only access to the credentials the Provider CLIs already stored.
//! Nothing here refreshes, writes or rotates a token, and no token is logged.

use super::{Provider, QuotaOutcome};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub struct Credential {
    pub token: String,
    pub account_id: Option<String>,
}

fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Parse a credential document. `None` means not signed in.
pub fn parse(provider: Provider, data: &[u8]) -> Option<Credential> {
    let root: Value = serde_json::from_slice(data).ok()?;
    match provider {
        Provider::Claude => Some(Credential {
            token: non_empty(root.pointer("/claudeAiOauth/accessToken"))?,
            account_id: None,
        }),
        Provider::Codex => Some(Credential {
            token: non_empty(root.pointer("/tokens/access_token"))?,
            account_id: non_empty(root.pointer("/tokens/account_id")),
        }),
        Provider::OpencodeGo => Some(Credential {
            token: non_empty(root.pointer("/opencode-go/key"))?,
            account_id: None,
        }),
        Provider::Grok => {
            let map = root.as_object()?;
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let usable = |k: &&String| non_empty(map[*k].get("key")).is_some();
            let is_xai = |k: &&String| {
                k.as_str() == "https://auth.x.ai" || k.starts_with("https://auth.x.ai::")
            };
            let chosen = keys
                .iter()
                .filter(|k| is_xai(k))
                .find(|k| usable(k))
                .or_else(|| keys.iter().find(|k| usable(k)))?;
            let entry = &map[*chosen];
            Some(Credential {
                token: non_empty(entry.get("key"))?,
                account_id: non_empty(entry.get("user_id")),
            })
        }
    }
}

/// Credential file of a Provider under `home`; `None` for Claude (Keychain).
pub fn file_path(provider: Provider, home: &Path) -> Option<PathBuf> {
    match provider {
        Provider::Claude => None,
        Provider::Codex => Some(home.join(".codex/auth.json")),
        Provider::OpencodeGo => Some(home.join(".local/share/opencode/auth.json")),
        Provider::Grok => Some(home.join(".grok/auth.json")),
    }
}

/// opencode v2 keeps its credentials in this SQLite database under `home`.
const OPENCODE_DB: &str = ".local/share/opencode/opencode.db";

/// The newest active OpenCode Go key, wrapped in the v1 `auth.json` shape `parse` reads.
const OPENCODE_QUERY: &str = "select json_object('opencode-go', json(value)) from credential \
     where integration_id = 'opencode-go' and coalesce(active, 1) = 1 \
     order by time_updated desc limit 1";

/// `None` = no OpenCode Go key, or the database did not open.
async fn read_opencode_db(db: &Path) -> Option<Credential> {
    // `-readonly` also sees what opencode has not checkpointed yet, but it cannot
    // open the database once a clean exit removed the WAL; `immutable` reads that
    // one without creating or touching anything beside it.
    let immutable = format!("file:{}?mode=ro&immutable=1", db.display());
    let opens: [&[&std::ffi::OsStr]; 2] = [
        &["-readonly".as_ref(), db.as_os_str()],
        &[immutable.as_ref()],
    ];
    for open in opens {
        let child = tokio::process::Command::new("/usr/bin/sqlite3")
            .arg("-bail")
            .args(open)
            .arg(OPENCODE_QUERY)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output();
        let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(10), child).await else {
            continue;
        };
        if out.status.success() {
            return parse(Provider::OpencodeGo, &out.stdout);
        }
    }
    None
}

/// Map the `security find-generic-password` outcome. `None` = signal/timeout/spawn failure.
pub fn keychain_result(exit_code: Option<i32>, stdout: &[u8]) -> Result<Credential, QuotaOutcome> {
    match exit_code {
        Some(0) => parse(Provider::Claude, stdout).ok_or(QuotaOutcome::NotSignedIn),
        Some(44) => Err(QuotaOutcome::NotSignedIn),
        _ => Err(QuotaOutcome::Failed {
            reason: "Keychain access denied".into(),
        }),
    }
}

async fn read_keychain() -> Result<Credential, QuotaOutcome> {
    let child = tokio::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(30), child).await {
        Ok(Ok(out)) => keychain_result(out.status.code(), &out.stdout),
        _ => keychain_result(None, &[]),
    }
}

/// Read the stored credential of a Provider.
pub async fn read(provider: Provider) -> Result<Credential, QuotaOutcome> {
    if provider == Provider::Claude {
        return read_keychain().await;
    }
    let home = std::env::var_os("HOME").ok_or(QuotaOutcome::NotSignedIn)?;
    if provider == Provider::OpencodeGo {
        if let Some(cred) = read_opencode_db(&Path::new(&home).join(OPENCODE_DB)).await {
            return Ok(cred);
        }
    }
    // opencode v1 kept its key in `auth.json`.
    let path = file_path(provider, Path::new(&home)).ok_or(QuotaOutcome::NotSignedIn)?;
    let data = tokio::fs::read(path)
        .await
        .map_err(|_| QuotaOutcome::NotSignedIn)?;
    parse(provider, &data).ok_or(QuotaOutcome::NotSignedIn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::{Provider, QuotaOutcome};
    use std::path::{Path, PathBuf};

    fn cred(token: &str, account: Option<&str>) -> Option<Credential> {
        Some(Credential {
            token: token.into(),
            account_id: account.map(Into::into),
        })
    }
    fn p(provider: Provider, s: &str) -> Option<Credential> {
        parse(provider, s.as_bytes())
    }

    #[test]
    fn claude_reads_access_token_from_keychain_json() {
        assert_eq!(
            p(
                Provider::Claude,
                r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat","refreshToken":"r","expiresAt":1}}"#
            ),
            cred("sk-ant-oat", None)
        );
    }
    #[test]
    fn codex_reads_token_and_account() {
        assert_eq!(
            p(
                Provider::Codex,
                r#"{"auth_mode":"chatgpt","tokens":{"access_token":"eyJ","account_id":"acct-1","refresh_token":"r"}}"#
            ),
            cred("eyJ", Some("acct-1"))
        );
        assert_eq!(
            p(Provider::Codex, r#"{"tokens":{"access_token":"eyJ"}}"#),
            cred("eyJ", None)
        );
    }
    #[test]
    fn codex_with_api_key_only_is_not_signed_in() {
        assert_eq!(p(Provider::Codex, r#"{"OPENAI_API_KEY":"sk-proj"}"#), None);
    }
    #[test]
    fn opencode_reads_only_the_go_key() {
        assert_eq!(
            p(
                Provider::OpencodeGo,
                r#"{"nvidia":{"type":"api","key":"nv"},"opencode-go":{"type":"api","key":"go-key"}}"#
            ),
            cred("go-key", None)
        );
        assert_eq!(
            p(
                Provider::OpencodeGo,
                r#"{"nvidia":{"type":"api","key":"nv"}}"#
            ),
            None
        );
    }
    #[test]
    fn grok_prefers_xai_issuer_with_id_suffix() {
        let s = r#"{"https://other.example":{"key":"other","user_id":"u0"},
                    "https://auth.x.ai::b1a0":{"key":"xai","user_id":"u1"}}"#;
        assert_eq!(p(Provider::Grok, s), cred("xai", Some("u1")));
    }
    #[test]
    fn grok_falls_back_to_another_issuer_in_sorted_order() {
        assert_eq!(
            p(
                Provider::Grok,
                r#"{"https://other.example":{"key":"other"}}"#
            ),
            cred("other", None)
        );
        assert_eq!(
            p(
                Provider::Grok,
                r#"{"https://b.example":{"key":"b"},"https://a.example":{"key":"a"}}"#
            ),
            cred("a", None)
        );
    }
    #[test]
    fn empty_tokens_and_malformed_files_are_not_signed_in() {
        assert_eq!(
            p(Provider::Claude, r#"{"claudeAiOauth":{"accessToken":""}}"#),
            None
        );
        assert_eq!(p(Provider::Codex, "not json"), None);
        assert_eq!(p(Provider::Grok, "[]"), None);
    }
    #[test]
    fn file_paths() {
        let home = Path::new("/Users/me");
        assert_eq!(file_path(Provider::Claude, home), None);
        assert_eq!(
            file_path(Provider::Codex, home),
            Some(PathBuf::from("/Users/me/.codex/auth.json"))
        );
        assert_eq!(
            file_path(Provider::OpencodeGo, home),
            Some(PathBuf::from("/Users/me/.local/share/opencode/auth.json"))
        );
        assert_eq!(
            file_path(Provider::Grok, home),
            Some(PathBuf::from("/Users/me/.grok/auth.json"))
        );
    }

    /// An opencode v2 database as opencode leaves it after a clean exit: WAL
    /// mode, everything checkpointed, no `-wal` or `-shm` beside it.
    fn closed_opencode_db(dir: &Path, rows: &str) -> PathBuf {
        let db = dir.join("opencode.db");
        let sql = format!(
            "pragma journal_mode=wal;
             create table credential (id text primary key, integration_id text, label text not null,
               value text not null, connector_id text, method_id text, active integer,
               time_created integer not null, time_updated integer not null);
             {rows}
             pragma wal_checkpoint(truncate);"
        );
        let out = std::process::Command::new("/usr/bin/sqlite3")
            .arg(&db)
            .arg(sql)
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
        for sidecar in ["opencode.db-wal", "opencode.db-shm"] {
            let _ = std::fs::remove_file(dir.join(sidecar));
        }
        db
    }

    #[tokio::test]
    async fn opencode_db_reads_the_active_go_key_after_a_clean_exit() {
        let d = tempfile::tempdir().unwrap();
        let db = closed_opencode_db(
            d.path(),
            r#"insert into credential values
                 ('c1','opencode-go','OpenCode Go','{"type":"key","key":"old"}',null,null,1,1,1),
                 ('c2','opencode-go','OpenCode Go','{"type":"key","key":"new"}',null,null,1,2,2),
                 ('c3','opencode-go','OpenCode Go','{"type":"key","key":"off"}',null,null,0,3,3),
                 ('c4','nvidia','NVIDIA','{"type":"key","key":"nv"}',null,null,1,4,4);"#,
        );
        assert_eq!(read_opencode_db(&db).await, cred("new", None));
        assert!(!d.path().join("opencode.db-wal").exists());
        assert!(!d.path().join("opencode.db-shm").exists());
    }

    #[tokio::test]
    async fn opencode_db_without_a_go_key_or_missing_is_not_signed_in() {
        let d = tempfile::tempdir().unwrap();
        let db = closed_opencode_db(
            d.path(),
            r#"insert into credential values
                 ('c4','nvidia','NVIDIA','{"type":"key","key":"nv"}',null,null,1,4,4);"#,
        );
        assert_eq!(read_opencode_db(&db).await, None);
        let missing = d.path().join("none/opencode.db");
        assert_eq!(read_opencode_db(&missing).await, None);
        assert!(!missing.exists());
    }

    #[test]
    fn keychain_exit_codes() {
        let json = br#"{"claudeAiOauth":{"accessToken":"t"}}"#;
        assert_eq!(
            keychain_result(Some(0), json),
            Ok(Credential {
                token: "t".into(),
                account_id: None
            })
        );
        assert_eq!(
            keychain_result(Some(0), b"garbage"),
            Err(QuotaOutcome::NotSignedIn)
        );
        assert_eq!(
            keychain_result(Some(44), b""),
            Err(QuotaOutcome::NotSignedIn)
        );
        let denied = Err(QuotaOutcome::Failed {
            reason: "Keychain access denied".into(),
        });
        assert_eq!(keychain_result(Some(1), b""), denied);
        assert_eq!(keychain_result(None, b""), denied);
    }
}
