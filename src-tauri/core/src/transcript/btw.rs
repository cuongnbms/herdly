//! Side questions (btw): the argv that runs `claude -p` on a fork of a Transcript, and the
//! parsing of its stream-json output into events for the card.
use crate::error::{AppError, AppResult};
use crate::transport::{exec, exec_bytes, spawn_lines, Transport};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

/// The `sh -c` body: enter the working directory, find `claude` (through a login shell when
/// it is not on PATH) and exec it with the remaining arguments.
pub const CLAUDE_SCRIPT: &str = r#"cd "$1" || exit 1; shift
p="$1"; shift
c=$(command -v "$p") || c=$("${SHELL:-/bin/sh}" -lc "command -v $p" 2>/dev/null | tail -n 1)
[ -n "$c" ] || { echo "claude not found on this machine" >&2; exit 127; }
exec "$c" "$@""#;

/// The argv that asks `question` on a fork of the Transcript `transcript_id`, or, when
/// `fork_id` is given, resumes that fork without forking again. The question goes after
/// `--` so a leading dash is not read as a flag.
pub fn btw_argv(
    program: &str,
    cwd: &str,
    transcript_id: &str,
    fork_id: Option<&str>,
    model: Option<&str>,
    question: &str,
) -> Vec<String> {
    let mut a: Vec<String> = [
        "sh",
        "-c",
        CLAUDE_SCRIPT,
        "sh",
        cwd,
        program,
        "-p",
        "--resume",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push(fork_id.unwrap_or(transcript_id).to_string());
    if fork_id.is_none() {
        a.push("--fork-session".into());
    }
    if let Some(m) = model {
        a.extend(["--model".to_string(), m.to_string()]);
    }
    a.extend(
        [
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--verbose",
            "--",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    a.push(question.to_string());
    a
}

fn values(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.lines().filter_map(|l| serde_json::from_str(l).ok())
}

/// `message.model` of the last assistant line that has one.
pub fn last_model(text: &str) -> Option<String> {
    values(text)
        .filter(|v| v["type"] == "assistant")
        .filter_map(|v| v["message"]["model"].as_str().map(str::to_string))
        .last()
}

/// `cwd` of the last line that has one.
pub fn last_cwd(text: &str) -> Option<String> {
    values(text)
        .filter_map(|v| v["cwd"].as_str().map(str::to_string))
        .last()
}

/// What a side question reports while it runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BtwEvent {
    Delta {
        text: String,
    },
    Tool {
        name: String,
    },
    /// The fork's session id, known as soon as the run starts (so a stopped ask can still be discarded).
    Started {
        fork_id: String,
    },
    Done {
        fork_id: String,
        cache_read: u64,
        input: u64,
    },
    Error {
        message: String,
    },
}

/// The events one line of `claude -p --output-format stream-json` carries. Lines from a
/// subagent (a non-null `parent_tool_use_id`), unknown lines and non-JSON give none.
pub fn parse_line(line: &str) -> Vec<BtwEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    let from_subagent = !v["parent_tool_use_id"].is_null();
    match v["type"].as_str() {
        Some("stream_event") if !from_subagent => {
            let delta = &v["event"]["delta"];
            if v["event"]["type"] == "content_block_delta" && delta["type"] == "text_delta" {
                if let Some(text) = delta["text"].as_str() {
                    return vec![BtwEvent::Delta { text: text.into() }];
                }
            }
            vec![]
        }
        Some("assistant") if !from_subagent => v["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "tool_use")
            .filter_map(|b| b["name"].as_str())
            .map(|name| BtwEvent::Tool { name: name.into() })
            .collect(),
        Some("result") => {
            if v["is_error"] == true {
                let message = v["result"]
                    .as_str()
                    .or_else(|| v["subtype"].as_str())
                    .unwrap_or("error");
                vec![BtwEvent::Error {
                    message: message.into(),
                }]
            } else if v["is_error"] == false {
                vec![BtwEvent::Done {
                    fork_id: v["session_id"].as_str().unwrap_or_default().into(),
                    cache_read: v["usage"]["cache_read_input_tokens"].as_u64().unwrap_or(0),
                    input: v["usage"]["input_tokens"].as_u64().unwrap_or(0),
                }]
            } else {
                vec![]
            }
        }
        Some("system") if !from_subagent && v["subtype"] == "init" => {
            match v["session_id"].as_str() {
                Some(id) if !id.is_empty() => vec![BtwEvent::Started { fork_id: id.into() }],
                _ => vec![],
            }
        }
        _ => vec![],
    }
}

/// Drops ANSI escape sequences (`ESC [ … final`, or `ESC` plus one character) and `\r`.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\x1b' => {
                if it.peek() == Some(&'[') {
                    it.next();
                    for n in it.by_ref() {
                        if ('\x40'..='\x7e').contains(&n) {
                            break;
                        }
                    }
                } else {
                    it.next();
                }
            }
            '\r' => {}
            c => out.push(c),
        }
    }
    out
}

/// Whether a non-JSON output line is worth showing in an error: not blank once cleaned, and
/// not the `Connection to <host> closed.` ssh prints when a tty session ends (or the `Shared
/// connection to <host> closed.` of a ControlMaster mux client).
fn keep_noise(line: &str) -> bool {
    let l = line.trim();
    let ssh_closing = (l.starts_with("Connection to ") || l.starts_with("Shared connection to "))
        && l.ends_with(" closed.");
    !l.is_empty() && !ssh_closing
}

/// Whether a stream-json line starts a new assistant message of the main conversation.
fn starts_message(v: &Value) -> bool {
    v["type"] == "stream_event"
        && v["parent_tool_use_id"].is_null()
        && v["event"]["type"] == "message_start"
}

/// Pushes `line` onto a ring that keeps the last 5.
fn push_last5(ring: &mut VecDeque<String>, line: String) {
    if ring.len() == 5 {
        ring.pop_front();
    }
    ring.push_back(line);
}

/// Asks `question` on a fork of the Transcript at `path` (or on the fork `fork_id`), running
/// `claude -p` on the Machine in the Transcript's working directory and passing each parsed
/// event to `emit`. `cancel` firing kills the run and returns without emitting. The text of
/// an answer's later messages starts after a blank line. A `fork_id` that is the
/// Transcript's own id is refused, and a run that did not fork is stopped with an error.
#[allow(clippy::too_many_arguments)]
pub async fn ask(
    t: &dyn Transport,
    remote: bool,
    program: &str,
    path: &str,
    question: &str,
    fork_id: Option<&str>,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
    emit: &mut (dyn FnMut(BtwEvent) + Send),
) -> AppResult<()> {
    if !path.starts_with('/') {
        return Err(AppError::new(
            "invalid",
            format!("the transcript path is not absolute: {path}"),
        ));
    }
    let out = exec_bytes(t, &["cat".to_string(), path.to_string()]).await?;
    if out.status != 0 {
        return Err(AppError::new(
            "io",
            format!("reading the transcript failed: {}", out.stderr.trim()),
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let cwd = last_cwd(&text)
        .ok_or_else(|| AppError::new("not_found", "the transcript has no working directory"))?;
    let model = last_model(&text);
    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if fork_id.is_some_and(|f| f.eq_ignore_ascii_case(stem)) {
        return Err(AppError::new(
            "invalid",
            "the fork id is the transcript's own id",
        ));
    }
    let argv = btw_argv(program, &cwd, stem, fork_id, model.as_deref(), question);
    let mut child = spawn_lines(t, &argv, remote).await?;
    let mut finished = false;
    let mut noise: VecDeque<String> = VecDeque::new();
    // Text has been emitted, and a later message has started since.
    let (mut wrote, mut gap) = (false, false);
    loop {
        tokio::select! {
            biased;
            _ = &mut cancel => return Ok(()), // dropping the child kills the process
            line = child.next_line() => {
                let Some(line) = line? else { break };
                let events = parse_line(&line);
                match serde_json::from_str::<Value>(&line) {
                    Ok(v) => gap |= wrote && starts_message(&v),
                    Err(_) => {
                        let clean = strip_ansi(&line);
                        if keep_noise(&clean) {
                            push_last5(&mut noise, clean.trim().to_string());
                        }
                    }
                }
                for e in events {
                    match e {
                        BtwEvent::Started { ref fork_id } if fork_id.eq_ignore_ascii_case(stem) => {
                            // Resumed the Transcript itself: stop before it is written to.
                            emit(BtwEvent::Error { message: "claude did not fork the transcript".into() });
                            return Ok(()); // dropping the child kills the process
                        }
                        BtwEvent::Delta { .. } => {
                            if std::mem::take(&mut gap) {
                                emit(BtwEvent::Delta { text: "\n\n".into() });
                            }
                            wrote = true;
                            emit(e);
                        }
                        BtwEvent::Done { ref fork_id, .. } if fork_id.is_empty() => {
                            finished = true;
                            emit(BtwEvent::Error { message: "claude returned no session id".into() });
                        }
                        BtwEvent::Done { .. } | BtwEvent::Error { .. } => {
                            finished = true;
                            emit(e);
                        }
                        e => emit(e),
                    }
                }
            }
        }
    }
    let (status, stderr) = child.finish().await?;
    if !finished {
        let tail = noise.iter().cloned().collect::<Vec<_>>().join("\n");
        let mut err_lines = VecDeque::new();
        for l in stderr.lines().map(strip_ansi).filter(|l| keep_noise(l)) {
            push_last5(&mut err_lines, l.trim().to_string());
        }
        let err_text = err_lines.into_iter().collect::<Vec<_>>().join("\n");
        let message = if !err_text.is_empty() {
            err_text
        } else if !tail.is_empty() {
            tail
        } else {
            format!("claude exited with {status}")
        };
        emit(BtwEvent::Error { message });
    }
    Ok(())
}

/// Deletes the fork `fork_id` that `claude -p --fork-session` left in the Machine's Claude
/// config (`config_dir`, or `$CLAUDE_CONFIG_DIR`, or `~/.claude`). It lands in the project
/// directory of the cwd the run used, not beside the Transcript, so every project directory
/// is searched. Only a UUID that is not the Transcript's own id is ever removed.
pub async fn discard_in(
    t: &dyn Transport,
    config_dir: Option<&str>,
    path: &str,
    fork_id: &str,
) -> AppResult<()> {
    let stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    // Only the canonical lowercase hyphenated form, and never the Transcript's own id (on a
    // case-insensitive filesystem an uppercase spelling would name the same file).
    let canonical = uuid::Uuid::parse_str(fork_id)
        .ok()
        .filter(|u| u.hyphenated().to_string() == fork_id);
    let is_transcript = |u: uuid::Uuid| {
        fork_id.eq_ignore_ascii_case(stem) || uuid::Uuid::parse_str(stem).is_ok_and(|s| s == u)
    };
    if canonical.is_none_or(is_transcript) {
        return Err(AppError::new("invalid", "not a side question fork id"));
    }
    let script = r#"d="${1:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"; rm -f -- "$d"/projects/*/"$2".jsonl; rm -rf -- "$d"/projects/*/"$2""#;
    let argv: Vec<String> = ["sh", "-c", script, "sh", config_dir.unwrap_or(""), fork_id]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let out = exec(t, &argv).await?;
    if out.status != 0 {
        return Err(AppError::new(
            "io",
            format!("deleting the fork failed: {}", out.stderr.trim()),
        ));
    }
    Ok(())
}

/// [`discard_in`] with the Machine's default Claude config.
pub async fn discard(t: &dyn Transport, path: &str, fork_id: &str) -> AppResult<()> {
    discard_in(t, None, path, fork_id).await
}

/// The cancel senders of the side questions running now, by ask id.
#[derive(Default)]
pub struct BtwRuns(pub std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn first_question_forks_the_transcript() {
        let a = btw_argv(
            "claude",
            "/w/b",
            "t1",
            None,
            Some("claude-opus-5-5"),
            "why?",
        );
        assert_eq!(&a[..5], &s(&["sh", "-c", CLAUDE_SCRIPT, "sh", "/w/b"])[..]);
        assert_eq!(
            &a[5..],
            &s(&[
                "claude",
                "-p",
                "--resume",
                "t1",
                "--fork-session",
                "--model",
                "claude-opus-5-5",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--",
                "why?",
            ])[..]
        );
    }

    #[test]
    fn follow_up_resumes_the_fork_without_forking_again() {
        let a = btw_argv("claude", "/w", "t1", Some("f1"), None, "-v là gì?");
        assert!(a.windows(2).any(|w| w == ["--resume", "f1"]));
        assert!(!a.contains(&"--fork-session".to_string()));
        assert!(!a.contains(&"--model".to_string()));
        assert_eq!(&a[a.len() - 2..], &s(&["--", "-v là gì?"])[..]);
    }

    const T: &str = concat!(
        r#"{"type":"user","cwd":"/w/a","message":{"role":"user","content":"hi"},"uuid":"u1"}"#,
        "\n",
        r#"{"type":"assistant","cwd":"/w/a","message":{"model":"claude-sonnet-5-5","content":[]},"uuid":"a1"}"#,
        "\n",
        r#"{"type":"assistant","cwd":"/w/b","message":{"model":"claude-opus-5-5","content":[]},"uuid":"a2"}"#,
        "\n",
        r#"{"type":"system","subtype":"compact_boundary"}"#,
        "\n",
    );

    #[test]
    fn model_and_cwd_come_from_the_last_lines_that_have_them() {
        assert_eq!(last_model(T).as_deref(), Some("claude-opus-5-5"));
        assert_eq!(last_cwd(T).as_deref(), Some("/w/b"));
        assert_eq!(last_model(r#"{"type":"user"}"#), None);
        assert_eq!(last_cwd(r#"{"type":"user"}"#), None);
    }

    #[test]
    fn stream_lines_become_events() {
        assert_eq!(
            parse_line(
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}"#
            ),
            vec![BtwEvent::Delta { text: "Hel".into() }]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","id":"t","name":"Read","input":{}}]}}"#
            ),
            vec![BtwEvent::Tool {
                name: "Read".into()
            }]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"f1","usage":{"input_tokens":12,"cache_read_input_tokens":34000}}"#
            ),
            vec![BtwEvent::Done {
                fork_id: "f1".into(),
                cache_read: 34000,
                input: 12
            }]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"f1"}"#
            ),
            vec![BtwEvent::Error {
                message: "error_during_execution".into()
            }]
        );
        assert_eq!(
            parse_line(r#"{"type":"system","subtype":"init","session_id":"f1"}"#),
            vec![BtwEvent::Started {
                fork_id: "f1".into()
            }]
        );
        assert_eq!(
            parse_line(r#"{"type":"system","subtype":"hook_started","session_id":"f1"}"#),
            vec![]
        );
        assert_eq!(parse_line("Warning: not json"), vec![]);
    }

    #[test]
    fn subagent_lines_are_ignored() {
        assert_eq!(
            parse_line(
                r#"{"type":"stream_event","parent_tool_use_id":"toolu_x","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}"#
            ),
            vec![]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"assistant","parent_tool_use_id":"toolu_x","message":{"content":[{"type":"tool_use","id":"t","name":"Read","input":{}}]}}"#
            ),
            vec![]
        );
    }

    fn fake(dir: &std::path::Path, body: &str) -> String {
        let p = dir.join("fake-claude");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p.to_string_lossy().into_owned()
    }

    fn transcript(dir: &std::path::Path, cwd: &std::path::Path) -> String {
        let p = dir.join("t1.jsonl");
        std::fs::write(
            &p,
            format!(
                "{{\"type\":\"assistant\",\"cwd\":\"{}\",\"message\":{{\"model\":\"m1\",\"content\":[]}}}}\n",
                cwd.display()
            ),
        )
        .unwrap();
        p.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn ask_streams_events_and_runs_in_the_transcript_cwd() {
        let d = tempfile::tempdir().unwrap();
        let work = d.path().join("work");
        std::fs::create_dir(&work).unwrap();
        let prog = fake(
            d.path(),
            r#"for a; do q="$a"; done
printf '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"%s|%s"}}}\n' "$(pwd -P)" "$q"
echo '{"type":"result","is_error":false,"session_id":"f1","usage":{"input_tokens":1,"cache_read_input_tokens":2}}'"#,
        );
        let path = transcript(d.path(), &work);
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let mut got = vec![];
        ask(
            &LocalTransport,
            false,
            &prog,
            &path,
            "why?",
            None,
            rx,
            &mut |e| got.push(e),
        )
        .await
        .unwrap();
        let work = std::fs::canonicalize(&work).unwrap();
        assert_eq!(
            got,
            vec![
                BtwEvent::Delta {
                    text: format!("{}|why?", work.display())
                },
                BtwEvent::Done {
                    fork_id: "f1".into(),
                    cache_read: 2,
                    input: 1
                },
            ]
        );
    }

    #[tokio::test]
    async fn a_failed_run_without_a_result_is_an_error_event() {
        let d = tempfile::tempdir().unwrap();
        let prog = fake(d.path(), "echo 'No conversation found' >&2; exit 1");
        let path = transcript(d.path(), d.path());
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let mut got = vec![];
        ask(
            &LocalTransport,
            false,
            &prog,
            &path,
            "q",
            None,
            rx,
            &mut |e| got.push(e),
        )
        .await
        .unwrap();
        assert_eq!(
            got,
            vec![BtwEvent::Error {
                message: "No conversation found".into()
            }]
        );
    }

    #[tokio::test]
    async fn an_empty_session_id_is_an_error_event() {
        let d = tempfile::tempdir().unwrap();
        let prog = fake(
            d.path(),
            r#"echo '{"type":"result","is_error":false,"session_id":""}'"#,
        );
        let path = transcript(d.path(), d.path());
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let mut got = vec![];
        ask(
            &LocalTransport,
            false,
            &prog,
            &path,
            "q",
            None,
            rx,
            &mut |e| got.push(e),
        )
        .await
        .unwrap();
        assert_eq!(
            got,
            vec![BtwEvent::Error {
                message: "claude returned no session id".into()
            }]
        );
    }

    #[test]
    fn noise_loses_ansi_and_the_ssh_closing_line() {
        assert_eq!(strip_ansi("\x1b[?25hhello\r"), "hello");
        assert!(!keep_noise("Connection to 1.2.3.4 closed."));
        assert!(!keep_noise(&strip_ansi(
            "Shared connection to devtuf closed.\r"
        )));
        assert!(!keep_noise("Shared connection to devtuf closed.\r"));
        assert!(!keep_noise("  "));
        assert!(keep_noise("boom"));
    }

    #[tokio::test]
    async fn cancel_stops_the_run_without_events() {
        let d = tempfile::tempdir().unwrap();
        let prog = fake(
            d.path(),
            "sleep 5; echo '{\"type\":\"result\",\"is_error\":false,\"session_id\":\"f1\"}'",
        );
        let path = transcript(d.path(), d.path());
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(()).unwrap();
        let mut got = vec![];
        let t0 = std::time::Instant::now();
        ask(
            &LocalTransport,
            false,
            &prog,
            &path,
            "q",
            None,
            rx,
            &mut |e| got.push(e),
        )
        .await
        .unwrap();
        assert!(got.is_empty());
        assert!(t0.elapsed() < std::time::Duration::from_secs(2));
    }

    #[tokio::test]
    async fn discard_removes_a_uuid_fork_from_any_project_dir() {
        let d = tempfile::tempdir().unwrap();
        let cfg = d.path().join("cfg");
        let a = cfg.join("projects/-a");
        let b = cfg.join("projects/-b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let path = transcript(&a, d.path());
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::write(b.join(format!("{id}.jsonl")), "x").unwrap();
        std::fs::create_dir(b.join(&id)).unwrap();
        std::fs::write(b.join(&id).join("t.txt"), "x").unwrap();
        let other = b.join(format!("{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&other, "x").unwrap();
        let cfg_s = cfg.to_str().unwrap();
        discard_in(&LocalTransport, Some(cfg_s), &path, &id)
            .await
            .unwrap();
        assert!(!b.join(format!("{id}.jsonl")).exists());
        assert!(!b.join(&id).exists());
        assert!(other.exists());
        discard_in(&LocalTransport, Some(cfg_s), &path, &id)
            .await
            .unwrap();
        assert_eq!(
            discard_in(&LocalTransport, Some(cfg_s), &path, "t1")
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
        assert_eq!(
            discard_in(&LocalTransport, Some(cfg_s), &path, "../t1")
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
        assert!(std::path::Path::new(&path).exists());
    }

    #[tokio::test]
    async fn ssh_close_notice_on_stderr_does_not_hide_the_stdout_error() {
        let d = tempfile::tempdir().unwrap();
        let prog = fake(
            d.path(),
            r"echo 'real failure'; echo 'Connection to h closed.' >&2; printf 'Shared connection to h closed.\r\n' >&2; exit 1",
        );
        let path = transcript(d.path(), d.path());
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let mut got = vec![];
        ask(
            &LocalTransport,
            false,
            &prog,
            &path,
            "q",
            None,
            rx,
            &mut |e| got.push(e),
        )
        .await
        .unwrap();
        assert_eq!(
            got,
            vec![BtwEvent::Error {
                message: "real failure".into()
            }]
        );
    }

    #[tokio::test]
    async fn discard_refuses_the_transcripts_own_id_in_any_spelling() {
        let d = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let path = d.path().join(format!("{id}.jsonl"));
        std::fs::write(&path, "x").unwrap();
        let p = path.to_str().unwrap();
        for bad in [id.clone(), id.to_uppercase(), format!("{{{id}}}")] {
            assert_eq!(
                discard(&LocalTransport, p, &bad).await.unwrap_err().code,
                "invalid"
            );
        }
        assert!(path.exists());
    }

    async fn run(prog: &str, path: &str, fork_id: Option<&str>) -> (AppResult<()>, Vec<BtwEvent>) {
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let mut got = vec![];
        let r = ask(
            &LocalTransport,
            false,
            prog,
            path,
            "q",
            fork_id,
            rx,
            &mut |e| got.push(e),
        )
        .await;
        (r, got)
    }

    #[tokio::test]
    async fn resuming_the_transcripts_own_id_is_refused_before_spawning() {
        let d = tempfile::tempdir().unwrap();
        let marker = d.path().join("ran");
        let prog = fake(d.path(), &format!("touch '{}'", marker.display()));
        let path = transcript(d.path(), d.path());
        for bad in ["t1", "T1"] {
            let (r, got) = run(&prog, &path, Some(bad)).await;
            assert_eq!(r.unwrap_err().code, "invalid");
            assert!(got.is_empty());
        }
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn a_run_that_did_not_fork_is_an_error_and_is_stopped() {
        let d = tempfile::tempdir().unwrap();
        let prog = fake(
            d.path(),
            r#"echo '{"type":"system","subtype":"init","session_id":"T1"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}'
echo '{"type":"result","is_error":false,"session_id":"T1"}'"#,
        );
        let path = transcript(d.path(), d.path());
        let (r, got) = run(&prog, &path, None).await;
        r.unwrap();
        assert_eq!(
            got,
            vec![BtwEvent::Error {
                message: "claude did not fork the transcript".into()
            }]
        );
    }

    #[tokio::test]
    async fn the_messages_of_one_answer_are_separated_by_a_blank_line() {
        let d = tempfile::tempdir().unwrap();
        let prog = fake(
            d.path(),
            r#"start='{"type":"stream_event","event":{"type":"message_start","message":{}}}'
text() { printf '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"%s"}}}\n' "$1"; }
echo "$start"; text A
echo "$start"; text B
echo '{"type":"result","is_error":false,"session_id":"f1"}'"#,
        );
        let path = transcript(d.path(), d.path());
        let (r, got) = run(&prog, &path, None).await;
        r.unwrap();
        let text: String = got
            .iter()
            .filter_map(|e| match e {
                BtwEvent::Delta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "A\n\nB");
    }

    #[tokio::test]
    async fn a_message_without_text_adds_no_blank_line() {
        let d = tempfile::tempdir().unwrap();
        let prog = fake(
            d.path(),
            r#"start='{"type":"stream_event","event":{"type":"message_start","message":{}}}'
echo "$start"
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Read","input":{}}]}}'
echo "$start"
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"B"}}}'
echo '{"type":"result","is_error":false,"session_id":"f1"}'"#,
        );
        let path = transcript(d.path(), d.path());
        let (r, got) = run(&prog, &path, None).await;
        r.unwrap();
        assert_eq!(
            got[0],
            BtwEvent::Tool {
                name: "Read".into()
            }
        );
        assert_eq!(got[1], BtwEvent::Delta { text: "B".into() });
    }

    #[tokio::test]
    async fn stderr_in_an_error_keeps_its_last_five_lines() {
        let d = tempfile::tempdir().unwrap();
        let prog = fake(
            d.path(),
            "for i in 1 2 3 4 5 6 7; do echo \"e$i\" >&2; done; exit 1",
        );
        let path = transcript(d.path(), d.path());
        let (r, got) = run(&prog, &path, None).await;
        r.unwrap();
        assert_eq!(
            got,
            vec![BtwEvent::Error {
                message: "e3\ne4\ne5\ne6\ne7".into()
            }]
        );
    }
}
