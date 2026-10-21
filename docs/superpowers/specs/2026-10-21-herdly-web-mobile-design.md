# Herdly Web: herdr from a phone

Date: 2026-10-21
Status: approved design (brief approved under autopilot; see Rulings)

## Purpose

The user wants to manage herdr on their devbox from their phone: watch agent status, read an
Agent's Chat, reply, answer its questions and permission prompts, and stop it. **Herdly Web**
is a separate process on the devbox that drives only that Machine's local herdr through
`herdly-core`, and serves a mobile-first web UI that the phone opens in Chrome over WireGuard.

The desktop app does not change. The user: "I don't want to change this app because I want it
optimized for desktop." Nothing under `src/` or `src-tauri/src/` is edited; `herdly-core`
changes only if a missing `pub` forces it (none is known: `MachineManager::call`
`core/src/machines.rs:1489`, `views` `:513`, `open_chat` `:646`, `ChatManager::page`
`core/src/transcript/mod.rs:429` and `ChatManager::close` are all `pub`).

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
  (`core/src/machines.rs:363`, `load_registry` `:72`).
- **Plain HTTP over WireGuard**, no TLS and no service worker. See
  [ADR 0011](../../adr/0011-herdly-web-plain-http-over-wireguard.md). The MVP needs no secure
  context; the Chrome flag `unsafely-treat-insecure-origin-as-secure` is not required and the
  builder adds nothing that depends on it.
- **Bound to the WireGuard address plus a paired-device cookie.** Never `0.0.0.0`.
- **Server in the existing Cargo workspace** as `src-tauri/web` (`herdly-web`). Rejected: a
  separate workspace at the repo root (second `Cargo.lock`, drift) and a separate repo with a
  git dependency (silent breakage while `herdly-core` is unstable).
- **Frontend: a new React + Vite app in `web/`**, importing only pure modules from `src/`.
  Rejected: Preact/vanilla (no reuse of `react-markdown` or the React-shaped helpers).
- **Transport: REST for commands, one WebSocket per tab for events.** Rejected: WebSocket
  only (hand-rolled request ids, harder to debug).
- **Chat fan-out by reattaching.** One tail and one broadcast sink per Pane; a new subscriber
  re-runs `open_chat`, so every tab on that Pane gets a fresh `Reset`. Rejected: a server-side
  item cache per Pane (a second copy of the tail's state that can drift).
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
and the desktop release workflow build exactly what they build today. Gates run with
`--workspace`.

Modules, one job each:

- `main.rs`: CLI (`serve` default, `pair`, `devices`, `revoke <id>`), config, startup.
  - `serve` flags: `--bind <addr:port>` (default `192.0.2.10:7380`), `--static <dir>`,
    `--state <dir>` (default `$XDG_STATE_HOME/herdly-web`, i.e. `~/.local/state/herdly-web`),
    `--origin <url>` (default `http://<bind>`).
  - Startup mirrors the desktop's `.setup` (`src-tauri/src/lib.rs:123-146`):
    `MachineManager::new(<state>/machines.json, emit)` (the file is never written, so only
    `LOCAL` exists), `set_chat_manager(ChatManager::default())`, then
    `connect_at_startup()` (`core/src/machines.rs:1047`). No `AttachManager`.
  - If the bind fails (address not up), log the error and exit non-zero. systemd restarts it.
- `backend.rs`: `trait Backend` with what the handlers need: `views()`, `call(session, method,
  params)`, `open_chat(pane, sink)`, `page(pane, before, limit)`, `close_chat(pane)`. `Core`
  implements it over `MachineManager` + `ChatManager` with `machine_id = "local"`; tests use a
  fake.
- `hub.rs`: turns `UiEvent::{Machine, PaneStatus}` (`core/src/machines.rs:193`) into a
  `tokio::sync::broadcast` channel every WebSocket reads.
- `chat.rs`: the Chat hub, one entry per Pane: a `broadcast::Sender<ChatEvent>`, a subscriber
  count, and an async mutex serialising opens of that Pane.
  - First subscriber: `open_chat` with a sink that sends into the Pane's broadcast channel.
  - Later subscriber: `open_chat` again (core's `reattach_cached` path, no locating); the
    tail sends `Reset` to the same sink (`core/src/transcript/tail.rs:107`), so every tab on
    the Pane resets. The chat client treats `Reset` as "replace the items".
  - Last subscriber gone (unsubscribe or socket closed): `ChatManager::close`, which parks the
    tail (`PARKED_TAILS` = 3) so reopening is cheap.
- `api.rs`: REST routes (below).
- `ws.rs`: the WebSocket protocol (below).
- `auth.rs`: pairing, devices, cookie check, Origin check.

### Frontend `web/`

- Own `package.json`: React 19, Vite, `react-markdown` + `remark-gfm` + `rehype-highlight`,
  vitest + testing-library. Same major versions as the root `package.json`.
- Vite alias `@desktop` → `../src`. Allowed imports from it: `lib/types.ts`,
  `chat/chatStore.ts`, `chat/checklist.ts`, `chat/prompt/screenPrompt.ts`,
  `chat/prompt/sendAnswer.ts`, `chat/prompt/askedPreviews.ts`, and other files under
  `src/chat/` only if they import neither `@tauri-apps/*` nor `lib/ipc`. A test fails the
  build if anything in the web bundle's import graph reaches `@tauri-apps/*` or
  `src/lib/ipc.ts`. (`src/chat/markdown.tsx` imports `@tauri-apps/plugin-opener`, so the web
  app has its own markdown components.)
- Markdown renders without `rehype-raw`: HTML in a Transcript shows as text. Links open with
  `target="_blank" rel="noopener noreferrer"`.
- Built with `npm run build` into `web/dist`, which `--static` points at.

## API

Every Pane is on Machine `local`. The client sends `{session, pane_id}`; the server sets
`machine_id`. The server builds every herdr call's params itself; there is no generic
`herdr_call` proxy. All four methods are in `ALLOWED_METHODS` (`core/src/machines.rs:35`) and
go through `MachineManager::call`.

| Route | Does |
|---|---|
| `GET /api/machines` | `views()` |
| `GET /api/chat/page?session&pane_id&before&limit` | `ChatManager::page`, `limit` ≤ `CHAT_PAGE` (200) |
| `POST /api/pane/read` `{session, pane_id, format: "text" \| "ansi"}` | `pane.read` with `source: "visible"`, `strip_ansi` for text |
| `POST /api/pane/prompt` `{session, pane_id, text}` | `agent.prompt` `{target, text}` |
| `POST /api/pane/keys` `{session, pane_id, keys: string[]}` | `agent.send_keys` `{target, keys}` |
| `POST /api/pane/text` `{session, pane_id, text}` | `pane.send_text` `{pane_id, text}` |

- Request bodies are capped at 1 MiB.
- Errors return core's `AppError` JSON: `not_found` → 404, `invalid` → 400, missing or
  unknown cookie → 401, bad Origin → 403, any other herdr or core error → 502.

### WebSocket `/ws`

One connection per tab, JSON text frames.

- Server → client:
  - on connect: `{type: "machines", views}`;
  - `{type: "machine", view}` and `{type: "pane_status", ev}` from the hub;
  - `{type: "chat_opened", pane, located}`, `{type: "chat", pane, event}` (a core
    `ChatEvent`), `{type: "chat_error", pane, error}`, only to sockets subscribed to `pane`.
- Client → server: `{type: "subscribe", pane: {session, pane_id}}`,
  `{type: "unsubscribe", pane}`.
- A socket whose broadcast receiver reports `Lagged` is closed by the server. The client
  reconnects and resubscribes, and the `Reset` that follows restores the full state, so a
  slow client never silently misses an `Append`.

## Flows

1. **Open the app**: GET `/` serves `web/dist/index.html`. The UI connects `/ws`; a 401 on
   the upgrade or on `/api/machines` shows the "Not paired" screen.
2. **Open a Chat**: subscribe → `chat_opened` → `Reset {items, total}` → `Append`/`Meta`.
   Scrolling to the top pages older items with `/api/chat/page`.
3. **Send a message**: the Composer POSTs `/api/pane/prompt`. The message shows as pending
   until the Transcript's `Append` carries it (the idea of `src/chat/outgoing.ts`, reused
   only if it stays free of Tauri imports).
4. **Answer a prompt**: while a Chat is open the client POSTs `/api/pane/read` (text) at once
   on every status change, then every 1500 ms (`PROMPT_POLL_MS`,
   `src/chat/PromptPanel.tsx:27`), never while one read is in flight or the page is hidden.
   It parses the screen with `screenPrompt` and answers with `sendAnswer` through a
   `PromptIo {read, keys, text}` (`src/chat/prompt/sendAnswer.ts:12`) backed by the REST
   routes.
5. **Stop the Agent**: Esc POSTs `keys: ["esc"]`, Ctrl+C `keys: ["ctrl+c"]` (key names
   verified against herdr's parser, `src/chat/Composer.tsx:20-24`).
6. **Status**: `pane_status` and `machine` update the list. No notification is raised.

## Auth

- **Pairing**: `herdly-web pair` writes `<state>/pairing.json` with the SHA-256 of a random
  256-bit token and an expiry 10 minutes out, and prints
  `http://192.0.2.10:7380/pair?t=<token>` plus a QR code of it in the terminal. A new `pair`
  replaces any pending one.
- `GET /pair?t=<token>`: if the hash matches and has not expired, the server creates a device
  `{id, name (from User-Agent), cookie_sha256, created, last_seen}` in `<state>/devices.json`,
  deletes `pairing.json`, sets the cookie and redirects to `/`. Otherwise 403 with a plain
  "pairing link expired or used" page.
- **Cookie** `herdly_web`: random 256-bit, `HttpOnly`, `SameSite=Strict`, `Path=/`,
  `Max-Age` one year. Only its hash is stored.
- Every `/api/*` route and the `/ws` upgrade need a cookie whose hash is in `devices.json`.
  Static files and `/pair` do not.
- **Origin check**: every POST and the `/ws` upgrade need `Origin` equal to `--origin`;
  anything else is 403. This plus `SameSite=Strict` blocks a page elsewhere from driving the
  Agents through the phone's browser.
- `herdly-web devices` lists devices; `herdly-web revoke <id>` removes one. The server reads
  `devices.json` again when its mtime changes, so a revoke takes effect on the next request;
  open WebSockets of a revoked device are closed within 15 s.
- Files under `<state>` are created `0600`, the directory `0700`.
- Responses carry `Content-Security-Policy: default-src 'self'; connect-src 'self'
  ws://<bind>; img-src 'self' data:; object-src 'none'; base-uri 'none'` and
  `X-Content-Type-Options: nosniff`.

## Mobile UI

Two screens, phone-first (one column, thumb-reachable controls at the bottom).

1. **Pane list**: Sessions (running first) › Workspaces › Panes. Each Pane row shows the
   Agent name, the Pane title and a status badge; `blocked` Panes sort to the top of their
   Session. Tapping a Pane with a Claude Code or pi Agent opens its Chat; other Panes show
   "Chat lens supports Claude Code and pi only".
2. **Chat**: header (back, Pane title, status), the Transcript (markdown, collapsed tool
   calls, checklists via `checklist.ts`, images as an "[image]" placeholder), a prompt card
   above the Composer when a screen prompt is found, and a bottom bar with Esc, Ctrl+C, the
   text field and Send.

Both screens show a "Disconnected, reconnecting…" bar while the WebSocket is down.

## Error handling

- **herdr down or not found**: the local `MachineView` carries the state and error; the list
  shows them as a banner. The server keeps running.
- **Chat cannot open** (no transcript, unsupported agent): `chat_error` for that Pane; the
  Chat screen shows the message and a Retry.
- **REST failure**: the Composer keeps the text and shows the error; a prompt answer that
  `sendAnswer` reports as not sent shows the fresh prompt.
- **WebSocket drop** (phone sleeps, network change): reconnect with backoff 1 s doubling to
  15 s, then resubscribe to the open Chat; its `Reset` restores the view.
- **Bind failure**: exit non-zero with the address in the message.

## Testing

- **Task 1, before any web code**: make `cargo clippy --workspace --all-targets -- -D warnings`
  clean (4 known errors in test code: `core/src/machines.rs:1815`,
  `core/src/transcript/claude.rs:575`, and a `Command` never `wait()`ed in `core/tests/*.rs`)
  and run `cargo test --workspace -- --ignored --test-threads=1`, recording the result as the
  baseline. Known pre-existing failure:
  `quota::credentials::tests::opencode_db_reads_the_active_go_key_after_a_clean_exit`.
- **Rust, `herdly-web`**, against a fake `Backend`:
  - auth: pairing token hashing, expiry, one-time use, cookie check, revoke via mtime reload;
  - Origin check on POST and on the WebSocket upgrade;
  - each REST route builds the herdr params it should and maps errors to status codes;
  - Chat hub: first subscriber opens, second reopens (both get `Reset`), last one closes,
    concurrent subscribes open once at a time;
  - a lagging socket is closed;
  - bind failure exits non-zero.
- **Rust, `--ignored`**: one test that starts the server on `127.0.0.1` against the real
  local herdr and checks `/api/machines` lists a running Session.
- **Web, vitest**: Pane list (sorting, badges, live updates from a mocked socket), Chat
  (Reset, Append, paging, pending message), prompt card through a mocked `PromptIo`, Esc and
  Ctrl+C, the reconnect bar, the "Not paired" screen, and the import guard.
- **Desktop unchanged**: `git diff main -- src src-tauri/src` is empty, and the desktop's
  `npm test` and `cargo test -p herdly` still pass.

## Operations

1. **Environments**: the devbox (this Linux machine, `wg0` `192.0.2.10`) and the user's
   Android phone on WireGuard. Nothing else.
2. **Install**: `cargo build --release -p herdly-web`, `npm ci && npm run build` in `web/`, a
   unit file `~/.config/systemd/user/herdly-web.service` (in the repo as
   `web/herdly-web.service`) with `ExecStart=<repo>/src-tauri/target/release/herdly-web serve
   --static <repo>/web/dist`, `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`
   so herdr is found, `Restart=on-failure`, `RestartSec=5`.
3. **Irreversible or security-sensitive steps, ask before running**:
   - `systemctl --user enable --now herdly-web`;
   - `loginctl enable-linger cuongnb` (needed only for it to run while the user is logged
     out; `Linger=no` today);
   - `herdly-web pair` and opening the link on the phone (the user does this).
4. **Rollback**: `systemctl --user disable --now herdly-web`, remove the unit file and
   `~/.local/state/herdly-web`. A half-applied install (unit present, binary missing) fails
   to start and touches nothing; the same steps remove it. The desktop app is unaffected
   either way.
5. **Live check**: `curl -i http://192.0.2.10:7380/api/machines` without a cookie returns 401;
   on the phone, after pairing, the list shows `default`, `bluematrix`, `pegabot`,
   `tasipay`; a Claude Code Pane's Chat opens and Esc reaches it.

## Done when

- The checks under Testing pass and the desktop diff is empty.
- `web/README.md` covers build, install, pairing, revoking and rollback.
- The root `README.md` mentions Herdly Web in one line and points at `web/README.md`.

## Non-goals

- Web Push, and moving `shouldNotify` (`src/notify.ts:35`) to the server.
- Any notification, sound or vibration.
- Read-only diff, Git view, Files, Edit mode.
- Terminal lens, attach, Take over, "held".
- Images in the Composer, showing Transcript images, slash completion, model menu, Fork,
  Side question.
- Creating, closing or renaming Tabs, Workspaces, Panes; starting or stopping Sessions.
- Remote (ssh) Machines.
- HTTPS, a service worker, PWA install.
- Quota.

## Rulings

Made under autopilot; the user has not reviewed them.

### Flagged
- none

### Other
- Ruling: axum for HTTP and WebSocket — mature, tokio-native, built-in WebSocket upgrade — cost if wrong: swapping the HTTP layer of one small crate.
- Ruling: default port 7380 — free on the devbox (`ss -ltn`) — cost if wrong: a flag change.
- Ruling: pairing and device state as files in `~/.local/state/herdly-web`, shared by the CLI and the server, reloaded on mtime — no IPC between CLI and server — cost if wrong: a revoke that waits for a restart.
- Ruling: handlers go through a `Backend` trait with a fake for tests — core's MachineManager test seams are private — cost if wrong: one indirection.
- Ruling: `herdly-web` is in `members`, not `default-members`; gates use `--workspace` — keeps `tauri build` and the release workflow unchanged — cost if wrong: a dev forgets `--workspace` and misses a web break.
- Ruling: static files and `/pair` need no cookie; everything else does — the bundle holds no secrets — cost if wrong: anyone on WireGuard can download the UI code.
- Ruling: Markdown without `rehype-raw`; CSP header — Transcript content is untrusted — cost if wrong: some HTML in messages shows as text.
- Ruling: Transcript images shown as a placeholder — keeps the MVP to the agreed scope — cost if wrong: one more route (`ChatManager::image`).
- Ruling: Task 1 cleans `clippy --all-targets` and records the `--ignored` baseline — the user's answer — cost if wrong: none.
- Ruling: glossary terms **Herdly Web** and **Paired device** — "server" is on the glossary's avoid list — cost if wrong: a rename.
