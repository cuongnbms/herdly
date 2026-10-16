//! Background work a pi agent keeps running after its run ends: pi-background-tasks' `bg_*`
//! tasks and pi-subagents' background agents. herdr reports pi idle once its run settles,
//! while that work is still going; the app reads the transcript to keep showing it working.
use super::rpc;
use crate::{
    error::{AppError, AppResult},
    transport::{exec, Transport},
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

/// Answers whether an agent whose run ended still has background work running; `None` when
/// that could not be found out.
#[async_trait]
pub trait Probe: Send + Sync {
    async fn busy(&self, socket: &Path, pane_id: &str) -> Option<bool>;
}

/// `ps` reports pi's age in whole seconds; work started within this of it counts as its own.
const START_SLACK_MS: i64 = 5_000;

/// Reads pi transcripts over a Machine's transport, remembering how far each pane's was read.
pub struct PiProbe {
    transport: Arc<dyn Transport>,
    tracks: Mutex<HashMap<String, Track>>,
}

/// One pane's transcript, read up to `offset`.
#[derive(Default)]
struct Track {
    path: String,
    offset: u64,
    pending: Pending,
}

impl PiProbe {
    pub fn new(transport: Arc<dyn Transport>) -> Self {
        PiProbe {
            transport,
            tracks: Mutex::default(),
        }
    }

    async fn check(&self, socket: &Path, pane_id: &str) -> AppResult<bool> {
        let got = rpc::call(socket, "agent.get", json!({ "target": pane_id })).await?;
        let agent = &got["agent"];
        let session = &agent["agent_session"];
        // Only the transcript herdr names: a guessed one could be another pane's.
        let path = match session["value"].as_str() {
            Some(p) if agent["agent"] == "pi" && session["kind"] == "path" => p.to_string(),
            _ => {
                self.tracks.lock().unwrap().remove(pane_id);
                return Ok(false);
            }
        };
        let info = rpc::call(socket, "pane.process_info", json!({ "pane_id": pane_id })).await?;
        let info = &info["process_info"];
        // pi's TUI runs as `pi`, or as `node …/bin/pi`; while it runs a tool only its children
        // may show, in the process group it leads as the shell's foreground job.
        let is_pi = |a: &Value| {
            a.as_str()
                .is_some_and(|a| a.rsplit('/').next() == Some("pi"))
        };
        let pid = info["foreground_processes"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| is_pi(&p["name"]) || is_pi(&p["argv"][0]) || is_pi(&p["argv"][1]))
            .and_then(|p| p["pid"].as_u64())
            .or_else(|| info["foreground_process_group_id"].as_u64());
        let offset = {
            let mut tracks = self.tracks.lock().unwrap();
            let track = tracks.entry(pane_id.to_string()).or_default();
            if track.path != path {
                *track = Track {
                    path: path.clone(),
                    ..Track::default()
                };
            }
            track.offset
        };
        // Kept in place while the scan runs: a check cut short by its timeout loses nothing.
        // The pane's watcher is the only caller, one check at a time.
        let s = scan(&*self.transport, &path, offset, pid).await?;
        let mut tracks = self.tracks.lock().unwrap();
        let track = tracks.entry(pane_id.to_string()).or_default();
        if s.start < offset {
            track.pending = Pending::default(); // the file was replaced: read it anew
        }
        for l in &s.lines {
            track.pending.line(l);
        }
        track.offset = s.end;
        Ok(track
            .pending
            .running_since(s.started_ms.map(|ms| ms - START_SLACK_MS)))
    }
}

#[async_trait]
impl Probe for PiProbe {
    async fn busy(&self, socket: &Path, pane_id: &str) -> Option<bool> {
        self.check(socket, pane_id)
            .await
            .inspect_err(|e| tracing::debug!("background check of {pane_id} failed: {e:?}"))
            .ok()
    }
}

/// Lines `Pending` reads: tool results naming the tools or carrying a task snapshot, and the
/// two plugins' completion notifications. pi writes compact JSON, one entry per line.
const PATTERN: &str = r#""toolName":"(Agent|get_subagent_result)"|"task":[{]|"tasks":[[]|"customType":"(background-task|subagent)-notification""#;

/// Prints `parse_scan`'s header, then the matching lines from `$2` to the size measured.
const SCRIPT: &str = r#"f=$1; o=$2; pid=$3
s=$(wc -c < "$f" 2>/dev/null | tr -d ' '); [ -n "$s" ] || s=0
[ "$s" -ge "$o" ] || o=0
e=; [ -n "$pid" ] && e=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' '); [ -n "$e" ] || e=-
c=0
if [ "$s" -gt "$o" ] && [ "$(tail -c +"$s" "$f" | head -c 1 | od -An -tx1 | tr -d ' \n')" != 0a ]; then
  c=$(tail -c +$((o+1)) "$f" | head -c $((s-o)) | tail -n 1 | wc -c | tr -d ' ')
fi
echo "herdr-bg $s $o $c $(date +%s) $e"
[ "$s" -gt "$o" ] || exit 0
tail -c +$((o+1)) "$f" | head -c $((s-o)) | LC_ALL=C grep -a -b -E "$4"
exit 0"#;

/// Read `path` from `offset` on, keeping only the lines `Pending` reads, and the age of `pid`.
pub async fn scan(t: &dyn Transport, path: &str, offset: u64, pid: Option<u64>) -> AppResult<Scan> {
    let argv = [
        "sh",
        "-c",
        SCRIPT,
        "sh",
        path,
        &offset.to_string(),
        &pid.map(|p| p.to_string()).unwrap_or_default(),
        PATTERN,
    ]
    .map(String::from);
    let out = exec(t, &argv).await?;
    parse_scan(&out.stdout).ok_or_else(|| {
        AppError::new(
            "protocol",
            format!("background scan of {path} failed: {}", out.stderr.trim()),
        )
    })
}

/// Work started and not yet seen to end, by id, with its start in Unix ms.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pending {
    started: HashMap<String, i64>,
}

impl Pending {
    /// Read one transcript line. Starts: a tool result carrying a running pi-background-tasks
    /// task that will notify, or pi-subagents' `Agent` result for a background spawn. Ends: their
    /// notifications, a task snapshot showing it ended, or a `get_subagent_result` read of it.
    pub fn line(&mut self, line: &str) {
        let Ok(e) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let at = e["timestamp"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.timestamp_millis());
        match e["type"].as_str() {
            Some("message") if e["message"]["role"] == "toolResult" => {
                let m = &e["message"];
                let details = &m["details"];
                if details["task"].is_object() {
                    self.task(&details["task"], at);
                }
                for t in details["tasks"].as_array().into_iter().flatten() {
                    self.task(t, at);
                }
                match m["toolName"].as_str() {
                    Some("Agent") if details["status"] == "background" => {
                        if let Some(id) = details["agentId"].as_str() {
                            self.start(id, at);
                        }
                    }
                    Some("get_subagent_result") => {
                        if let Some((id, status)) = agent_read(m) {
                            if status != "running" && status != "queued" {
                                self.started.remove(&id);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some("custom_message") => match e["customType"].as_str() {
                Some("background-task-notification") => self.end(&e["details"]["id"]),
                Some("subagent-notification") => {
                    let d = &e["details"];
                    self.end(&d["id"]);
                    for o in d["others"].as_array().into_iter().flatten() {
                        self.end(&o["id"]);
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }

    /// Whether any pending work started at or after `since_ms` (all of it when `None`).
    pub fn running_since(&self, since_ms: Option<i64>) -> bool {
        self.started
            .values()
            .any(|&at| since_ms.is_none_or(|since| at >= since))
    }

    /// A pi-background-tasks task snapshot. Without a notification nothing marks its end.
    fn task(&mut self, t: &Value, at: Option<i64>) {
        let Some(id) = t["id"].as_str() else { return };
        if t["status"] == "running" && t["notifyOnCompletion"] != false {
            self.start(id, t["startTime"].as_i64().or(at));
        } else {
            self.started.remove(id);
        }
    }

    fn start(&mut self, id: &str, at: Option<i64>) {
        self.started.insert(id.to_string(), at.unwrap_or(0));
    }

    fn end(&mut self, id: &Value) {
        if let Some(id) = id.as_str() {
            self.started.remove(id);
        }
    }
}

/// The agent id and status a `get_subagent_result` text reports: `Agent: <id>` then
/// `Type: … | Status: <status> …`.
fn agent_read(message: &Value) -> Option<(String, String)> {
    let text = message["content"]
        .as_array()?
        .iter()
        .find_map(|c| c["text"].as_str())?;
    let mut lines = text.lines();
    let id = lines.next()?.strip_prefix("Agent: ")?.trim().to_string();
    let status = lines
        .next()?
        .split(" | ")
        .find_map(|part| part.strip_prefix("Status: "))?
        .split_whitespace()
        .next()?
        .to_string();
    Some((id, status))
}

/// What `scan` read: a range of the transcript, its matching lines and pi's age.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scan {
    /// Where this read started: 0 when the file is shorter than the offset asked for.
    pub start: u64,
    /// Where to read from next: the end of the last whole line read.
    pub end: u64,
    /// Matching whole lines.
    pub lines: Vec<String>,
    /// When pi started, in Unix ms, when its age was known.
    pub started_ms: Option<i64>,
}

/// Parse `SCRIPT`'s output; `None` without its header.
///
/// The header is `herdr-bg <size> <start> <cut> <now> <etime>`: the file's size, the offset read
/// from, the bytes of a last line still being written, the Machine's clock in seconds and pi's
/// `ps` age (`-` when unknown). Each following line is grep's `<offset from start>:<line>`.
pub fn parse_scan(out: &str) -> Option<Scan> {
    let mut lines = out.lines();
    let head: Vec<&str> = lines.next()?.split(' ').collect();
    let [tag, size, start, cut, now, etime] = head.as_slice() else {
        return None;
    };
    if *tag != "herdr-bg" {
        return None;
    }
    let (size, start, cut) = (
        size.parse::<u64>().ok()?,
        start.parse::<u64>().ok()?,
        cut.parse::<u64>().ok()?,
    );
    let end = size.saturating_sub(cut).max(start);
    let lines = lines
        .filter_map(|l| {
            let (off, line) = l.split_once(':')?;
            (start + off.parse::<u64>().ok()? < end).then(|| line.to_string())
        })
        .collect();
    let started_ms = now
        .parse::<i64>()
        .ok()
        .zip(etime_secs(etime))
        .map(|(now, age)| (now - age) * 1000);
    Some(Scan {
        start,
        end,
        lines,
        started_ms,
    })
}

/// `ps -o etime` (`[[dd-]hh:]mm:ss`) in seconds.
fn etime_secs(s: &str) -> Option<i64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, rest)) => (d.parse::<i64>().ok()?, rest),
        None => (0, s),
    };
    let parts = rest
        .split(':')
        .map(|p| p.parse::<i64>().ok())
        .collect::<Option<Vec<_>>>()?;
    let (h, m, sec) = match parts.as_slice() {
        [m, s] => (0, *m, *s),
        [h, m, s] => (*h, *m, *s),
        _ => return None,
    };
    Some(days * 86_400 + h * 3_600 + m * 60 + sec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: &str = "2026-10-16T09:00:00.000Z";
    const T0_MS: i64 = 1_792_141_200_000;

    fn tool_result(name: &str, details: Value, text: &str) -> String {
        json!({"type":"message","id":"a","parentId":"b","timestamp":T0,
            "message":{"role":"toolResult","toolCallId":"c","toolName":name,
                "content":[{"type":"text","text":text}],"details":details,"isError":false,"timestamp":0}})
        .to_string()
    }
    fn custom(kind: &str, details: Value) -> String {
        json!({"type":"custom_message","customType":kind,"content":"…","display":true,
            "details":details,"id":"d","parentId":"e","timestamp":T0})
        .to_string()
    }
    fn task(id: &str, status: &str, notify: bool) -> Value {
        json!({"id":id,"name":"Verify","command":"bun run check","status":status,
            "startTime":T0_MS,"notifyOnCompletion":notify,"triggerOnCompletion":true})
    }
    fn pending(lines: &[String]) -> Pending {
        let mut p = Pending::default();
        for l in lines {
            p.line(l);
        }
        p
    }

    #[test]
    fn a_bg_task_runs_until_its_notification() {
        let started = tool_result(
            "bg_run",
            json!({"task": task("ba0e0df0a", "running", true)}),
            "started",
        );
        assert!(pending(std::slice::from_ref(&started)).running_since(None));
        let ended = custom(
            "background-task-notification",
            task("ba0e0df0a", "completed", true),
        );
        assert!(!pending(&[started, ended]).running_since(None));
    }

    #[test]
    fn a_bg_task_without_a_notification_is_not_waited_for() {
        let started = tool_result(
            "bg_run",
            json!({"task": task("t1", "running", false)}),
            "started",
        );
        assert!(!pending(&[started]).running_since(None));
    }

    #[test]
    fn any_launch_carrying_a_task_counts() {
        // bg_delegate / fusion launches carry the same task snapshot.
        let started = tool_result(
            "bg_delegate",
            json!({"schema_version":"pi-background-tasks.delegate-launch.v1","task": task("t1", "running", true)}),
            "launched",
        );
        assert!(pending(&[started]).running_since(None));
    }

    #[test]
    fn a_status_or_kill_showing_it_ended_ends_it() {
        let a = tool_result("bg_run", json!({"task": task("t1", "running", true)}), "");
        let b = tool_result("bg_run", json!({"task": task("t2", "running", true)}), "");
        let status = tool_result(
            "bg_status",
            json!({"tasks":[task("t1", "failed", true), task("t2", "running", true)]}),
            "",
        );
        assert!(pending(&[a.clone(), b.clone(), status.clone()]).running_since(None));
        let kill = tool_result(
            "bg_kill",
            json!({"task": task("t2", "killed", true), "message":"killed"}),
            "",
        );
        assert!(!pending(&[a, b, status, kill]).running_since(None));
    }

    #[test]
    fn a_background_agent_runs_until_its_notification() {
        let spawn = |id: &str| {
            tool_result(
                "Agent",
                json!({"displayName":"Agent","status":"background","agentId":id,"toolUses":0}),
                "Agent started in background.",
            )
        };
        let (a, b) = (spawn("d1242f98-d294-452"), spawn("d27f3b50-3ea6-438"));
        assert!(pending(std::slice::from_ref(&a)).running_since(None));
        // A group completion lists the rest under `others`.
        let done = custom(
            "subagent-notification",
            json!({"id":"d1242f98-d294-452","status":"completed","others":[{"id":"d27f3b50-3ea6-438","status":"completed"}]}),
        );
        assert!(!pending(&[a, b, done]).running_since(None));
    }

    #[test]
    fn a_foreground_agent_is_no_background_work() {
        let fg = tool_result("Agent", json!({"status":"completed","agentId":"x"}), "done");
        assert!(!pending(&[fg]).running_since(None));
    }

    #[test]
    fn reading_an_agents_result_ends_it_unless_it_still_runs() {
        let spawn = tool_result(
            "Agent",
            json!({"status":"background","agentId":"d27f3b50-3ea6-438"}),
            "",
        );
        let read = |status: &str| {
            tool_result(
                "get_subagent_result",
                Value::Null,
                &format!("Agent: d27f3b50-3ea6-438\nType: Agent | Status: {status} | Tool uses: 5\nDescription: Review\n\nok"),
            )
        };
        assert!(pending(&[spawn.clone(), read("running")]).running_since(None));
        assert!(pending(&[spawn.clone(), read("queued")]).running_since(None));
        assert!(!pending(&[spawn, read("completed")]).running_since(None));
    }

    #[test]
    fn work_started_before_pi_did_died_with_the_old_process() {
        let started = tool_result("bg_run", json!({"task": task("t1", "running", true)}), "");
        let p = pending(&[started]);
        assert!(p.running_since(Some(T0_MS - 5_000)));
        assert!(!p.running_since(Some(T0_MS + 5_000)));
        // An agent spawn has no start of its own: the entry's timestamp is used.
        let spawn = tool_result("Agent", json!({"status":"background","agentId":"x"}), "");
        let p = pending(&[spawn]);
        assert!(p.running_since(Some(T0_MS)));
        assert!(!p.running_since(Some(T0_MS + 1)));
    }

    #[test]
    fn unrelated_and_broken_lines_change_nothing() {
        let mut p = pending(&[tool_result(
            "bg_run",
            json!({"task": task("t1", "running", true)}),
            "",
        )]);
        let before = p.clone();
        p.line("{not json");
        p.line("");
        p.line(&json!({"type":"message","message":{"role":"assistant","content":[]}}).to_string());
        p.line(&custom(
            "background-task-notification",
            json!({"id":"other","status":"completed"}),
        ));
        assert_eq!(p, before);
    }

    #[test]
    fn parses_a_scan() {
        let out = "herdr-bg 1000 400 0 1791882100 01:40\n\
                   10:{\"a\":1}\n\
                   250:{\"b\":2}\n";
        assert_eq!(
            parse_scan(out),
            Some(Scan {
                start: 400,
                end: 1000,
                lines: vec!["{\"a\":1}".into(), "{\"b\":2}".into()],
                started_ms: Some((1_791_882_100 - 100) * 1000),
            })
        );
    }

    #[test]
    fn a_half_written_last_line_is_left_for_the_next_scan() {
        // 300 bytes after the last newline: the scan ends at 700, and a match starting there waits.
        let out = "herdr-bg 1000 400 300 1791882100 -\n\
                   10:{\"a\":1}\n\
                   300:{\"b\":";
        assert_eq!(
            parse_scan(out),
            Some(Scan {
                start: 400,
                end: 700,
                lines: vec!["{\"a\":1}".into()],
                started_ms: None,
            })
        );
    }

    #[test]
    fn pis_age_reads_every_etime_form() {
        let at = |etime: &str| {
            parse_scan(&format!("herdr-bg 0 0 0 1000000 {etime}\n")).and_then(|s| s.started_ms)
        };
        assert_eq!(at("05:07"), Some((1_000_000 - 307) * 1000));
        assert_eq!(at("02:05:07"), Some((1_000_000 - 7_507) * 1000));
        assert_eq!(
            at("3-02:05:07"),
            Some((1_000_000 - 3 * 86_400 - 7_507) * 1000)
        );
        assert_eq!(at("garbage"), None);
    }

    #[test]
    fn no_header_is_no_scan() {
        assert_eq!(parse_scan(""), None);
        assert_eq!(parse_scan("sh: tail: not found\n"), None);
    }

    use crate::{herdr::fake::FakeHerdr, transport::local::LocalTransport};
    use std::io::Write;

    fn append(path: &Path, text: &str) {
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }

    #[tokio::test]
    async fn scan_reads_matching_whole_lines_from_an_offset() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let started = tool_result("bg_run", json!({"task": task("t1", "running", true)}), "");
        let chatter = json!({"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"x".repeat(5000)}]}}).to_string();
        append(&p, &format!("{chatter}\n{started}\n{chatter}\n"));
        let t = LocalTransport;
        let path = p.to_str().unwrap();
        let s = scan(&t, path, 0, None).await.unwrap();
        assert_eq!(s.lines, vec![started.clone()]);
        assert_eq!(s.end, std::fs::metadata(&p).unwrap().len());
        assert_eq!(s.started_ms, None);

        // A notification half written: it waits until its newline lands.
        let ended = custom(
            "background-task-notification",
            task("t1", "completed", true),
        );
        let (head, tail) = ended.split_at(40);
        append(&p, head);
        let s2 = scan(&t, path, s.end, None).await.unwrap();
        assert_eq!((s2.end, s2.lines.len()), (s.end, 0));
        append(&p, &format!("{tail}\n"));
        let s3 = scan(&t, path, s2.end, None).await.unwrap();
        assert_eq!(s3.lines, vec![ended]);
        assert_eq!(s3.end, std::fs::metadata(&p).unwrap().len());
    }

    #[tokio::test]
    async fn scan_reports_pis_start_and_survives_a_missing_file() {
        let t = LocalTransport;
        let pid = u64::from(std::process::id());
        let s = scan(&t, "/nonexistent/s.jsonl", 0, Some(pid))
            .await
            .unwrap();
        assert_eq!((s.end, s.lines.len()), (0, 0));
        let now = chrono::Utc::now().timestamp_millis();
        let started = s.started_ms.expect("this test process's age");
        assert!(
            started <= now && started > now - 3_600_000,
            "{started} vs {now}"
        );
    }

    /// A herdr answering `agent.get` and `pane.process_info` for one pane, with this test
    /// process as the agent's.
    fn herdr_with(agent: &'static str, session: Value) -> FakeHerdr {
        let pid = std::process::id();
        let info = json!({"foreground_processes":[{"argv":[agent],"name":agent,"pid":pid}]});
        herdr_answering(agent, session, info)
    }
    fn herdr_answering(agent: &'static str, session: Value, info: Value) -> FakeHerdr {
        FakeHerdr::start(Arc::new(move |m, _| match m {
            "agent.get" => Ok(
                json!({"type":"agent_info","agent":{"agent":agent,"agent_session":session.clone()}}),
            ),
            "pane.process_info" => {
                Ok(json!({"type":"pane_process_info","process_info":info.clone()}))
            }
            _ => Err(("unknown".into(), m.to_string())),
        }))
    }
    fn now_line(line: String) -> String {
        line.replace(
            T0,
            &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        )
    }

    #[tokio::test]
    async fn pi_probe_follows_the_panes_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let mut started_task = task("t1", "running", true);
        started_task["startTime"] = json!(chrono::Utc::now().timestamp_millis());
        append(
            &p,
            &format!(
                "{}\n",
                tool_result("bg_run", json!({"task": started_task}), "")
            ),
        );
        let f = herdr_with(
            "pi",
            json!({"agent":"pi","kind":"path","value":p.to_str().unwrap()}),
        );
        let probe = PiProbe::new(Arc::new(LocalTransport));
        assert_eq!(probe.busy(&f.path, "w1:p2").await, Some(true));
        assert_eq!(
            probe.busy(&f.path, "w1:p2").await,
            Some(true),
            "still running"
        );
        append(
            &p,
            &format!(
                "{}\n",
                now_line(custom(
                    "background-task-notification",
                    task("t1", "completed", true)
                ))
            ),
        );
        assert_eq!(probe.busy(&f.path, "w1:p2").await, Some(false));
    }

    #[tokio::test]
    async fn pi_probe_ignores_work_older_than_pi() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        // A task from a day ago predates this test process: its pi is gone.
        let mut old = task("t1", "running", true);
        old["startTime"] = json!(chrono::Utc::now().timestamp_millis() - 86_400_000);
        append(
            &p,
            &format!("{}\n", tool_result("bg_run", json!({"task": old}), "")),
        );
        let f = herdr_with(
            "pi",
            json!({"agent":"pi","kind":"path","value":p.to_str().unwrap()}),
        );
        assert_eq!(
            PiProbe::new(Arc::new(LocalTransport))
                .busy(&f.path, "w1:p2")
                .await,
            Some(false)
        );
    }

    #[tokio::test]
    async fn pi_probe_finds_pi_run_by_node_or_as_the_foreground_job() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let mut old = task("t1", "running", true);
        old["startTime"] = json!(chrono::Utc::now().timestamp_millis() - 86_400_000);
        append(
            &p,
            &format!("{}\n", tool_result("bg_run", json!({"task": old}), "")),
        );
        let session = json!({"agent":"pi","kind":"path","value":p.to_str().unwrap()});
        let pid = std::process::id();
        // Its age is only known from its pid: an unknown pid would leave the old task running.
        for info in [
            // pi's TUI keeps node's process name.
            json!({"foreground_processes":[{"argv":["node","/opt/node/bin/pi"],"name":"node","pid":pid}]}),
            // Running a tool: only pi's children show, in pi's own process group.
            json!({"foreground_process_group_id":pid,"foreground_processes":[{"argv":["bun","test"],"name":"bun","pid":1}]}),
        ] {
            let f = herdr_answering("pi", session.clone(), info.clone());
            assert_eq!(
                PiProbe::new(Arc::new(LocalTransport))
                    .busy(&f.path, "w1:p2")
                    .await,
                Some(false),
                "{info}"
            );
        }
    }

    #[tokio::test]
    async fn pi_probe_needs_pi_and_its_session_path() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        append(
            &p,
            &format!(
                "{}\n",
                now_line(tool_result(
                    "Agent",
                    json!({"status":"background","agentId":"x"}),
                    ""
                ))
            ),
        );
        let path = json!({"agent":"pi","kind":"path","value":p.to_str().unwrap()});
        let probe = || PiProbe::new(Arc::new(LocalTransport));
        assert_eq!(
            probe()
                .busy(&herdr_with("pi", path.clone()).path, "w1:p2")
                .await,
            Some(true)
        );
        assert_eq!(
            probe()
                .busy(&herdr_with("claude", path).path, "w1:p2")
                .await,
            Some(false)
        );
        let id_only = json!({"agent":"pi","kind":"id","value":"01a143ed"});
        assert_eq!(
            probe().busy(&herdr_with("pi", id_only).path, "w1:p2").await,
            Some(false)
        );
    }
}
