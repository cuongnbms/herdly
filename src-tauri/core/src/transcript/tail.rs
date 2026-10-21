//! Stream a transcript file with `tail -F` on the Machine and feed a parser.
use super::images::{ImageSink, ImageStore, IMAGE_BUDGET, PARKED_IMAGE_BUDGET};
use super::{ChatEvent, ChatItem, ChatMeta, Parser, ParserOutput};
use crate::error::AppError;
use crate::transport::Transport;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::task::JoinHandle;

const BATCH: Duration = Duration::from_millis(50);
const RESET_ITEMS: usize = 500;
/// Silence that ends the first backlog when the size header is unreadable.
const QUIET: Duration = if cfg!(test) { Duration::from_secs(1) } else { Duration::from_secs(2) };
const MAX_LINE: usize = 32 * 1024 * 1024;
/// Lines a transport may print before the header, such as a login banner.
const BEFORE_HEADER: usize = 64;

pub type Sink = Arc<dyn Fn(ChatEvent) + Send + Sync>;

/// Where a tail's events go. `sink` is None while the tail is parked; `attach` leaves the
/// new sink in `pending` for the parse thread to adopt, so attaching never blocks.
struct Link {
    sink: Option<Sink>,
    pending: Option<Sink>,
}

type SharedLink = Arc<Mutex<Link>>;

/// Sends `ev` to the current sink, if any. The sink is cloned out so it runs unlocked.
fn emit(link: &SharedLink, ev: ChatEvent) {
    let sink = link.lock().unwrap().sink.clone();
    if let Some(sink) = sink {
        sink(ev);
    }
}

/// What a stopped tail keeps so a later open can read on from `offset`.
pub struct Kept {
    pub parser: Box<dyn Parser>,
    pub items: Vec<ChatItem>,
    /// Bytes of whole lines consumed, header excluded.
    pub offset: u64,
}

/// Where a tail leaves its `Kept` state when its parse thread ends.
#[derive(Clone, Default)]
pub struct FrozenSlot(Arc<(Mutex<Option<Kept>>, Condvar)>);

impl FrozenSlot {
    /// Fills the slot and wakes a `take` that is waiting.
    fn put(&self, k: Kept) {
        *self.0 .0.lock().unwrap() = Some(k);
        self.0 .1.notify_all();
    }

    /// Waits up to `wait` for the slot to fill, then takes what it holds.
    pub fn take(&self, wait: Duration) -> Option<Kept> {
        let guard = self.0 .0.lock().unwrap();
        let (mut guard, _) = self
            .0
             .1
            .wait_timeout_while(guard, wait, |k| k.is_none())
            .unwrap();
        guard.take()
    }
}

/// A running tail. Dropping it ends the `tail` process.
pub struct TailHandle {
    items: Arc<Mutex<Vec<ChatItem>>>,
    images: Arc<Mutex<ImageStore>>,
    link: SharedLink,
    task: JoinHandle<()>,
    /// Set once the parse thread is gone: past that, nothing reaches a sink.
    done: Arc<AtomicBool>,
    /// Filled by the parse thread when it ends.
    kept: FrozenSlot,
}

impl TailHandle {
    /// Stops the tail (as dropping does) and returns the slot its state will land in.
    pub fn freeze(self) -> FrozenSlot {
        self.kept.clone()
    }

    /// The last `limit` items whose absolute index is `< before`.
    pub fn page(&self, before: usize, limit: usize) -> Vec<ChatItem> {
        let items = self.items.lock().unwrap();
        let end = before.min(items.len());
        items[end.saturating_sub(limit)..end].to_vec()
    }

    /// Parks the tail: it keeps reading but emits nothing, and keeps fewer images.
    pub fn detach(&self) {
        {
            let mut link = self.link.lock().unwrap();
            link.sink = None;
            link.pending = None;
        }
        self.images.lock().unwrap().set_budget(PARKED_IMAGE_BUDGET);
    }

    /// Sends later events to `sink`, starting with a Reset of what the tail kept. The
    /// parse thread takes it over within a tick (50 ms).
    pub fn attach(&self, sink: Sink) {
        self.images.lock().unwrap().set_budget(IMAGE_BUDGET);
        self.link.lock().unwrap().pending = Some(sink);
    }

    /// Whether the tail still delivers: the parse thread is up and the reader has not
    /// finished. The reader can outlive the parse thread briefly after an Eof.
    pub fn is_running(&self) -> bool {
        !self.done.load(Ordering::Acquire) && !self.task.is_finished()
    }

    /// The tail's image store, shared: lock it after letting go of any other lock.
    pub fn images(&self) -> Arc<Mutex<ImageStore>> {
        self.images.clone()
    }
}

impl Drop for TailHandle {
    fn drop(&mut self) {
        // Aborting drops the future, closing the child's stdin; the wrapper then kills tail.
        self.task.abort();
    }
}

struct State {
    items: Arc<Mutex<Vec<ChatItem>>>,
    images: Arc<Mutex<ImageStore>>,
    /// The Model and Reasoning effort last sent to the sink.
    last_meta: ChatMeta,
    parser: Box<dyn Parser>,
    link: SharedLink,
    /// Events of the current batch, in order.
    events: Vec<ChatEvent>,
    /// Items appended since the last event was queued.
    appended: Vec<ChatItem>,
    sent_first: bool,
    /// The file's size when the tail started, from the header line.
    size: Option<u64>,
    /// Bytes of the stream read after the header.
    consumed: u64,
    /// When the last byte arrived; None until the first.
    last_byte: Option<Instant>,
    /// Bytes of whole lines parsed or skipped so far, header excluded.
    offset: u64,
    /// Replaces `parser` when the file turns out shorter than `offset`.
    fresh: Option<Box<dyn Parser>>,
    /// Receives the parser, items and offset when the parse thread ends.
    kept: FrozenSlot,
    /// Dropped with the State, so any end of the parse thread (Eof, closed channel, panic,
    /// failed spawn) marks the tail done.
    _done: DoneOnDrop,
}

struct DoneOnDrop(Arc<AtomicBool>);

impl Drop for DoneOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// The header line is `herdr-tail <size> <start>`: the file's size and the byte the stream starts at.
fn parse_header(line: &[u8]) -> Option<(u64, u64)> {
    let mut parts = std::str::from_utf8(line).ok()?.split_whitespace();
    if parts.next()? != "herdr-tail" {
        return None;
    }
    let size = parts.next()?.parse().ok()?;
    let start = parts.next()?.parse().ok()?;
    Some((size, start))
}

impl State {
    fn reset_event(items: &[ChatItem]) -> ChatEvent {
        ChatEvent::Reset {
            items: items[items.len().saturating_sub(RESET_ITEMS)..].to_vec(),
            total: items.len(),
        }
    }

    fn line(&mut self, line: &str) {
        // Parse into a local list so the store is locked only to put, never during a parse.
        let mut found: Vec<(String, String, Vec<u8>)> = Vec::new();
        let out = self.parser.push_line(line, &mut found);
        if !found.is_empty() {
            let mut images = self.images.lock().unwrap();
            for (r, media_type, bytes) in found {
                images.put(r, media_type, bytes);
            }
        }
        match out {
            ParserOutput::None => {}
            ParserOutput::Append(v) => {
                // Before the first Reset, `items` is all that is needed: that Reset snapshots it.
                if self.sent_first {
                    self.appended.extend(v.iter().cloned());
                }
                self.items.lock().unwrap().extend(v);
            }
            ParserOutput::Reset(v) => {
                if !self.appended.is_empty() {
                    self.events.push(ChatEvent::Append {
                        items: std::mem::take(&mut self.appended),
                    });
                }
                let mut items = self.items.lock().unwrap();
                *items = v;
                self.events.push(Self::reset_event(&items));
            }
        }
    }

    fn flush(&mut self) {
        if !self.sent_first {
            // Wait until the backlog's bytes have all been read (or, with no usable size,
            // the stream goes quiet), then send one Reset covering everything.
            let caught_up = self.size.is_some_and(|s| self.consumed >= s)
                || self.last_byte.is_some_and(|t| t.elapsed() >= QUIET);
            if !caught_up {
                return;
            }
            let ev = Self::reset_event(&self.items.lock().unwrap());
            self.events.clear();
            self.appended.clear();
            self.sent_first = true;
            emit(&self.link, ev);
            self.send_meta_if_changed();
            return;
        }
        if !self.appended.is_empty() {
            self.events.push(ChatEvent::Append {
                items: std::mem::take(&mut self.appended),
            });
        }
        for ev in self.events.drain(..) {
            emit(&self.link, ev);
        }
        self.send_meta_if_changed();
    }

    fn send_meta_if_changed(&mut self) {
        let meta = self.parser.meta();
        if meta != self.last_meta {
            self.last_meta = meta.clone();
            emit(
                &self.link,
                ChatEvent::Meta {
                    model: meta.model,
                    effort: meta.effort,
                    context_tokens: meta.context_tokens,
                },
            );
        }
    }

    /// Moves a pending sink in. What was queued for the old sink is dropped: the Reset
    /// below covers it. Before the first Reset there is nothing more to do, as that
    /// Reset goes to the new sink.
    fn adopt_pending(&mut self) {
        {
            let mut link = self.link.lock().unwrap();
            let Some(s) = link.pending.take() else { return };
            link.sink = Some(s);
        }
        self.events.clear();
        self.appended.clear();
        if self.sent_first {
            let ev = Self::reset_event(&self.items.lock().unwrap());
            emit(&self.link, ev);
            self.last_meta = ChatMeta::default();
            self.send_meta_if_changed();
        }
    }
}

pub fn spawn_tail(
    t: Arc<dyn Transport>,
    path: String,
    parser: Box<dyn Parser>,
    sink: Sink,
) -> TailHandle {
    start(t, path, sink, parser, Vec::new(), 0, None)
}

/// Starts a tail that reads on from `kept.offset`; `fresh` replaces the kept parser and
/// items when the file is now shorter than the offset.
pub fn resume_tail(
    t: Arc<dyn Transport>,
    path: String,
    kept: Kept,
    fresh: Box<dyn Parser>,
    sink: Sink,
) -> TailHandle {
    start(t, path, sink, kept.parser, kept.items, kept.offset, Some(fresh))
}

fn start(
    t: Arc<dyn Transport>,
    path: String,
    sink: Sink,
    parser: Box<dyn Parser>,
    kept_items: Vec<ChatItem>,
    offset: u64,
    fresh: Option<Box<dyn Parser>>,
) -> TailHandle {
    let items: Arc<Mutex<Vec<ChatItem>>> = Arc::new(Mutex::new(kept_items));
    let images = Arc::new(Mutex::new(ImageStore::new(IMAGE_BUDGET)));
    let done: Arc<AtomicBool> = Arc::default();
    let kept = FrozenSlot::default();
    let state = State {
        items: items.clone(),
        images: images.clone(),
        last_meta: ChatMeta::default(),
        parser,
        link: Arc::new(Mutex::new(Link { sink: Some(sink), pending: None })),
        events: Vec::new(),
        appended: Vec::new(),
        sent_first: false,
        size: None,
        consumed: 0,
        last_byte: None,
        offset,
        fresh,
        kept: kept.clone(),
        _done: DoneOnDrop(done.clone()),
    };
    let link = state.link.clone();
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    // Parsing is CPU-bound (lines reach 32 MiB), so it gets a thread of its own. It ends
    // when the reader is aborted and the channel closes.
    let spawned = std::thread::Builder::new()
        .name("chat-parse".into())
        .spawn(move || parse_loop(state, rx));
    if let Err(e) = spawned {
        emit(&link, ChatEvent::Error { error: AppError::new("io", e.to_string()) });
    }
    let task = tokio::spawn(read(t, path, offset, link.clone(), tx));
    TailHandle {
        items,
        images,
        link,
        task,
        done,
        kept,
    }
}

/// What the reader tells the parse thread.
enum Msg {
    /// The `herdr-tail <size> <start>` header line, parsed; None when none came.
    Header(Option<(u64, u64)>),
    /// One line without its newline, and its raw length with `\r\n` or `\n`.
    Line(Vec<u8>, usize),
    /// A line dropped for exceeding `MAX_LINE`, with its raw length.
    Skipped(usize),
    /// Raw bytes read after the header, sent once the chunk's lines are.
    Bytes(usize),
    Tick,
    /// The tail's output ended.
    Eof,
}

fn parse_loop(mut st: State, mut rx: tokio::sync::mpsc::Receiver<Msg>) {
    while let Some(m) = rx.blocking_recv() {
        st.adopt_pending();
        match m {
            Msg::Header(h) => {
                // Without a header the stream's start is unknown: a resumed tail keeps what it read.
                if h.is_some_and(|(_, start)| start < st.offset) {
                    if let Some(p) = st.fresh.take() {
                        st.parser = p;
                    }
                    st.items.lock().unwrap().clear();
                    st.offset = 0;
                }
                st.size = h.map(|(size, start)| size.saturating_sub(start));
                st.last_byte = Some(Instant::now());
            }
            Msg::Line(mut bytes, raw) => {
                if bytes.last() == Some(&b'\r') {
                    bytes.pop();
                }
                st.line(&String::from_utf8_lossy(&bytes));
                st.offset += raw as u64;
            }
            Msg::Skipped(raw) => st.offset += raw as u64,
            Msg::Bytes(n) => {
                st.consumed += n as u64;
                st.last_byte = Some(Instant::now());
            }
            Msg::Tick => st.flush(),
            Msg::Eof => {
                st.flush();
                emit(
                    &st.link,
                    ChatEvent::Error {
                        error: AppError::new("io", "transcript tail exited"),
                    },
                );
                break;
            }
        }
    }
    let kept = Kept {
        parser: st.parser,
        items: st.items.lock().unwrap().clone(),
        offset: st.offset,
    };
    st.kept.put(kept);
}

async fn read(
    t: Arc<dyn Transport>,
    path: String,
    offset: u64,
    link: SharedLink,
    tx: tokio::sync::mpsc::Sender<Msg>,
) {
    // The remote command ends (and kills tail) when its stdin reaches EOF, i.e. when the
    // handle drops: closing stdin is the only reliable cleanup over ssh without a tty.
    // The header is `herdr-tail <size> <start>`: a file shorter than `offset` is read from byte 0.
    let script = r#"s=$(wc -c < "$1" 2>/dev/null | tr -d ' '); [ -n "$s" ] || s=0
if [ "$s" -ge "$2" ]; then o=$2; else o=0; fi
echo "herdr-tail $s $o"; tail -c +$((o+1)) -F "$1" & p=$!; cat >/dev/null; kill $p 2>/dev/null"#;
    let argv = t.wrap(
        &["sh".into(), "-c".into(), script.into(), "sh".into(), path, offset.to_string()],
        false,
    );
    let spawned = Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            emit(&link, ChatEvent::Error { error: e.into() });
            return;
        }
    };
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let _stdin = child.stdin.take();
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + BATCH, BATCH);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut chunk = vec![0u8; 64 * 1024];
    let mut buf: Vec<u8> = Vec::new();
    let mut dropping = false;
    let mut header = true;
    // Whole lines read before the header, read as the file's if none comes.
    let mut before: Vec<(Vec<u8>, usize)> = Vec::new();
    let mut last_read: Option<Instant> = None;
    // Raw bytes of the line being read, which may span chunks.
    let mut line_raw = 0usize;
    loop {
        tokio::select! {
            n = stdout.read(&mut chunk) => {
                let n = match n { Ok(0) | Err(_) => break, Ok(n) => n };
                last_read = Some(Instant::now());
                // Header bytes and lines before it are not counted: they are not part of the file.
                let mut raw = 0usize;
                for part in chunk[..n].split_inclusive(|b| *b == b'\n') {
                    let complete = part.ends_with(b"\n");
                    if header {
                        buf.extend_from_slice(part.strip_suffix(b"\n").unwrap_or(part));
                        line_raw += part.len();
                        if complete {
                            let whole = std::mem::take(&mut line_raw);
                            if let Some(head) = parse_header(&buf) {
                                buf.clear();
                                before.clear();
                                header = false;
                                if tx.send(Msg::Header(Some(head))).await.is_err() { return; }
                            } else {
                                before.push((std::mem::take(&mut buf), whole));
                            }
                        }
                        if before.len() >= BEFORE_HEADER || buf.len() > MAX_LINE {
                            header = false;
                            if !headerless(&tx, &mut before).await { return; }
                        }
                        continue;
                    }
                    raw += part.len();
                    line_raw += part.len();
                    if !dropping {
                        buf.extend_from_slice(part.strip_suffix(b"\n").unwrap_or(part));
                        if buf.len() > MAX_LINE {
                            dropping = true;
                            buf.clear();
                        }
                    }
                    if complete {
                        let sent = if dropping {
                            tx.send(Msg::Skipped(line_raw)).await
                        } else {
                            tx.send(Msg::Line(std::mem::take(&mut buf), line_raw)).await
                        };
                        if sent.is_err() { return; }
                        dropping = false;
                        line_raw = 0;
                        buf.clear();
                    }
                }
                // Sent even when 0, so a header still arriving starts the quiet clock.
                if tx.send(Msg::Bytes(raw)).await.is_err() { return; }
            }
            _ = tick.tick() => {
                if header && last_read.is_some_and(|t| t.elapsed() >= QUIET) {
                    header = false;
                    if !headerless(&tx, &mut before).await { return; }
                }
                if tx.send(Msg::Tick).await.is_err() { return; }
            }
        }
    }
    if header && !headerless(&tx, &mut before).await {
        return;
    }
    let _ = tx.send(Msg::Eof).await;
}

/// Gives up on the header: the lines read before it are sent as the file's.
async fn headerless(tx: &tokio::sync::mpsc::Sender<Msg>, before: &mut Vec<(Vec<u8>, usize)>) -> bool {
    if tx.send(Msg::Header(None)).await.is_err() {
        return false;
    }
    for (bytes, raw) in before.drain(..) {
        if tx.send(Msg::Line(bytes, raw)).await.is_err() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::images::ImageSink;
    use std::sync::{Arc, Mutex};
    struct Lines;
    impl Parser for Lines {
        fn push_line(&mut self, line: &str, _images: &mut dyn ImageSink) -> ParserOutput {
            if line == "RESET" {
                ParserOutput::Reset(vec![ChatItem::System {
                    ts: None,
                    text: "reset".into(),
                }])
            } else {
                ParserOutput::Append(vec![ChatItem::User {
                    id: None,
                    images: vec![],
                    skills: vec![],
                    ts: None,
                    text: line.into(),
                }])
            }
        }
    }
    struct MetaLines {
        model: Option<String>,
    }
    impl Parser for MetaLines {
        fn push_line(&mut self, line: &str, images: &mut dyn ImageSink) -> ParserOutput {
            if let Some(m) = line.strip_prefix("MODEL ") {
                self.model = Some(m.into());
                return ParserOutput::None;
            }
            if let Some(r) = line.strip_prefix("IMG ") {
                images.put(r.into(), "image/png".into(), vec![7, 7]);
                return ParserOutput::None;
            }
            ParserOutput::Append(vec![ChatItem::User {
                id: None,
                ts: None,
                text: line.into(),
                images: vec![],
                skills: vec![],
            }])
        }
        fn meta(&self) -> crate::transcript::ChatMeta {
            crate::transcript::ChatMeta {
                model: self.model.clone(),
                ..Default::default()
            }
        }
    }

    /// Blocks inside `push_line` until released, reporting when it got there.
    struct Stuck {
        entered: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    }
    impl Parser for Stuck {
        fn push_line(&mut self, _: &str, images: &mut dyn ImageSink) -> ParserOutput {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            images.put("r".into(), "image/png".into(), vec![1]);
            ParserOutput::None
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_image_store_is_free_while_a_line_parses() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let (entered_tx, entered) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(Stuck { entered: entered_tx, release: release_rx }),
            Arc::new(|_| {}),
        );
        let store = h.images();
        tokio::task::spawn_blocking(move || entered.recv_timeout(std::time::Duration::from_secs(3)))
            .await.unwrap().expect("parser never ran");
        assert!(store.try_lock().is_ok(), "the store is locked during the parse");
        release.send(()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(store.lock().unwrap().get("r"), Some(("image/png".to_string(), vec![1])));
    }

    #[tokio::test]
    async fn meta_sent_after_reset_and_on_change() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(MetaLines { model: None }),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        {
            let ev = got.lock().unwrap();
            assert_eq!(ev.len(), 1, "{ev:?}");
            assert!(matches!(ev[0], ChatEvent::Reset { .. }));
        }
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        writeln!(f, "MODEL m1\nb\nIMG r1").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        writeln!(f, "c").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let ev = got.lock().unwrap();
        let metas: Vec<_> = ev
            .iter()
            .filter_map(|e| match e {
                ChatEvent::Meta { model, .. } => Some(model.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(metas, vec![Some("m1".to_string())]);
        let store = h.images();
        assert_eq!(
            store.lock().unwrap().get("r1"),
            Some(("image/png".to_string(), vec![7, 7]))
        );
        assert_eq!(store.lock().unwrap().get("nope"), None);
        drop(ev);
        drop(h);
    }

    #[tokio::test]
    async fn meta_known_at_open_follows_the_reset() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "MODEL m0\na\n").unwrap();
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let _h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(MetaLines { model: None }),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(ev[0], ChatEvent::Reset { .. }));
        assert!(matches!(&ev[1], ChatEvent::Meta { model: Some(m), .. } if m == "m0"));
    }

    #[tokio::test]
    async fn streams_reset_then_appends() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nb\n").unwrap();
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(Lines),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"c\nRESET\n").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { items, total: 2 } if items.len() == 2));
        assert!(ev.iter().any(|e| matches!(e, ChatEvent::Append { items } if items == &vec![ChatItem::User { id: None, ts: None, text: "c".into(), images: vec![], skills: vec![] }])));
        assert!(matches!(ev.last().unwrap(), ChatEvent::Reset { items, .. } if items.len() == 1));
        drop(ev);
        drop(h);
    }
    #[tokio::test]
    async fn invalid_utf8_lines_do_not_stop_the_stream() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, b"a\n\xff\xfe\xfd\nb\n").unwrap();
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let _h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(Lines),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(
            matches!(&got.lock().unwrap()[0], ChatEvent::Reset { items, total: 3 } if items[0] == ChatItem::User { id: None, ts: None, text: "a".into(), images: vec![], skills: vec![] } && items[2] == ChatItem::User { id: None, ts: None, text: "b".into(), images: vec![], skills: vec![] })
        );
    }
    #[tokio::test]
    async fn empty_and_missing_files_still_reset() {
        let d = tempfile::tempdir().unwrap();
        for name in ["empty.jsonl", "missing.jsonl"] {
            let p = d.path().join(name);
            if name == "empty.jsonl" {
                std::fs::write(&p, "").unwrap();
            }
            let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
            let g = got.clone();
            let _h = spawn_tail(
                Arc::new(crate::transport::local::LocalTransport),
                p.to_string_lossy().into(),
                Box::new(Lines),
                Arc::new(move |e| g.lock().unwrap().push(e)),
            );
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            assert!(
                matches!(&got.lock().unwrap()[0], ChatEvent::Reset { items, total: 0 } if items.is_empty()),
                "{name}"
            );
        }
    }
    fn tail_running(path: &str) -> bool {
        std::process::Command::new("pgrep")
            .args(["-f", "--", &format!("-F {path}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[tokio::test]
    async fn dropping_the_handle_ends_tail() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("drop-me.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let path: String = p.to_string_lossy().into();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            path.clone(),
            Box::new(Lines),
            Arc::new(|_| {}),
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(tail_running(&path), "tail should be running");
        drop(h);
        for _ in 0..40 {
            if !tail_running(&path) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("tail still running after drop");
    }
    #[tokio::test]
    async fn pages_older_items() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, (0..700).map(|i| format!("m{i}\n")).collect::<String>()).unwrap();
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(Lines),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        assert!(
            matches!(&got.lock().unwrap()[0], ChatEvent::Reset { items, total: 700 } if items.len() == 500 && items[0] == ChatItem::User { id: None, ts: None, text: "m200".into(), images: vec![], skills: vec![] })
        );
        let older = h.page(200, 200);
        assert_eq!(older.len(), 200);
        assert_eq!(
            older[0],
            ChatItem::User {
                id: None,
                images: vec![],
                skills: vec![],
                ts: None,
                text: "m0".into()
            }
        );
    }

    /// Starts the command only after `delay`, like a slow ssh: nothing arrives at first.
    struct Slow(&'static str);
    #[async_trait::async_trait]
    impl crate::transport::Transport for Slow {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let mut v: Vec<String> = vec!["sh".into(), "-c".into(), format!("sleep {}; exec \"$@\"", self.0), "sh".into()];
            v.extend(argv.iter().cloned());
            v
        }
        async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
        async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
    }
    /// Prints a junk line before the command, like a login banner.
    struct Junk;
    #[async_trait::async_trait]
    impl crate::transport::Transport for Junk {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let mut v: Vec<String> = vec!["sh".into(), "-c".into(), "echo ' junk'; exec \"$@\"".into(), "sh".into()];
            v.extend(argv.iter().cloned());
            v
        }
        async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
        async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
    }
    /// Runs the script with its header's marker removed: no header line is recognised.
    struct NoMarker;
    #[async_trait::async_trait]
    impl crate::transport::Transport for NoMarker {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            argv.iter().map(|a| a.replace("herdr-tail ", "")).collect()
        }
        async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
        async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
    }
    fn collect(t: Arc<dyn crate::transport::Transport>, p: &std::path::Path) -> (TailHandle, Arc<Mutex<Vec<ChatEvent>>>) {
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = spawn_tail(t, p.to_string_lossy().into(), Box::new(Lines), Arc::new(move |e| g.lock().unwrap().push(e)));
        (h, got)
    }

    fn state(parser: Box<dyn Parser>) -> State {
        State {
            items: Arc::default(),
            images: Arc::new(Mutex::new(ImageStore::new(IMAGE_BUDGET))),
            last_meta: ChatMeta::default(),
            parser,
            link: Arc::new(Mutex::new(Link { sink: None, pending: None })),
            events: Vec::new(),
            appended: Vec::new(),
            sent_first: false,
            size: None,
            consumed: 0,
            last_byte: None,
            offset: 0,
            fresh: None,
            kept: FrozenSlot::default(),
            _done: DoneOnDrop(Arc::default()),
        }
    }

    #[test]
    fn skipped_lines_count_toward_the_offset() {
        let st = state(Box::new(Lines));
        let slot = st.kept.clone();
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        tx.blocking_send(Msg::Line(b"a".to_vec(), 2)).unwrap();
        tx.blocking_send(Msg::Skipped(40)).unwrap();
        tx.blocking_send(Msg::Line(b"b".to_vec(), 3)).unwrap();
        drop(tx);
        parse_loop(st, rx);
        let kept = slot
            .take(Duration::from_millis(10))
            .expect("the slot is filled when the channel closes");
        assert_eq!(kept.offset, 45);
        assert_eq!(kept.items.len(), 2);
    }

    #[test]
    fn an_eof_fills_the_slot_too() {
        let st = state(Box::new(Lines));
        let slot = st.kept.clone();
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        tx.blocking_send(Msg::Line(b"a".to_vec(), 2)).unwrap();
        tx.blocking_send(Msg::Eof).unwrap();
        parse_loop(st, rx);
        assert_eq!(
            slot.take(Duration::from_millis(10)).map(|k| k.offset),
            Some(2)
        );
    }

    #[test]
    fn an_eof_leaves_the_shared_items_for_page() {
        let st = state(Box::new(Lines));
        let items = st.items.clone();
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        tx.blocking_send(Msg::Line(b"a".to_vec(), 2)).unwrap();
        tx.blocking_send(Msg::Eof).unwrap();
        parse_loop(st, rx);
        assert_eq!(items.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_empty_slot_gives_up_after_the_wait() {
        let start = Instant::now();
        assert!(FrozenSlot::default()
            .take(Duration::from_millis(50))
            .is_none());
        assert!(start.elapsed() >= Duration::from_millis(50));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_frozen_tail_keeps_its_items_and_the_offset_of_its_last_whole_line() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nbb\r\nhalf").unwrap();
        let (h, _got) = collect(Arc::new(crate::transport::local::LocalTransport), &p);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let kept = h.freeze().take(Duration::from_millis(500)).expect("kept");
        assert_eq!(
            kept.offset, 6,
            "a\\n and bb\\r\\n; the half line is not counted"
        );
        assert_eq!(kept.items.len(), 2);
    }

    #[test]
    fn the_parse_thread_marks_the_tail_done_however_it_ends() {
        for eof in [true, false] {
            let st = state(Box::new(Lines));
            let done = st._done.0.clone();
            let (tx, rx) = tokio::sync::mpsc::channel(4);
            if eof {
                tx.blocking_send(Msg::Eof).unwrap();
            } else {
                drop(tx);
            }
            parse_loop(st, rx);
            assert!(done.load(Ordering::Acquire), "eof: {eof}");
        }
    }

    #[tokio::test]
    async fn a_done_tail_is_not_running_while_its_reader_lingers() {
        let done: Arc<AtomicBool> = Arc::default();
        let h = TailHandle {
            items: Arc::default(),
            images: Arc::new(Mutex::new(ImageStore::new(IMAGE_BUDGET))),
            link: Arc::new(Mutex::new(Link { sink: None, pending: None })),
            task: tokio::spawn(std::future::pending()),
            done: done.clone(),
            kept: FrozenSlot::default(),
        };
        assert!(h.is_running());
        done.store(true, Ordering::Release);
        assert!(!h.is_running());
    }

    #[test]
    fn the_backlog_is_not_queued_twice_before_the_first_reset() {
        let mut st = state(Box::new(Lines));
        st.line("a");
        st.line("b");
        assert_eq!(st.items.lock().unwrap().len(), 2);
        assert!(st.appended.is_empty(), "the first Reset already carries the backlog");
        st.sent_first = true;
        st.line("c");
        assert_eq!(st.appended.len(), 1);
    }

    #[test]
    fn reads_the_size_and_start_header() {
        assert_eq!(parse_header(b"herdr-tail 1234 0"), Some((1234, 0)));
        assert_eq!(parse_header(b"herdr-tail   77 12\r"), Some((77, 12)));
        assert_eq!(parse_header(b"herdr-tail 1234"), None);
        assert_eq!(parse_header(b"1234 0"), None, "a banner line of two numbers is not the header");
        assert_eq!(parse_header(b" junk"), None);
    }

    fn texts(ev: &ChatEvent) -> Vec<String> {
        match ev {
            ChatEvent::Reset { items, .. } => items
                .iter()
                .map(|i| match i {
                    ChatItem::User { text, .. } => text.clone(),
                    other => format!("{other:?}"),
                })
                .collect(),
            other => panic!("not a reset: {other:?}"),
        }
    }

    async fn frozen(p: &std::path::Path) -> Kept {
        frozen_via(Arc::new(crate::transport::local::LocalTransport), p, Box::new(Lines)).await
    }

    async fn frozen_via(t: Arc<dyn crate::transport::Transport>, p: &std::path::Path, parser: Box<dyn Parser>) -> Kept {
        let h = spawn_tail(t, p.to_string_lossy().into(), parser, Arc::new(|_| {}));
        tokio::time::sleep(Duration::from_millis(400)).await;
        h.freeze().take(Duration::from_millis(500)).expect("kept")
    }

    fn resume(p: &std::path::Path, kept: Kept) -> (TailHandle, Arc<Mutex<Vec<ChatEvent>>>) {
        resume_via(Arc::new(crate::transport::local::LocalTransport), p, kept, Box::new(Lines))
    }

    fn resume_via(t: Arc<dyn crate::transport::Transport>, p: &std::path::Path, kept: Kept, fresh: Box<dyn Parser>) -> (TailHandle, Arc<Mutex<Vec<ChatEvent>>>) {
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = resume_tail(t, p.to_string_lossy().into(), kept, fresh, Arc::new(move |e| g.lock().unwrap().push(e)));
        (h, got)
    }

    fn append(p: &std::path::Path, bytes: &[u8]) {
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(p).unwrap().write_all(bytes).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_resumed_tail_reads_on_from_its_offset() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nb\n").unwrap();
        let kept = frozen(&p).await;
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"c\n").unwrap();
        let (_h, got) = resume(&p, kept);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { total: 3, .. }), "{ev:?}");
        assert_eq!(texts(&ev[0]), ["a", "b", "c"]);
        assert!(!ev.iter().any(|e| matches!(e, ChatEvent::Append { .. })), "{ev:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_half_line_is_read_whole_after_a_resume() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nhal").unwrap();
        let kept = frozen(&p).await;
        assert_eq!((kept.offset, kept.items.len()), (2, 1));
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"f\n").unwrap();
        let (_h, got) = resume(&p, kept);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(texts(&got.lock().unwrap()[0]), ["a", "half"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_shrunk_file_resumes_as_a_fresh_read() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nb\nc\n").unwrap();
        let kept = frozen(&p).await;
        std::fs::write(&p, "x\n").unwrap();
        let (_h, got) = resume(&p, kept);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { total: 1, .. }), "{ev:?}");
        assert_eq!(texts(&ev[0]), ["x"]);
    }

    #[tokio::test]
    async fn a_slow_start_still_sends_the_whole_backlog_as_one_reset() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, (0..50).map(|i| format!("m{i}\n")).collect::<String>()).unwrap();
        // Slower than QUIET (1 s in tests): the quiet clock must not run before the first byte.
        let (_h, got) = collect(Arc::new(Slow("1.3")), &p);
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { total: 50, .. }), "{ev:?}");
        assert!(!ev.iter().any(|e| matches!(e, ChatEvent::Append { .. })), "{ev:?}");
    }

    #[tokio::test]
    async fn a_last_line_without_newline_follows_the_reset() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nb").unwrap();
        let (_h, got) = collect(Arc::new(crate::transport::local::LocalTransport), &p);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(matches!(&got.lock().unwrap()[0], ChatEvent::Reset { total: 1, .. }));
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"\n").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let ev = got.lock().unwrap();
        assert!(ev.iter().any(|e| matches!(e, ChatEvent::Append { items } if items.len() == 1)), "{ev:?}");
    }

    #[tokio::test]
    async fn a_line_before_the_header_is_not_read_as_the_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let (_h, got) = collect(Arc::new(Junk), &p);
        // Well before QUIET: the header's size, not the quiet rule, sent this Reset.
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { total: 1, .. }), "{ev:?}");
        assert_eq!(texts(&ev[0]), ["a"]);
    }

    #[tokio::test]
    async fn no_header_falls_back_to_quiet() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let (_h, got) = collect(Arc::new(NoMarker), &p);
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        assert!(got.lock().unwrap().is_empty(), "sent before QUIET");
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        // The unmarked size line is read as the file: only the quiet rule could have sent this Reset.
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { total: 2, .. }), "{ev:?}");
        assert_eq!(texts(&ev[0]), ["2 0", "a"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_line_before_the_header_loses_nothing_on_a_resume() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nb\n").unwrap();
        let kept = frozen_via(Arc::new(Junk), &p, Box::new(Lines)).await;
        assert_eq!((kept.offset, kept.items.len()), (4, 2));
        append(&p, b"c\nd\ne\n");
        let (h, got) = resume_via(Arc::new(Junk), &p, kept, Box::new(Lines));
        tokio::time::sleep(Duration::from_millis(400)).await;
        {
            let ev = got.lock().unwrap();
            assert!(matches!(&ev[0], ChatEvent::Reset { total: 5, .. }), "{ev:?}");
            assert_eq!(texts(&ev[0]), ["a", "b", "c", "d", "e"]);
        }
        let kept = h.freeze().take(Duration::from_millis(500)).expect("kept");
        assert_eq!((kept.offset, kept.items.len()), (10, 5));
    }

    #[test]
    fn a_resumed_tail_without_a_header_keeps_what_it_read() {
        let mut st = state(Box::new(Lines));
        st.items.lock().unwrap().push(ChatItem::User { id: None, text: "a".into(), ts: None, images: vec![], skills: vec![] });
        st.offset = 2;
        st.fresh = Some(Box::new(Lines));
        let slot = st.kept.clone();
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        tx.blocking_send(Msg::Header(None)).unwrap();
        tx.blocking_send(Msg::Line(b"b".to_vec(), 2)).unwrap();
        drop(tx);
        parse_loop(st, rx);
        let kept = slot.take(Duration::from_millis(10)).expect("kept");
        assert_eq!((kept.offset, kept.items.len()), (4, 2));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pi_an_entry_appended_after_a_resume_attaches_to_its_parent_from_before_the_freeze() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        let entry = |id: &str, parent: Option<&str>, text: &str| {
            format!("{}\n", serde_json::json!({"type":"message","id":id,"parentId":parent,"message":{"role":"user","content":text}}))
        };
        std::fs::write(&p, entry("a", None, "A") + &entry("b", Some("a"), "B")).unwrap();
        let t: Arc<dyn crate::transport::Transport> = Arc::new(crate::transport::local::LocalTransport);
        let kept = frozen_via(t.clone(), &p, Box::new(crate::transcript::pi::PiParser::default())).await;
        append(&p, entry("c", Some("a"), "C").as_bytes());
        let (_h, got) = resume_via(t, &p, kept, Box::new(crate::transcript::pi::PiParser::default()));
        tokio::time::sleep(Duration::from_millis(400)).await;
        let ev = got.lock().unwrap();
        assert_eq!(texts(&ev[0]), ["A", "C"], "{ev:?}");
    }
}
