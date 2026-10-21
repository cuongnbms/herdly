//! Claude Code transcript parser.
use super::images::{decode_image, ImageSink};
use super::locate::input_summary;
use super::{
    cap_input, meta_label, truncate_result as truncate, ChatItem, ChatMeta, ImageRef, Parser, ParserOutput,
};
use serde_json::Value;

#[derive(Default)]
pub struct ClaudeParser {
    meta: ChatMeta,
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = text.find(&open)? + open.len();
    let len = text[start..].find(&format!("</{name}>"))?;
    Some(text[start..start + len].trim())
}

/// The chat text for a user record: a slash command reads as the user typed
/// it, and the CLI's own bookkeeping (command output, caveats) is dropped.
fn user_text(text: &str) -> Option<String> {
    if text.starts_with("<command-") {
        let name = tag(text, "command-name")?;
        return Some(match tag(text, "command-args").filter(|a| !a.is_empty()) {
            Some(args) => format!("{name} {args}"),
            None => name.to_string(),
        });
    }
    if text.starts_with("<local-command-") || text.starts_with("Caveat:") {
        return None;
    }
    Some(text.to_string())
}

/// The chat item for a user record's text: a `!` shell command and its
/// output get their own items, anything else reads as the user's words.
fn user_item(text: &str, ts: &Option<String>) -> Option<ChatItem> {
    if text.starts_with("<bash-input>") {
        let command = tag(text, "bash-input")?;
        return Some(ChatItem::ShellCommand {
            ts: ts.clone(),
            command: command.to_string(),
        });
    }
    if text.starts_with("<bash-stdout>") || text.starts_with("<bash-stderr>") {
        let stdout = tag(text, "bash-stdout").unwrap_or("");
        let stderr = tag(text, "bash-stderr").unwrap_or("");
        if stdout.is_empty() && stderr.is_empty() {
            return None;
        }
        return Some(ChatItem::ShellOutput {
            ts: ts.clone(),
            stdout: truncate(stdout.to_string()),
            stderr: truncate(stderr.to_string()),
        });
    }
    user_text(text).map(|text| ChatItem::User {
        id: None,
        images: vec![],
        skills: vec![],
        ts: ts.clone(),
        text,
    })
}

/// A model id from its display name, as `/model` reports it: `Sonnet 5.5` → `claude-sonnet-5-5`.
/// Parenthesised notes such as `(1M context)` are dropped.
/// A message typed while the agent is mid-turn is recorded as a
/// `queued_command` attachment, not a user record: rewrite it as the user
/// record it stands for. Other queued prompts (a subagent's hand-back, a task
/// notification) are not the user's words.
fn queued_prompt(v: &Value) -> Option<Value> {
    let a = v.get("attachment")?;
    let human = a.get("type")?.as_str()? == "queued_command"
        && a.get("commandMode").and_then(Value::as_str) == Some("prompt")
        && a.get("origin")
            .and_then(|o| o.get("kind"))
            .and_then(Value::as_str)
            == Some("human");
    human.then(|| {
        serde_json::json!({
            "type": "user",
            "uuid": v.get("uuid"),
            "timestamp": v.get("timestamp"),
            "isSidechain": v.get("isSidechain"),
            "message": {"content": a.get("prompt")},
        })
    })
}

fn model_id(display: &str) -> Option<String> {
    let name = display.split(" (").next()?.trim();
    if name.is_empty() {
        return None;
    }
    let slug = name.to_lowercase().replace([' ', '.'], "-");
    meta_label(&format!("claude-{slug}"))
}

impl ClaudeParser {
    /// `/model` and `/effort` take effect before the next reply, so read them from the
    /// command's output instead of waiting for the next assistant record.
    fn read_command_output(&mut self, text: &str) {
        let Some(out) = tag(text, "local-command-stdout") else {
            return;
        };
        if let Some(rest) = out.strip_prefix("Set model to `") {
            if let Some(model) = rest.split('`').next().and_then(model_id) {
                self.meta.model = Some(model);
            }
        } else if let Some(rest) = out.strip_prefix("Set effort level to ") {
            if let Some(effort) = rest.split_whitespace().next().and_then(meta_label) {
                self.meta.effort = Some(effort);
            }
        }
    }
}

impl Parser for ClaudeParser {
    fn push_line(&mut self, line: &str, images: &mut dyn ImageSink) -> ParserOutput {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => queued_prompt(&v).unwrap_or(v),
            Err(e) => {
                tracing::debug!("skipping non-JSON transcript line: {e}");
                return ParserOutput::None;
            }
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(kind, "user" | "assistant") {
            tracing::trace!(
                record_type = kind,
                "skipping transcript record: unknown type"
            );
            return ParserOutput::None;
        }
        if let Some(reason) = ["isMeta", "isSidechain", "isCompactSummary"]
            .into_iter()
            .find(|k| flag(&v, k))
        {
            tracing::trace!(record_type = kind, reason, "skipping transcript record");
            return ParserOutput::None;
        }
        if kind == "assistant" {
            let model = v
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(Value::as_str)
                .and_then(meta_label);
            if model.is_some() {
                self.meta.model = model;
            }
            let effort = v.get("effort").and_then(Value::as_str).and_then(meta_label);
            if effort.is_some() {
                self.meta.effort = effort;
            }
            if let Some(n) = context_tokens(v.get("message").and_then(|m| m.get("usage"))) {
                self.meta.context_tokens = Some(n);
            }
        }
        let ts = v
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        let content = v.get("message").and_then(|m| m.get("content"));
        // The CLI's own prompts to the agent (a background task finishing)
        // are not the user's words: show their summary as a system line.
        if v.get("promptSource").and_then(Value::as_str) == Some("system") {
            return match content
                .and_then(Value::as_str)
                .and_then(|s| tag(s, "summary"))
            {
                Some(text) => ParserOutput::Append(vec![ChatItem::System {
                    ts: ts.clone(),
                    text: text.to_string(),
                }]),
                None => ParserOutput::None,
            };
        }
        let mut items = vec![];
        match content {
            Some(Value::String(s)) if kind == "user" => {
                self.read_command_output(s);
                items.extend(user_item(s, &ts));
            }
            Some(Value::Array(blocks)) => {
                let uuid = v.get("uuid").and_then(Value::as_str);
                let mut refs = vec![];
                for (index, b) in blocks.iter().enumerate() {
                    let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
                    match (kind, bt) {
                        ("user", "text") => items.extend(
                            b.get("text")
                                .and_then(Value::as_str)
                                .and_then(|t| user_item(t, &ts)),
                        ),
                        ("user", "tool_result") => items.push(ChatItem::ToolResult {
                            images: vec![],
                            ts: ts.clone(),
                            call_id: b
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            output: truncate(result_text(b.get("content"))),
                            is_error: flag(b, "is_error"),
                        }),
                        ("assistant", "text") => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                items.push(ChatItem::AssistantText {
                                    ts: ts.clone(),
                                    markdown: t.to_string(),
                                });
                            }
                        }
                        ("assistant", "thinking") => {
                            if let Some(t) = b.get("thinking").and_then(Value::as_str) {
                                items.push(ChatItem::Thinking {
                                    ts: ts.clone(),
                                    text: t.to_string(),
                                });
                            }
                        }
                        ("assistant", "tool_use") => {
                            let name = b
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let input = b.get("input").cloned().unwrap_or(Value::Null);
                            items.push(ChatItem::ToolCall {
                                ts: ts.clone(),
                                id: b
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                input_summary: input_summary(&name, &input),
                                name,
                                input: cap_input(input),
                            });
                        }
                        ("user", "image") => {
                            let source = b.get("source");
                            let field =
                                |k: &str| source.and_then(|s| s.get(k)).and_then(Value::as_str);
                            if let (Some(uuid), Some("base64"), Some(media_type), Some(data)) =
                                (uuid, field("type"), field("media_type"), field("data"))
                            {
                                if let Some(bytes) = decode_image(media_type, data) {
                                    let reference = format!("{uuid}:{index}");
                                    images.put(reference.clone(), media_type.to_string(), bytes);
                                    refs.push(ImageRef {
                                        reference,
                                        media_type: media_type.to_string(),
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
                if !refs.is_empty() {
                    match items
                        .iter_mut()
                        .find(|i| matches!(i, ChatItem::User { .. }))
                    {
                        Some(ChatItem::User { images, .. }) => *images = refs,
                        _ => items.insert(
                            0,
                            ChatItem::User {
                                id: None,
                                ts: ts.clone(),
                                text: String::new(),
                                images: refs,
                                skills: vec![],
                            },
                        ),
                    }
                }
            }
            _ => {}
        }
        if let Some(uuid) = v.get("uuid").and_then(Value::as_str) {
            for item in &mut items {
                if let ChatItem::User { id, .. } = item {
                    *id = Some(uuid.to_string());
                }
            }
        }
        if items.is_empty() {
            ParserOutput::None
        } else {
            ParserOutput::Append(items)
        }
    }

    fn meta(&self) -> ChatMeta {
        self.meta.clone()
    }
}

/// A reply's whole context: the prompt (fresh, cached and newly cached) plus its output.
/// None when the usage is missing or all zero, as on a synthetic reply.
fn context_tokens(usage: Option<&Value>) -> Option<u64> {
    let usage = usage?;
    let n: u64 = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "output_tokens",
    ]
    .iter()
    .filter_map(|k| usage.get(*k).and_then(Value::as_u64))
    .sum();
    (n > 0).then_some(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::{ChatItem::*, Parser, ParserOutput};
    #[test]
    fn a_user_item_carries_its_line_uuid() {
        let items = run(r#"{"type":"user","uuid":"u9","message":{"content":"hello"}}"#);
        assert!(matches!(&items[0], ChatItem::User { id: Some(id), text, .. } if id == "u9" && text == "hello"));
        let items = run(r#"{"type":"user","uuid":"u8","message":{"content":[{"type":"text","text":"hi"}]}}"#);
        assert!(matches!(&items[0], ChatItem::User { id: Some(id), .. } if id == "u8"));
    }

    #[test]
    fn caps_a_huge_write_but_summarises_the_whole_input() {
        let content = "x".repeat(1024 * 1024);
        let line = serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Write","input":{"file_path":"/src/a.rs","content":content}}]}}).to_string();
        let full = input_summary("Write", &serde_json::json!({"file_path":"/src/a.rs","content":content}));
        match ClaudeParser::default().push_line(&line, &mut Vec::<(String, String, Vec<u8>)>::new()) {
            ParserOutput::Append(v) => match &v[0] {
                ChatItem::ToolCall { input, input_summary, .. } => {
                    assert!(input["content"].as_str().unwrap().len() < 70 * 1024);
                    assert_eq!(input_summary, &full);
                }
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
    }
    fn run(text: &str) -> Vec<ChatItem> {
        let mut p = ClaudeParser::default();
        let mut out = vec![];
        for l in text.lines() {
            if let ParserOutput::Append(v) =
                p.push_line(l, &mut Vec::<(String, String, Vec<u8>)>::new())
            {
                out.extend(v)
            }
        }
        out
    }
    #[test]
    fn parses_fixture() {
        let items = run(include_str!("../../tests/fixtures/claude.jsonl"));
        assert_eq!(
            items,
            vec![
                User {
                    id: Some("u1".into()),
                    images: vec![],
                    skills: vec![],
                    ts: None,
                    text: "list files".into()
                },
                Thinking {
                    ts: None,
                    text: "need ls".into()
                },
                AssistantText {
                    ts: None,
                    markdown: "Listing **now**.".into()
                },
                ToolCall {
                    ts: None,
                    id: "toolu_1".into(),
                    name: "Bash".into(),
                    input_summary: "ls".into(),
                    input: serde_json::json!({"command":"ls","description":"list"})
                },
                ToolResult {
                    images: vec![],
                    ts: None,
                    call_id: "toolu_1".into(),
                    output: "a.txt\nb.txt".into(),
                    is_error: false
                },
                ToolResult {
                    images: vec![],
                    ts: None,
                    call_id: "toolu_2".into(),
                    output: "boom".into(),
                    is_error: true
                },
                User {
                    id: None,
                    images: vec![],
                    skills: vec![],
                    ts: None,
                    text: "/clear".into()
                },
                AssistantText {
                    ts: None,
                    markdown: "Done.".into()
                },
            ]
        );
    }
    #[test]
    fn skips_garbage_lines() {
        let items = run("{\"type\":\"user\",\"message\":{\"content\":\"a\"}}\n\u{FFFD}\u{FFFD}garbage\n{\"type\":\"user\",\"message\":{\"content\":\"b\"}");
        assert_eq!(
            items,
            vec![User {
                id: None,
                images: vec![],
                skills: vec![],
                ts: None,
                text: "a".into()
            }]
        );
        let more = run("{\"type\":\"user\",\"message\":{\"content\":\"b\"}}");
        assert_eq!(
            more,
            vec![User {
                id: None,
                images: vec![],
                skills: vec![],
                ts: None,
                text: "b".into()
            }]
        );
    }
    #[test]
    fn shows_slash_commands_as_user_text() {
        let line = serde_json::json!({"type":"user","message":{"content":"<command-message>working-time</command-message>\n<command-name>/working-time</command-name>\n<command-args>last 1 day</command-args>"}}).to_string();
        assert_eq!(
            run(&line),
            vec![User {
                id: None,
                images: vec![],
                skills: vec![],
                ts: None,
                text: "/working-time last 1 day".into()
            }]
        );
        let bare = serde_json::json!({"type":"user","message":{"content":"<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>"}}).to_string();
        assert_eq!(
            run(&bare),
            vec![User {
                id: None,
                images: vec![],
                skills: vec![],
                ts: None,
                text: "/clear".into()
            }]
        );
        let stdout = serde_json::json!({"type":"user","message":{"content":"<local-command-stdout></local-command-stdout>"}}).to_string();
        assert_eq!(run(&stdout), vec![]);
    }
    #[test]
    fn shows_shell_commands_and_their_output() {
        let input = serde_json::json!({"type":"user","message":{"content":"<bash-input> ls -la ~/x</bash-input>"}}).to_string();
        assert_eq!(
            run(&input),
            vec![ShellCommand {
                ts: None,
                command: "ls -la ~/x".into()
            }]
        );
        let out = serde_json::json!({"type":"user","message":{"content":"<bash-stdout>a\nb</bash-stdout><bash-stderr>oops</bash-stderr>"}}).to_string();
        assert_eq!(
            run(&out),
            vec![ShellOutput {
                ts: None,
                stdout: "a\nb".into(),
                stderr: "oops".into()
            }]
        );
        let block = serde_json::json!({"type":"user","message":{"content":[{"type":"text","text":"<bash-input>pwd</bash-input>"}]}}).to_string();
        assert_eq!(
            run(&block),
            vec![ShellCommand {
                ts: None,
                command: "pwd".into()
            }]
        );
        let empty = serde_json::json!({"type":"user","message":{"content":"<bash-stdout></bash-stdout><bash-stderr></bash-stderr>"}}).to_string();
        assert_eq!(run(&empty), vec![]);
    }
    #[test]
    fn truncates_long_shell_output() {
        let big = "x".repeat(20_000);
        let line = serde_json::json!({"type":"user","message":{"content":format!("<bash-stdout>{big}</bash-stdout><bash-stderr></bash-stderr>")}}).to_string();
        match &run(&line)[..] {
            [ShellOutput { stdout, .. }] => {
                assert!(stdout.len() < 17_000 && stdout.ends_with("(truncated)"))
            }
            other => panic!("{other:?}"),
        }
    }
    #[test]
    fn skips_system_prompts() {
        let note = serde_json::json!({"type":"user","promptSource":"system","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>\n<task-id>a1</task-id>\n<summary>Agent \"Research\" finished</summary>\n</task-notification>"}}).to_string();
        assert_eq!(
            run(&note),
            vec![System {
                ts: None,
                text: "Agent \"Research\" finished".into()
            }]
        );
        let bare = serde_json::json!({"type":"user","promptSource":"system","message":{"content":"<task-notification>\n<task-id>a1</task-id>\n</task-notification>"}}).to_string();
        assert_eq!(run(&bare), vec![]);
        let typed = serde_json::json!({"type":"user","promptSource":"typed","origin":{"kind":"human"},"message":{"content":"ok"}}).to_string();
        assert_eq!(
            run(&typed),
            vec![User {
                id: None,
                images: vec![],
                skills: vec![],
                ts: None,
                text: "ok".into()
            }]
        );
    }
    #[test]
    fn truncates_long_results() {
        let big = "x".repeat(20_000);
        let line = serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content": big}]}}).to_string();
        match &run(&line)[0] {
            ToolResult { output, .. } => {
                assert!(output.len() < 16_500);
                assert!(output.ends_with("… (truncated)"));
            }
            o => panic!("{o:?}"),
        }
    }
    #[test]
    fn truncates_on_char_boundary() {
        // 3-byte chars; 16384 is not a multiple of 3 boundary issue: 16384 % 3 == 1
        let big = "€".repeat(10_000);
        let line = serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content": big}]}}).to_string();
        match &run(&line)[0] {
            ToolResult { output, .. } => {
                assert!(output.len() < 16_500);
                assert!(output.ends_with("… (truncated)"));
            }
            o => panic!("{o:?}"),
        }
    }
    use crate::transcript::{ChatMeta, ImageRef};
    fn run_with(text: &str) -> (Vec<ChatItem>, Vec<(String, String, Vec<u8>)>, ClaudeParser) {
        let mut p = ClaudeParser::default();
        let mut sink: Vec<(String, String, Vec<u8>)> = vec![];
        let mut out = vec![];
        for l in text.lines() {
            if let ParserOutput::Append(v) = p.push_line(l, &mut sink) {
                out.extend(v)
            }
        }
        (out, sink, p)
    }
    fn png(data: &str) -> serde_json::Value {
        serde_json::json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":data}})
    }
    fn queued(prompt: serde_json::Value, kind: &str) -> String {
        serde_json::json!({"type":"attachment","uuid":"q1","timestamp":"2026-10-04T08:51:36.240Z","isSidechain":false,"attachment":{"type":"queued_command","prompt":prompt,"commandMode":"prompt","origin":{"kind":kind}}}).to_string()
    }
    #[test]
    fn shows_messages_sent_mid_turn() {
        let (items, _, _) = run_with(&queued("ssh lên demo2 để check".into(), "human"));
        assert_eq!(
            items,
            vec![User {
                id: Some("q1".into()),
                ts: Some("2026-10-04T08:51:36.240Z".into()),
                text: "ssh lên demo2 để check".into(),
                skills: vec![],
                images: vec![],
            }]
        );
        let with_image = queued(
            serde_json::json!([{"type":"text","text":"[Image #1] look"}, png("AQID")]),
            "human",
        );
        let (items, sink, _) = run_with(&with_image);
        assert_eq!(
            items,
            vec![User {
                id: Some("q1".into()),
                ts: Some("2026-10-04T08:51:36.240Z".into()),
                text: "[Image #1] look".into(),
                skills: vec![],
                images: vec![ImageRef {
                    reference: "q1:1".into(),
                    media_type: "image/png".into()
                }],
            }]
        );
        assert_eq!(sink.len(), 1);
        // A subagent's hand-back rides the same queue but is not the user's words.
        assert_eq!(
            run(&queued(
                "<agent-message>done</agent-message>".into(),
                "peer"
            )),
            vec![]
        );
    }
    #[test]
    fn image_beside_text_attaches_to_the_user_item() {
        let line = serde_json::json!({"type":"user","uuid":"u1","message":{"content":[png("AQID"),{"type":"text","text":"look"}]}}).to_string();
        let (items, sink, _) = run_with(&line);
        assert_eq!(
            items,
            vec![User {
                id: Some("u1".into()),
                ts: None,
                text: "look".into(),
                skills: vec![],
                images: vec![ImageRef {
                    reference: "u1:0".into(),
                    media_type: "image/png".into()
                }],
            }]
        );
        assert_eq!(
            sink,
            vec![("u1:0".to_string(), "image/png".to_string(), vec![1, 2, 3])]
        );
    }
    #[test]
    fn image_only_record_gets_an_empty_user_item() {
        let line = serde_json::json!({"type":"user","uuid":"u2","message":{"content":[
            {"type":"image","source":{"type":"base64","media_type":"image/svg+xml","data":"AQID"}},
            png("not base64!"),
            png("AQID")
        ]}})
        .to_string();
        let (items, sink, _) = run_with(&line);
        assert_eq!(
            items,
            vec![User {
                id: Some("u2".into()),
                ts: None,
                text: "".into(),
                skills: vec![],
                images: vec![ImageRef {
                    reference: "u2:2".into(),
                    media_type: "image/png".into()
                }],
            }]
        );
        assert_eq!(sink.len(), 1);
    }
    #[test]
    fn no_uuid_no_images() {
        let line = serde_json::json!({"type":"user","message":{"content":[png("AQID"),{"type":"text","text":"x"}]}}).to_string();
        let (items, sink, _) = run_with(&line);
        assert_eq!(
            items,
            vec![User {
                id: None,
                ts: None,
                text: "x".into(),
                images: vec![],
                skills: vec![]
            }]
        );
        assert!(sink.is_empty());
    }
    #[test]
    fn string_content_unchanged() {
        let (items, sink, _) =
            run_with(r#"{"type":"user","uuid":"u3","message":{"content":"plain"}}"#);
        assert_eq!(
            items,
            vec![User {
                id: Some("u3".into()),
                ts: None,
                text: "plain".into(),
                images: vec![],
                skills: vec![]
            }]
        );
        assert!(sink.is_empty());
    }
    #[test]
    fn reads_model_and_effort_last_wins() {
        let lines = [
            serde_json::json!({"type":"assistant","effort":"medium","message":{"model":"claude-haiku-4-5","content":[]}}),
            serde_json::json!({"type":"assistant","effort":"high","message":{"model":"claude-opus-5-5","content":[]}}),
            serde_json::json!({"type":"assistant","message":{"model":"<synthetic>","content":[]}}),
            serde_json::json!({"type":"assistant","isSidechain":true,"effort":"low","message":{"model":"claude-sonnet-5-5","content":[]}}),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let (_, _, p) = run_with(&lines);
        assert_eq!(
            p.meta(),
            ChatMeta {
                model: Some("claude-opus-5-5".into()),
                effort: Some("high".into()),
                context_tokens: None,
            }
        );
    }
    #[test]
    fn reads_context_tokens_from_the_last_main_thread_usage() {
        let lines = [
            serde_json::json!({"type":"assistant","message":{"model":"claude-opus-5-5","content":[],"usage":{"input_tokens":1,"cache_read_input_tokens":100,"output_tokens":5}}}),
            serde_json::json!({"type":"assistant","message":{"model":"claude-opus-5-5","content":[],"usage":{"input_tokens":2,"cache_creation_input_tokens":20,"cache_read_input_tokens":300,"output_tokens":7}}}),
            serde_json::json!({"type":"assistant","isSidechain":true,"message":{"model":"claude-haiku-4-5","content":[],"usage":{"input_tokens":9000,"output_tokens":1}}}),
            serde_json::json!({"type":"assistant","message":{"model":"<synthetic>","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let (_, _, p) = run_with(&lines);
        assert_eq!(p.meta().context_tokens, Some(329));
    }
    #[test]
    fn reads_model_and_effort_from_slash_command_output() {
        let lines = [
            serde_json::json!({"type":"assistant","effort":"medium","message":{"model":"claude-opus-5-5","content":[]}}),
            serde_json::json!({"type":"user","message":{"content":"<local-command-stdout>Set model to `Sonnet 5.5` and saved as your default for new sessions</local-command-stdout>"}}),
            serde_json::json!({"type":"user","message":{"content":"<local-command-stdout>Set effort level to xhigh (saved as your default for new sessions): Deeper reasoning than high, just below maximum (on supported models)</local-command-stdout>"}}),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let (items, _, p) = run_with(&lines);
        assert_eq!(items, vec![]);
        assert_eq!(
            p.meta(),
            ChatMeta {
                model: Some("claude-sonnet-5-5".into()),
                effort: Some("xhigh".into()),
                context_tokens: None,
            }
        );
    }
    #[test]
    fn model_ids_from_display_names() {
        assert_eq!(model_id("Fable 5.1").as_deref(), Some("claude-fable-5-1"));
        assert_eq!(
            model_id("Opus 5 (1M context) (default)").as_deref(),
            Some("claude-opus-5")
        );
        assert_eq!(model_id("Haiku 4.5").as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(model_id(""), None);
    }
    #[test]
    fn no_effort_field_leaves_it_unset() {
        let (_, _, p) = run_with(&serde_json::json!({"type":"assistant","message":{"model":"claude-opus-5-5","content":[]}}).to_string());
        assert_eq!(
            p.meta(),
            ChatMeta {
                model: Some("claude-opus-5-5".into()),
                ..Default::default()
            }
        );
    }
    #[test]
    fn stamps_items_with_the_record_timestamp() {
        let ts = "2026-10-03T00:49:32.966Z";
        let line = serde_json::json!({"type":"assistant","timestamp":ts,"message":{"content":[{"type":"text","text":"a"},{"type":"tool_use","id":"t","name":"Bash","input":{"command":"ls"}}]}}).to_string();
        let items = run(&line);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|i| i.ts() == Some(ts)), "{items:?}");
        let bare = run("{\"type\":\"user\",\"message\":{\"content\":\"a\"}}");
        assert_eq!(bare[0].ts(), None);
    }
}
