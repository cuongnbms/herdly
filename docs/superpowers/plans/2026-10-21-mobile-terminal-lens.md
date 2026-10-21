# Mobile Terminal Lens Implementation Plan

> **For agentic workers:** Execute this plan task by task with the executing-plans skill. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give paired phones an interactive Terminal lens without requiring an installed desktop upgrade.

**Architecture:** Reuse core AttachManager with a distinct owned manager per web terminal attempt. Keep Chat's socket unchanged; add an authenticated binary terminal socket, a generation-scoped browser transport, and web-local xterm UI behind a shared Pane header.

**Tech Stack:** Rust, Tokio, Axum 0.8, React 19, TypeScript, Vitest, xterm 6, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-21-mobile-terminal-lens-design.md`

## Global Constraints

- **Full suite:** Gate: after every task. Run commands separately from the worktree root:
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm --dir web test`
  - `pnpm --dir web build`
  - `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-core -p herdly-web`
  - `git diff --check`
- Prepare with pnpm at root and web separately, following `web/README.md`'s explicit pnpm convention despite the historical root npm lockfile. Use their existing pnpm lockfiles. Do not deploy, restart the real user service, push or publish. Record unavailable dependencies and baseline failures, never silently omit a gate.
- Workspace is the existing `.worktrees/feat-mobile-terminal-lens`, branch `feat/mobile-terminal-lens`, base main. No additional feature worktree. Test fixture Sessions are isolated, unique, and removed without touching the user's Session.
- No Tauri imports or desktop component/style/store reuse in web. Desktop source/UI and IPC stay unchanged except the approved core ACK ordering correction. Already-installed desktop requires no upgrade.
- Wire protocol, byte/frame limits, close codes, timeouts, retry rules and best-effort drain are exactly those in the Spec. Text errors use `{type:"error",error:{code,message}}`; never leak commands or secrets. Cookies and Origin checks apply equally to both sockets.
- Use web-only storage key prefix `herdly-web:lens:v1:` plus `JSON.stringify([session,pane_id])`, values `chat` or `terminal`. Storage failure is harmless. Do not change the existing webKey/Chat draft keys.
- New backend modules: `terminal/{mod,backend,protocol,queue,registry,socket}.rs`; new frontend modules under `web/src/terminal/` and `web/src/pane/`. Split only along these responsibilities, not speculative abstractions.
- Every task follows vertical red/green slices. The complete tracer tests below pin interfaces; remaining named cases are mandatory additional slices, not permission to implement untested branches. Run one new test at a time. Test adapters only replace OS/network/time boundaries. Preserve old assertions unless an approved behavior (such as enabling shell Panes) explicitly replaces them; document replacements.
- Library APIs and DOM quirks must be checked against the installed versions before use. If the declared interface cannot implement an approved requirement, stop rather than silently reduce behavior. No claim of real iOS/Android support from jsdom/emulation alone.

## Review Focus

- An immediate ACK inside Sink::data must leave no credit debt or deadlock (Task 1).
- Delayed open completion and old socket cleanup cannot orphan a child or terminate a replacement (Tasks 2, 4).
- Output split across UTF-8 boundaries, final chunks after Exited, and stale parse callbacks cannot corrupt output or ACK a new socket (Tasks 3, 5).
- Mobile IME/paste and xterm-generated replies must not be duplicated, Ctrl-transformed or confused with user input during settling (Task 6).
- Shell Panes must be reachable from every entry point, while stopped/missing Panes cannot attach (Task 7).

---

### Task 1: Correct core ACK accounting before delivery

**Files:**
- Modify/Test: `src-tauri/core/src/attach.rs` (read_loop around lines 547–555, existing tests module).

**Interfaces:**
- Consumes: `AttachManager::open`, `ack`, `close`, `Sink::data`, and the existing test helpers `key`, `sh`, `wait_for`.
- Produces: unchanged public API with outstanding-byte accounting occurring before Sink delivery, with no mutex held across callback.

- [ ] **Step 1: Write the failing test** in the existing tests module. The private balance assertion is intentional here: it deterministically observes the exact race without waiting for megabytes or a scheduling accident. The actual manager, PTY and Sink callback run.

```rust
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
        manager: manager.clone(), key: k.clone(),
        balance: Mutex::new(None),
    });
    manager.open(k.clone(), sh("printf ready; sleep 30"), 80, 24, sink.clone()).unwrap();
    wait_for(|| sink.balance.lock().unwrap().is_some()).await;
    let balance = *sink.balance.lock().unwrap();
    manager.close(&k);
    assert_eq!(balance, Some((5, 0)));
}
```

- [ ] **Step 2: Run and see the assertion fail.** This callback reads credit before and after its synchronous ACK: on old code the callback observes (0,0), so the ACK cannot discharge the 5 bytes later added by read_loop. No scheduling sleeps or production test hooks are necessary. Wrap the test's opened handle in an unconditional cleanup guard so failure/timeout also closes it.

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-core immediate_sink_ack_leaves_no_outstanding_debt -- --nocapture`
Expected: FAIL on `Some((5,0))` versus old `Some((0,0))`; a callback deadlock is also a failure, enforced by a bounded test timeout.

- [ ] **Step 3: Implement** credit reservation before `sink.data(bytes)`, release credit lock before delivery, reacquire only for threshold waiting; preserve closed checks, wakeups and saturating ACK behavior. Add one real-stream immediate-ACK test above HIGH_WATER that proves progress, then rerun existing pause/resume, close-while-paused and reopen tests individually.
- [ ] **Step 4: Verify** `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-core attach::tests` passes. Verify no code changes outside ACK accounting/test support are required.
- [ ] **Step 5: Commit** `fix(core): account terminal bytes before sink delivery`.

### Task 2: Add owned terminal backend handles and local target resolution

**Files:**
- Create: `src-tauri/web/src/terminal/mod.rs`, `src-tauri/web/src/terminal/backend.rs`.
- Modify: `src-tauri/web/src/lib.rs`, `src-tauri/web/src/backend.rs`, `src-tauri/web/src/testing.rs`.
- Test: inline tests in `terminal/backend.rs`.

**Interfaces:**
- Produces: `TerminalSize { pub cols: u16, pub rows: u16 }` (Clone, Copy, Debug, Deserialize, Serialize, PartialEq) and `#[async_trait] pub trait TerminalHandle: Send + Sync` with `async fn open(&self, size: TerminalSize, sink: Arc<dyn herdly_core::attach::Sink>) -> AppResult<()>`, `async fn write(&self, data: Vec<u8>) -> AppResult<()>`, `async fn resize(&self, size: TerminalSize) -> AppResult<()>`, `fn ack(&self, bytes: usize)`, `async fn close(&self)`.
- Produces: `OwnedTerminal::new(key: AttachKey, argv: Vec<String>) -> Arc<OwnedTerminal>` (internal constructor, no browser strings), implementation of TerminalHandle owning a distinct AttachManager; idempotent close.
- Produces: `resolve_terminal(views: &[MachineView], pane: &WebPane) -> AppResult<AttachKey>`; only connected local Machine, running Session and nonempty Terminal ID are accepted.
- Produces: `Backend::terminal(&self, pane: &WebPane, takeover: bool) -> AppResult<Arc<dyn TerminalHandle>>`, implemented by Core using resolve_terminal, mgr.info(LOCAL), mgr.transport(LOCAL), attach_argv and transport.wrap(..., true). Terminal allocation does not spawn until open.

- [ ] **Step 1: Write the failing resolution test.** In backend.rs tests, use the complete typed fixture below; no transcript fixture is necessary.

```rust
use super::*;
use herdly_core::view::{MachineState, MachineView, SessionView, WorkspaceView, TabView, PaneView};
use herdly_core::herdr::types::AgentStatus;
fn shell_view() -> MachineView {
    MachineView {
        id: "local".into(), label: "local".into(), kind: "local".into(),
        state: MachineState::Connected, error: None, version: None,
        pi_agent_dir: None, has_pi: false, status: AgentStatus::Idle,
        sessions: vec![SessionView {
            name: "work".into(), running: true, status: AgentStatus::Idle, error: None,
            workspaces: vec![WorkspaceView {
                workspace_id: "w1".into(), label: "one".into(), number: 1, status: AgentStatus::Idle,
                tabs: vec![TabView {
                    tab_id: "t1".into(), label: "shell".into(), number: 1, status: AgentStatus::Idle,
                    panes: vec![PaneView {
                        pane_id: "p1".into(), terminal_id: "term_7".into(), title: "shell".into(),
                        cwd: None, agent: None, status: AgentStatus::Idle,
                    }],
                }],
            }],
        }],
    }
}
#[test]
fn resolves_shell_without_chat_and_rejects_stale_targets() {
    let p = WebPane { session: "work".into(), pane_id: "p1".into() };
    let mut m = shell_view();
    assert_eq!(resolve_terminal(&[m.clone()], &p).unwrap(), AttachKey {
        machine_id: "local".into(), session: "work".into(), terminal_id: "term_7".into(),
    });
    m.sessions[0].running = false;
    assert!(resolve_terminal(&[m.clone()], &p).is_err());
    m.sessions[0].running = true;
    m.id = "remote".into();
    assert!(resolve_terminal(&[m], &p).is_err());
    assert!(resolve_terminal(&[], &p).is_err());
}
```

- [ ] **Step 2: Add the interface with a rejecting stub**, run `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-web resolves_shell_without_chat_and_rejects_stale_targets`; see the first successful-resolution assertion fail, not just missing imports.
- [ ] **Step 3: Implement resolution and owned handle.** Add missing Pane, disconnected Machine, empty Terminal ID and duplicate Pane across Workspaces cases as separate slices. Keep the real target key (do not fake session/terminal IDs to manufacture ownership). Use manager open_async/write_async/close_async; resize runs off runtime workers as it may block on a PTY lock. Retain ownership while open completes after cancellation (supervisor in Task 4). One handle may only open once; Take over creates another.
- [ ] **Step 4: Test the real owned handle** with `sh -c 'read line; printf "got:%s\n" "$line"; sleep 30'`, an actual Sink collecting bytes/events, bounded polling and unconditional close. Assert `write(b"hello\n")` yields `got:hello`, resize succeeds, close emits Detached, a second close is harmless, and closing one independently created handle leaves a second handle delivering output. Add a failed-command open case; no orphan children. Extend FakeBackend with public `terminal_attempts: Mutex<Vec<Arc<FakeTerminal>>>`. FakeTerminal is a test adapter implementing TerminalHandle, with recorded size/input/ACK/close calls, an optional gated open/write, and `emit_data`/`emit_event` methods delivering through the captured real Sink. All arguments must be recorded and asserted by route tests.
- [ ] **Step 5: Verify** `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-web` passes, then commit `feat(web): add owned terminal backend handles`.

### Task 3: Define bounded terminal protocol, output queue and ACK ledger

**Files:**
- Create: `src-tauri/web/src/terminal/protocol.rs`, `src-tauri/web/src/terminal/queue.rs`.
- Modify: `src-tauri/web/src/terminal/mod.rs`.
- Test: inline modules in the new files.

**Interfaces:**
- Consumes: TerminalSize and WebPane from Task 2.
- Produces: `OpenRequest { pane: WebPane, size: TerminalSize, takeover: bool }`; the wire open has flat cols/rows as specified, not a nested size field.
- Produces: `Command::{Open(OpenRequest), Input(Vec<u8>), Resize(TerminalSize), Ack(usize), Close}`; `decode(message: axum::extract::ws::Message) -> Result<Command, u16>` returning close code on rejection.
- Produces: a byte-and-frame bounded queue implementing core Sink via an adapter; ordered binary/state frames, atomic seal, nonblocking try-enqueue, overflow notification. Limit 2 MiB and 256 frames, terminal-state grace 250 ms. No dropped frame masquerading as success.
- Produces: `AckLedger::default()`, `sent(bytes: usize)`, `ack(bytes: usize) -> Result<(), u16>`; sent credit is reserved before writer exposes bytes to the peer, with no ACK path blocked behind a pending network send. Outstanding count includes sent/in-flight output, never unsent queued frames. Excess ACK returns 1008. Only validated credit reaches TerminalHandle::ack.

- [ ] **Step 1: Write tracer tests.** These go in protocol.rs and queue.rs respectively.

```rust
use super::*;
#[test]
fn accepts_flat_open_and_rejects_out_of_range_sizes() {
    use axum::extract::ws::Message;
    let valid = r#"{"type":"open","pane":{"session":"s","pane_id":"p1"},"cols":80,"rows":24,"takeover":false}"#;
    match decode(Message::Text(valid.into())).unwrap() {
        Command::Open(r) => {
            assert_eq!(r.pane.session, "s");
            assert_eq!(r.pane.pane_id, "p1");
            assert_eq!(r.size, TerminalSize { cols: 80, rows: 24 });
            assert!(!r.takeover);
        }
        _ => panic!("not an open"),
    }
    for text in [
        r#"{"type":"resize","cols":1,"rows":24}"#,
        r#"{"type":"resize","cols":80,"rows":0}"#,
        r#"{"type":"resize","cols":1001,"rows":24}"#,
        r#"{"type":"ack","bytes":-1}"#,
        r#"{"type":"bogus"}"#,
    ] {
        assert_eq!(decode(Message::Text(text.into())).unwrap_err(), 1008);
    }
}
```

```rust
use super::*;
#[test]
fn ack_cannot_spend_unsent_or_already_acked_output() {
    let mut l = AckLedger::default();
    assert_eq!(l.ack(1), Err(1008));
    l.sent(5);
    assert_eq!(l.ack(2), Ok(()));
    assert_eq!(l.ack(4), Err(1008));
    assert_eq!(l.ack(3), Ok(()));
    assert_eq!(l.ack(1), Err(1008));
}
```

- [ ] **Step 2: Add rejecting decoder/ledger stubs** and run each test separately until assertion-red. Derive Debug for command types so unwrap_err is usable. Run via `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-web terminal::`.
- [ ] **Step 3: Implement and add slices** for exact size boundaries (2x1,1000x1000), 16 KiB text and 64 KiB binary boundaries, malformed JSON/extra open target fields, missing fields, zero/excess ACK, raw bytes `[0xff,0x1b,0x00]` preserved, split multibyte output, exact queue frame/byte overflow, state-before-trailing-data, seal-versus-delivery race, and expiry under a nonreading receiver. Reject unknown target fields rather than silently accept browser machine_id/argv. Ping/Pong handling is the socket layer's responsibility, not an application protocol error.
- [ ] **Step 4: Verify** new tests pass and overflow cannot wait on Tokio from a core Sink thread; commit `feat(web): define bounded terminal websocket protocol`.

### Task 4: Serve terminal sockets with cancellation, revocation and shutdown cleanup

**Files:**
- Create: `src-tauri/web/src/terminal/registry.rs`, `src-tauri/web/src/terminal/socket.rs`, `src-tauri/web/tests/terminal_ws.rs`.
- Modify: `src-tauri/web/src/app.rs`, `src-tauri/web/src/cli.rs`, `src-tauri/web/src/testing.rs`, `src-tauri/web/src/terminal/mod.rs`.
- Test: `src-tauri/web/tests/terminal_ws.rs`, inline registry tests; extend existing security-header tests located by `grep content-security-policy src-tauri/web/tests/*`.

**Interfaces:**
- Consumes: Backend::terminal, TerminalHandle, Command/decode, bounded queue/ACK ledger from Tasks 2–3.
- Produces: `terminal::socket::ws_handler` mounted at `/ws/terminal`; `TerminalRegistry::new() -> Arc<Self>`, `async fn shutdown(&self)`; registry on AppState initialized in cli and all test state constructors.
- Produces: per-socket supervisor retaining a pending open even when socket task is canceled; serialized bounded write worker (64 input frames/1 MiB maximum), independent reader/control/revocation/close path. On input overflow close 4000, discard pending input, kill Attach before joining writer. Use 2-second network close grace. Existing Chat `/ws` messages and implementation are unchanged.

- [ ] **Step 1: Write the route tracer below.** Its helpers use existing testing::state_with/paired_cookie rather than a parallel auth mock. Copy the existing ws.rs request/receive pattern; this complete helper intentionally checks the terminal path, not Chat.

```rust
use futures_util::{SinkExt, StreamExt};
use herdly_web::{app::router, testing::{state_with, paired_cookie, FakeBackend}};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use serde_json::json;
const ORIGIN: &str = "http://192.0.2.10:7380";
#[tokio::test]
async fn terminal_requires_pairing_and_origin_then_forwards_raw_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeBackend::default());
    let st = state_with(fake.clone(), dir.path(), Duration::from_millis(50));
    let cookie = paired_cookie(&st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws/terminal", listener.local_addr().unwrap());
    let app = router(st.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let request = |origin: &str, paired: bool| {
        let mut req = url.clone().into_client_request().unwrap();
        req.headers_mut().insert("origin", origin.parse().unwrap());
        if paired { req.headers_mut().insert("cookie", format!("herdly_web={cookie}").parse().unwrap()); }
        req
    };
    assert!(tokio_tungstenite::connect_async(request(ORIGIN, false)).await.is_err());
    assert!(tokio_tungstenite::connect_async(request("http://evil.example", true)).await.is_err());
    let (mut ws, _) = tokio_tungstenite::connect_async(request(ORIGIN, true)).await.unwrap();
    ws.send(Message::Text(json!({"type":"open","pane":{"session":"s","pane_id":"p1"},"cols":80,"rows":24,"takeover":false}).to_string().into())).await.unwrap();
    let attempt = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(h) = fake.terminal_attempts.lock().unwrap().first().cloned() {
                if h.is_open() { break h; }
            }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    attempt.emit_data(vec![0x1b, 0x5b, 0xff]);
    loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await.unwrap().unwrap().unwrap() {
            Message::Binary(bytes) => { assert_eq!(&bytes[..], &[0x1b,0x5b,0xff]); break; }
            Message::Text(_) => continue,
            other => panic!("{other:?}"),
        }
    }
    ws.send(Message::Text(r#"{"type":"ack","bytes":3}"#.into())).await.unwrap();
    ws.send(Message::Binary(b"hello\r".to_vec().into())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if attempt.inputs() == vec![b"hello\r".to_vec()] && attempt.acks() == vec![3] { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    ws.close(None).await.unwrap();
    st.terminals.shutdown().await;
    assert!(attempt.is_closed());
    server.abort();
}
```

- [ ] **Step 2: Add handler returning an authenticated unsupported error**, plus registry interface and test adapter accessors, so valid terminal connection fails on a meaningful protocol assertion rather than imports. Run `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-web --test terminal_ws terminal_requires_pairing_and_origin_then_forwards_raw_bytes` and record red.
- [ ] **Step 3: Implement socket and supervisor.** Configure max message/frame size before upgrade, enforce smaller control-frame limit after decode. Select concurrently over socket messages, device revocation, cancellation and writer termination. Deadline applies to initial open frame; a separate supervisor owns any pending PTY spawn through completion and closes it if canceled. No abort-only cleanup of spawn_blocking. Registry refuses new attempts after shutdown begins; signals from SIGINT/SIGTERM invoke shutdown before runtime exit, using cfg(unix) for SIGTERM.
- [ ] **Step 4: Add one integration slice at a time:** second open rejected; fake asserts exact Pane/takeover/size; resize/ACK routing; no ACK before sent; early binary input; unknown/malformed/oversized frames with correct close codes; 10-second idle-open timeout with controlled clock; queue overflow and nonreading-peer close; terminal-event grace/seal/2-second drain; revoked pairing 4401 while open/write is pending; disconnect during gated open then late open cleanup; blocked write does not prevent close; two attempts' close calls stay isolated; registry shutdown drains supervisors and rejects new ones. Real PTY tests for cancellation/blocked-write/shutdown supplement, not replace, fake tests. Cleanup must not terminate the real user Session.
- [ ] **Step 5: Add CSP** `style-src 'self' 'unsafe-inline'` only, preserving default/connect/img/object/base directives and paired reads. Security-header test asserts style directive present and default-src remains `'self'` without script/eval relaxation. Verify existing Chat ws suite unchanged. Run `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-web`, then commit `feat(web): serve authenticated terminal sockets with owned cleanup`.

### Task 5: Implement generation-safe browser terminal transport

**Files:**
- Create: `web/src/terminal/socket.ts`, `web/src/terminal/socket.test.ts`, `web/src/terminal/types.ts`.
- Consumes existing constants: `web/src/config.ts`; do not change Chat Socket protocol.

**Interfaces:**
- Produces: `TerminalSize = {cols:number;rows:number}`; `TerminalEvent` matching the Spec server text events plus local `{type:"connecting"}|{type:"disconnected"}|{type:"unpaired"}`.
- Produces: `TerminalSocket` constructor `(url:string,pane:WebPane,on:{output(bytes:Uint8Array,parsed:()=>void):void;event(e:TerminalEvent):void;reset():void},deps?:Partial<TerminalSocketDeps>)`; methods `start(size:TerminalSize,takeover?:boolean):void`, `stop():void`, `input(text:string):void`, `reply(text:string):void`, `resize(size:TerminalSize):void`. `input` requires Attached; `reply` may run during settling after open frame. Neither queues disconnected input.
- TerminalSocketDeps: `open(url:string):TerminalWebSocket`, `me():Promise<number>`, `setTimeout(fn:()=>void,ms:number):unknown`, `clearTimeout(id:unknown):void`; TerminalWebSocket has binaryType:string, send(data:string|ArrayBufferView):void, close():void, nullable onopen/onmessage/onclose/onerror callbacks. Incoming message data is string|ArrayBuffer. Set binaryType to arraybuffer.
- start invalidates/closes previous attempt and invokes reset before new output. Restart/backoff uses cached current size and takeover=false. stop invalidates parse callbacks and timers and never reconnects. After Held/Exited/Detached, keep output rendering but reject input/retry. Propagate unpaired to the app, not a silent local banner only.

- [ ] **Step 1: Write the complete tracer** with an explicit OS WebSocket boundary fake.

```ts
import { describe, expect, it } from "vitest";
import { TerminalSocket, type TerminalWebSocket } from "./socket";
class Wire implements TerminalWebSocket {
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: {data:string|ArrayBuffer}) => void) | null = null;
  onclose: ((e: {code:number}) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: (string|ArrayBufferView)[] = [];
  closed = false;
  send(d:string|ArrayBufferView) { this.sent.push(d); }
  close() { this.closed = true; }
}
describe("TerminalSocket", () => {
  it("ACKs only after parse and never through a replacement socket", () => {
    const wires: Wire[] = [];
    const parsed: (()=>void)[] = [];
    const output: number[][] = [];
    const s = new TerminalSocket("ws://h/ws/terminal", {session:"s",pane_id:"p1"}, {
      reset() {}, event() {},
      output(bytes, done) { output.push([...bytes]); parsed.push(done); },
    }, {open(url) { expect(url).toBe("ws://h/ws/terminal"); const w=new Wire(); wires.push(w); return w; }});
    s.start({cols:80,rows:24});
    const first = wires[0]; first.onopen!();
    expect(JSON.parse(first.sent[0] as string)).toEqual({type:"open",pane:{session:"s",pane_id:"p1"},cols:80,rows:24,takeover:false});
    first.onmessage!({data:new Uint8Array([0xe2,0x82,0xac]).buffer});
    expect(output).toEqual([[0xe2,0x82,0xac]]);
    expect(first.sent).toHaveLength(1);
    parsed[0]();
    expect(JSON.parse(first.sent[1] as string)).toEqual({type:"ack",bytes:3});
    first.onmessage!({data:new Uint8Array([0x41]).buffer});
    s.start({cols:100,rows:30}); wires[1].onopen!();
    parsed[1]();
    expect(wires[1].sent).toHaveLength(1);
    expect(first.closed).toBe(true);
    s.stop();
  });
});
```

- [ ] **Step 2: Stub methods with no-op bodies**, run `pnpm --dir web test src/terminal/socket.test.ts`; see the missing initial open/output behavior assertion fail after stubs compile.
- [ ] **Step 3: Implement and add slices:** reply before Attached versus blocked user input; input UTF-8 binary after Attached; split UTF-8 bytes not decoded in transport; duplicate resize suppressed; data after Exited still rendered; double onerror/onclose only one retry; backoff 1/2/4/8/15/15 seconds; explicit Take over true only on requested attempt, subsequent retry false; 1000/1008/1009/application error no retry; 4000/1006 retry; 4401 or /api/me 401 unpaired; stale timer/onmessage/output callback ignored; stop while pairing check pending cancels retry. Fake dependencies must expose timer delays and allow callbacks to run even after cancellation to verify generation guards. Bound browser buffered input: reject/drop while disconnected, do not accumulate for later send.
- [ ] **Step 4: Verify** `pnpm --dir web test src/terminal/socket.test.ts` and `pnpm --dir web typecheck`; commit `feat(web): add generation safe terminal transport`.

### Task 6: Build the mobile xterm lens and input/key bar

**Files:**
- Create: `web/src/terminal/TerminalLens.tsx`, `KeyBar.tsx`, `input.ts`, `input.test.ts`, `TerminalLens.test.tsx`, `terminal.css`.
- Modify: `web/package.json`, `web/pnpm-lock.yaml`.

**Interfaces:**
- Consumes: TerminalSocket, TerminalSize and TerminalEvent from Task 5.
- Produces: `TerminalLens({pane}:{pane:WebPane})` with a live xterm, banner, Reattach/Take over, key bar and cleanup; one terminal instance per attempt, no cache. Attach only while visible/mounted and target still valid. It calls useWeb.setConn("unpaired") when terminal auth is revoked and must stop the Chat socket from restoring paired UI without a fresh auth check.
- Produces: `controlCharacter(text:string):string|null` (ASCII @.._, case-insensitive letters, ?→DEL), `cursorKey(direction:"up"|"down"|"left"|"right",application:boolean):string`; one-shot Ctrl state in input controller, never applied to terminal replies. `KeyBar({disabled,ctrl,onCtrl,onKey})` sends logical keys with accessible labels (Esc, Tab, Ctrl, Arrow up/down/left/right).
- Add @xterm/xterm ^6.0.0, @xterm/addon-fit ^0.11.0, @xterm/addon-unicode11 ^0.9.0 and @fontsource/jetbrains-mono ^5.3.0 to web dependencies. No WebGL dependency. Import xterm CSS/font in web only; preserve assetsInline font handling and import guard.

- [ ] **Step 1: Write the first input tests** (then run individual cases as slices).

```ts
import { expect, it } from "vitest";
import { controlCharacter, cursorKey } from "./input";
it.each([["c","\x03"],["C","\x03"],["@","\x00"],["[","\x1b"],["_","\x1f"],["?","\x7f"],["é",null],["你好",null],["",null]])(
  "maps only supported Ctrl input %s", (text,expected) => expect(controlCharacter(text!)).toBe(expected),
);
it("uses the current cursor application encoding", () => {
  expect(cursorKey("up",false)).toBe("\x1b[A");
  expect(cursorKey("left",true)).toBe("\x1bOD");
});
```

- [ ] **Step 2: Add rejecting helper stubs**, run `pnpm --dir web test src/terminal/input.test.ts` and observe literal control-sequence assertions fail, then implement the helpers.
- [ ] **Step 3: Install dependencies and implement TerminalLens**, reading installed xterm public APIs for Unicode, cursor key mode, replies, composition and touch scrolling. Keep xterm/replies enabled during settling but capture user keyboard/beforeinput/input/composition/paste/keybar before entry; do not use disableStdin. User text passes through control mapping only at the entry boundary and clears one-shot Ctrl; raw onData protocol replies are never Ctrl-transformed. Add capture guards only where the library needs them; test actual DOM events with real xterm in browser where jsdom cannot prove behavior. Standard paste uses xterm paste semantics once, no synthetic submit. Do not auto-focus. Fit once measurable and debounce resize 150 ms; ignore unchanged size. Use safe-area inset, min-height:0, 100dvh-compatible sizing, horizontal keybar scroll, 44px buttons. Touch scroll gestures scroll scrollback without pointer reports; a tap focuses without automatically clicking a terminal UI target. No auto-link handler or OSC52 clipboard writes.
- [ ] **Step 4: Add component test slices** using real React UI and a transport factory boundary only: initial connecting/Attached/Held/Exited/error banners, Take over opt-in, stale callbacks, on unpaired no later Chat event can resurrect paired UI, terminal disposal on Lens switch, hidden→visible normal reopen, no autofocus, Ctrl clear on blur/disconnect, arrow encoding. Pair negative keyboard assertions with a successful typing case after Attached. Add browser tests for real xterm query-before-Attached plus blocked paste/composition, IME once after Attached, Ctrl not consumed by query replies, and touch scrolling with mouse reporting; these join Task 8's real serving smoke. If library behavior requires a different input seam, preserve the contract and record the adaptation rather than weaken tests.
- [ ] **Step 5: Verify** web tests/typecheck/build and import guard, then commit `feat(web): add touch friendly terminal lens`.

### Task 7: Integrate shared Pane header, Lens choice and all navigation paths

**Files:**
- Create: `web/src/pane/PaneScreen.tsx`, `lens.ts`, `lens.test.ts`, `PaneScreen.test.tsx`.
- Modify: `web/src/App.tsx`, `web/src/App.test.tsx`, `web/src/chat/ChatScreen.tsx`, `web/src/chat/ChatHeader.tsx`, `web/src/chat/ChatHeader.test.tsx`, `web/src/chat/PaneSheet.tsx` if needed, `web/src/list/PaneGroups.tsx`, `web/src/list/PaneCard.tsx`, `web/src/list/PaneList.test.tsx`, `web/src/nav/Sidebar.tsx`, `web/src/store.ts`, `web/src/styles.css`.

**Interfaces:**
- Consumes: TerminalLens({pane}), canChat, findRow/groupByStatus/rowPane, existing ChatScreen body.
- Produces: `type Lens="chat"|"terminal"`; `chooseLens(agent:string|null,saved:unknown):Lens`; `loadLens(pane:WebPane):Lens|null`, `saveLens(pane:WebPane,lens:Lens):void` using Global Constraints key format.
- Produces: PaneScreen props `{pane:WebPane;socket?:Socket;onBack():void;onSwitch(p:WebPane):void;onMenu():void}` owning header/selector and Chat subscribe/unsubscribe only when Chat shown. ChatScreen may retain its standalone wrapper for existing tests but PaneScreen must render only one header (use an optional `showHeader` prop default true, or extract a ChatBody with equivalent behavior).
- Keep store openChat/closeChat names to avoid gratuitous renaming; correct their comments to mean selected Pane. Persistent Chat drafts remain per-Pane and survive Lens changes. Do not clear a valid Chat state solely because Terminal is selected; unsubscribe live Chat while hidden and resubscribe on return. Existing Back/Pane switch cleanup remains.

- [ ] **Step 1: Write Lens decision/storage tests.**

```ts
import { beforeEach, expect, it } from "vitest";
import { chooseLens, loadLens, saveLens } from "./lens";
beforeEach(() => localStorage.clear());
it.each([
  ["claude",null,"chat"],["pi",null,"chat"],[null,null,"terminal"],
  ["codex","chat","terminal"],["pi","terminal","terminal"],[null,"chat","terminal"],
  ["claude","garbage","chat"],
])("selects %s with preference %s", (agent,saved,expected) => {
  expect(chooseLens(agent,saved)).toBe(expected);
});
it("keeps preferences separate by Session and Pane", () => {
  const a={session:"one",pane_id:"p1"}, b={session:"two",pane_id:"p1"};
  expect(loadLens(a)).toBeNull();
  saveLens(a,"terminal"); saveLens(b,"chat");
  expect(loadLens(a)).toBe("terminal"); expect(loadLens(b)).toBe("chat");
  localStorage.setItem('herdly-web:lens:v1:["one","p1"]',"bad");
  expect(loadLens(a)).toBeNull();
});
```

- [ ] **Step 2: Add stubs returning fixed Chat/null**, run `pnpm --dir web test src/pane/lens.test.ts`; see shell/preference assertions fail, then implement helpers. Add throwing localStorage getters/setters tests as guards.
- [ ] **Step 3: Integrate PaneScreen and header.** Selector has accessible `Chat`/`Terminal` controls with selected state; disable Chat for unsupported Agent, not the Pane itself. Remove PaneGroups unsupported early return/hint and Sidebar canChat disabling; stopped Sessions remain disabled. Remove canChat filtering from header's needs-you navigation. Remove unconditional App Chat subscription; PaneScreen owns it with effect cleanup and an explicit Retry handler. A missing/stopped/disconnected target shows unavailable, closes existing terminal and cannot open a new one. Handle terminal_id changes for an open Pane as a new attempt, never keep writing to an old ID. Chat unpaired state must be sticky until new successful pairing/authentication, not reset by a still-live Machine frame or healthy Chat socket.
- [ ] **Step 4: Update/add integration slices** in real App tests: shell from Pane list opens Terminal, shell from sidebar works, Pane sheet can switch to shell, blocked shell is reachable through needs chip; no Chat subscribe for any shell path; claude default opens Chat; toggling to Terminal unsubscribes Chat, returning subscribes without losing draft; preference survives remount; one header at a time; terminal-only Chat disabled; Back returns list; missing Pane/stopped Session closes terminal; stale Chat open after terminal unpair cannot resurrect content. Replace old assertions that shell sidebar buttons are disabled, documenting approval of Terminal reachability. Keep ordering and focus-trap tests.
- [ ] **Step 5: Verify** all web tests/build plus existing desktop tests/typecheck; commit `feat(web): integrate pane lens selection across mobile navigation`.

### Task 8: Live verification

**Files:**
- Create: `src-tauri/web/tests/terminal_herdr.rs`, `web/scripts/terminal-smoke.mjs`.
- Modify: `web/README.md`, `README.md` where mobile feature scope is described; test runner dependencies only if required for reproducible smoke.
- Evidence: the executing-plans run directory, not a claim in docs that devices were tested when they were not.

**Interfaces:**
- Consumes: assembled production web bundle, Rust app/router and terminal socket; configurable `HERDR_TEST_BIN` or PATH lookup; private temporary herdr Session/state/static directories.
- Produces: real attach ownership/cleanup smoke, production CSP/rendering smoke and a documented manual mobile acceptance checklist. No service deployment.

- [ ] **Step 1: Write and prove a failing live regression** before treating smoke as coverage: launch a temporary Session, a terminal that echoes a unique marker, and a paired web process bound to a free loopback port with its matching Origin and fresh state directory. Open the real `/ws/terminal`, send open, wait for Attached, send marker input, assert output contains that literal. Run the same test with an intentionally wrong Pane ID and assert an application error; this validates that the successful fixture is not just matching old output. A fixture RAII guard kills only its own child processes and Session on every exit. Query installed CLI help for Session/Pane creation syntax, never guess or mutate the user's Session.
- [ ] **Step 2: Extend real-herdr tests in vertical slices:** first normal attach works, second normal attempt receives Held, explicit takeover works, delayed first-handle cleanup cannot kill replacement, web close leaves Pane process alive (send/read a second marker through another normal attach), resize changes real terminal dimensions, canceled pending open cannot leave an attach child, shutdown cleans handles. Real-PTY blocked-write/slow-ACK exit fixtures from Tasks 2/4 run as part of the same verification. Tests needing herdr may be explicitly opt-in with a documented command, but must actually run here if available; record if blocked. Use unique Session names and configurable executable, never the old hardcoded macOS path.
- [ ] **Step 3: Add reproducible browser smoke** with Playwright loaded as an explicit dev dependency only if no installed browser tool is available. Serve `web/dist` through actual Rust middleware with fresh temporary pairing, capture securitypolicyviolation events, and assert terminal output text is visible and correctly sized at 320x640 and 390x844 and after rotation. Load a page-local inline script probe and assert it is blocked while xterm dynamic CSS works. Test real xterm query/reply during settling with no user-paste/IME leak, UTF-8 display, input once after Attached, Ctrl and arrow behavior, mouse-reporting-enabled touch scroll, switching/back/disconnect/background cleanup. Do not weaken renderer tests into jsdom mocks. Report the browser executable/version and evidence paths.
- [ ] **Step 4: Update documentation** to describe local Machine Terminal lens, exclusive Held/Take over and desktop interruption, keyboard/keybar, reconnect input loss, release on backgrounding, best-effort final output, same trusted-network implications and inline-style-only CSP allowance. Upgrade executable and assets together, no desktop upgrade. Document non-destructive rollback to previous binary/assets; retain existing install/uninstall instructions but do not execute them. Add iOS Safari/Android Chrome manual checklist (keyboard, IME, safe area, mouse-reporting scroll, background/resume and desktop takeover). Mark checks awaiting a real phone, never fabricate acceptance.
- [ ] **Step 5: Verify** all Global Constraints commands, plus `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-web --test terminal_herdr -- --ignored --test-threads=1` if the fixture is opt-in, `node web/scripts/terminal-smoke.mjs` (the script builds/starts only temporary local fixtures and exits nonzero on failed assertions), and final whole-branch review. Expected: no new failures versus recorded baseline. If a new blocker survives one fix round or an approved answer cannot hold, stop autopilot with evidence. Commit `test(web): verify terminal lifecycle and document mobile use`. The controller performs the granted local merge only after its executing-plans merge gates; no push or deploy.
