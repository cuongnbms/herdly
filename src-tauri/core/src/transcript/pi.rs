//! pi transcript parser: entries form a tree; the visible conversation is the branch from
//! the last entry up to the root.
use super::images::{decode_image, ImageSink};
use super::locate::input_summary;
use super::skill_prompt::parse_skill_prompt;
use super::{cap_input, meta_label, truncate_result, ChatItem, ChatMeta, ImageRef, Parser, ParserOutput};
use serde_json::Value;
use std::collections::HashMap;

const MAX_BRANCH_BYTES: usize = 64 * 1024 * 1024;
const TOO_LARGE: &str = "Conversation too large to show; use the Terminal lens.";

/// What is kept per entry: just enough to rebuild a branch.
struct Entry {
    parent: Option<String>,
    items: Vec<ChatItem>,
    len: usize,
}

pub struct PiParser {
    entries: HashMap<String, Entry>,
    leaf: Option<String>,
    /// Sum of line lengths along the visible branch.
    branch_bytes: usize,
    limit: usize,
    too_large: bool,
    meta: ChatMeta,
}

impl Default for PiParser {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            leaf: None,
            branch_bytes: 0,
            limit: MAX_BRANCH_BYTES,
            too_large: false,
            meta: ChatMeta::default(),
        }
    }
}

impl PiParser {
    #[cfg(test)]
    fn with_limit(limit: usize) -> Self {
        Self {
            limit,
            ..Self::default()
        }
    }

    /// Track the latest Model, Reasoning effort and context size, in file order whatever the branch.
    fn read_meta(&mut self, v: &Value) {
        let label = |x: Option<&Value>| x.and_then(Value::as_str).and_then(meta_label);
        match v.get("type").and_then(Value::as_str) {
            Some("model_change") => {
                if let Some(m) = label(v.get("modelId")).or_else(|| label(v.get("model"))) {
                    self.meta.model = Some(m);
                }
            }
            Some("thinking_level_change") => {
                if let Some(e) = label(v.get("thinkingLevel")) {
                    self.meta.effort = Some(e);
                }
            }
            Some("message") => {
                let msg = v.get("message");
                if msg.and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant") {
                    if let Some(m) = label(msg.and_then(|m| m.get("model"))) {
                        self.meta.model = Some(m);
                    }
                    // A failed reply reports all zeros: keep the last real count.
                    let total = msg
                        .and_then(|m| m.get("usage"))
                        .and_then(|u| u.get("totalTokens"))
                        .and_then(Value::as_u64);
                    if let Some(n) = total.filter(|&n| n > 0) {
                        self.meta.context_tokens = Some(n);
                    }
                }
            }
            _ => {}
        }
    }

    fn trip(&mut self) -> ParserOutput {
        self.too_large = true;
        self.entries.clear();
        ParserOutput::Reset(vec![ChatItem::System {
            ts: None,
            text: TOO_LARGE.to_string(),
        }])
    }
}

fn str_of<'a>(v: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .unwrap_or("")
}

fn text_blocks(content: Option<&Value>) -> Vec<String> {
    match content {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str).map(str::to_string))
            .collect(),
        _ => vec![],
    }
}

/// Decode the image blocks of one message, store their bytes in the sink and return the
/// refs. A ref is `<entry id>:<n>`, with n counting the kept images from 0.
fn image_refs(entry_id: &str, content: Option<&Value>, sink: &mut dyn ImageSink) -> Vec<ImageRef> {
    let Some(Value::Array(blocks)) = content else {
        return vec![];
    };
    let mut refs = vec![];
    for b in blocks {
        if b.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let media_type = str_of(b, &["mimeType", "media_type"]);
        let Some(bytes) = decode_image(media_type, str_of(b, &["data"])) else {
            continue;
        };
        let reference = format!("{entry_id}:{}", refs.len());
        sink.put(reference.clone(), media_type.to_string(), bytes);
        refs.push(ImageRef {
            reference,
            media_type: media_type.to_string(),
        });
    }
    refs
}

fn message_items(entry_id: &str, entry: &Value, sink: &mut dyn ImageSink) -> Vec<ChatItem> {
    let Some(msg) = entry.get("message") else {
        return vec![];
    };
    let hidden = |v: &Value| v.get("display").and_then(Value::as_bool) == Some(false);
    if hidden(entry) || hidden(msg) {
        return vec![];
    }
    let ts = entry
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string);
    let content = msg.get("content");
    match msg.get("role").and_then(Value::as_str).unwrap_or("") {
        "user" => {
            let mut items: Vec<ChatItem> = text_blocks(content)
                .into_iter()
                .map(|text| {
                    let (text, skills) = match parse_skill_prompt(&text) {
                        Some((skills, request)) if !request.is_empty() => (request, skills),
                        Some((skills, _)) => {
                            let fallback = skills
                                .iter()
                                .map(|s| format!("/skill:{}", s.name))
                                .collect::<Vec<_>>()
                                .join(" ");
                            (fallback, skills)
                        }
                        None => (text, vec![]),
                    };
                    ChatItem::User {
                        id: Some(entry_id.to_string()),
                        images: vec![],
                        skills,
                        ts: ts.clone(),
                        text,
                    }
                })
                .collect();
            let refs = image_refs(entry_id, content, sink);
            if !refs.is_empty() {
                match items.first_mut() {
                    Some(ChatItem::User { images, .. }) => *images = refs,
                    _ => items.insert(
                        0,
                        ChatItem::User {
                            id: Some(entry_id.to_string()),
                            images: refs,
                            skills: vec![],
                            ts: ts.clone(),
                            text: String::new(),
                        },
                    ),
                }
            }
            items
        }
        "assistant" => {
            let mut items = vec![];
            let Some(Value::Array(blocks)) = content else {
                return items;
            };
            for b in blocks {
                match b.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            items.push(ChatItem::AssistantText {
                                ts: ts.clone(),
                                markdown: t.to_string(),
                            });
                        }
                    }
                    "thinking" => {
                        if let Some(t) = b.get("thinking").and_then(Value::as_str) {
                            items.push(ChatItem::Thinking {
                                ts: ts.clone(),
                                text: t.to_string(),
                            });
                        }
                    }
                    "toolCall" => {
                        let name = str_of(b, &["toolName", "name"]).to_string();
                        let input = ["toolInput", "input", "arguments"]
                            .iter()
                            .find_map(|k| b.get(*k))
                            .cloned()
                            .unwrap_or(Value::Null);
                        items.push(ChatItem::ToolCall {
                            ts: ts.clone(),
                            id: str_of(b, &["toolCallId", "id", "callId"]).to_string(),
                            input_summary: input_summary(&name, &input),
                            name,
                            input: cap_input(input),
                        });
                    }
                    _ => {}
                }
            }
            items
        }
        "toolResult" => vec![ChatItem::ToolResult {
            images: image_refs(entry_id, content, sink),
            ts: ts.clone(),
            call_id: str_of(msg, &["toolCallId", "callId"]).to_string(),
            output: truncate_result(text_blocks(content).join("\n")),
            is_error: msg.get("isError").and_then(Value::as_bool).unwrap_or(false),
        }],
        _ => vec![],
    }
}

impl Parser for PiParser {
    fn push_line(&mut self, line: &str, images: &mut dyn ImageSink) -> ParserOutput {
        if self.too_large {
            return ParserOutput::None;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("skipping non-JSON transcript line: {e}");
                return ParserOutput::None;
            }
        };
        let Some(id) = v.get("id").and_then(Value::as_str).map(str::to_string) else {
            let record_type = str_of(&v, &["type"]);
            tracing::trace!(record_type, "skipping transcript entry without id");
            return ParserOutput::None;
        };
        let parent = v
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_string);
        self.read_meta(&v);
        let is_message = v.get("type").and_then(Value::as_str) == Some("message");
        let items = if is_message {
            message_items(&id, &v, images)
        } else {
            vec![]
        };
        if items.is_empty() {
            tracing::trace!(entry_id = id.as_str(), "transcript entry produces no items");
        }
        let len = line.len();

        let extends_leaf = match (&self.leaf, &parent) {
            (Some(leaf), Some(p)) => leaf == p,
            (None, None) => true,
            _ => false,
        };
        let appended = items.clone();
        if let Some(old) = self
            .entries
            .insert(id.clone(), Entry { parent, items, len })
        {
            tracing::trace!(
                entry_id = id.as_str(),
                old_len = old.len,
                "duplicate entry id replaced"
            );
        }
        self.leaf = Some(id.clone());

        if extends_leaf {
            self.branch_bytes += len;
            if self.branch_bytes > self.limit {
                return self.trip();
            }
            return if appended.is_empty() {
                ParserOutput::None
            } else {
                ParserOutput::Append(appended)
            };
        }

        // Branch switch (or unknown parent): rebuild the path from the new leaf to the root.
        let mut path = vec![];
        let mut bytes = 0usize;
        let mut cursor = Some(id);
        while let Some(cur) = cursor {
            let Some(entry) = self.entries.get(&cur) else {
                break;
            };
            if path.len() > self.entries.len() {
                break; // cycle guard
            }
            bytes += entry.len;
            path.push(entry);
            cursor = entry.parent.clone();
        }
        self.branch_bytes = bytes;
        if bytes > self.limit {
            return self.trip();
        }
        let items = path
            .iter()
            .rev()
            .flat_map(|e| e.items.iter().cloned())
            .collect();
        ParserOutput::Reset(items)
    }

    fn meta(&self) -> ChatMeta {
        self.meta.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::{ChatItem::*, ChatMeta, ImageRef, Parser, ParserOutput, SkillUse};
    fn feed(p: &mut PiParser, text: &str) -> Vec<ParserOutput> {
        text.lines()
            .map(|l| p.push_line(l, &mut Vec::<(String, String, Vec<u8>)>::new()))
            .collect()
    }
    fn appended(outs: Vec<ParserOutput>) -> Vec<ChatItem> {
        outs.into_iter()
            .flat_map(|o| match o {
                ParserOutput::Append(v) => v,
                ParserOutput::Reset(v) => v,
                ParserOutput::None => vec![],
            })
            .collect()
    }

    #[test]
    fn a_user_item_carries_its_entry_id() {
        let mut p = PiParser::default();
        let items = appended(feed(&mut p, r#"{"type":"message","id":"e1","parentId":null,"message":{"role":"user","content":"hey"}}"#));
        assert!(matches!(&items[0], ChatItem::User { id: Some(id), .. } if id == "e1"));
    }

    #[test]
    fn caps_a_huge_write_but_summarises_the_whole_input() {
        let content = "x".repeat(1024 * 1024);
        let line = serde_json::json!({"type":"message","id":"a","parentId":null,"message":{"role":"assistant","content":[{"type":"toolCall","id":"t","name":"write","arguments":{"path":"/src/a.rs","content":content}}]}}).to_string();
        let full = input_summary("write", &serde_json::json!({"path":"/src/a.rs","content":content}));
        match PiParser::default().push_line(&line, &mut Vec::<(String, String, Vec<u8>)>::new()) {
            ParserOutput::Append(v) | ParserOutput::Reset(v) => match &v[0] {
                ChatItem::ToolCall { input, input_summary, .. } => {
                    assert!(input["content"].as_str().unwrap().len() < 70 * 1024);
                    assert_eq!(input_summary, &full);
                }
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn skill_prompt_becomes_request_and_skills() {
        let mut p = PiParser::default();
        let text = "<skill name=\"tdd\" location=\"/t/SKILL.md\">\nbody\n</skill>";
        let line = serde_json::json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":[{"type":"text","text":text}]}}).to_string();
        match p.push_line(&line, &mut Vec::<(String, String, Vec<u8>)>::new()) {
            ParserOutput::Append(v) => assert_eq!(v, vec![User {
                id: Some("a".into()),
                ts: None, text: "/skill:tdd".into(), images: vec![],
                skills: vec![SkillUse { name: "tdd".into(), path: "/t/SKILL.md".into() }],
            }]),
            o => panic!("{o:?}"),
        }
    }

    #[test]
    fn parses_linear_branch() {
        let mut p = PiParser::default();
        let items = appended(feed(&mut p, include_str!("../../tests/fixtures/pi.jsonl")));
        assert_eq!(
            items,
            vec![
                User {
                    id: Some("a".into()),
                    images: vec![],
                    skills: vec![],
                    ts: None,
                    text: "hi".into()
                },
                Thinking {
                    ts: None,
                    text: "greet".into()
                },
                AssistantText {
                    ts: None,
                    markdown: "Hello!".into()
                },
                ToolCall {
                    ts: None,
                    id: "c1".into(),
                    name: "bash".into(),
                    input_summary: "pwd".into(),
                    input: serde_json::json!({"command":"pwd"})
                },
                ToolResult {
                    images: vec![],
                    ts: None,
                    call_id: "c1".into(),
                    output: "/w/app".into(),
                    is_error: false
                },
            ]
        );
    }
    #[test]
    fn branch_switch_resets_to_new_path() {
        let mut p = PiParser::default();
        feed(&mut p, include_str!("../../tests/fixtures/pi.jsonl"));
        let out = p.push_line(r#"{"type":"message","id":"e","parentId":"a","message":{"role":"user","content":"again"}}"#, &mut Vec::<(String, String, Vec<u8>)>::new());
        match out {
            ParserOutput::Reset(items) => assert_eq!(
                items,
                vec![
                    User {
                        id: Some("a".into()),
                        images: vec![],
                        skills: vec![],
                        ts: None,
                        text: "hi".into()
                    },
                    User {
                        id: Some("e".into()),
                        images: vec![],
                        skills: vec![],
                        ts: None,
                        text: "again".into()
                    }
                ]
            ),
            o => panic!("{o:?}"),
        }
        let next = p.push_line(r#"{"type":"message","id":"f","parentId":"e","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}"#, &mut Vec::<(String, String, Vec<u8>)>::new());
        assert!(
            matches!(next, ParserOutput::Append(v) if v == vec![AssistantText { ts: None, markdown: "ok".into() }])
        );
    }
    #[test]
    fn unknown_parent_starts_branch_there() {
        let mut p = PiParser::default();
        let out = p.push_line(r#"{"type":"message","id":"x","parentId":"gone","message":{"role":"user","content":"hey"}}"#, &mut Vec::<(String, String, Vec<u8>)>::new());
        assert!(
            matches!(out, ParserOutput::Reset(v) if v == vec![User { id: Some("x".into()), ts: None, text: "hey".into(), images: vec![], skills: vec![] }])
        );
    }
    #[test]
    fn truncates_long_results() {
        let mut p = PiParser::default();
        let big = "x".repeat(20_000);
        let line = serde_json::json!({"type":"message","id":"a","parentId":null,"message":{"role":"toolResult","toolCallId":"t","content":[{"type":"text","text":big}]}}).to_string();
        match p.push_line(&line, &mut Vec::<(String, String, Vec<u8>)>::new()) {
            ParserOutput::Append(v) => match &v[0] {
                ToolResult { output, .. } => {
                    assert!(output.len() < 16_500);
                    assert!(output.ends_with("… (truncated)"));
                }
                o => panic!("{o:?}"),
            },
            o => panic!("{o:?}"),
        }
    }
    #[test]
    fn oversize_branch_emits_system_once_then_stops() {
        let mut p = PiParser::with_limit(300);
        let l1 = r#"{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"one"}}"#;
        assert!(matches!(
            p.push_line(l1, &mut Vec::<(String, String, Vec<u8>)>::new()),
            ParserOutput::Append(_)
        ));
        let big = format!(
            r#"{{"type":"message","id":"b","parentId":"a","message":{{"role":"user","content":"{}"}}}}"#,
            "y".repeat(300)
        );
        match p.push_line(&big, &mut Vec::<(String, String, Vec<u8>)>::new()) {
            ParserOutput::Reset(v) => assert_eq!(
                v,
                vec![System {
                    ts: None,
                    text: "Conversation too large to show; use the Terminal lens.".into()
                }]
            ),
            o => panic!("{o:?}"),
        }
        assert!(matches!(
            p.push_line(l1, &mut Vec::<(String, String, Vec<u8>)>::new()),
            ParserOutput::None
        ));
    }
    #[test]
    fn stamps_items_with_the_entry_timestamp() {
        let mut p = PiParser::default();
        let line = r#"{"type":"message","id":"a","parentId":null,"timestamp":"2026-10-02T11:46:32.940Z","message":{"role":"user","content":"hi","timestamp":1790941592936}}"#;
        match p.push_line(line, &mut Vec::<(String, String, Vec<u8>)>::new()) {
            ParserOutput::Append(v) => assert_eq!(v[0].ts(), Some("2026-10-02T11:46:32.940Z")),
            o => panic!("{o:?}"),
        }
    }

    fn img(data: &str) -> serde_json::Value {
        serde_json::json!({"type":"image","mimeType":"image/png","data":data})
    }
    #[test]
    fn images_in_user_and_tool_result() {
        let mut p = PiParser::default();
        let mut sink: Vec<(String, String, Vec<u8>)> = vec![];
        let lines = [
            serde_json::json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"see"},img("AQID")]}}),
            serde_json::json!({"type":"message","id":"b","parentId":"a","message":{"role":"toolResult","toolCallId":"c1","content":[{"type":"text","text":"read"},{"type":"image","media_type":"image/jpeg","data":"AQID"},img("AQID")]}}),
            serde_json::json!({"type":"message","id":"c","parentId":"b","message":{"role":"user","content":[img("AQID")]}}),
        ];
        let items = appended(
            lines
                .iter()
                .map(|l| p.push_line(&l.to_string(), &mut sink))
                .collect(),
        );
        let r = |s: &str, t: &str| ImageRef {
            reference: s.into(),
            media_type: t.into(),
        };
        assert_eq!(
            items,
            vec![
                User {
                    id: Some("a".into()),
                    ts: None,
                    text: "see".into(),
                    skills: vec![],
                    images: vec![r("a:0", "image/png")]
                },
                ToolResult {
                    ts: None,
                    call_id: "c1".into(),
                    output: "read".into(),
                    is_error: false,
                    images: vec![r("b:0", "image/jpeg"), r("b:1", "image/png")]
                },
                User {
                    id: Some("c".into()),
                    ts: None,
                    text: "".into(),
                    skills: vec![],
                    images: vec![r("c:0", "image/png")]
                },
            ]
        );
        assert_eq!(sink.len(), 4);
    }
    #[test]
    fn refs_survive_branch_rebuild() {
        let mut p = PiParser::default();
        let mut sink: Vec<(String, String, Vec<u8>)> = vec![];
        p.push_line(&serde_json::json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"},img("AQID")]}}).to_string(), &mut sink);
        p.push_line(r#"{"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}"#, &mut sink);
        match p.push_line(r#"{"type":"message","id":"e","parentId":"a","message":{"role":"user","content":"again"}}"#, &mut sink) {
            ParserOutput::Reset(items) => assert!(
                matches!(&items[0], User { images, .. } if images[0].reference == "a:0")
            ),
            o => panic!("{o:?}"),
        }
    }
    #[test]
    fn reads_model_and_thinking_level() {
        let mut p = PiParser::default();
        let mut sink: Vec<(String, String, Vec<u8>)> = vec![];
        for l in [
            r#"{"type":"model_change","id":"m1","parentId":null,"provider":"anthropic","modelId":"claude-sonnet-5-5"}"#,
            r#"{"type":"thinking_level_change","id":"t1","parentId":"m1","thinkingLevel":"off"}"#,
            r#"{"type":"message","id":"a","parentId":"t1","message":{"role":"assistant","model":"gpt-5","content":[],"usage":{"input":241,"output":119,"cacheRead":82560,"totalTokens":82920}}}"#,
            r#"{"type":"message","id":"b","parentId":"a","message":{"role":"assistant","model":"gpt-5","content":[],"usage":{"input":0,"output":0,"totalTokens":0}}}"#,
            r#"{"type":"model_change","id":"m2","parentId":"a","modelId":"<none>"}"#,
        ] {
            p.push_line(l, &mut sink);
        }
        assert_eq!(
            p.meta(),
            ChatMeta {
                model: Some("gpt-5".into()),
                effort: Some("off".into()),
                context_tokens: Some(82920),
            }
        );
    }
}
