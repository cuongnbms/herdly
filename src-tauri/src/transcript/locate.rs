//! Find the transcript file of the agent running in a Pane.
use crate::error::{AppError, AppResult};
use crate::transport::{exec, MachineInfo, Transport};
use crate::view::PaneView;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Located {
    pub agent: String,
    pub path: String,
    pub ambiguous: bool,
    pub candidates: Vec<String>,
    /// The file does not exist yet: Claude writes it on the first prompt, at `path`.
    pub pending: bool,
    /// Reopened on the Pane's running tail without locating again: the lens checks it after.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cached: bool,
}

fn java_string_hash(s: &str) -> i32 {
    s.encode_utf16()
        .fold(0i32, |h, u| h.wrapping_mul(31).wrapping_add(u as i32))
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Claude Code's project directory name for `cwd`.
pub fn claude_project_dir(cwd: &str) -> String {
    let enc: String = cwd
        .encode_utf16()
        .map(|u| {
            if u < 128 && (u as u8).is_ascii_alphanumeric() {
                u as u8 as char
            } else {
                '-'
            }
        })
        .collect();
    if enc.len() <= 200 {
        return enc;
    }
    format!(
        "{}-{}",
        &enc[..200],
        base36(java_string_hash(cwd).unsigned_abs() as u64)
    )
}

/// pi's session directory name for `cwd`.
pub fn pi_session_dir(cwd: &str) -> String {
    format!(
        "--{}--",
        cwd.trim_start_matches('/').replace(['/', '\\', ':'], "-")
    )
}

/// A one-line summary of a tool call's input, at most 120 chars plus `…`.
pub fn input_summary(name: &str, input: &Value) -> String {
    let keys: &[&str] = match name {
        "Bash" => &["command"],
        "Read" | "Edit" | "Write" => &["file_path", "path"],
        "Grep" | "Glob" => &["pattern"],
        _ => &[],
    };
    let s = keys
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str))
        .or_else(|| {
            input
                .as_object()
                .and_then(|o| o.values().find_map(Value::as_str))
        })
        .unwrap_or("");
    if s.chars().count() > 120 {
        format!("{}…", s.chars().take(120).collect::<String>())
    } else {
        s.to_string()
    }
}

fn sh(script: &str, arg: &str) -> Vec<String> {
    vec![
        "sh".into(),
        "-c".into(),
        script.into(),
        "sh".into(),
        arg.into(),
    ]
}

async fn file_exists(t: &dyn Transport, path: &str) -> AppResult<bool> {
    Ok(exec(t, &sh(r#"test -f "$1""#, path)).await?.status == 0)
}

/// Up to 20 `*.jsonl` files in `dir`, newest first. Only a transport failure is an error.
async fn newest_in(t: &dyn Transport, dir: &str) -> AppResult<Vec<String>> {
    let script = r#"cd "$1" 2>/dev/null && ls -1t -- *.jsonl 2>/dev/null | head -n 20"#;
    let o = exec(t, &sh(script, dir)).await?;
    Ok(o.stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| format!("{}/{l}", dir.trim_end_matches('/')))
        .collect())
}

/// `<id>.jsonl` in any Claude project directory under `home`.
async fn claude_session_anywhere(
    t: &dyn Transport,
    home: &str,
    id: &str,
) -> AppResult<Option<String>> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Ok(None);
    }
    let script = r#"for f in "$1"/.claude/projects/*/"$2".jsonl; do test -f "$f" && { echo "$f"; break; }; done"#;
    let argv: Vec<String> = vec![
        "sh".into(),
        "-c".into(),
        script.into(),
        "sh".into(),
        home.into(),
        id.into(),
    ];
    let o = exec(t, &argv).await?;
    Ok(o.stdout.lines().find(|l| !l.is_empty()).map(str::to_string))
}

/// Whether herdr detected a Claude agent but has not reported its session yet: herdr learns
/// the id from Claude's SessionStart hook, shortly after the agent shows up in the pane.
pub fn awaiting_session(agent_get: &Value) -> bool {
    agent_get["agent"]["agent"] == "claude" && agent_get["agent"]["agent_session"].is_null()
}

pub async fn locate(
    t: &dyn Transport,
    info: &MachineInfo,
    agent_get: &Value,
    pane: &PaneView,
) -> AppResult<Located> {
    locate_in(t, info, agent_get, pane, None).await
}

/// Like `locate`, also trying the pane's `foreground_cwd`: an exact Claude session id in the
/// `cwd` dir, then in the `foreground_cwd` dir, then in any project dir, else where Claude will
/// write it, flagged as pending. Without a session from herdr, the newest file in each dir in
/// turn, flagged as ambiguous.
pub async fn locate_in(
    t: &dyn Transport,
    info: &MachineInfo,
    agent_get: &Value,
    pane: &PaneView,
    foreground_cwd: Option<&str>,
) -> AppResult<Located> {
    let agent = agent_get["agent"]["agent"]
        .as_str()
        .map(str::to_string)
        .or_else(|| pane.agent.clone())
        .unwrap_or_default();
    let session = &agent_get["agent"]["agent_session"];
    let found = |path: String, ambiguous: bool, candidates: Vec<String>| Located {
        agent: agent.clone(),
        path,
        ambiguous,
        candidates,
        pending: false,
        cached: false,
    };

    if session["kind"] == "path" {
        if let Some(p) = session["value"].as_str() {
            return Ok(found(p.to_string(), false, vec![p.to_string()]));
        }
    }
    let home = info.home.trim_end_matches('/');
    let mut cwds: Vec<&str> = Vec::new();
    for c in [pane.cwd.as_deref(), foreground_cwd].into_iter().flatten() {
        if !cwds.contains(&c) {
            cwds.push(c);
        }
    }
    let dirs: Vec<String> = match agent.as_str() {
        "claude" => cwds
            .iter()
            .map(|c| format!("{home}/.claude/projects/{}", claude_project_dir(c)))
            .collect(),
        "pi" => cwds
            .iter()
            .map(|c| {
                format!(
                    "{}/{}",
                    info.pi_dir.trim_end_matches('/'),
                    pi_session_dir(c)
                )
            })
            .collect(),
        _ => Vec::new(),
    };
    if agent == "claude" {
        if let Some(id) = session["value"].as_str() {
            for dir in &dirs {
                let path = format!("{dir}/{id}.jsonl");
                if file_exists(t, &path).await? {
                    return Ok(found(path.clone(), false, vec![path]));
                }
            }
            // The agent may have started in another directory than the pane's cwd.
            if let Some(path) = claude_session_anywhere(t, home, id).await? {
                return Ok(found(path.clone(), false, vec![path]));
            }
            // Claude writes its transcript only after the first prompt: the newest file in the
            // directory would be another pane's conversation. Expect it in the dir of the last cwd,
            // the `foreground_cwd` when given: the directory Claude runs in.
            if let Some(dir) = dirs.last() {
                let path = format!("{dir}/{id}.jsonl");
                return Ok(Located {
                    pending: true,
                    ..found(path.clone(), false, vec![path])
                });
            }
            return Err(AppError::new(
                "not_found",
                format!("no transcript yet for claude session {id}"),
            ));
        }
    }
    // No session from herdr: the newest file is a guess, whatever else runs in this directory.
    for dir in &dirs {
        let candidates = newest_in(t, dir).await?;
        if let Some(first) = candidates.first() {
            return Ok(found(first.clone(), true, candidates));
        }
    }
    Err(AppError::new(
        "not_found",
        format!(
            "no transcript found for {} in {}",
            if agent.is_empty() { "agent" } else { &agent },
            cwds.first().copied().unwrap_or("unknown directory")
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn claude_dir_encoding() {
        assert_eq!(
            claude_project_dir("/Users/me/herdr app"),
            "-Users-me-herdr-app"
        );
        assert_eq!(
            claude_project_dir("/srv/example.com/my_project"),
            "-srv-example-com-my-project"
        );
        let long = format!("/{}", "a".repeat(250));
        let enc = claude_project_dir(&long);
        assert!(enc.starts_with(&format!("-{}", "a".repeat(199))));
        assert_eq!(enc.len(), 200 + 1 + enc.rsplit('-').next().unwrap().len());
    }
    #[test]
    fn pi_dir_encoding() {
        assert_eq!(
            pi_session_dir("/Users/cuongnb/agent-skills/skills"),
            "--Users-cuongnb-agent-skills-skills--"
        );
        assert_eq!(pi_session_dir("/Users/cuongnb"), "--Users-cuongnb--");
    }
    #[test]
    fn summarises_tool_input() {
        assert_eq!(
            input_summary("Bash", &json!({"command":"ls -la","description":"x"})),
            "ls -la"
        );
        assert_eq!(
            input_summary("Edit", &json!({"file_path":"/a/b.rs","old_string":"x"})),
            "/a/b.rs"
        );
        assert_eq!(
            input_summary("Grep", &json!({"pattern":"fn main"})),
            "fn main"
        );
        assert_eq!(input_summary("Other", &json!({"n":1,"q":"hello"})), "hello");
        assert_eq!(
            input_summary("Bash", &json!({"command":"x".repeat(200)}))
                .chars()
                .count(),
            121
        );
    }
    #[tokio::test]
    async fn locates_newest_claude_file_and_flags_ambiguity() {
        let home = tempfile::tempdir().unwrap();
        let dir = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir("/w/app"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.jsonl"), "{}\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(dir.join("new.jsonl"), "{}\n").unwrap();
        let info = crate::transport::MachineInfo {
            home: home.path().to_string_lossy().into(),
            herdr: "herdr".into(),
            pi_dir: "/none".into(),
            agent_dir: "/h/.pi/agent".into(),
            pi: String::new(),
            version: "0.9.3".into(),
            protocol: 22,
        };
        let pane = crate::view::PaneView {
            pane_id: "w1:p1".into(),
            terminal_id: "t".into(),
            title: "x".into(),
            cwd: Some("/w/app".into()),
            agent: Some("claude".into()),
            status: Default::default(),
        };
        let got = locate(
            &crate::transport::local::LocalTransport,
            &info,
            &json!({"agent":{"agent":"claude"}}),
            &pane,
        )
        .await
        .unwrap();
        assert!(got.path.ends_with("/new.jsonl"), "{}", got.path);
        assert!(got.ambiguous);
        assert_eq!(got.candidates.len(), 2);
        let exact = locate(
            &crate::transport::local::LocalTransport,
            &info,
            &json!({"agent":{"agent":"claude","agent_session":{"kind":"id","value":"old"}}}),
            &pane,
        )
        .await
        .unwrap();
        assert!(exact.path.ends_with("/old.jsonl") && !exact.ambiguous);
    }

    fn claude_fixture() -> (
        tempfile::TempDir,
        crate::transport::MachineInfo,
        crate::view::PaneView,
    ) {
        let home = tempfile::tempdir().unwrap();
        let dir = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir("/w/app"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("other-pane.jsonl"), "{}\n").unwrap();
        let info = crate::transport::MachineInfo {
            home: home.path().to_string_lossy().into(),
            herdr: "herdr".into(),
            pi_dir: "/none".into(),
            agent_dir: "/h/.pi/agent".into(),
            pi: String::new(),
            version: "0.9.3".into(),
            protocol: 22,
        };
        let pane = crate::view::PaneView {
            pane_id: "w1:p1".into(),
            terminal_id: "t".into(),
            title: "x".into(),
            cwd: Some("/w/app".into()),
            agent: Some("claude".into()),
            status: Default::default(),
        };
        (home, info, pane)
    }

    #[tokio::test]
    async fn known_session_without_its_file_is_pending_not_another_panes_transcript() {
        let (home, info, pane) = claude_fixture();
        let got = locate(
            &crate::transport::local::LocalTransport,
            &info,
            &json!({"agent":{"agent":"claude","agent_session":{"kind":"id","value":"fresh-id"}}}),
            &pane,
        )
        .await
        .unwrap();
        let want = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir("/w/app"))
            .join("fresh-id.jsonl");
        assert_eq!(got.path, want.to_string_lossy());
        assert!(got.pending && !got.ambiguous);
        assert_eq!(got.candidates, vec![got.path.clone()]);
    }

    #[tokio::test]
    async fn pending_transcript_is_expected_in_the_foreground_cwd_dir() {
        let (home, info, pane) = claude_fixture();
        let got = locate_in(
            &crate::transport::local::LocalTransport,
            &info,
            &json!({"agent":{"agent":"claude","agent_session":{"kind":"id","value":"fresh-id"}}}),
            &pane,
            Some("/w/app/sub"),
        )
        .await
        .unwrap();
        let want = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir("/w/app/sub"))
            .join("fresh-id.jsonl");
        assert_eq!(got.path, want.to_string_lossy());
        assert!(got.pending);
    }

    #[tokio::test]
    async fn an_existing_transcript_is_not_pending() {
        let (_home, info, pane) = claude_fixture();
        let got = locate(
            &crate::transport::local::LocalTransport,
            &info,
            &json!({"agent":{"agent":"claude","agent_session":{"kind":"id","value":"other-pane"}}}),
            &pane,
        )
        .await
        .unwrap();
        assert!(!got.pending);
    }

    #[tokio::test]
    async fn known_session_is_found_in_another_project_dir() {
        let (home, info, pane) = claude_fixture();
        let elsewhere = home
            .path()
            .join(".claude/projects")
            .join(claude_project_dir("/w/app/.worktrees/x"));
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("sid.jsonl"), "{}\n").unwrap();
        let got = locate(
            &crate::transport::local::LocalTransport,
            &info,
            &json!({"agent":{"agent":"claude","agent_session":{"kind":"id","value":"sid"}}}),
            &pane,
        )
        .await
        .unwrap();
        assert!(got.path.ends_with("/sid.jsonl"), "{}", got.path);
        assert!(!got.ambiguous);
    }

    #[test]
    fn awaits_a_claude_session_herdr_has_not_reported() {
        assert!(awaiting_session(&json!({"agent":{"agent":"claude"}})));
        assert!(!awaiting_session(
            &json!({"agent":{"agent":"claude","agent_session":{"kind":"id","value":"sid"}}})
        ));
        assert!(!awaiting_session(&json!({"agent":{"agent":"pi"}})));
        assert!(!awaiting_session(&Value::Null));
    }
}
