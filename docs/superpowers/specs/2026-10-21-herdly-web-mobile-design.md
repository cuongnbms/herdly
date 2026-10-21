# Herdly Web: herdr from a phone

Date: 2026-10-21
Status: approved design (brief approved under autopilot; see Rulings)

## Purpose

The user wants to manage herdr on their devbox from their phone: watch agent status, read an
Agent's Chat, reply, answer its questions and permission prompts, and stop it. **Herdly Web**
is a separate process on the devbox that drives only that Machine's local herdr through
`herdly-core`, and serves a mobile-first web UI that the phone opens in Chrome over WireGuard.

The desktop app does not change. The user: "I don't want to change this app because I want it
optimized for desktop." Nothing under `src/` or `src-tauri/src/` is edited. `herdly-core`
changes only for Task 1's clippy fixes, or if a missing `pub` forces it (none is known:
`MachineManager::call` `core/src/machines.rs:1489`, `views` `:513`, `locate_pane` `:586`,
`open_chat` `:646`, `set_chat_manager` `:400`, `ChatManager::page`
`core/src/transcript/mod.rs:429` and `ChatManager::close` `:416` are all `pub`).

Files outside the desktop app that do change: `src-tauri/Cargo.toml` (`members`), the root
`vite.config.ts` (`test.exclude`), `mise.toml`, `README.md`.

## Setting

- **Devbox**: this Linux machine. LAN `192.168.0.2`, WireGuard `wg0` `192.0.2.10/32`. herdr
  is `~/.local/bin/herdr`, with Sessions `default`, `bluematrix`, `pegabot`, `tasipay` running
  and `carex`, `probe` stopped (`herdr session list`, 2026-10-21). The desktop app on the
  user's Mac reaches the same herdr over SSH; Herdly Web is a second, independent client.
- **Phone**: Android, Chrome, on the WireGuard network.
- **Network**: hub-and-spoke WireGuard. `wg show` lists one peer, `198.51.100.7:51820`,
  with allowed IPs `192.0.2.0/24`; phone-to-devbox traffic is decrypted and re-encrypted at
  that hub.
- **User**: one person, possibly on more than one browser tab or device.

## Decisions

- **A separate web app; the desktop UI stays as it is.** Rejected: a responsive desktop UI.
- **Local only.** Herdly Web drives the devbox's own herdr; no SSH Machines.
  `MachineManager::new` with a registry path that does not exist yields just `LOCAL`
  (`core/src/machines.rs:363`, `load_registry` `:75`).
- **Plain HTTP over WireGuard**, no TLS and no service worker. See
  [ADR 0011](../../adr/0011-herdly-web-plain-http-over-wireguard.md). The MVP needs no secure
  context; the Chrome flag `unsafely-treat-insecure-origin-as-secure` is not required and the
  builder adds nothing that depends on it.
- **Bound to the WireGuard address plus a Paired device cookie.** Never `0.0.0.0`.
- **Herdly Web's crate is in the existing Cargo workspace** as `src-tauri/web`
  (`herdly-web`). Rejected: a separate workspace at the repo root (second `Cargo.lock`,
  drift) and a separate repo with a git dependency (silent breakage while `herdly-core` is
  unstable).
- **Frontend: a new React + Vite app in `web/`**, importing only pure modules from `src/`.
  Rejected: Preact/vanilla (no reuse of `react-markdown` or the React-shaped helpers).
- **Transport: REST for commands, one WebSocket per tab for events.** Rejected: WebSocket
  only (hand-rolled request ids, harder to debug).
- **Chat fan-out by reattaching.** One tail and one broadcast sink per Pane; a new subscriber
  re-runs `open_chat`, so every tab on that Pane gets a fresh `Reset` event. Rejected: a
  per-Pane item cache in Herdly Web (a second copy of the tail's state that can drift).
- **Static bundle served from a directory** (`--static <dir>`), not embedded, so
  `cargo test --workspace` never needs a frontend build.
- **Run as a systemd user unit.**
- **No epic.** Web Push, read-only diff and a phone Terminal lens are later work, not planned
  here.

## MVP scope

1. **Pane list**: Session › Workspace › Pane with each Agent's status (`working`, `blocked`,
   `done`, `idle`, `unknown`), live.
2. **Chat lens** for Claude Code and pi Agents (the parsers core has):
   - read the Transcript (last 500 items, older ones paged in on scroll);
   - send a text message;
   - answer the question, approval, plan or menu prompt waiting on the Agent's screen;
   - Esc and Ctrl+C buttons.

## Architecture

```
Android Chrome ──HTTP + WS over WireGuard──▶ 192.0.2.10:7380   herdly-web
                                                 │  axum: /api/*, /ws, /pair, static web/dist
                                                 ▼
                                            Backend trait ──▶ herdly-core
                                                 MachineManager (LOCAL) + ChatManager
                                                 ▼
                                            local herdr sockets (~/.config/herdr/...)
```

### Crate `src-tauri/web` (`herdly-web`, binary)

Added to `members` in `src-tauri/Cargo.toml`, **not** to `default-members`, so `tauri build`
and the desktop release workflow build exactly what they build today. The developer gates
move to `--workspace` (see Testing). `[profile.release]` has `panic = "abort"`
workspace-wide, so a panicking handler ends the process and systemd restarts it; handlers
return errors instead of panicking.

Modules, one job each:

- `main.rs`: CLI and startup.
  - Subcommands: `serve` (default), `pair`, `devices`, `revoke <id>`. All take
    `--state <dir>`, default `$XDG_STATE_HOME/herdly-web`, falling back to
    `$HOME/.local/state/herdly-web` when `XDG_STATE_HOME` is unset (it is unset in the
    systemd user environment).
  - `serve` and `pair` take `--bind <addr:port>` (default `192.0.2.10:7380`) and
    `--origin <url>` (default `http://<bind>`). `pair` prints its link from `--origin`.
  - `serve` takes `--static <dir>`, required; it exits non-zero if the directory has no
    `index.html`.
  - Startup mirrors the desktop's `.setup` (`src-tauri/src/lib.rs:123-146`):
    `MachineManager::new(<state>/machines.json, emit)` (the file is never written, so only
    `LOCAL` exists); `let chats = Arc::new(ChatManager::default())`;
    `mgr.set_chat_manager(chats.clone())`, keeping `chats` for the Chat hub; then
    `connect_at_startup()` (`core/src/machines.rs:1047`). No `AttachManager`.
  - If the bind fails (address not up), log the error with the address and exit non-zero.
    systemd restarts it.
- `backend.rs`: `trait Backend` with what the handlers need: `views()`, `call(session,
  method, params)`, `locate(pane)`, `open_chat(pane, path: Option<String>, sink)`,
  `page(pane, before, limit)`, `close_chat(pane)`. `Core` implements it over
  `MachineManager` + `ChatManager` with `machine_id = "local"`; tests use a fake.
- `hub.rs`: turns `UiEvent::{Machine, PaneStatus}` (`core/src/machines.rs:193`) into a
  `tokio::sync::broadcast` channel every WebSocket reads, and forwards each `PaneStatus` to
  the Chat hub.
- `chat.rs`: the Chat hub (rules below).
- `api.rs`: REST routes.
- `ws.rs`: the WebSocket protocol.
- `auth.rs`: pairing, devices, cookie check, Origin check.
- `store.rs`: the `<state>` files (locking, atomic writes).

### Chat hub

One entry per Pane: a `broadcast::Sender` of serialised `chat` frames, the set of sockets
subscribed, the current `Located`, and an async mutex.

- **Every open and close of a Pane runs under its mutex**, so a close racing an open never
  leaves an orphan tail (the desktop needed the same, `src/chat/chatSession.ts:15-41`).
- **Subscriptions are a set per socket.** A `subscribe` from a socket already in the set
  (Retry, or a resubscribe) re-runs the open without counting the socket twice.
- **Open**: the socket takes its `broadcast::Receiver` *before* the open runs, so it misses
  nothing. The open calls `Backend::open_chat(pane, path, sink)` with a sink that sends into
  the Pane's channel; core's tail hands the sink to its parse thread within 50 ms
  (`core/src/transcript/tail.rs:105-110`), so a `Reset` event may reach the client before
  `chat_opened`, and the client accepts either order.
  - First subscriber: open with `path = None`.
  - Later subscriber: open again with the entry's current path, so core's
    `reattach_cached` path is taken and the tail sends `Reset` to the same sink: every tab on
    the Pane resets.
- **Locate after a cached open.** Core's contract is that a `cached` open is checked
  afterwards (`core/src/transcript/locate.rs:16-18`; the desktop does it at
  `src/chat/ChatLens.tsx:150-161`). After any open whose `Located.cached` is true and whose
  `path` was `None`, the hub calls `Backend::locate(pane)`; when the path differs it opens
  again with `Some(fresh.path)` on the same sink, so every tab gets the new Transcript, and
  sends `chat_opened` with the fresh `Located`. This catches `/clear`, `/resume` and a new
  session in the Pane.
- **Pending Transcript.** While the entry's `Located.pending` is true, every `PaneStatus`
  event for that Pane, and once more 1500 ms after it, triggers a locate; when it is no longer
  pending (or the path changed) the hub opens on the fresh path. This mirrors
  `src/chat/pendingTranscript.ts`.
- **Ambiguous location**: the hub uses `Located.path` as core chose it; `chat_opened` carries
  `ambiguous` and `candidates`, and the Chat screen shows "Several transcripts match; showing
  the newest". No picker in the MVP.
- **Last subscriber gone** (unsubscribe or socket closed): `close_chat`, which parks the tail
  (`PARKED_TAILS` = 3) so reopening is cheap; the entry is dropped.
- **Open fails**: every subscribed socket gets `chat_error`; the entry keeps its subscribers
  and no tail. A later `subscribe` (Retry) runs the open again. Unsubscribing the last
  socket drops the entry.
- **Tail ends**: core sends an `error` `ChatEvent` when the tail exits; it reaches clients as
  `{type: "chat", event: {type: "error", …}}`. Both error shapes show the same Retry, which
  sends `subscribe` again.
- Frames are serialised once per event and shared (`Arc<str>`) across sockets; a `Reset`
  event can be several MB (500 items, tool results ≤16 KiB and input strings ≤64 KiB each,
  `core/src/transcript/mod.rs:170-171`). HTTP responses and WebSocket frames are not
  compressed in the MVP.

### Frontend `web/`

- Own `package.json` and `pnpm-lock.yaml`, installed with `pnpm install` inside `web/`.
  `web/` is **not** added to the root `pnpm-workspace.yaml`, so the root lock that the
  release job installs with `--frozen-lockfile` does not change. React 19, Vite,
  `react-markdown` + `remark-gfm` + `rehype-highlight`, vitest + testing-library, the same
  major versions as the root `package.json`.
- Vite and `tsconfig` alias `@desktop` → `../src`. The reused modules are exactly
  `lib/types.ts`, `chat/chatStore.ts`, `chat/checklist.ts`, `chat/prompt/screenPrompt.ts`,
  `chat/prompt/sendAnswer.ts`, `chat/prompt/askedPreviews.ts`: each imports only relative
  paths within this set (or nothing). A module with a bare import (`react`, `@tauri-apps/*`,
  …) would resolve from the repo root's `node_modules`, which the devbox does not have, or
  load a second React, so none is reused; `src/chat/outgoing.ts` (imports `react`) and
  `src/chat/markdown.tsx` (imports `@tauri-apps/plugin-opener`) are rewritten in `web/`.
- **Import guard**: a vitest test in `web/` that walks the import graph of every `@desktop/*`
  import and fails if any file reached has a non-relative import, or is `src/lib/ipc.ts`.
- Markdown renders without `rehype-raw`: HTML in a Transcript shows as text. Links open with
  `target="_blank" rel="noopener noreferrer"`.
- Built with `pnpm build` into `web/dist`, which `--static` points at.
- The root `vite.config.ts` gains `"web/**"` in `test.exclude`, so the desktop's `pnpm test`
  does not collect `web/` tests (it would today: its exclude is only
  `[...configDefaults.exclude, ".worktrees/**"]`, `vite.config.ts:37`).

## API

Every Pane is on Machine `local`. The client sends `{session, pane_id}`; Herdly Web sets
`machine_id`. It builds every herdr call's params itself; there is no generic `herdr_call`
proxy. The three methods are in `ALLOWED_METHODS` (`core/src/machines.rs:35`) and go through
`MachineManager::call`.

| Route | Does |
|---|---|
| `GET /api/me` | `{device_id, name}` of the calling Paired device |
| `GET /api/machines` | `views()` |
| `GET /api/chat/page?session&pane_id&before&limit` | `ChatManager::page`, `limit` ≤ `CHAT_PAGE` (200); 404 when the Pane has no open Chat |
| `POST /api/pane/read` `{session, pane_id}` | `pane.read` with `source: "visible"`, `format: "text"`, `strip_ansi: true`; returns `{text}`, taken from herdr's `text` or `read.text` (both shapes occur, `src/chat/PromptPanel.tsx:316-317`) |
| `POST /api/pane/prompt` `{session, pane_id, text}` | `agent.prompt` `{target, text}` |
| `POST /api/pane/keys` `{session, pane_id, keys: string[]}` | `agent.send_keys` `{target, keys}` |
| `POST /api/pane/text` `{session, pane_id, text}` | `pane.send_text` `{pane_id, text}` |

- Request bodies are capped at 1 MiB.
- Errors return core's `AppError` JSON. Status by code: `not_found` → 404, `invalid` → 400,
  `conflict` → 409, `timeout` → 504, any other herdr or core error → 502. Missing or unknown
  cookie → 401, bad Origin → 403.

### WebSocket `/ws`

One connection per tab, JSON text frames.

- The upgrade needs the cookie and the Origin; otherwise it is refused with 401 or 403. The
  browser cannot read that status, so the client calls `GET /api/me` after every failed or
  closed socket and shows "Not paired" on a 401.
- Server → client:
  - on connect: `{type: "machines", views}`;
  - `{type: "machine", view}` and `{type: "pane_status", ev}` from the hub;
  - `{type: "chat_opened", pane, located}`, `{type: "chat", pane, event}` (a core
    `ChatEvent`), `{type: "chat_error", pane, error}`, only to sockets subscribed to `pane`.
- Client → server: `{type: "subscribe", pane: {session, pane_id}}`,
  `{type: "unsubscribe", pane}`.
- A socket whose broadcast receiver reports `Lagged` is closed by Herdly Web (close code
  4000). The client reconnects and resubscribes, and the `Reset` event that follows restores
  the full state, so a slow client never silently misses an `Append`. The resubscribe also
  resets every other tab on that Pane, which jumps them to the latest message and drops their
  paged-in items; accepted.
- A socket of a revoked device is closed with code 4401 within 15 s of the revoke; the client
  shows "Not paired" without reconnecting.

## Flows

1. **Open the app**: GET `/` serves `web/dist/index.html`. The UI connects `/ws`; a refused or
   closed socket leads to `GET /api/me` as above.
2. **Open a Chat**: `subscribe` → `chat_opened` and a `Reset` event `{items, total}` (in
   either order) → `Append`/`Meta` events. Scrolling to the top pages older items with
   `/api/chat/page`. Every `Reset` replaces the items.
3. **Send a message**: the Composer POSTs `/api/pane/prompt`. The message shows as pending
   until an `Append` carries a user item with the same text, or 30 s pass (then it shows
   "not seen yet"). This is `web/`'s own code, after the idea of `src/chat/outgoing.ts`.
4. **Answer a prompt**: only while the Pane's status is `blocked`, as on the desktop
   (`src/chat/ChatLens.tsx:602-604`):
   - The Chat screen POSTs `/api/pane/read` at once when the status turns `blocked` and on
     every status or title change, then every 1500 ms (`PROMPT_POLL_MS`,
     `src/chat/PromptPanel.tsx:27`), never while a read is in flight or the page is hidden.
   - It parses the screen with `readPrompt` from `screenPrompt.ts` (with the fallback, which
     always yields a card, `screenPrompt.ts:889-891`) and answers with `sendAnswer` through a
     `PromptIo {read, keys, text}` (`src/chat/prompt/sendAnswer.ts:12`) backed by the REST
     routes.
   - While `blocked`, the prompt card replaces the Composer's text field (text sent with
     `agent.prompt` would land in the Agent's menu); Esc and Ctrl+C stay.
   - When the status leaves `blocked`, polling stops and the card goes.
5. **Stop the Agent**: Esc POSTs `keys: ["esc"]`, Ctrl+C `keys: ["ctrl+c"]` (key names
   verified against herdr's parser, `src/chat/Composer.tsx:20-24`).
6. **Status**: `pane_status` and `machine` update the list. No notification is raised.
7. **Seen `done`**: Herdly Web has its own `MachineManager` and so its own done marks, which
   only a `pane.focus` from that process clears (`core/src/herdr/model.rs:5-9`); Herdly Web
   never focuses. The client therefore keeps its own seen marks: opening a Chat of a `done`
   Pane records that Pane as seen in `localStorage`, and the list shows a seen `done` Pane
   like `idle` until its status changes.

## Auth

- **State files** under `<state>` (directory `0700`, files `0600`): `pairing.json`,
  `devices.json`, `.lock`. Every reader and writer, CLI or `serve`, takes an exclusive
  `flock` on `.lock`, reads the file fresh, changes it, writes a temp file and renames it over
  the old one. `serve` keeps no in-memory copy it writes back.
- **Pairing**: `herdly-web pair` writes `pairing.json` with the SHA-256 of a random 256-bit
  token and an expiry 10 minutes out, and prints `<origin>/pair?t=<token>` plus a QR code of
  it in the terminal. A new `pair` replaces any pending one.
- `GET /pair?t=<token>`: if the hash matches and has not expired, Herdly Web adds a device
  `{id, name (from User-Agent), cookie_sha256, created, last_seen}` to `devices.json`,
  deletes `pairing.json`, sets the cookie and redirects to `/`. Otherwise 403 with a plain
  "pairing link expired or used" page.
- **Cookie** `herdly_web`: random 256-bit, `HttpOnly`, `SameSite=Strict`, `Path=/`,
  `Max-Age` one year. Only its hash is stored. It cannot be `Secure` (plain HTTP).
- Every `/api/*` route and the `/ws` upgrade need a cookie whose hash is in `devices.json`.
  `serve` caches the set of hashes and reloads it when the file's mtime changes. `last_seen`
  is written at most once an hour per device.
- Static files and `/pair` need no cookie.
- **Origin check**: every POST and the `/ws` upgrade need `Origin` equal to `--origin`;
  anything else is 403. This plus `SameSite=Strict` blocks a page elsewhere from driving the
  Agents through the phone's browser.
- `herdly-web devices` lists devices; `herdly-web revoke <id>` removes one. The next request
  sees it (mtime reload); open sockets of that device are closed with 4401 by a 15 s check.
- **Headers**: every response carries `X-Content-Type-Options: nosniff`; HTML carries
  `Content-Security-Policy: default-src 'self'; connect-src 'self' ws://<origin host:port>;
  img-src 'self' data:; object-src 'none'; base-uri 'none'`. `index.html` is served with
  `Cache-Control: no-cache`; hashed files under `assets/` with
  `Cache-Control: public, max-age=31536000, immutable`, so a rebuild never leaves the phone on
  an `index.html` pointing at deleted assets.

## Mobile UI

Two screens, phone-first (one column, thumb-reachable controls at the bottom).

1. **Pane list**: Sessions (running first) › Workspaces › Panes. Each Pane row shows the
   Agent name, the Pane title and a status badge; `blocked` Panes sort to the top of their
   Session. Tapping a Pane with a Claude Code or pi Agent opens its Chat; other Panes show
   "Chat lens supports Claude Code and pi only".
2. **Chat**: header (back, Pane title, status), the Transcript (markdown, collapsed tool
   calls, checklists via `checklist.ts`, images as an "[image]" placeholder), and a bottom
   bar: Esc, Ctrl+C, and either the text field with Send or, while `blocked`, the prompt card.

Both screens show a "Disconnected, reconnecting…" bar while the WebSocket is down, and the
"Not paired" screen replaces everything on a 401.

## Error handling

- **herdr down or not found**: the local `MachineView` carries the state and error; the list
  shows them as a banner. Herdly Web keeps running.
- **Chat cannot open** (no transcript, unsupported agent) or **tail ends**: the Chat screen
  shows the message and a Retry (see Chat hub).
- **REST failure**: the Composer keeps the text and shows the error; a prompt answer that
  `sendAnswer` reports as not sent shows the fresh prompt.
- **WebSocket drop** (phone sleeps, network change): `GET /api/me`; on 401 "Not paired",
  otherwise reconnect with backoff 1 s doubling to 15 s, then resubscribe to the open Chat;
  its `Reset` event restores the view.
- **Bind failure** or missing `--static`: exit non-zero with the reason.

## Testing

- **Task 1, before any web code**:
  - make `cargo clippy --workspace --all-targets -- -D warnings` clean. The four known errors:
    `core/src/machines.rs:1815`, `core/src/transcript/claude.rs:575`,
    `core/tests/ssh_localhost.rs:52`, `core/tests/attach_herdr.rs:72`;
  - record two baselines: `cargo test --workspace` (known failure:
    `quota::credentials::tests::opencode_db_reads_the_active_go_key_after_a_clean_exit`,
    `core/src/quota/credentials.rs:302`) and
    `cargo test --workspace -- --ignored --test-threads=1` (the two `#[ignore]` tests,
    `core/tests/attach_herdr.rs:69`, `core/tests/ssh_localhost.rs:31`).
- **Developer gates**: `mise.toml` `lint` becomes `cargo clippy --workspace -- -D warnings`,
  `test:backend` `cargo test --workspace`, the ignored-tests task gains `--workspace`, and a
  `test:web` task runs `pnpm --dir web test`, included in `mise run test`. README line 59
  ("`cargo test` and `cargo clippy` in `src-tauri` cover both crates") is updated to say
  `--workspace` covers all three.
- **Rust, `herdly-web`**, against a fake `Backend`:
  - auth: token hashing, expiry, one-time use, cookie check, revoke seen through the mtime
    reload, a revoke while `serve` writes `last_seen` stays revoked;
  - Origin check on POST and on the WebSocket upgrade;
  - each REST route builds the herdr params it should and maps errors to status codes;
  - Chat hub: first subscriber opens with no path; a second opens again (both get `Reset`);
    a socket subscribing twice counts once; the last one closes; open and close of one Pane
    never overlap; a cached open with a changed location reopens on the fresh path; a pending
    location is retried on a status event; a failed open sends `chat_error` and a Retry
    reopens;
  - a lagging socket is closed with 4000; a revoked device's socket with 4401;
  - static: `Cache-Control` on `index.html` and `assets/*`; missing `--static` exits
    non-zero; a bind failure exits non-zero.
- **Rust, `--ignored`**: one test that starts `serve` on `127.0.0.1` against the real local
  herdr and checks `/api/machines` lists a running Session.
- **Web, vitest**: Pane list (sorting, badges, seen `done`, live updates from a mocked
  socket), Chat (`Reset` before or after `chat_opened`, `Append`, paging, pending message,
  ambiguous note, Retry), prompt card only while `blocked` through a mocked `PromptIo`,
  Composer hidden while `blocked`, Esc and Ctrl+C, the reconnect bar, "Not paired" after a
  failed socket and a 401 from `/api/me`, close code 4401, and the import guard.
- **Desktop unchanged**: `git diff main -- src src-tauri/src` is empty; the desktop's
  `pnpm test` (which no longer collects `web/`) and `cargo test -p herdly` pass.

## Operations

1. **Environments**: the devbox (this Linux machine, `wg0` `192.0.2.10`) and the user's
   Android phone on WireGuard. Nothing else.
2. **Install** (from the main checkout, not a `.worktrees/` path):
   `cargo build --release -p herdly-web` in `src-tauri`; `pnpm install && pnpm build` in
   `web/`; copy `web/herdly-web.service` to `~/.config/systemd/user/`, replacing `@REPO@`
   with the checkout's absolute path. The unit has
   `ExecStart=@REPO@/src-tauri/target/release/herdly-web serve --static @REPO@/web/dist`,
   `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin` so herdr is found,
   `Restart=on-failure`, `RestartSec=5`. `web/README.md` gives the `sed` line for the
   substitution.
3. **Upgrade**: `git pull`, rebuild both as in Install, `systemctl --user restart
   herdly-web`. `<state>` needs no migration; Paired devices stay paired.
4. **Irreversible or security-sensitive steps, ask before running**:
   - `systemctl --user enable --now herdly-web`;
   - `loginctl enable-linger cuongnb` (needed only for it to run while the user is logged
     out; `Linger=no` today);
   - `herdly-web pair` and opening the link on the phone (the user does this).
5. **Rollback**: `systemctl --user disable --now herdly-web`, remove the unit file and
   `~/.local/state/herdly-web`. A half-applied install (unit present, binary missing) fails
   to start and touches nothing; the same steps remove it. The desktop app is unaffected
   either way.
6. **Live check**: `curl -i http://192.0.2.10:7380/api/machines` without a cookie returns 401;
   on the phone, after pairing, the list shows `default`, `bluematrix`, `pegabot`,
   `tasipay`; a Claude Code Pane's Chat opens and Esc reaches it.

## Done when

- The checks under Testing pass and the desktop diff is empty.
- `web/README.md` covers build, install, upgrade, pairing, revoking and rollback.
- The root `README.md` mentions Herdly Web in one line and points at `web/README.md`.

## Non-goals

- Web Push, and moving `shouldNotify` (`src/notify.ts:35`) to Herdly Web.
- Any notification, sound or vibration.
- Read-only diff, Git view, Files, Edit mode.
- Terminal lens, attach, Take over, "held"; a screen mirror (`pane.read` as ANSI).
- A picker for an ambiguous Transcript.
- Images in the Composer, showing Transcript images, slash completion, model menu, Fork,
  Side question.
- Creating, closing or renaming Tabs, Workspaces, Panes; starting or stopping Sessions.
- Remote (ssh) Machines.
- HTTPS, a service worker, PWA install, response compression.
- Quota.

## Rulings

Made under autopilot; the user has not reviewed them.

### Flagged
- none

### Other
- Ruling: axum for HTTP and WebSocket — mature, tokio-native, built-in WebSocket upgrade — cost if wrong: swapping the HTTP layer of one small crate.
- Ruling: default port 7380 — free on the devbox (`ss -ltn`) — cost if wrong: a flag change.
- Ruling: pairing and device state as files in `<state>`, shared by the CLI and `serve` under `flock`, reloaded on mtime — no IPC between CLI and `serve` — cost if wrong: a revoke that waits for a restart.
- Ruling: handlers go through a `Backend` trait with a fake for tests — core's MachineManager test seams are private — cost if wrong: one indirection.
- Ruling: `herdly-web` is in `members`, not `default-members`; `mise.toml` and README move to `--workspace` — keeps `tauri build` and the release workflow unchanged — cost if wrong: a dev who runs bare `cargo test` misses a web break.
- Ruling: `web/` has its own pnpm lock and is not a pnpm workspace member — the release job's frozen root lock stays as it is — cost if wrong: two lockfiles to update.
- Ruling: reuse only `src/` modules with relative imports, enforced by a vitest import guard — bare imports from `src/` resolve to the root `node_modules` or a second React (reviewer's trial with vite 8.3.4) — cost if wrong: a little duplicated React code.
- Ruling: static files and `/pair` need no cookie; everything else does — the bundle holds no secrets — cost if wrong: anyone on WireGuard can download the UI code.
- Ruling: Markdown without `rehype-raw`; CSP header — Transcript content is untrusted — cost if wrong: some HTML in messages shows as text.
- Ruling: Transcript images shown as a placeholder — keeps the MVP to the agreed scope — cost if wrong: one more route (`ChatManager::image`).
- Ruling: an ambiguous Transcript shows core's choice with a note, no picker — keeps the MVP small — cost if wrong: the user sees the wrong conversation in a rare case until they use the desktop.
- Ruling: `done` cleared by client-side seen marks in `localStorage`, not by `pane.focus` — `pane.focus` would move herdr's real focus under the desktop, and a core seam would change core — cost if wrong: seen state does not follow the user across devices.
- Ruling: the prompt card replaces the Composer while `blocked` — text sent then would land in the Agent's menu — cost if wrong: the user cannot queue a message while a prompt waits.
- Ruling: a resubscribe after lag resets every tab on that Pane — follows the approved fan-out choice — cost if wrong: other tabs lose their paged-in items now and then.
- Ruling: Task 1 cleans `clippy --all-targets` and records both baselines — the user's answer — cost if wrong: none.
- Ruling: glossary terms **Herdly Web** and **Paired device** — "server" is on the glossary's avoid list — cost if wrong: a rename.
