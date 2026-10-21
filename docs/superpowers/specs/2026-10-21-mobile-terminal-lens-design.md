# Mobile Terminal Lens

## Approved brief

Add an interactive Terminal lens to Herdly Web, reusing the existing core attach implementation with a web-specific transport and UI. The user selected this over extracting a shared desktop/web component, and approved the design below. Installed desktop applications must not need an upgrade. Desktop UI and Tauri commands remain unchanged. Following independent review, the user also approved: permitting inline CSS only (not inline scripts) for xterm; a narrowly scoped shared-core ACK race fix with regression tests; and keeping the current core trailing-output drain limit rather than guaranteeing lossless output at exit.

Users can read live terminal output, type, resize, and explicitly Take over an exclusive Attach. Switching Chat / Terminal happens in the Pane header. A mobile key bar provides Esc, Tab, Ctrl and arrow keys. Leaving Terminal closes the web Attach, not the Pane's running process. Reconnect never replays input or automatically takes over.

Workspace: `.worktrees/feat-mobile-terminal-lens`, branch `feat/mobile-terminal-lens`, based on main `1ab1ba12453cb20fe509df19ceff80289e9d25d0`.

## Existing code and terminology

- `GLOSSARY.md` defines Pane, Terminal, exclusive Attach and Lens. These meanings do not change. Herdly Web's definition must now include the Terminal lens as well as Chat.
- `web/src/App.tsx` currently opens ChatScreen for every selected Pane and subscribes to Chat through the existing `/ws` connection.
- `web/src/config.ts` defines Chat capability for claude/pi. Terminal must also be reachable for Panes without those Agents; Chat capability must not gate opening a Pane.
- `src-tauri/web/src/backend.rs` has no attach operations today. `src-tauri/web/src/app.rs` guards the existing `/ws` with Origin and paired-device checks.
- `src-tauri/core/src/attach.rs` provides a Tauri-independent AttachManager, Sink, AttachEvent, ack-based output flow control, open_async, write_async and close_async. Its open reuses a live entry by replacing its Sink. This is not a web ownership policy.
- Desktop `src/terminal/TerminalLens.tsx` depends on Tauri IPC, clipboard and desktop stores. Do not import this component into web or relax the import guard to admit desktop IPC.

This design supersedes only the Terminal-lens exclusion in the original mobile web design. Other existing scope and security constraints remain.

## Architecture

Keep the existing `/ws` event/Chat connection intact. Add `/ws/terminal` exclusively for a single Terminal Attach per connection. Serve it behind the same Origin and cookie middleware, paired-device revocation check and bounded-close behavior as `/ws`. The terminal connection has an independent queue and cannot stall Chat or Machine events.

Reuse core AttachManager without changing its public API or desktop callers. The one approved shared-core correction is to account for outstanding bytes before handing them to Sink, eliminating the early-ACK race. Do not hold the unacked mutex across Sink callbacks: an immediate/reentrant ACK must not deadlock. Preserve wakeup/close handling and existing thresholds; prove the ordering with a deterministic regression test whose Sink acknowledges immediately during data delivery, plus existing core and desktop regression checks. A web-specific backend abstraction creates an owned terminal handle for each terminal socket. Each handle owns a separate AttachManager and exactly one AttachKey. Separate managers prevent a second socket's normal open from silently replacing the first socket's Sink. Exclusivity across handles and desktop processes remains enforced by herdr. Use core attach_argv and the local Machine's configured transport as desktop term_open does, rather than constructing a shell command from browser strings. Run blocking PTY operations off Tokio workers.

The web adapter resolves WebPane (session, pane_id) to its current terminal_id from authoritative local Machine views. Browser-supplied terminal IDs, Machine IDs or argv are not accepted. Reject a missing/stopped Session or missing Terminal with an application error. Revalidate the mapping on each new Attach attempt; do not use Chat transcript locate as a prerequisite for shell Panes.

The abstraction must be fakeable by backend/route tests. Extend or compose the Backend trait and Core construction sites, updating all test doubles as needed. No desktop UI/Tauri changes are planned. Any additional need to alter shared core semantics beyond the approved ACK ordering correction must be raised before implementation rather than quietly expanding scope.

## Wire protocol

One socket is one attempt. The client sends exactly one initial JSON text frame:

`{"type":"open","pane":{"session":"…","pane_id":"…"},"cols":80,"rows":24,"takeover":false}`

The server validates and resolves it, then opens the owned handle. A repeated open is a protocol error; Take over and Reattach always create a fresh socket after closing the previous attempt.

After open, client messages are:

- Binary: UTF-8 bytes generated by xterm input (including paste and escape sequences).
- Text `{"type":"resize","cols":80,"rows":24}`.
- Text `{"type":"ack","bytes":1234}` acknowledging output parsed by xterm, not merely received by the browser.
- Text `{"type":"close"}` requesting immediate Attach cleanup.

Server messages are:

- Binary: raw terminal output bytes, without UTF-8 decode/re-encode.
- Text events `{"type":"attached"}`, `{"type":"held"}`, `{"type":"exited","code":0}` (code may be null), `{"type":"detached"}`.
- Text `{"type":"error","error":{"code":"…","message":"…"}}` for application failures.

Serialize concurrent Sink callbacks into one bounded adapter queue and preserve that queue's ordering through a single writer; do not claim an ordering across core reader and exit-watcher threads that core does not provide. Held/Exited may precede the last output callback. On Held/Exited/Detached, disable input immediately, but keep accepting output into the attempt queue for a bounded 250 ms adapter grace period, then seal it atomically against further callbacks. Drain accepted output/control frames with a 2-second send deadline, then close normally (1000); if the peer cannot drain, close as lagged (4000). Queue overflow always remains a lagged failure. The frontend continues rendering binary chunks for this same attempt until its socket closes even after a terminal state event. This is a bounded best-effort drain: preserve output delivered to the browser, not all output produced by the underlying process. Core already waits only 250 ms for its reader after child exit; bytes not forwarded by core, or callbacks after the adapter is sealed, may be lost. No core exit/drain semantics change is authorized. The browser acknowledges complete binary chunks only after the xterm write callback; never acknowledge control frames. Server tracks outstanding bytes per connection and rejects acknowledgements exceeding bytes sent, so a malformed ACK cannot bypass flow control.

Bounds: initial open within 10 seconds of upgrade; text control frame at most 16 KiB; input binary frame at most 64 KiB; cols 2..1000 and rows 1..1000; outbound queue at most 2 MiB in bytes plus at most 256 frames. Configure WebSocket message limits explicitly. Split/coalesce output within these bounds. Backpressure uses core ACK thresholds; queue overflow closes with 4000 and cleans up rather than dropping bytes. Invalid frames or unsupported operations close with 1008; oversized messages with 1009. Revoked pairing closes with 4401. Error messages never contain argv, credentials or pairing cookies.

Binary input is accepted only while the attempt is usable; control replies generated by xterm while core is still settling Attached may be forwarded once open has succeeded, but user typing is disabled until Attached. No input is buffered for reconnect. PTY write calls are serialized through a bounded worker queue so a blocked write cannot prevent socket cleanup or revocation. On closing, discard queued input and close the owned handle; do not await an indefinitely blocked write before killing its Attach child.

## Ownership and lifecycle

A frontend generation counter scopes every socket callback, output write callback and timer to its current attempt. Never send stale ACKs, resize or input through a replacement socket. Allocate a fresh xterm on a fresh attempt; reset output state so a restarted terminal screen is not concatenated with an old one. No cross-Pane xterm cache in this iteration.

A backend handle belongs only to its own socket. A supervisor, not the request task alone, retains ownership across pending open and cancellation. Register supervisors in application state; implement SIGINT/SIGTERM graceful shutdown that stops accepting opens, cancels attempts and closes handles before ending the runtime. Close on client close, socket error, timeout, overflow, pairing revocation and startup failure as well. Dropping AttachManager alone is not cleanup. An asynchronous open completing after cancellation must close its resulting Attach. Initiate kill/close before joining input workers; never wait indefinitely on a blocked write. Cleanup is idempotent. Forced process termination cannot promise graceful cleanup. Per-attempt manager ownership means delayed cleanup from an old socket cannot close a new socket's Attach, even for the same Terminal.

- Normal entry: open with takeover=false.
- Held: show that another Attach owns the Terminal. No automatic retry or takeover. Take over closes this attempt and opens a fresh one with takeover=true, only following that button click.
- Exited: display exit code when available, retain output received by the browser (including accepted trailing chunks), and offer Reattach (normal open). Do not claim the complete final process output was captured.
- Detached/error: preserve visible output, disable input, offer Reattach; errors use the existing web banner styling.
- Transient network loss or close 4000 (lagged): show Disconnected, discard queued input, and reconnect with the web backoff delays while this Terminal lens remains visible. Every retry uses takeover=false, including after a successful explicit Take over. An application error frame ends the attempt with close 1008 and requires manual Reattach. Close 1008 (policy) and 1009 (oversized) never auto-retry. Stop retrying on Held, Exited, Detached, explicit close or unpaired. A normal server close (1000) is terminal, not an automatic reconnect trigger. Do not reuse the existing Chat socket's retry-all-errors behavior.
- On 4401, or a failed pairing check returning 401, stop and use the app's Not paired state. A healthy Chat socket does not override terminal revocation.
- Switching Lens/Pane, Back, or hiding the browser document closes the terminal socket immediately and cancels retries. When the document becomes visible again in Terminal, open normally. This releases ownership while a phone is backgrounded; a dead peer may still take network detection time to disappear, so the new attempt can be Held. It must never silently take over.

Close here means terminate only the `herdr terminal attach` child through core close_async, not the underlying Terminal or Session. Do not use desktop's idle release grace for web sockets.

## Mobile UI

Introduce a Pane-level screen/container with a shared header and a Chat / Terminal selector. Keep the sidebar, Pane title/switcher and Back navigation. Avoid mounting two independent headers. Chat rendering and Composer stay in the Chat lens; Terminal shows xterm and its key bar instead of the Chat Composer.

Persist a web-only Lens override per session+pane_id in localStorage, with safe handling when storage is unavailable or malformed. With no override, claude/pi Panes default to Chat; other Panes default to Terminal. When Chat is unavailable, only Terminal is enabled, regardless of a stale saved Chat override. All navigation paths (Pane list, sidebar, Pane switcher and attention navigation) must permit terminal-only Panes; preserve their existing ordering. Existing Chat eligibility filters must not accidentally hide shell Panes from selection. Do not introduce a requirement for a Transcript before opening Terminal. If a previously selected Pane disappears, show it as unavailable and prevent attaching to a stale Terminal.

Follow existing mobile header, banner and button styling. Add web-local terminal CSS and xterm dependencies, not desktop styles/stores. The lens selector must fit a 320px viewport, using a second header row if needed. Key buttons have accessible labels, visible focus and at least 44px touch targets; the key bar can scroll horizontally rather than overflow the page.

Use xterm with FitAddon, UTF-8 binary writes, Unicode support compatible with desktop and a self-hosted monospace font. The user approved a narrowly scoped CSP change: add `style-src 'self' 'unsafe-inline'` to permit xterm's runtime-generated styles and inline style attributes. Do not add unsafe-inline to script-src/default-src, allow eval, or loosen connect/object/base restrictions. Test the production-built UI served by the real Rust middleware, not only Vite/jsdom, verifying xterm text, font and resize without style CSP violations and confirming inline scripts remain blocked. Start with the standard renderer; WebGL is not required. Use ResizeObserver plus viewport changes to refit after layout settles, including rotation and virtual keyboard changes; do not send duplicate sizes. Use the current dynamic viewport layout and account for bottom safe-area inset.

No autofocus on Lens entry or reconnect. A deliberate tap on the terminal focuses its textarea and opens the mobile keyboard. Key bar taps preserve established terminal focus without opening a keyboard just from navigation. Esc sends ESC, Tab sends HT, arrow keys use the current terminal cursor-key encoding. Ctrl is a visible one-shot modifier for the next supported control-key character (ASCII @ through _, case-insensitive letters, and ? for DEL); unsupported composed/non-ASCII input is sent unchanged and clears Ctrl. Clear Ctrl on blur, disconnect or Lens change. Normal typing must preserve mobile composition/IME behavior; do not turn intermediate composition events into duplicate input. No synthetic Enter on paste. Do not use disableStdin or indiscriminate onData filtering to lock input during Attached settling: those also suppress terminal-generated replies. Gate actual user entry at keyboard/composition/paste event boundaries and the key bar while leaving terminal replies intact. Apply Ctrl only to user-originated entry, never arbitrary onData replies. Use capture-phase DOM guards for composition, beforeinput/input and paste where required, and verify no user text leaks before Attached while a terminal query still receives its reply.

Support touch scrolling of scrollback without sending accidental terminal clicks; verify the interaction with terminal mouse reporting rather than assuming browser overflow alone handles it. Standard browser paste is supported. Automatic OSC52 clipboard writes, image upload, custom copy UI, pinch zoom, desktop key-binding parity and full mouse interaction are out of scope. Do not promise clipboard APIs unavailable over plain HTTP.

## Security and deployment

Keep the local-Machine-only boundary, paired cookies and Origin checks. No new listening address, port, authentication or TLS model. Apart from the approved style-src policy for terminal rendering, all existing CSP restrictions remain. Existing HTTP/WS-over-WireGuard assumptions remain; terminal content and typed commands have the same trusted-network visibility implications as existing web traffic. Do not enable automatic opening of terminal-provided links or clipboard operations.

Upgrade herdly-web and its bundled web assets together. The installed desktop binary and herdr protocol are unchanged. The ACK correction ships in herdly-web's linked core; already-installed desktop applications continue to work with their existing core and do not need this correction for wire compatibility. No database/data migration. Rollback uses the previous herdly-web executable/assets; new localStorage Lens preference keys can be ignored by old assets. Updating README and build/install documentation belongs to implementation, not running a production deployment. No deployment is authorized by this design.

## Verification

1. Backend unit tests: local Pane-to-Terminal resolution, missing/stopped targets, argv/transport reuse and owned handle cleanup.
2. Shared-core regression tests must force a synchronous ACK from Sink::data and show accounting returns to zero without deadlock; also test pause/resume and close during backpressure. PTY exit tests with slow ACK must confirm bounded completion without claiming full-output retention. Route/socket integration tests using fake terminal handles: pairing/Origin denial; valid open, raw binary output/input, ordered state frames, resize and ACK; malformed/oversized frames; excessive ACK; bounded queues and nonreading peers; open timeout; blocked writes; revocation; close during pending open; disconnect cleanup; stale attempt isolation.
3. Ownership integration: two normal web opens cannot silently share/replace a Sink; explicit Take over only on user request; closing an older handle does not close the replacement. Use controlled real attach/PTY fixtures where mocks alone cannot prove exclusive-attach behavior. New web fixtures must accept a configurable herdr executable (default PATH lookup), use unique temporary Sessions and work on Linux; do not rely on the existing ignored core fixture's hard-coded /opt/homebrew/bin/herdr. Include real PTY cancellation-during-open, blocked-write and graceful-shutdown checks that verify no Attach child remains; terminate the Attach before awaiting input worker completion.
4. Frontend tests: Lens defaults/storage/unavailable Chat, all Pane navigation entry points, no Chat regression, switch cleanup, no autofocus, key bar and Ctrl lifecycle, IME/paste, sizing, ACK after parse, stale socket callbacks, disconnect input loss, normal-only retries, background/foreground and unpaired behavior. Preserve import-guard tests against Tauri dependencies.
5. Run existing web tests/build and Rust web tests, plus applicable core regression tests and desktop typecheck/tests to detect accidental shared-code impact. Record exact commands and any pre-existing failures during implementation setup.
6. Browser smoke at narrow mobile sizes and rotation, with virtual-keyboard layout coverage where automation permits. Real iOS Safari and Android Chrome checks remain explicit manual acceptance for keyboard/IME, touch scroll under mouse reporting, safe areas, background/resume, and Take over between phone and desktop. Mark any checks not performed rather than claiming device support from emulation alone.

Acceptance: a paired phone can open a shell or Agent Pane's Terminal, read/generate live output, type and resize; Held requires explicit Take over; stale/disconnected attempts cannot replay keys or close a newer Attach; leaving Terminal does not kill the Pane process; Chat and installed desktop remain usable without a desktop upgrade.
