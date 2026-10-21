//! Transcript discovery and streaming: find an agent's JSONL transcript on a Machine and
//! tail it into chat items.
pub mod btw;
pub mod claude;
pub mod fork;
pub mod images;
pub mod locate;
pub mod pi;
mod skill_prompt;
pub mod tail;

use crate::error::AppError;
use crate::transport::Transport;
use crate::view::PaneRef;
use images::ImageSink;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use locate::{locate, Located};
pub use tail::{resume_tail, spawn_tail, FrozenSlot, Kept, Sink, TailHandle};

/// An image attached to a chat item; its bytes are fetched by `reference`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ImageRef {
    #[serde(rename = "ref")]
    pub reference: String,
    pub media_type: String,
}

/// A Skill the user invoked in a message.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SkillUse {
    pub name: String,
    pub path: String,
}

/// The Model, Reasoning effort and context size an Agent reports in its Transcript.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ChatMeta {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Tokens the last main-thread reply took in and gave out: how full the context is.
    pub context_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatItem {
    User {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        text: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        skills: Vec<SkillUse>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    AssistantText {
        markdown: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    Thinking {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    ToolCall {
        id: String,
        name: String,
        input_summary: String,
        input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    ToolResult {
        call_id: String,
        output: String,
        is_error: bool,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    System {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    /// A command the user ran in the agent's own shell (Claude Code's `!`).
    ShellCommand {
        command: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    ShellOutput {
        stdout: String,
        stderr: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
}

impl ChatItem {
    /// When the transcript record that produced this item was written (ISO 8601), if it says.
    pub fn ts(&self) -> Option<&str> {
        match self {
            ChatItem::User { ts, .. }
            | ChatItem::AssistantText { ts, .. }
            | ChatItem::Thinking { ts, .. }
            | ChatItem::ToolCall { ts, .. }
            | ChatItem::ToolResult { ts, .. }
            | ChatItem::System { ts, .. }
            | ChatItem::ShellCommand { ts, .. }
            | ChatItem::ShellOutput { ts, .. } => ts.as_deref(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    Reset {
        items: Vec<ChatItem>,
        total: usize,
    },
    Append {
        items: Vec<ChatItem>,
    },
    Error {
        error: AppError,
    },
    Meta {
        model: Option<String>,
        effort: Option<String>,
        context_tokens: Option<u64>,
    },
}

#[derive(Debug)]
pub enum ParserOutput {
    None,
    Append(Vec<ChatItem>),
    Reset(Vec<ChatItem>),
}

pub trait Parser: Send {
    fn push_line(&mut self, line: &str, images: &mut dyn ImageSink) -> ParserOutput;
    /// The latest Model, Reasoning effort and context size seen so far.
    fn meta(&self) -> ChatMeta {
        ChatMeta::default()
    }
}

/// A Model or Reasoning effort value fit to show: not empty, at most 100 chars, not a
/// `<placeholder>`.
pub(crate) fn meta_label(s: &str) -> Option<String> {
    if s.is_empty() || s.chars().count() > 100 || s.starts_with('<') {
        None
    } else {
        Some(s.to_string())
    }
}

const MAX_RESULT_BYTES: usize = 16 * 1024;
pub(crate) const MAX_INPUT_STRING_BYTES: usize = 64 * 1024;

/// Cuts `s` to at most `max` bytes on a char boundary, marking the cut.
fn cut(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &s[..end])
}

/// Truncates a tool result to at most 16 KiB on a char boundary, marking the cut.
pub(crate) fn truncate_result(s: String) -> String {
    cut(s, MAX_RESULT_BYTES)
}

/// Caps every string in a tool input at 64 KiB, keeping all fields, so a huge Write
/// or Edit can't bloat the Chat.
pub(crate) fn cap_input(v: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::String(s) => Value::String(cut(s, MAX_INPUT_STRING_BYTES)),
        Value::Array(a) => Value::Array(a.into_iter().map(cap_input).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, cap_input(v))).collect()),
        other => other,
    }
}

/// The transcript parser for an agent.
pub fn parser_for(agent: &str) -> Option<Box<dyn Parser>> {
    match agent {
        "claude" => Some(Box::new(claude::ClaudeParser::default())),
        "pi" => Some(Box::new(pi::PiParser::default())),
        _ => None,
    }
}

/// Closed tails kept running, so reopening skips the backlog.
pub const PARKED_TAILS: usize = 3;

/// Frozen tails kept to read on from where they stopped.
pub const FROZEN_TAILS: usize = 8;

/// How long a resume waits for a frozen tail's parse thread to hand over its state.
pub const FREEZE_WAIT: Duration = Duration::from_millis(500);

struct Entry {
    path: String,
    /// Where `path` came from, once `set_located` recorded it.
    located: Option<Located>,
    handle: TailHandle,
}

/// A stopped tail's parser, items and offset, filling `slot`.
struct Frozen {
    path: String,
    located: Option<Located>,
    slot: FrozenSlot,
}

#[derive(Default)]
struct Tails {
    open: HashMap<PaneRef, Entry>,
    /// Oldest first.
    parked: VecDeque<(PaneRef, Entry)>,
    /// Oldest first, at most one per `(pane, path)`.
    frozen: VecDeque<(PaneRef, Frozen)>,
}

/// A Machine's tails, taken out under the lock and ended after it: open, parked, frozen.
type MachineTails = (Vec<Entry>, VecDeque<(PaneRef, Entry)>, VecDeque<(PaneRef, Frozen)>);

/// One live transcript tail per open Pane, plus up to 3 parked and 8 frozen ones.
#[derive(Default)]
pub struct ChatManager {
    tails: Mutex<Tails>,
}

impl ChatManager {
    /// Registers `handle` for `pane`: a previous tail of another path is frozen, one of
    /// the same path dropped (and so killed).
    pub fn insert(&self, pane: PaneRef, path: String, handle: TailHandle) {
        let gone = {
            let mut t = self.tails.lock().unwrap();
            let mut gone: Vec<Entry> = t.open.remove(&pane).into_iter().collect();
            if let Some(i) = t.parked.iter().position(|(p, _)| p == &pane) {
                gone.extend(t.parked.remove(i).map(|(_, e)| e));
            }
            t.frozen.retain(|(p, f)| !(p == &pane && f.path == path));
            t.open.insert(
                pane.clone(),
                Entry {
                    path: path.clone(),
                    located: None,
                    handle,
                },
            );
            gone
        };
        let (same, other): (Vec<Entry>, Vec<Entry>) = gone.into_iter().partition(|e| e.path == path);
        drop(same);
        self.freeze_all(other.into_iter().map(|e| (pane.clone(), e)).collect());
    }

    /// Freezes the entries, then keeps them frozen: one per `(pane, path)`, the oldest
    /// past `FROZEN_TAILS` dropped.
    fn freeze_all(&self, gone: Vec<(PaneRef, Entry)>) {
        let frozen: Vec<(PaneRef, Frozen)> = gone
            .into_iter()
            .map(|(pane, e)| {
                let (path, located) = (e.path, e.located);
                (
                    pane,
                    Frozen {
                        path,
                        located,
                        slot: e.handle.freeze(),
                    },
                )
            })
            .collect();
        let dropped: Vec<(PaneRef, Frozen)> = {
            let mut t = self.tails.lock().unwrap();
            let mut dropped = Vec::new();
            for (pane, f) in frozen {
                if let Some(i) = t.frozen.iter().position(|(p, o)| p == &pane && o.path == f.path) {
                    dropped.extend(t.frozen.remove(i));
                }
                t.frozen.push_back((pane, f));
            }
            let extra = t.frozen.len().saturating_sub(FROZEN_TAILS);
            dropped.extend(t.frozen.drain(..extra));
            dropped
        };
        drop(dropped);
    }

    /// Removes and returns the slot of the Pane's frozen tail of `path`.
    pub fn take_frozen(&self, pane: &PaneRef, path: &str) -> Option<FrozenSlot> {
        let mut t = self.tails.lock().unwrap();
        let i = t.frozen.iter().position(|(p, f)| p == pane && f.path == path)?;
        t.frozen.remove(i).map(|(_, f)| f.slot)
    }

    /// How the Pane's newest frozen tail was located, when found (not pending) and, if
    /// `path` is given, of that path.
    pub fn frozen_located(&self, pane: &PaneRef, path: Option<&str>) -> Option<Located> {
        let t = self.tails.lock().unwrap();
        t.frozen
            .iter()
            .rev()
            .filter(|(p, _)| p == pane)
            .find_map(|(_, f)| {
                f.located
                    .clone()
                    .filter(|l| !l.pending && path.is_none_or(|p| p == l.path))
            })
    }

    /// Reopens the Pane's tail onto `sink` if it is still tailing `path`; false if there
    /// is none (a stale one is frozen), and the caller must spawn a fresh tail.
    pub fn reattach(&self, pane: &PaneRef, path: &str, sink: Sink) -> bool {
        let entry = {
            let mut t = self.tails.lock().unwrap();
            match t.open.remove(pane) {
                Some(e) => Some(e),
                None => t
                    .parked
                    .iter()
                    .position(|(p, _)| p == pane)
                    .and_then(|i| t.parked.remove(i))
                    .map(|(_, e)| e),
            }
        };
        let Some(entry) = entry else { return false };
        if entry.path != path || !entry.handle.is_running() {
            self.freeze_all(vec![(pane.clone(), entry)]);
            return false;
        }
        // `attach` locks the image store, so the map lock is already released.
        entry.handle.attach(sink);
        // A concurrent insert may have filled the slot; drop that entry after the guard.
        let replaced = self.tails.lock().unwrap().open.insert(pane.clone(), entry);
        drop(replaced);
        true
    }

    /// Records how the Pane's open tail was located, when it tails `l.path`.
    pub fn set_located(&self, pane: &PaneRef, l: &Located) {
        if let Some(e) = self.tails.lock().unwrap().open.get_mut(pane) {
            if e.path == l.path {
                e.located = Some(l.clone());
            }
        }
    }

    /// Reopens the Pane's running tail onto `sink` without locating its transcript again,
    /// returning how it was located. Only a tail whose transcript was found (not pending)
    /// qualifies, and only when it tails `path`, if given. None: locate and open as usual.
    pub fn reattach_cached(
        &self,
        pane: &PaneRef,
        path: Option<&str>,
        sink: Sink,
    ) -> Option<Located> {
        let located = {
            let t = self.tails.lock().unwrap();
            let entry = t
                .open
                .get(pane)
                .or_else(|| t.parked.iter().find(|(p, _)| p == pane).map(|(_, e)| e))?;
            entry
                .located
                .clone()
                .filter(|l| !l.pending && path.is_none_or(|p| p == l.path))?
        };
        self.reattach(pane, &located.path, sink).then_some(located)
    }

    /// Opens a tail of `path` onto `sink`: reattaches the Pane's, else resumes its frozen
    /// one from where it stopped, else spawns a fresh one with `parser`. False when it spawned.
    pub async fn open_tail(&self, pane: &PaneRef, path: &str, t: Arc<dyn Transport>, parser: Box<dyn Parser>, sink: Sink) -> bool {
        if self.reattach(pane, path, sink.clone()) {
            return true;
        }
        let kept = match self.take_frozen(pane, path) {
            Some(slot) => tokio::task::spawn_blocking(move || slot.take(FREEZE_WAIT)).await.ok().flatten(),
            None => None,
        };
        let resumed = kept.is_some();
        let handle = match kept {
            Some(kept) => resume_tail(t, path.to_string(), kept, parser, sink),
            None => spawn_tail(t, path.to_string(), parser, sink),
        };
        self.insert(pane.clone(), path.to_string(), handle);
        resumed
    }

    /// Parks the Pane's tail; the oldest parked ones past `PARKED_TAILS` are frozen.
    pub fn close(&self, pane: &PaneRef) {
        let entry = self.tails.lock().unwrap().open.remove(pane);
        let Some(entry) = entry else { return };
        entry.handle.detach();
        let gone: Vec<(PaneRef, Entry)> = {
            let mut t = self.tails.lock().unwrap();
            t.parked.push_back((pane.clone(), entry));
            let extra = t.parked.len().saturating_sub(PARKED_TAILS);
            t.parked.drain(..extra).collect()
        };
        self.freeze_all(gone);
    }

    pub fn page(&self, pane: &PaneRef, before: usize, limit: usize) -> Option<Vec<ChatItem>> {
        self.tails
            .lock()
            .unwrap()
            .open
            .get(pane)
            .map(|e| e.handle.page(before, limit))
    }

    /// The bytes of the image `r` in the Pane's open chat.
    pub fn image(&self, pane: &PaneRef, r: &str) -> Result<Vec<u8>, AppError> {
        // The tail locks the store only briefly, but `tails` must still not be held
        // while locking it.
        let store = self
            .tails
            .lock()
            .unwrap()
            .open
            .get(pane)
            .map(|e| e.handle.images())
            .ok_or_else(|| AppError::new("not_found", "no open chat for this pane"))?;
        let found = store.lock().unwrap().get(r);
        found
            .map(|(_, bytes)| bytes)
            .ok_or_else(|| AppError::new("not_found", "image not available"))
    }

    /// End every tail of the Machine, open, parked or frozen (it was disconnected or removed).
    pub fn close_machine(&self, machine_id: &str) {
        let (open, parked, frozen): MachineTails = {
            let mut t = self.tails.lock().unwrap();
            let t = &mut *t;
            let keys: Vec<PaneRef> = t
                .open
                .keys()
                .filter(|p| p.machine_id == machine_id)
                .cloned()
                .collect();
            let open: Vec<Entry> = keys.into_iter().filter_map(|k| t.open.remove(&k)).collect();
            let (gone, kept) = std::mem::take(&mut t.parked)
                .into_iter()
                .partition(|(p, _)| p.machine_id == machine_id);
            t.parked = kept;
            let frozen = std::mem::take(&mut t.frozen);
            let (gone_frozen, kept_frozen) = frozen
                .into_iter()
                .partition(|(p, _)| p.machine_id == machine_id);
            t.frozen = kept_frozen;
            (open, gone, gone_frozen)
        };
        drop((open, parked, frozen));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn caps_each_input_string_and_keeps_every_field() {
        let big = format!("a{}", "é".repeat(40 * 1024)); // 80 KiB; the leading byte makes a 2-byte char straddle the cut
        let v = serde_json::json!({"file_path": "/a", "edits": [{"old_string": big, "new_string": "x"}], "n": 3});
        let out = cap_input(v);
        let old = out["edits"][0]["old_string"].as_str().unwrap();
        assert!(old.ends_with("\n… (truncated)"));
        assert!(old.len() <= MAX_INPUT_STRING_BYTES + "\n… (truncated)".len());
        assert_eq!(out["edits"][0]["new_string"], "x");
        assert_eq!(out["file_path"], "/a");
        assert_eq!(out["n"], 3);
    }

    struct NoItems;
    impl Parser for NoItems {
        fn push_line(&mut self, _: &str, _: &mut dyn ImageSink) -> ParserOutput {
            ParserOutput::None
        }
    }

    #[tokio::test]
    async fn image_lookup_through_chat_manager() {
        struct OneImage;
        impl Parser for OneImage {
            fn push_line(&mut self, _: &str, images: &mut dyn images::ImageSink) -> ParserOutput {
                images.put("u:0".into(), "image/png".into(), vec![1, 2, 3]);
                ParserOutput::None
            }
        }
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "x\n").unwrap();
        let chats = ChatManager::default();
        let pane = PaneRef {
            machine_id: "a".into(),
            session: "default".into(),
            pane_id: "w1:p1".into(),
        };
        chats.insert(
            pane.clone(),
            p.to_string_lossy().into(),
            spawn_tail(
                Arc::new(crate::transport::local::LocalTransport),
                p.to_string_lossy().into(),
                Box::new(OneImage),
                Arc::new(|_| {}),
            ),
        );
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert_eq!(chats.image(&pane, "u:0").unwrap(), vec![1, 2, 3]);
        assert_eq!(
            chats.image(&pane, "u:9").unwrap_err().message,
            "image not available"
        );
        let other = PaneRef {
            pane_id: "w1:p2".into(),
            ..pane
        };
        assert_eq!(
            chats.image(&other, "u:0").unwrap_err().message,
            "no open chat for this pane"
        );
    }

    #[tokio::test]
    async fn image_lookup_lets_go_of_the_handles_while_the_store_is_busy() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "").unwrap();
        let chats = Arc::new(ChatManager::default());
        let pane = PaneRef {
            machine_id: "a".into(),
            session: "default".into(),
            pane_id: "w1:p1".into(),
        };
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(NoItems),
            Arc::new(|_| {}),
        );
        let store = h.images();
        chats.insert(pane.clone(), p.to_string_lossy().into(), h);
        // The tail is mid-line (a long parse holds the store lock).
        let busy = store.lock().unwrap();
        let (c, p2) = (chats.clone(), pane.clone());
        std::thread::spawn(move || {
            let _ = c.image(&p2, "u:0");
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        let (tx, rx) = std::sync::mpsc::channel();
        let c = chats.clone();
        std::thread::spawn(move || {
            tx.send(c.page(&pane, 0, 1).is_some()).unwrap();
        });
        let paged = rx.recv_timeout(std::time::Duration::from_secs(2));
        drop(busy);
        assert_eq!(paged, Ok(true), "chat_page waited on the image store");
    }

    #[tokio::test]
    async fn close_machine_ends_only_that_machines_tails() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "").unwrap();
        let path: String = p.to_string_lossy().into();
        let chats = ChatManager::default();
        let pane = |m: &str| PaneRef {
            machine_id: m.into(),
            session: "default".into(),
            pane_id: "w1:p1".into(),
        };
        for m in ["a", "b"] {
            let h = spawn_tail(
                Arc::new(crate::transport::local::LocalTransport),
                path.clone(),
                Box::new(NoItems),
                Arc::new(|_| {}),
            );
            chats.insert(pane(m), path.clone(), h);
        }
        chats.close_machine("a");
        assert!(chats.page(&pane("a"), 0, 1).is_none());
        assert!(chats.page(&pane("b"), 0, 1).is_some());
    }

    struct Echo;
    impl Parser for Echo {
        fn push_line(&mut self, line: &str, _: &mut dyn ImageSink) -> ParserOutput {
            let item = ChatItem::User { id: None, ts: None, text: line.into(), images: vec![], skills: vec![] };
            if line == "RESET" { ParserOutput::Reset(vec![item]) } else { ParserOutput::Append(vec![item]) }
        }
    }
    fn pane(id: &str) -> PaneRef {
        PaneRef { machine_id: "a".into(), session: "default".into(), pane_id: id.into() }
    }
    fn recorder() -> (Sink, Arc<std::sync::Mutex<Vec<ChatEvent>>>) {
        let got: Arc<std::sync::Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        (Arc::new(move |e| g.lock().unwrap().push(e)), got)
    }
    fn open(chats: &ChatManager, p: &PaneRef, path: &std::path::Path) -> Arc<std::sync::Mutex<Vec<ChatEvent>>> {
        let (sink, got) = recorder();
        let path: String = path.to_string_lossy().into();
        if !chats.reattach(p, &path, sink.clone()) {
            chats.insert(p.clone(), path.clone(), spawn_tail(Arc::new(crate::transport::local::LocalTransport), path, Box::new(Echo), sink));
        }
        got
    }

    async fn open_via(chats: &ChatManager, p: &PaneRef, path: &std::path::Path) -> (bool, Arc<std::sync::Mutex<Vec<ChatEvent>>>) {
        let (sink, got) = recorder();
        let t: Arc<dyn crate::transport::Transport> = Arc::new(crate::transport::local::LocalTransport);
        let kept = chats.open_tail(p, &path.to_string_lossy(), t, Box::new(Echo), sink).await;
        (kept, got)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reopening_a_frozen_tail_reads_only_what_was_added() {
        let d = tempfile::tempdir().unwrap();
        let (f, g) = (d.path().join("f.jsonl"), d.path().join("g.jsonl"));
        std::fs::write(&f, "a\nb\n").unwrap();
        std::fs::write(&g, "").unwrap();
        let chats = ChatManager::default();
        assert!(!open_via(&chats, &pane("p1"), &f).await.0, "spawned");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        open_via(&chats, &pane("p1"), &g).await; // freezes f
        // Same length, so a read from the kept offset sees `c` and a read from byte 0 sees `x`, `y`.
        std::fs::write(&f, "x\ny\nc\n").unwrap();
        let (resumed, got) = open_via(&chats, &pane("p1"), &f).await;
        assert!(resumed);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let ev = got.lock().unwrap();
        let ChatEvent::Reset { items, total: 3 } = &ev[0] else { panic!("{ev:?}") };
        let texts: Vec<&str> = items.iter().map(|i| match i { ChatItem::User { text, .. } => text.as_str(), _ => "" }).collect();
        assert_eq!(texts, ["a", "b", "c"], "{ev:?}");
        drop(ev);
        assert!(chats.take_frozen(&pane("p1"), &f.to_string_lossy()).is_none(), "f's slot was taken");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_empty_slot_falls_back_to_a_fresh_tail() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("f.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        let chats = ChatManager::default();
        let path: String = f.to_string_lossy().into();
        // A slot nobody fills: its parse thread panicked.
        chats.tails.lock().unwrap().frozen.push_back((pane("p1"), Frozen { path: path.clone(), located: None, slot: FrozenSlot::default() }));
        let start = std::time::Instant::now();
        let (resumed, got) = open_via(&chats, &pane("p1"), &f).await;
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        assert!(!resumed, "a fresh tail re-reads the file: not cached");
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert!(matches!(&got.lock().unwrap()[0], ChatEvent::Reset { total: 2, .. }));
    }

    #[tokio::test]
    async fn reopening_a_parked_tail_resets_from_kept_items() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        let chats = ChatManager::default();
        let first = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        chats.close(&pane("p1"));
        assert!(chats.page(&pane("p1"), 2, 10).is_none(), "a parked tail is not open");
        use std::io::Write;
        // A pi-style branch switch while parked.
        std::fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(b"RESET\n").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let second = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let ev = second.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { items, total: 1 } if items.len() == 1), "{ev:?}");
        assert_eq!(ev.iter().filter(|e| matches!(e, ChatEvent::Reset { .. })).count(), 1);
        assert!(!first.lock().unwrap().iter().any(|e| matches!(e, ChatEvent::Reset { total: 1, .. })), "the closed lens got events");
    }

    #[tokio::test]
    async fn close_then_open_within_a_tick_still_resets_once() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        chats.close(&pane("p1"));
        let again = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let ev = again.lock().unwrap();
        assert_eq!(ev.iter().filter(|e| matches!(e, ChatEvent::Reset { total: 1, .. })).count(), 1, "{ev:?}");
    }

    #[tokio::test]
    async fn a_parked_tail_mid_backlog_sends_its_first_reset_once() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.close(&pane("p1")); // before any Reset was sent
        let again = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let ev = again.lock().unwrap();
        assert_eq!(ev.iter().filter(|e| matches!(e, ChatEvent::Reset { .. })).count(), 1, "{ev:?}");
    }

    #[tokio::test]
    async fn a_fourth_park_drops_the_oldest_and_other_paths_start_fresh() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        let g = d.path().join("u.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        std::fs::write(&g, "z\n").unwrap();
        let chats = ChatManager::default();
        for id in ["p1", "p2", "p3", "p4"] {
            open(&chats, &pane(id), &f);
            chats.close(&pane(id));
        }
        let (sink, _) = recorder();
        assert!(!chats.reattach(&pane("p1"), &f.to_string_lossy(), sink.clone()), "p1 should have been dropped");
        assert!(!chats.reattach(&pane("p4"), &g.to_string_lossy(), sink.clone()), "another path must not reattach");
        assert!(chats.reattach(&pane("p3"), &f.to_string_lossy(), sink));
    }

    #[tokio::test]
    async fn a_dead_parked_tail_is_not_reattached() {
        struct Gone;
        #[async_trait::async_trait]
        impl crate::transport::Transport for Gone {
            fn wrap(&self, _: &[String], _: bool) -> Vec<String> { vec!["true".into()] }
            async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
            async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
        }
        let chats = ChatManager::default();
        let (sink, _) = recorder();
        chats.insert(pane("p1"), "/x".into(), spawn_tail(Arc::new(Gone), "/x".into(), Box::new(Echo), sink.clone()));
        chats.close(&pane("p1"));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!chats.reattach(&pane("p1"), "/x", sink));
    }

    #[tokio::test]
    async fn close_machine_drops_parked_tails() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.close(&pane("p1"));
        chats.close_machine("a");
        let (sink, _) = recorder();
        assert!(!chats.reattach(&pane("p1"), &f.to_string_lossy(), sink));
    }

    fn located(path: &std::path::Path, pending: bool) -> Located {
        let path: String = path.to_string_lossy().into();
        Located { agent: "claude".into(), candidates: vec![path.clone()], path, ambiguous: false, pending, cached: false }
    }

    #[tokio::test]
    async fn a_located_parked_tail_reopens_without_locating() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.set_located(&pane("p1"), &located(&f, false));
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        chats.close(&pane("p1"));
        let (sink, got) = recorder();
        assert_eq!(chats.reattach_cached(&pane("p1"), None, sink), Some(located(&f, false)));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(matches!(&got.lock().unwrap()[0], ChatEvent::Reset { total: 2, .. }));
        assert!(chats.page(&pane("p1"), 2, 10).is_some(), "reopened, not parked");
        let (sink, _) = recorder();
        let same = f.to_string_lossy();
        assert!(chats.reattach_cached(&pane("p1"), Some(&same), sink).is_some(), "the chosen path is the tailed one");
    }

    #[tokio::test]
    async fn only_a_found_transcript_on_the_asked_path_is_reopened_from_cache() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let chats = ChatManager::default();
        let (sink, _) = recorder();
        open(&chats, &pane("p1"), &f);
        assert_eq!(chats.reattach_cached(&pane("p1"), None, sink.clone()), None, "never located");
        chats.set_located(&pane("p1"), &located(&f, true));
        assert_eq!(chats.reattach_cached(&pane("p1"), None, sink.clone()), None, "pending: Claude may write elsewhere");
        chats.set_located(&pane("p1"), &located(&d.path().join("u.jsonl"), false));
        assert_eq!(chats.reattach_cached(&pane("p1"), None, sink.clone()), None, "a location for another path is ignored");
        chats.set_located(&pane("p1"), &located(&f, false));
        assert_eq!(chats.reattach_cached(&pane("p1"), Some("/other.jsonl"), sink.clone()), None, "the user chose another file");
        assert!(chats.page(&pane("p1"), 1, 10).is_some(), "a miss leaves the tail be");
        assert!(chats.reattach_cached(&pane("p2"), None, sink).is_none(), "no tail for that pane");
    }

    #[tokio::test]
    async fn a_dead_located_tail_is_located_again() {
        struct Gone;
        #[async_trait::async_trait]
        impl crate::transport::Transport for Gone {
            fn wrap(&self, _: &[String], _: bool) -> Vec<String> { vec!["true".into()] }
            async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
            async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
        }
        let chats = ChatManager::default();
        let (sink, _) = recorder();
        let f = std::path::Path::new("/x");
        chats.insert(pane("p1"), "/x".into(), spawn_tail(Arc::new(Gone), "/x".into(), Box::new(Echo), sink.clone()));
        chats.set_located(&pane("p1"), &located(f, false));
        chats.close(&pane("p1"));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(chats.reattach_cached(&pane("p1"), None, sink), None);
    }

    /// Its stdin closes after 0.3 s, so the script kills `tail`, as an ssh drop ends it.
    struct Dies;
    #[async_trait::async_trait]
    impl crate::transport::Transport for Dies {
        fn wrap(&self, argv: &[String], _: bool) -> Vec<String> {
            let mut v: Vec<String> = vec!["sh".into(), "-c".into(), "sleep 0.3 | \"$@\"".into(), "sh".into()];
            v.extend(argv.iter().cloned());
            v
        }
        async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
        async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
    }
    const WAIT: std::time::Duration = std::time::Duration::from_millis(500);

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_fourth_park_freezes_the_oldest() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        let path: String = f.to_string_lossy().into();
        let chats = ChatManager::default();
        for id in ["p1", "p2", "p3", "p4"] {
            open(&chats, &pane(id), &f);
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            chats.close(&pane(id));
        }
        assert!(chats.take_frozen(&pane("p2"), &path).is_none(), "p2 is still parked");
        let kept = chats.take_frozen(&pane("p1"), &path).expect("p1 frozen").take(WAIT).expect("kept");
        assert_eq!((kept.offset, kept.items.len()), (4, 2));
        assert!(chats.take_frozen(&pane("p1"), &path).is_none(), "taken once");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dead_tail_is_frozen_when_reopened() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        let path: String = f.to_string_lossy().into();
        let chats = ChatManager::default();
        let (sink, _) = recorder();
        chats.insert(pane("p1"), path.clone(), spawn_tail(Arc::new(Dies), path.clone(), Box::new(Echo), sink.clone()));
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        assert!(!chats.reattach(&pane("p1"), &path, sink));
        let kept = chats.take_frozen(&pane("p1"), &path).expect("frozen").take(WAIT).expect("kept");
        assert_eq!((kept.offset, kept.items.len()), (4, 2));
    }

    #[tokio::test]
    async fn another_transcript_on_the_pane_freezes_the_first_with_where_it_was_found() {
        let d = tempfile::tempdir().unwrap();
        let (f, g) = (d.path().join("f.jsonl"), d.path().join("g.jsonl"));
        std::fs::write(&f, "a\n").unwrap();
        std::fs::write(&g, "b\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.set_located(&pane("p1"), &located(&f, false));
        open(&chats, &pane("p1"), &g);
        let fp: String = f.to_string_lossy().into();
        assert_eq!(chats.frozen_located(&pane("p1"), Some(&fp)), Some(located(&f, false)));
        assert_eq!(chats.frozen_located(&pane("p1"), None), Some(located(&f, false)));
        assert_eq!(chats.frozen_located(&pane("p1"), Some("/other.jsonl")), None);
        assert_eq!(chats.frozen_located(&pane("p2"), None), None);
        assert!(chats.take_frozen(&pane("p1"), &fp).is_some());
    }

    #[tokio::test]
    async fn a_pending_location_is_not_reused_from_a_frozen_tail() {
        let d = tempfile::tempdir().unwrap();
        let (f, g) = (d.path().join("f.jsonl"), d.path().join("g.jsonl"));
        std::fs::write(&f, "").unwrap();
        std::fs::write(&g, "").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.set_located(&pane("p1"), &located(&f, true));
        open(&chats, &pane("p1"), &g);
        assert_eq!(chats.frozen_located(&pane("p1"), None), None);
    }

    #[tokio::test]
    async fn frozen_tails_past_eight_drop_the_oldest_and_go_with_their_machine() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let path: String = f.to_string_lossy().into();
        let chats = ChatManager::default();
        // 12 closes: 3 stay parked, 9 freeze, the first of them is dropped.
        for i in 0..12 {
            let p = pane(&format!("p{i}"));
            open(&chats, &p, &f);
            chats.close(&p);
        }
        assert!(chats.take_frozen(&pane("p0"), &path).is_none());
        assert!(chats.take_frozen(&pane("p1"), &path).is_some());
        chats.close_machine("a");
        assert!(chats.take_frozen(&pane("p2"), &path).is_none(), "close_machine clears frozen tails");
    }

    #[test]
    fn serializes_cached_only_when_set() {
        let f = std::path::Path::new("/x");
        assert!(serde_json::to_value(located(f, false)).unwrap().get("cached").is_none());
        let v = serde_json::to_value(Located { cached: true, ..located(f, false) }).unwrap();
        assert_eq!(v["cached"], true);
    }

    #[test]
    fn serializes_ts_only_when_known() {
        let with = serde_json::to_value(ChatItem::User {
            id: None,
            text: "a".into(),
            images: vec![],
            skills: vec![],
            ts: Some("2026-10-03T00:00:00Z".into()),
        })
        .unwrap();
        assert_eq!(with["ts"], "2026-10-03T00:00:00Z");
        let without = serde_json::to_value(ChatItem::User {
            id: None,
            text: "a".into(),
            images: vec![],
            skills: vec![],
            ts: None,
        })
        .unwrap();
        assert!(without.get("ts").is_none());
    }

    #[test]
    fn a_user_item_without_id_serializes_no_id() {
        let v = serde_json::to_value(ChatItem::User { id: None, ts: None, text: "a".into(), images: vec![], skills: vec![] }).unwrap();
        assert!(v.get("id").is_none());
        let v = serde_json::to_value(ChatItem::User { id: Some("u1".into()), ts: None, text: "a".into(), images: vec![], skills: vec![] }).unwrap();
        assert_eq!(v["id"], "u1");
    }

    #[test]
    fn omits_empty_images_and_skills() {
        let v = serde_json::to_value(ChatItem::User {
            id: None,
            text: "a".into(),
            images: vec![],
            skills: vec![],
            ts: None,
        })
        .unwrap();
        assert!(v.get("images").is_none() && v.get("skills").is_none());
        let v = serde_json::to_value(ChatItem::ToolResult {
            call_id: "c".into(),
            output: "o".into(),
            is_error: false,
            images: vec![ImageRef {
                reference: "e:0".into(),
                media_type: "image/png".into(),
            }],
            ts: None,
        })
        .unwrap();
        assert_eq!(
            v["images"],
            serde_json::json!([{ "ref": "e:0", "media_type": "image/png" }])
        );
    }

    #[test]
    fn serializes_meta_event() {
        let v = serde_json::to_value(ChatEvent::Meta {
            model: Some("m".into()),
            effort: None,
            context_tokens: Some(42),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "type": "meta", "model": "m", "effort": null, "context_tokens": 42 })
        );
    }

    #[test]
    fn meta_label_rejects_placeholders() {
        assert_eq!(
            meta_label("claude-opus-5-5"),
            Some("claude-opus-5-5".into())
        );
        assert_eq!(meta_label("<synthetic>"), None);
        assert_eq!(meta_label(""), None);
        assert_eq!(meta_label(&"x".repeat(101)), None);
    }
}
