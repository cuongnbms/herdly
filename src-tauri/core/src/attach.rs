//! Terminal attach manager: one PTY-backed `herdr terminal attach` child per Terminal,
//! with ack-based flow control, held-attach detection and idle detach.
use crate::error::{AppError, AppResult};
use crate::transport::{herdr_argv, MachineInfo};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const READ_CHUNK: usize = 64 * 1024;
const HIGH_WATER: usize = 1 << 20;
const LOW_WATER: usize = 512 * 1024;
/// Reads within this window of a batch's first read go out as one sink message. At 2ms
/// keystroke echo stays far under a frame, so no interactive fast path is needed.
const COALESCE: Duration = Duration::from_millis(2);
/// Read chunks queued ahead of the forwarder while flow control pauses it.
const READ_QUEUE: usize = 4;
const WRITE_CHUNK: usize = 16 * 1024;
const HELD_SCAN: usize = 4096;
const HELD_MARKER: &[u8] = b"already has an attached client";
/// How long the exit watcher waits for the reader to drain trailing output.
const DRAIN_GRACE: Duration = Duration::from_millis(250);
/// `Attached` waits this long after the first byte so a refusal message (which follows
/// terminal-reset escape sequences) can still be recognised as `Held`.
const ATTACH_SETTLE: Duration = Duration::from_millis(400);
/// `herdr terminal attach` (0.9.5) asks the outer terminal about SGR-pixel mouse (DECRQM 1016, then
/// DA1 as the sentinel) and waits only 250ms, counted from when it sent the probe, before
/// handing stdin to the pane. A reply that lands later reaches the shell prompt as typed
/// text (`1016;2$y1;2c`). The reader keeps the probe from xterm.js (too slow over ssh plus
/// the frontend round trip) and answers it itself, but only within PROBE_ANSWER_WINDOW.
const PROBE: &[u8] = b"\x1b[?1016$p\x1b[c";
/// What xterm.js 6.0 answers before any mouse mode is set: 1016 reset, VT100 with AVO.
const PROBE_REPLY: &[u8] = b"\x1b[?1016;2$y\x1b[?1;2c";
/// A probe that reaches us later than this after spawn crossed a slow link (opening a
/// workspace streams session logs over the same ssh master, and probes then arrive 1-2s
/// late), so a reply would miss herdr's deadline and land at the prompt. Left unanswered,
/// herdr just times out: it only uses pixel mouse with exact pixel geometry, which our PTY
/// never reports. Unloaded, probes arrive in 30-140ms and the spawn alone costs a round trip.
const PROBE_ANSWER_WINDOW: Duration = Duration::from_millis(150);

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AttachKey {
    pub machine_id: String,
    pub session: String,
    pub terminal_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AttachEvent {
    Attached,
    Held,
    Exited { code: Option<i32> },
    Detached,
}

pub trait Sink: Send + Sync {
    fn data(&self, bytes: Vec<u8>);
    fn event(&self, e: AttachEvent);
}

/// `herdr [--session S] terminal attach <terminal_id> [--takeover]`. herdr 0.9.3 rejects
/// `--takeover` ahead of the id ("unknown option: <terminal_id>").
pub fn attach_argv(
    info: &MachineInfo,
    session: &str,
    terminal_id: &str,
    takeover: bool,
) -> Vec<String> {
    let mut args = vec!["terminal", "attach", terminal_id];
    if takeover {
        args.push("--takeover");
    }
    herdr_argv(info, session, &args)
}

type Entries = Arc<Mutex<HashMap<AttachKey, Arc<Entry>>>>;

struct Entry {
    key: AttachKey,
    sink: Mutex<Arc<dyn Sink>>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Bytes forwarded to the sink and not yet acknowledged.
    unacked: Mutex<usize>,
    resume: Condvar,
    /// Set once by whoever ends the attach (detach or child exit).
    closed: AtomicBool,
    held: AtomicBool,
    /// `Attached` has been emitted (at most once per child).
    attached: AtomicBool,
    /// Bumped by `open`/`release` so a stale idle timer does nothing.
    generation: AtomicU64,
    handle: Option<tokio::runtime::Handle>,
    spawned: Instant,
}

impl Entry {
    fn sink(&self) -> Arc<dyn Sink> {
        self.sink.lock().unwrap().clone()
    }
    /// Emit `Attached` once, unless the attach was refused or has ended.
    fn emit_attached(&self) {
        if !self.held.load(Ordering::SeqCst)
            && !self.closed.load(Ordering::SeqCst)
            && !self.attached.swap(true, Ordering::SeqCst)
        {
            self.sink().event(AttachEvent::Attached);
        }
    }
    fn wake_reader(&self) {
        // Take the lock so a reader between its check and its wait cannot miss the wakeup.
        let _g = self.unacked.lock().unwrap();
        self.resume.notify_all();
    }
}

pub struct AttachManager {
    idle: Duration,
    entries: Entries,
    /// One lock per key in use. Same-key `open`, `release` and `close` (and `write`'s lookup)
    /// stay ordered while a spawn runs outside `entries`, so other keys never wait on it.
    keys: Mutex<HashMap<AttachKey, Arc<Mutex<()>>>>,
    /// Runs in `open` just before the PTY is spawned, so tests can hold a spawn in flight.
    #[cfg(test)]
    before_spawn: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl AttachManager {
    pub fn new(idle: Duration) -> Arc<Self> {
        Arc::new(Self {
            idle,
            entries: Arc::new(Mutex::new(HashMap::new())),
            keys: Mutex::new(HashMap::new()),
            #[cfg(test)]
            before_spawn: Mutex::new(None),
        })
    }

    fn get(&self, key: &AttachKey) -> AppResult<Arc<Entry>> {
        self.entries
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "not_found",
                    format!("terminal {} is not attached", key.terminal_id),
                )
            })
    }

    /// Run `f` under `key`'s lock, dropping the lock from `keys` once nobody else wants it.
    fn with_key<R>(&self, key: &AttachKey, f: impl FnOnce() -> R) -> R {
        let lock = self
            .keys
            .lock()
            .unwrap()
            .entry(key.clone())
            .or_default()
            .clone();
        let r = {
            let _g = lock.lock().unwrap_or_else(|p| p.into_inner());
            f()
        };
        let mut keys = self.keys.lock().unwrap();
        // Clones are only taken under `keys`: two holders means the map and this call.
        if Arc::strong_count(&lock) == 2 {
            keys.remove(key);
        }
        r
    }

    /// Spawn `argv` verbatim on a PTY, or reuse the live attach for `key`.
    pub fn open(
        &self,
        key: AttachKey,
        argv: Vec<String>,
        cols: u16,
        rows: u16,
        sink: Arc<dyn Sink>,
    ) -> AppResult<()> {
        // The key's lock spans check + spawn + insert, so concurrent opens of one key cannot
        // both spawn; `entries` is only held briefly, so other keys never wait on a spawn.
        self.with_key(&key.clone(), || {
            self.open_locked(key, argv, cols, rows, sink)
        })
    }

    /// `open` on a blocking thread: openpty and fork/exec block, and a second open of the
    /// same key waits for the first.
    pub async fn open_async(
        self: &Arc<Self>,
        key: AttachKey,
        argv: Vec<String>,
        cols: u16,
        rows: u16,
        sink: Arc<dyn Sink>,
    ) -> AppResult<()> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.open(key, argv, cols, rows, sink))
            .await
            .map_err(|e| AppError::new("io", format!("terminal open task failed: {e}")))?
    }

    fn open_locked(
        &self,
        key: AttachKey,
        argv: Vec<String>,
        cols: u16,
        rows: u16,
        sink: Arc<dyn Sink>,
    ) -> AppResult<()> {
        let mut map = self.entries.lock().unwrap();
        if let Some(e) = map.get(&key).cloned() {
            if e.held.load(Ordering::SeqCst) || e.closed.load(Ordering::SeqCst) {
                // Refused or ending: the old child is useless, respawn with the new argv.
                map.remove(&key);
                retire(&e);
            } else {
                *e.sink.lock().unwrap() = sink.clone();
                e.generation.fetch_add(1, Ordering::SeqCst);
                // Output sent to the previous (gone) sink was never acked; start fresh.
                *e.unacked.lock().unwrap() = 0;
                e.resume.notify_all();
                if let Some(m) = e.master.lock().unwrap().as_ref() {
                    let _ = m.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                // Not yet attached: the settle thread will announce it to the new sink.
                if e.attached.load(Ordering::SeqCst) {
                    sink.event(AttachEvent::Attached);
                }
                return Ok(());
            }
        }
        drop(map);
        let program = argv
            .first()
            .ok_or_else(|| AppError::new("invalid", "empty command"))?;
        #[cfg(test)]
        if let Some(f) = self.before_spawn.lock().unwrap().clone() {
            f();
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::new("io", e.to_string()))?;
        let spawned = Instant::now();
        let mut cmd = CommandBuilder::new(program);
        cmd.args(&argv[1..]);
        cmd.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::new("io", e.to_string()))?;
        drop(pair.slave);
        let io = pair
            .master
            .try_clone_reader()
            .and_then(|r| pair.master.take_writer().map(|w| (r, w)))
            .map_err(|e| AppError::new("io", e.to_string()));
        let (reader, writer) = match io {
            Ok(rw) => rw,
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        };
        let entry = Arc::new(Entry {
            key: key.clone(),
            sink: Mutex::new(sink),
            writer: Mutex::new(writer),
            master: Mutex::new(Some(pair.master)),
            killer: Mutex::new(child.clone_killer()),
            unacked: Mutex::new(0),
            resume: Condvar::new(),
            closed: AtomicBool::new(false),
            held: AtomicBool::new(false),
            attached: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            handle: tokio::runtime::Handle::try_current().ok(),
            spawned,
        });
        self.entries.lock().unwrap().insert(key, entry.clone());

        let (done_tx, done_rx) = mpsc::channel::<()>();
        let e = entry.clone();
        std::thread::spawn(move || {
            read_loop(&e, reader);
            let _ = done_tx.send(());
        });
        // Exit is detected by waiting on the child, not on reader EOF: a forked
        // descendant (`ssh -f`) can keep the PTY slave open indefinitely.
        let e = entry;
        let entries = self.entries.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            let _ = done_rx.recv_timeout(DRAIN_GRACE);
            if !e.closed.swap(true, Ordering::SeqCst) {
                remove_if_same(&entries, &e);
                if !e.held.load(Ordering::SeqCst) {
                    if !e.attached.swap(true, Ordering::SeqCst) {
                        e.sink().event(AttachEvent::Attached);
                    }
                    e.sink().event(AttachEvent::Exited { code });
                }
            }
            e.master.lock().unwrap().take();
            e.wake_reader();
        });
        Ok(())
    }

    pub fn write(&self, key: &AttachKey, data: &[u8]) -> AppResult<()> {
        // Only the lookup waits for an in-flight open; a blocked write must never hold the
        // key's lock, or `close` could not end a wedged terminal.
        let e = self.with_key(key, || self.get(key))?;
        let mut w = e.writer.lock().unwrap();
        for chunk in data.chunks(WRITE_CHUNK) {
            w.write_all(chunk)?;
        }
        w.flush()?;
        Ok(())
    }

    /// `write` on a blocking thread: a PTY write can block (a full buffer behind a wedged
    /// ssh connection) and must not stall a tokio worker.
    pub async fn write_async(self: &Arc<Self>, key: AttachKey, data: Vec<u8>) -> AppResult<()> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.write(&key, &data))
            .await
            .map_err(|e| AppError::new("io", format!("terminal write task failed: {e}")))?
    }

    pub fn resize(&self, key: &AttachKey, cols: u16, rows: u16) -> AppResult<()> {
        let e = self.get(key)?;
        let master = e.master.lock().unwrap();
        let m = master
            .as_ref()
            .ok_or_else(|| AppError::new("not_found", "terminal has exited"))?;
        m.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::new("io", e.to_string()))
    }

    pub fn ack(&self, key: &AttachKey, bytes: usize) {
        if let Ok(e) = self.get(key) {
            let mut n = e.unacked.lock().unwrap();
            *n = n.saturating_sub(bytes);
            e.resume.notify_all();
        }
    }

    /// Detach after the idle period unless the key is reopened meanwhile.
    pub fn release(&self, key: &AttachKey) {
        // Under the key's lock: a release queued behind an in-flight open must find its
        // entry, and an open that follows must see this generation bump.
        let found = self.with_key(key, || {
            let e = self.get(key).ok()?;
            Some((e.generation.fetch_add(1, Ordering::SeqCst) + 1, e))
        });
        let Some((generation, e)) = found else { return };
        let entries = self.entries.clone();
        let idle = self.idle;
        let fire = move |e: Arc<Entry>| {
            if e.generation.load(Ordering::SeqCst) == generation {
                detach(&entries, &e);
            }
        };
        match tokio::runtime::Handle::try_current()
            .ok()
            .or_else(|| e.handle.clone())
        {
            Some(h) => {
                h.spawn(async move {
                    tokio::time::sleep(idle).await;
                    fire(e);
                });
            }
            None => {
                std::thread::spawn(move || {
                    std::thread::sleep(idle);
                    fire(e);
                });
            }
        }
    }

    pub fn close(&self, key: &AttachKey) {
        self.with_key(key, || {
            if let Ok(e) = self.get(key) {
                detach(&self.entries, &e);
            }
        });
    }

    /// `release` on a blocking thread: it waits for an in-flight open of the same key.
    pub async fn release_async(self: &Arc<Self>, key: AttachKey) {
        let me = self.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || me.release(&key)).await {
            tracing::warn!("terminal release task failed: {e}");
        }
    }

    /// `close` on a blocking thread: it waits for an in-flight open of the same key.
    pub async fn close_async(self: &Arc<Self>, key: AttachKey) {
        let me = self.clone();
        if let Err(e) = tokio::task::spawn_blocking(move || me.close(&key)).await {
            tracing::warn!("terminal close task failed: {e}");
        }
    }

    /// Close the Machine's Session terminals only; the Machine-level terminals
    /// (empty session, e.g. the interactive ssh master) are left alone.
    pub fn close_machine_sessions(&self, machine_id: &str) {
        let list: Vec<Arc<Entry>> = self
            .entries
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.key.machine_id == machine_id && !e.key.session.is_empty())
            .cloned()
            .collect();
        for e in list {
            detach(&self.entries, &e);
        }
    }

    /// Does not wait for an open of this Machine that is still spawning (it is not in
    /// `entries` yet); over a dead ssh master that attach exits 255 and reports `Detached`.
    pub fn close_machine(&self, machine_id: &str) {
        let list: Vec<Arc<Entry>> = self
            .entries
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.key.machine_id == machine_id)
            .cloned()
            .collect();
        for e in list {
            detach(&self.entries, &e);
        }
    }
}

fn remove_if_same(entries: &Entries, e: &Arc<Entry>) {
    let mut map = entries.lock().unwrap();
    if map.get(&e.key).is_some_and(|cur| Arc::ptr_eq(cur, e)) {
        map.remove(&e.key);
    }
}

/// End an entry that is already out of the map, without emitting events.
fn retire(e: &Arc<Entry>) {
    e.closed.store(true, Ordering::SeqCst);
    let _ = e.killer.lock().unwrap().kill();
    e.master.lock().unwrap().take();
    e.wake_reader();
}

fn detach(entries: &Entries, e: &Arc<Entry>) {
    if e.closed.swap(true, Ordering::SeqCst) {
        return;
    }
    remove_if_same(entries, e);
    let _ = e.killer.lock().unwrap().kill();
    e.sink().event(AttachEvent::Detached);
    e.master.lock().unwrap().take();
    e.wake_reader();
}

fn read_loop(e: &Arc<Entry>, mut reader: Box<dyn Read + Send>) {
    // PTY reads block, so a separate thread reads and this one coalesces and forwards.
    // The bounded queue keeps the reader blocked while flow control pauses forwarding.
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(READ_QUEUE);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            if tx.send(buf[..n].to_vec()).is_err() {
                return;
            }
        }
    });
    let mut head: Vec<u8> = Vec::new();
    let mut first = true;
    let mut probe = ProbeFilter::default();
    coalesce(&rx, COALESCE, |bytes| {
        if e.closed.load(Ordering::SeqCst) {
            return false;
        }
        let sink = e.sink();
        if head.len() < HELD_SCAN {
            head.extend_from_slice(&bytes[..bytes.len().min(HELD_SCAN - head.len())]);
            if !e.held.load(Ordering::SeqCst)
                && head.windows(HELD_MARKER.len()).any(|w| w == HELD_MARKER)
            {
                e.held.store(true, Ordering::SeqCst);
                sink.event(AttachEvent::Held);
            }
        }
        if first {
            first = false;
            let e = e.clone();
            std::thread::spawn(move || {
                std::thread::sleep(ATTACH_SETTLE);
                e.emit_attached();
            });
        } else if head.len() >= HELD_SCAN {
            e.emit_attached();
        }
        let (bytes, asked) = probe.feed(bytes);
        if asked && e.spawned.elapsed() >= PROBE_ANSWER_WINDOW {
            tracing::debug!("terminal probe arrived late; leaving it unanswered");
        } else if asked {
            let mut w = e.writer.lock().unwrap();
            if let Err(err) = w.write_all(PROBE_REPLY).and_then(|_| w.flush()) {
                tracing::warn!("terminal probe reply failed: {err}");
            }
        }
        if bytes.is_empty() {
            return !e.closed.load(Ordering::SeqCst);
        }
        let n = bytes.len();
        // Charge the bytes before handing them to the sink, and release the credit lock first:
        // a sink that acknowledges synchronously inside `data` would otherwise acknowledge
        // bytes this batch adds right after it returns, leaving them unacked forever, and it
        // would deadlock against a lock held across the callback.
        {
            let mut unacked = e.unacked.lock().unwrap();
            *unacked += n;
        }
        sink.data(bytes);
        let mut unacked = e.unacked.lock().unwrap();
        if *unacked > HIGH_WATER {
            while *unacked >= LOW_WATER && !e.closed.load(Ordering::SeqCst) {
                unacked = e.resume.wait(unacked).unwrap();
            }
        }
        !e.closed.load(Ordering::SeqCst)
    });
}

/// Takes herdr's startup `PROBE` out of the first HELD_SCAN bytes of output, once. A tail
/// that could start the probe is held back until the next read settles it.
#[derive(Default)]
struct ProbeFilter {
    done: bool,
    scanned: usize,
    carry: Vec<u8>,
}

impl ProbeFilter {
    /// The bytes to forward, and whether the probe was found in them.
    fn feed(&mut self, bytes: Vec<u8>) -> (Vec<u8>, bool) {
        if self.done {
            return (bytes, false);
        }
        self.scanned += bytes.len();
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(&bytes);
        if let Some(i) = buf.windows(PROBE.len()).position(|w| w == PROBE) {
            self.done = true;
            buf.drain(i..i + PROBE.len());
            return (buf, true);
        }
        if self.scanned >= HELD_SCAN {
            self.done = true;
            return (buf, false);
        }
        let keep = (1..PROBE.len().min(buf.len() + 1))
            .rev()
            .find(|&k| buf.ends_with(&PROBE[..k]))
            .unwrap_or(0);
        self.carry = buf.split_off(buf.len() - keep);
        (buf, false)
    }
}

/// Merge reads that arrive within `window` of a batch's first read, up to READ_CHUNK,
/// and hand each batch to `forward` until it returns false or the reader ends.
fn coalesce(
    rx: &mpsc::Receiver<Vec<u8>>,
    window: Duration,
    mut forward: impl FnMut(Vec<u8>) -> bool,
) {
    let mut carry: Option<Vec<u8>> = None;
    loop {
        let mut batch = match carry.take().map_or_else(|| rx.recv(), Ok) {
            Ok(b) => b,
            Err(_) => return,
        };
        let deadline = Instant::now() + window;
        let mut ended = false;
        while batch.len() < READ_CHUNK {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                // Never exceed READ_CHUNK: the flow-control overshoot stays one chunk.
                Ok(c) if batch.len() + c.len() > READ_CHUNK => {
                    carry = Some(c);
                    break;
                }
                Ok(c) => batch.extend_from_slice(&c),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    ended = true;
                    break;
                }
            }
        }
        if !forward(batch) || ended {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;
    use std::time::Duration;

    /// Closes the attach even when a test fails or times out, from a helper thread so a
    /// reader wedged in a callback cannot hang the test binary.
    struct Close(Arc<AttachManager>, AttachKey);
    impl Drop for Close {
        fn drop(&mut self) {
            close_bounded(&self.0, &self.1);
        }
    }

    /// `close` from a helper thread, so a reader wedged inside its callback fails the test
    /// instead of hanging it. Returns false when `close` did not return in time.
    fn close_bounded(m: &Arc<AttachManager>, k: &AttachKey) -> bool {
        let (m, k) = (m.clone(), k.clone());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            m.close(&k);
            let _ = tx.send(());
        });
        rx.recv_timeout(Duration::from_secs(5)).is_ok()
    }

    #[derive(Default)]
    struct Rec {
        bytes: Mutex<Vec<u8>>,
        events: Mutex<Vec<AttachEvent>>,
    }
    impl Sink for Rec {
        fn data(&self, b: Vec<u8>) {
            self.bytes.lock().unwrap().extend(b)
        }
        fn event(&self, e: AttachEvent) {
            self.events.lock().unwrap().push(e)
        }
    }
    fn key(t: &str) -> AttachKey {
        AttachKey {
            machine_id: "local".into(),
            session: "default".into(),
            terminal_id: t.into(),
        }
    }
    fn sh(cmd: &str) -> Vec<String> {
        vec!["sh".into(), "-c".into(), cmd.into()]
    }
    async fn wait_for(cond: impl Fn() -> bool) {
        for _ in 0..100 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        panic!("timed out");
    }

    /// Hold every `open` just before its spawn until the returned sender is dropped.
    /// Returns (spawns entered, release, spawn count).
    fn gate_spawn(m: &AttachManager) -> (mpsc::Receiver<()>, mpsc::Sender<()>, Arc<AtomicU64>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let (entered_tx, go_rx) = (Mutex::new(entered_tx), Mutex::new(go_rx));
        let count = Arc::new(AtomicU64::new(0));
        let n = count.clone();
        *m.before_spawn.lock().unwrap() = Some(Arc::new(move || {
            n.fetch_add(1, Ordering::SeqCst);
            let _ = entered_tx.lock().unwrap().send(());
            let _ = go_rx.lock().unwrap().recv();
        }));
        (entered_rx, go_tx, count)
    }

    fn batches(chunks: Vec<Vec<u8>>, gap: Option<(usize, Duration)>) -> Vec<Vec<u8>> {
        let (tx, rx) = mpsc::sync_channel(chunks.len());
        match gap {
            // Queued up front: deterministic, no dependence on thread scheduling.
            None => chunks.into_iter().for_each(move |c| tx.send(c).unwrap()),
            Some((at, d)) => {
                std::thread::spawn(move || {
                    for (i, c) in chunks.into_iter().enumerate() {
                        if i == at {
                            std::thread::sleep(d);
                        }
                        tx.send(c).unwrap();
                    }
                });
            }
        }
        let mut out = Vec::new();
        coalesce(&rx, COALESCE, |b| {
            out.push(b);
            true
        });
        out
    }

    #[test]
    fn coalesces_small_reads_into_one_send() {
        let out = batches((0..50).map(|i| vec![i as u8; 10]).collect(), None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), 500);
        assert!(out[0].starts_with(&[0; 10]) && out[0].ends_with(&[49; 10]));
    }
    #[test]
    fn coalesced_sends_never_exceed_read_chunk() {
        let out = batches(vec![vec![1u8; 10 * 1024]; 10], None);
        let sizes: Vec<usize> = out.iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![60 * 1024, 40 * 1024]);
    }
    #[test]
    fn coalescing_window_does_not_hold_later_reads() {
        let out = batches(
            vec![b"a".to_vec(), b"b".to_vec()],
            Some((1, Duration::from_millis(50))),
        );
        assert_eq!(out, vec![b"a".to_vec(), b"b".to_vec()]);
    }
    #[test]
    fn coalesce_stops_when_forward_declines() {
        let (tx, rx) = mpsc::sync_channel(4);
        tx.send(b"a".to_vec()).unwrap();
        let mut n = 0;
        coalesce(&rx, COALESCE, |_| {
            n += 1;
            false
        });
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn echoes_input_and_reports_exit() {
        let m = AttachManager::new(Duration::from_millis(200));
        let rec = Arc::new(Rec::default());
        m.open(
            key("a"),
            sh("read l; echo got:$l; exit 3"),
            80,
            24,
            rec.clone(),
        )
        .unwrap();
        m.write(&key("a"), b"hello\n").unwrap();
        wait_for(|| {
            rec.events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, AttachEvent::Exited { .. }))
        })
        .await;
        assert!(String::from_utf8_lossy(&rec.bytes.lock().unwrap()).contains("got:hello"));
        assert!(rec.events.lock().unwrap().contains(&AttachEvent::Attached));
        assert!(rec
            .events
            .lock()
            .unwrap()
            .contains(&AttachEvent::Exited { code: Some(3) }));
    }
    #[tokio::test]
    async fn write_async_delivers_input() {
        let m = AttachManager::new(Duration::from_millis(200));
        let rec = Arc::new(Rec::default());
        m.open(key("w"), sh("read l; echo got:$l"), 80, 24, rec.clone())
            .unwrap();
        m.write_async(key("w"), b"async\n".to_vec()).await.unwrap();
        wait_for(|| String::from_utf8_lossy(&rec.bytes.lock().unwrap()).contains("got:async"))
            .await;
        assert_eq!(
            m.write_async(key("nope"), b"x".to_vec())
                .await
                .unwrap_err()
                .code,
            "not_found"
        );
    }
    #[tokio::test]
    async fn detects_held_attach() {
        let m = AttachManager::new(Duration::from_millis(200));
        let rec = Arc::new(Rec::default());
        m.open(key("b"), sh("echo 'herdr: server shut down: terminal attach failed: terminal term_b already has an attached client; retry with --takeover'; exit 1"), 80, 24, rec.clone()).unwrap();
        wait_for(|| rec.events.lock().unwrap().contains(&AttachEvent::Held)).await;
        assert!(!rec.events.lock().unwrap().contains(&AttachEvent::Attached));
    }
    #[tokio::test]
    async fn reader_pauses_without_acks() {
        let m = AttachManager::new(Duration::from_secs(5));
        let rec = Arc::new(Rec::default());
        m.open(
            key("c"),
            sh("yes 0123456789abcdef | head -c 8000000"),
            80,
            24,
            rec.clone(),
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        let got = rec.bytes.lock().unwrap().len();
        assert!(got <= (1 << 20) + 65536, "read {got} bytes without acks");
        m.ack(&key("c"), got);
        wait_for(|| rec.bytes.lock().unwrap().len() > got).await;
        m.close(&key("c"));
    }
    #[tokio::test]
    async fn immediate_sink_ack_leaves_no_outstanding_debt() {
        struct Immediate {
            manager: Arc<AttachManager>,
            key: AttachKey,
            balance: Mutex<Option<(usize, usize)>>,
        }
        impl Sink for Immediate {
            fn data(&self, bytes: Vec<u8>) {
                let entry = self.manager.get(&self.key).unwrap();
                let before = *entry.unacked.lock().unwrap();
                self.manager.ack(&self.key, bytes.len());
                let after = *entry.unacked.lock().unwrap();
                *self.balance.lock().unwrap() = Some((before, after));
            }
            fn event(&self, _: AttachEvent) {}
        }
        let manager = AttachManager::new(Duration::from_secs(5));
        let k = key("instant-ack");
        let sink = Arc::new(Immediate {
            manager: manager.clone(),
            key: k.clone(),
            balance: Mutex::new(None),
        });
        manager
            .open(
                k.clone(),
                sh("printf ready; sleep 30"),
                80,
                24,
                sink.clone(),
            )
            .unwrap();
        let _close = Close(manager.clone(), k.clone());
        wait_for(|| sink.balance.lock().unwrap().is_some()).await;
        let balance = *sink.balance.lock().unwrap();
        assert!(close_bounded(&manager, &k), "close must not hang");
        assert_eq!(balance, Some((5, 0)));
    }
    #[tokio::test]
    async fn immediate_acks_keep_output_flowing_above_the_high_water_mark() {
        struct StreamAcks {
            manager: Arc<AttachManager>,
            key: AttachKey,
            received: AtomicUsize,
        }
        impl Sink for StreamAcks {
            fn data(&self, bytes: Vec<u8>) {
                self.received.fetch_add(bytes.len(), Ordering::SeqCst);
                // Acknowledged before `data` returns: flow control must not stop the reader.
                self.manager.ack(&self.key, bytes.len());
            }
            fn event(&self, _: AttachEvent) {}
        }
        // Past the pause threshold, several times over.
        const TOTAL: usize = HIGH_WATER + READ_CHUNK + 1_000_000;
        let manager = AttachManager::new(Duration::from_secs(5));
        let k = key("stream-acks");
        let sink = Arc::new(StreamAcks {
            manager: manager.clone(),
            key: k.clone(),
            received: AtomicUsize::new(0),
        });
        // `/dev/zero` keeps the byte count exact: the PTY's ONLCR would inflate `yes` output.
        manager
            .open(
                k.clone(),
                sh(&format!("head -c {TOTAL} /dev/zero")),
                80,
                24,
                sink.clone(),
            )
            .unwrap();
        let _close = Close(manager.clone(), k.clone());
        let entry = manager.get(&k).unwrap();
        // The exit watcher removes the entry only once the child exited and the reader drained,
        // so the balance below is read after the reader's last delivery, without a sleep.
        let mut drained = false;
        for _ in 0..200 {
            if !manager.entries.lock().unwrap().contains_key(&k) {
                drained = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let got = sink.received.load(Ordering::SeqCst);
        let debt = *entry.unacked.lock().unwrap();
        assert!(drained, "the stream never finished and drained");
        assert_eq!(
            got, TOTAL,
            "a sink that acknowledges inside `data` must not stall the reader above HIGH_WATER"
        );
        assert_eq!(
            debt, 0,
            "bytes acknowledged inside `data` must not stay outstanding after delivery"
        );
    }
    #[tokio::test]
    async fn release_detaches_after_idle_unless_reopened() {
        let m = AttachManager::new(Duration::from_millis(200));
        let rec = Arc::new(Rec::default());
        m.open(key("d"), sh("sleep 30"), 80, 24, rec.clone())
            .unwrap();
        m.release(&key("d"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        m.open(key("d"), sh("sleep 30"), 100, 30, rec.clone())
            .unwrap(); // reuse, no second process
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!rec.events.lock().unwrap().contains(&AttachEvent::Detached));
        m.release(&key("d"));
        wait_for(|| rec.events.lock().unwrap().contains(&AttachEvent::Detached)).await;
    }
    #[tokio::test]
    async fn reopen_after_unacked_backlog_still_delivers() {
        let m = AttachManager::new(Duration::from_secs(5));
        let old = Arc::new(Rec::default());
        m.open(
            key("e"),
            sh("yes 0123456789abcdef | head -c 8000000"),
            80,
            24,
            old.clone(),
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(old.bytes.lock().unwrap().len() > (1 << 20));
        m.release(&key("e"));
        let new = Arc::new(Rec::default());
        m.open(key("e"), sh("sleep 30"), 80, 24, new.clone())
            .unwrap();
        wait_for(|| !new.bytes.lock().unwrap().is_empty()).await;
        m.close(&key("e"));
    }
    #[tokio::test]
    async fn reopen_of_held_key_respawns_with_new_argv() {
        let m = AttachManager::new(Duration::from_secs(5));
        let old = Arc::new(Rec::default());
        m.open(
            key("f"),
            sh("echo 'already has an attached client'; sleep 2"),
            80,
            24,
            old.clone(),
        )
        .unwrap();
        wait_for(|| old.events.lock().unwrap().contains(&AttachEvent::Held)).await;
        let new = Arc::new(Rec::default());
        m.open(key("f"), sh("echo fresh; sleep 5"), 80, 24, new.clone())
            .unwrap();
        wait_for(|| String::from_utf8_lossy(&new.bytes.lock().unwrap()).contains("fresh")).await;
        wait_for(|| new.events.lock().unwrap().contains(&AttachEvent::Attached)).await;
        assert!(!new.events.lock().unwrap().contains(&AttachEvent::Held));
        m.close(&key("f"));
    }
    #[tokio::test]
    async fn close_while_reader_paused_detaches() {
        let m = AttachManager::new(Duration::from_secs(5));
        let rec = Arc::new(Rec::default());
        m.open(
            key("g"),
            sh("yes 0123456789abcdef | head -c 8000000"),
            80,
            24,
            rec.clone(),
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        m.close(&key("g"));
        wait_for(|| rec.events.lock().unwrap().contains(&AttachEvent::Detached)).await;
    }
    #[tokio::test]
    async fn other_keys_do_not_wait_for_a_spawn() {
        let m = AttachManager::new(Duration::from_secs(5));
        let rec = Arc::new(Rec::default());
        m.open(
            key("y"),
            sh("read l; echo got:$l; sleep 30"),
            80,
            24,
            rec.clone(),
        )
        .unwrap();
        let (entered, go, _) = gate_spawn(&m);
        let m2 = m.clone();
        let opening = std::thread::spawn(move || {
            m2.open(key("x"), sh("sleep 30"), 80, 24, Arc::new(Rec::default()))
        });
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let m3 = m.clone();
        std::thread::spawn(move || {
            m3.ack(&key("y"), 1);
            m3.resize(&key("y"), 100, 30).unwrap();
            m3.write(&key("y"), b"hi\n").unwrap();
            let _ = done_tx.send(());
        });
        let finished = done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        drop(go);
        opening.join().unwrap().unwrap();
        assert!(finished, "key y waited for key x's spawn");
        wait_for(|| String::from_utf8_lossy(&rec.bytes.lock().unwrap()).contains("got:hi")).await;
        m.close(&key("x"));
        m.close(&key("y"));
    }
    #[tokio::test]
    async fn concurrent_opens_of_one_key_spawn_once() {
        let m = AttachManager::new(Duration::from_secs(5));
        let (entered, go, spawns) = gate_spawn(&m);
        let open = |m: Arc<AttachManager>| {
            std::thread::spawn(move || {
                m.open(key("s"), sh("sleep 30"), 80, 24, Arc::new(Rec::default()))
            })
        };
        let first = open(m.clone());
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let second = open(m.clone());
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !second.is_finished(),
            "the second open must wait for the first"
        );
        drop(go);
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();
        assert_eq!(spawns.load(Ordering::SeqCst), 1);
        assert_eq!(m.entries.lock().unwrap().len(), 1);
        m.close(&key("s"));
    }
    #[tokio::test]
    async fn release_behind_a_spawn_still_detaches() {
        let m = AttachManager::new(Duration::from_millis(200));
        let rec = Arc::new(Rec::default());
        let (entered, go, _) = gate_spawn(&m);
        let m2 = m.clone();
        let r = rec.clone();
        let opening = std::thread::spawn(move || m2.open(key("r"), sh("sleep 30"), 80, 24, r));
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let m3 = m.clone();
        let releasing = std::thread::spawn(move || m3.release(&key("r")));
        std::thread::sleep(Duration::from_millis(50));
        drop(go);
        opening.join().unwrap().unwrap();
        releasing.join().unwrap();
        wait_for(|| rec.events.lock().unwrap().contains(&AttachEvent::Detached)).await;
    }
    #[tokio::test]
    async fn async_open_and_release_round_trip() {
        let m = AttachManager::new(Duration::from_millis(200));
        let rec = Arc::new(Rec::default());
        m.open_async(key("h"), sh("sleep 30"), 80, 24, rec.clone())
            .await
            .unwrap();
        // Spawned on a blocking thread, the entry still gets the runtime for its idle timer.
        assert!(m.entries.lock().unwrap()[&key("h")].handle.is_some());
        assert!(
            m.keys.lock().unwrap().is_empty(),
            "key locks are dropped once unused"
        );
        m.release_async(key("h")).await;
        wait_for(|| rec.events.lock().unwrap().contains(&AttachEvent::Detached)).await;
        m.close_async(key("h")).await;
    }
    #[tokio::test]
    async fn answers_the_startup_probe_without_forwarding_it() {
        let m = AttachManager::new(Duration::from_secs(5));
        let rec = Arc::new(Rec::default());
        let n = PROBE_REPLY.len();
        let cmd =
            format!(r"stty raw -echo; printf '\033[?1016$p\033[c'; head -c {n} | tr '\033' E");
        m.open(key("p"), sh(&cmd), 80, 24, rec.clone()).unwrap();
        wait_for(|| String::from_utf8_lossy(&rec.bytes.lock().unwrap()).contains("E[?1;2c")).await;
        let out = rec.bytes.lock().unwrap().clone();
        assert!(String::from_utf8_lossy(&out).contains("E[?1016;2$yE[?1;2c"));
        assert!(!out.windows(PROBE.len()).any(|w| w == PROBE));
        m.close(&key("p"));
    }
    #[tokio::test]
    async fn leaves_a_late_probe_unanswered() {
        let m = AttachManager::new(Duration::from_secs(5));
        let rec = Arc::new(Rec::default());
        let wait = PROBE_ANSWER_WINDOW.as_millis() as f64 / 1000.0 + 0.1;
        let cmd = format!(
            r"stty raw -echo min 0 time 5; sleep {wait}; printf '\033[?1016$p\033[c'; echo got[$(head -c 1 | tr '\033' E)]"
        );
        m.open(key("late"), sh(&cmd), 80, 24, rec.clone()).unwrap();
        wait_for(|| String::from_utf8_lossy(&rec.bytes.lock().unwrap()).contains("got[")).await;
        wait_for(|| String::from_utf8_lossy(&rec.bytes.lock().unwrap()).contains(']')).await;
        let out = rec.bytes.lock().unwrap().clone();
        assert!(String::from_utf8_lossy(&out).contains("got[]"));
        assert!(!out.windows(PROBE.len()).any(|w| w == PROBE));
        m.close(&key("late"));
    }
    #[test]
    fn probe_filter_strips_a_probe_split_across_reads() {
        let mut f = ProbeFilter::default();
        assert_eq!(f.feed(b"ab\x1b[?10".to_vec()), (b"ab".to_vec(), false));
        assert_eq!(f.feed(b"16$p\x1b[".to_vec()), (Vec::new(), false));
        assert_eq!(f.feed(b"cz".to_vec()), (b"z".to_vec(), true));
        // Answered once: a later probe is the pane's own and reaches xterm.js.
        assert_eq!(f.feed(PROBE.to_vec()), (PROBE.to_vec(), false));
    }
    #[test]
    fn probe_filter_releases_a_held_prefix_that_is_not_the_probe() {
        let mut f = ProbeFilter::default();
        assert_eq!(f.feed(b"x\x1b[".to_vec()), (b"x".to_vec(), false));
        assert_eq!(f.feed(b"0m".to_vec()), (b"\x1b[0m".to_vec(), false));
    }
    #[test]
    fn probe_filter_stops_looking_after_the_head() {
        let mut f = ProbeFilter::default();
        let head = vec![b'a'; HELD_SCAN];
        assert_eq!(f.feed(head.clone()), (head, false));
        assert_eq!(f.feed(PROBE.to_vec()), (PROBE.to_vec(), false));
    }
    #[test]
    fn builds_attach_argv() {
        let info = crate::transport::MachineInfo {
            home: "/h".into(),
            herdr: "/h/herdr".into(),
            pi_dir: "/p".into(),
            agent_dir: "/h/.pi/agent".into(),
            pi: String::new(),
            version: "0.9.3".into(),
            protocol: 22,
        };
        assert_eq!(
            attach_argv(&info, "ai", "term_x", true),
            vec![
                "/h/herdr",
                "--session",
                "ai",
                "terminal",
                "attach",
                "term_x",
                "--takeover"
            ]
        );
        assert_eq!(
            attach_argv(&info, "default", "term_x", false),
            vec!["/h/herdr", "terminal", "attach", "term_x"]
        );
    }
}
