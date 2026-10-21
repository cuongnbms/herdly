# Herdly Web Implementation Plan

> **For agentic workers:** Execute this plan task by task with the executing-plans skill. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Herdly Web: a process on the devbox (`herdly-web`, Rust, axum) that drives the local herdr through `herdly-core`, plus a phone-first React app (`web/`) showing the Pane list with agent statuses and the Chat lens (read, reply, answer prompts, Esc/Ctrl+C).

**Architecture:** A binary-plus-library crate `src-tauri/web` in the existing Cargo workspace wraps `MachineManager` + `ChatManager` behind a `Backend` trait, serves REST under `/api`, one WebSocket per tab at `/ws` (machine views, pane statuses, Chat frames fanned out per Pane by a Chat hub), a cookie-based pairing flow, and the static build of `web/`. The React app reuses only Tauri-free, relative-import-only modules from `src/` through an `@desktop` alias.

**Tech Stack:** Rust 2021, tokio, axum 0.8 (`ws`), clap 4, sha2, getrandom, base64, qrcode, libc `flock`; React 19, Vite 8, react-markdown 10, zustand 5, vitest 5, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-21-herdly-web-mobile-design.md`

## Global Constraints

- **Full suite:**
  - `cargo clippy --workspace --all-targets -- -D warnings` (in `src-tauri`)
  - `cargo test --workspace` (in `src-tauri`; known pre-existing failure: `quota::credentials::tests::opencode_db_reads_the_active_go_key_after_a_clean_exit`)
  - `pnpm test` (repo root, desktop)
  - `pnpm typecheck` (repo root, desktop)
  - `pnpm --dir web test` (from Task 8 on)
  - `pnpm --dir web typecheck` (from Task 8 on)
  - Gate: after every task.
- **Setup, once, before the baseline:** `pnpm install --frozen-lockfile` at the repo root (the root suite needs `node_modules`); from Task 8 on, `pnpm install` in `web/` as well.
- **Desktop untouched:** no edit under `src/` or `src-tauri/src/`. `git diff main -- src src-tauri/src` stays empty. `herdly-core` (`src-tauri/core/`) changes only in Task 1.
- **Crate layout:** `src-tauri/web/` is package `herdly-web` with `src/lib.rs` (all modules, `pub`) and a thin `src/main.rs`; integration tests live in `src-tauri/web/tests/`. Added to `members` in `src-tauri/Cargo.toml`, never to `default-members`.
- **Machine:** every core call uses `machine_id = herdly_core::machines::LOCAL` (`"local"`). The web-facing Pane is `WebPane { session: String, pane_id: String }` (JSON `{"session","pane_id"}`); `WebPane::to_ref()` gives core's `PaneRef`. Client-side key: `` `${session}/${pane_id}` ``.
- **Errors:** every HTTP error body is core's `AppError` JSON `{"code","message"}`. Status by code: `not_found` 404, `invalid` 400, `conflict` 409, `timeout` 504, `unauthorized` 401, `forbidden` 403, anything else 502. Herdly Web's own codes: `unauthorized` (message `not paired`) and `forbidden` (message `bad origin` or `pairing link expired or used`).
- **Check order:** for POST routes and the `/ws` upgrade, the Origin check runs first (403), then the cookie (401). GET `/api/*` checks only the cookie. Static files and `GET /pair` check neither.
- **Constants (Rust, `src-tauri/web/src/config.rs`):** `DEFAULT_BIND = "192.0.2.10:7380"`, `COOKIE_NAME = "herdly_web"`, `COOKIE_MAX_AGE = 31_536_000`, `PAIRING_TTL_SECS = 600`, `LAST_SEEN_EVERY_SECS = 3600`, `REVOKE_CHECK = 15 s`, `BODY_LIMIT = 1 MiB`, `CLOSE_LAGGED = 4000`, `CLOSE_REVOKED = 4401`, `PENDING_RETRY = 1500 ms`, channel capacity `CHANNEL_CAP = 256`.
- **Constants (web, `web/src/config.ts`):** `PROMPT_POLL_MS = 1500`, `BACKOFF_START_MS = 1000`, `BACKOFF_MAX_MS = 15000`, `PENDING_STALE_MS = 30000`, `CHAT_PAGE = 200`, `SEEN_KEY = "herdly-web:seen"`.
- **Times** stored in `<state>` files are Unix seconds (`i64`). Functions that depend on time take `now: i64`; only `main.rs` and handlers read the clock (`config::now_secs()`).
- **Exit codes:** `herdly-web` prints `herdly-web: <reason>` to stderr and exits 1 on a bind failure, a missing or empty `--static`, or a state-dir error; clap's usage errors keep exit 2.
- **WebSocket frames** are JSON text, built once with `serde_json` and shared as `Arc<str>`: `{"type":"machines","views":[…]}`, `{"type":"machine","view":…}`, `{"type":"pane_status","ev":…}`, `{"type":"chat_opened","pane":WebPane,"located":…}`, `{"type":"chat","pane":WebPane,"event":ChatEvent}`, `{"type":"chat_error","pane":WebPane,"error":AppError}`. Client → server: `{"type":"subscribe","pane":WebPane}`, `{"type":"unsubscribe","pane":WebPane}`.
- **Reused desktop modules (web):** only `@desktop/lib/types`, `@desktop/chat/chatStore`, `@desktop/chat/checklist`, `@desktop/chat/prompt/screenPrompt`, `@desktop/chat/prompt/sendAnswer`. No other `@desktop` import.
- **Package manager:** pnpm. `web/` has its own `package.json` and `pnpm-lock.yaml`; it is not added to the root `pnpm-workspace.yaml`.
- **Copy (UI strings, exact):** `Not paired`, `Open a pairing link from herdly-web pair on the devbox.`, `Disconnected, reconnecting…`, `Chat lens supports Claude Code and pi only`, `Several transcripts match; showing the newest`, `Retry`, `Send`, `Esc`, `Ctrl+C`, `not seen yet`, `[image]`.

## Review Focus

- A phone that sleeps and wakes (socket closed, then reopened) → the open Chat comes back complete through a fresh `Reset` event, no duplicates; pinned in Task 8 (resubscribe on reconnect) and Task 4 (re-subscribe of the same socket counts once).
- An Agent that runs `/clear` or starts a new session in a Pane already tailed → the phone shows the new Transcript after reopening the Chat; Task 4 (`cached_open_with_moved_transcript_reopens_on_fresh_path`).
- A revoked device → its next request is 401 and its open socket closes with 4401, and it does not reconnect in a loop; Task 3, Task 6, Task 8.
- A permission menu on screen → the Composer's text field is gone so typed text cannot land in the menu; Esc and Ctrl+C still work; Task 11.
- A page on another origin POSTing to `/api/pane/prompt` with the phone's cookie → 403 and no herdr call; Task 5.

---

### Task 1: Clean clippy on all targets and record the baselines

**Files:**
- Modify: `src-tauri/core/src/machines.rs:1815`
- Modify: `src-tauri/core/src/transcript/claude.rs:575`
- Modify: `src-tauri/core/tests/attach_herdr.rs:17-30,71-78`
- Modify: `src-tauri/core/tests/ssh_localhost.rs:22-28,51-58`

**Interfaces:**
- Consumes: nothing.
- Produces: `cargo clippy --workspace --all-targets -- -D warnings` clean, which later tasks keep clean.

- [ ] **Step 1: See the four errors**

Run (in `src-tauri`): `cargo clippy --workspace --all-targets -- -D warnings 2>&1 | grep -A1 '^error'`
Expected: exactly these four: `using clone on type MachineState which implements the Copy trait` at `core/src/machines.rs:1815`; `very complex type used` at `core/src/transcript/claude.rs:575`; `spawned process is never wait()ed on` at `core/tests/ssh_localhost.rs:52` and `core/tests/attach_herdr.rs:72`.

- [ ] **Step 2: Fix them**

- `machines.rs:1815`: `v.state.clone()` becomes `v.state`.
- `claude.rs:575`: add `type Images = Vec<(String, String, Vec<u8>)>;` inside the test module and use it in `run_with`'s return type and for `sink`.
- Both test files: `SessionGuard` becomes `struct SessionGuard(Option<std::process::Child>);`. The test stores the spawned `herdr … server` child in it (`let _guard = SessionGuard(Some(Command::new(HERDR)…spawn().expect("spawn herdr server")));`, created where the `spawn` is today, so the guard still drops last). `Drop` runs the existing `server stop` and `session delete` commands, then `child.wait()` on the stored child (ignoring its result). No `#[allow]`.

- [ ] **Step 3: Verify clippy is clean**

Run: `cargo clippy --workspace --all-targets -- -D warnings`
Expected: exit 0, no `error`.

- [ ] **Step 4: Record the baselines**

Run: `cargo test --workspace 2>&1 | grep -E '^test result|FAILED|panicked'`
Expected: every `test result` ok except core's lib tests with 1 failure, `quota::credentials::tests::opencode_db_reads_the_active_go_key_after_a_clean_exit`.

Run: `cargo test --workspace -- --ignored --test-threads=1 2>&1 | grep -E '^test |^test result'`
Expected: `attaches_echoes_and_reports_held` passes; `ssh_localhost_master_exec_and_forward` passes (it prints `HERDLY_SSH_TEST != 1; skipping` unless that variable is set). Write both outputs into the commit message body.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/core
git commit -m "chore(clippy): clean on all targets; reap the herdr server in integration tests"
```

---

### Task 2: `herdly-web` crate, error mapping, `Backend` trait and its fake

**Files:**
- Modify: `src-tauri/Cargo.toml` (`[workspace] members = ["core", "web"]`; `default-members` unchanged)
- Create: `src-tauri/web/Cargo.toml`
- Create: `src-tauri/web/src/lib.rs`, `src-tauri/web/src/main.rs`, `src-tauri/web/src/config.rs`, `src-tauri/web/src/error.rs`, `src-tauri/web/src/backend.rs`, `src-tauri/web/src/testing.rs`
- Modify: `mise.toml` (`lint`, `test:backend`, `test:integration`)
- Modify: `README.md:59`
- Test: `src-tauri/web/tests/error.rs`, `src-tauri/web/tests/fake_backend.rs`

**Interfaces:**
- Consumes: `herdly_core::machines::{MachineManager, LOCAL}`, `herdly_core::transcript::{ChatManager, ChatEvent, ChatItem, Located, Sink}`, `herdly_core::view::{MachineView, PaneRef}`, `herdly_core::error::{AppError, AppResult}`.
- Produces:
  - `config.rs`: the constants listed in Global Constraints; `pub fn now_secs() -> i64`.
  - `error.rs`: `pub fn status_for(code: &str) -> axum::http::StatusCode`; `pub struct ApiError(pub AppError)` with `impl IntoResponse` (status from `status_for`, JSON body `{"code","message"}`) and `impl From<AppError> for ApiError`; `pub fn unauthorized() -> ApiError` (`unauthorized`/`not paired`); `pub fn forbidden(msg: &str) -> ApiError`.
  - `backend.rs`:
    - `#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)] pub struct WebPane { pub session: String, pub pane_id: String }` with `pub fn to_ref(&self) -> PaneRef` and `pub fn from_ref(r: &PaneRef) -> WebPane`.
    - `pub type ChatSink = herdly_core::transcript::Sink;`
    - `#[async_trait] pub trait Backend: Send + Sync + 'static { fn views(&self) -> Vec<MachineView>; async fn call(&self, session: &str, method: &str, params: Value) -> AppResult<Value>; async fn locate(&self, pane: &WebPane) -> AppResult<Located>; async fn open_chat(&self, pane: &WebPane, path: Option<String>, sink: ChatSink) -> AppResult<Located>; fn page(&self, pane: &WebPane, before: usize, limit: usize) -> Option<Vec<ChatItem>>; fn close_chat(&self, pane: &WebPane); }`
    - `pub struct Core { pub mgr: Arc<MachineManager>, pub chats: Arc<ChatManager> }` implementing `Backend`: `views` → `mgr.views()`; `call` → `mgr.call(LOCAL, session, method, params)`; `locate` → `mgr.locate_pane(&pane.to_ref(), None)`; `open_chat` → `mgr.open_chat(&chats, &pane.to_ref(), path, sink)`; `page` → `chats.page(…)`; `close_chat` → `chats.close(…)`.
  - `testing.rs` (always compiled, `pub`): `FakeBackend` (fields below), `pub fn located(path: &str) -> Located` (agent `"claude"`, all flags false, no candidates), `pub fn pane(session: &str, id: &str) -> WebPane`.

`FakeBackend` (`#[derive(Default)]`), every field `pub`:
- `views: Mutex<Vec<MachineView>>`
- `calls: Mutex<Vec<(String, String, Value)>>` (session, method, params), `call_result: Mutex<Option<AppResult<Value>>>` (None → `Ok(json!({}))`)
- `log: Mutex<Vec<String>>`: `"open:<pane_id>:<path or ->"` pushed when an open starts, `"opened:<pane_id>"` when it ends, `"close:<pane_id>"`, `"locate:<pane_id>"`
- `open_results: Mutex<VecDeque<AppResult<Located>>>` (empty → `Ok(located("/t/a.jsonl"))` with the requested path when one was given), `open_delay: Mutex<Duration>`
- `locate_results: Mutex<VecDeque<AppResult<Located>>>` (empty → `Err(AppError::new("not_found", "no locate result"))`)
- `sinks: Mutex<HashMap<WebPane, ChatSink>>` (the last sink given per Pane)
- `page_result: Mutex<Option<Vec<ChatItem>>>`, `pages: Mutex<Vec<(WebPane, usize, usize)>>`
- `pub fn emit(&self, pane: &WebPane, ev: ChatEvent)` calls that Pane's last sink.

`src-tauri/web/Cargo.toml` dependencies: `herdly-core = { path = "../core" }`, `axum = { version = "0.8", features = ["ws"] }`, `tokio = { version = "1", features = ["full"] }`, `serde = { version = "1", features = ["derive"] }`, `serde_json = "1"`, `async-trait = "0.1"`, `clap = { version = "4", features = ["derive"] }`, `sha2 = "0.10"`, `hex = "0.4"`, `getrandom = "0.3"`, `base64 = "0.22"`, `qrcode = { version = "0.14", default-features = false }`, `libc = "0.2"`, `futures-util = "0.3"`, `tracing = "0.1"`, `tracing-subscriber = "0.3"`. Dev: `tempfile = "3"`, `tower = { version = "0.5", features = ["util"] }`, `http-body-util = "0.1"`, `tokio-tungstenite = "0.26"`. `main.rs` in this task is `fn main() {}` (Task 7 fills it).

- [ ] **Step 1: Write the failing tests**

`src-tauri/web/tests/error.rs`:

```rust
use axum::{http::StatusCode, response::IntoResponse};
use herdly_core::error::AppError;
use herdly_web::error::{status_for, unauthorized, ApiError};

#[test]
fn codes_map_to_statuses() {
    assert_eq!(status_for("not_found"), StatusCode::NOT_FOUND);
    assert_eq!(status_for("invalid"), StatusCode::BAD_REQUEST);
    assert_eq!(status_for("conflict"), StatusCode::CONFLICT);
    assert_eq!(status_for("timeout"), StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(status_for("unauthorized"), StatusCode::UNAUTHORIZED);
    assert_eq!(status_for("forbidden"), StatusCode::FORBIDDEN);
    assert_eq!(status_for("herdr_error"), StatusCode::BAD_GATEWAY);
    assert_eq!(status_for("io"), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn api_error_body_is_the_app_error() {
    let res = ApiError(AppError::new("not_found", "unknown pane p9")).into_response();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let body = http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v, serde_json::json!({"code": "not_found", "message": "unknown pane p9"}));
    let res = unauthorized().into_response();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
```

`src-tauri/web/tests/fake_backend.rs`:

```rust
use herdly_core::transcript::ChatEvent;
use herdly_web::backend::{Backend, WebPane};
use herdly_web::testing::{pane, FakeBackend};
use std::sync::{Arc, Mutex};

#[test]
fn web_pane_round_trips_to_a_local_ref() {
    let p = pane("default", "p1");
    let r = p.to_ref();
    assert_eq!((r.machine_id.as_str(), r.session.as_str(), r.pane_id.as_str()), ("local", "default", "p1"));
    assert_eq!(WebPane::from_ref(&r), p);
}

#[tokio::test]
async fn fake_records_opens_and_replays_through_the_sink() {
    let fake = FakeBackend::default();
    let got: Arc<Mutex<Vec<String>>> = Default::default();
    let g = got.clone();
    let l = fake
        .open_chat(&pane("s", "p1"), None, Arc::new(move |e: ChatEvent| g.lock().unwrap().push(format!("{e:?}"))))
        .await
        .unwrap();
    assert_eq!(l.path, "/t/a.jsonl");
    fake.emit(&pane("s", "p1"), ChatEvent::Append { items: vec![] });
    assert_eq!(got.lock().unwrap().len(), 1);
    assert_eq!(*fake.log.lock().unwrap(), vec!["open:p1:-", "opened:p1"]);
}
```

- [ ] **Step 2: Add the stubs and see the tests fail**

Create the crate with every Interfaces item; `status_for` returns `StatusCode::IM_A_TEAPOT` and `FakeBackend::open_chat` returns `Err(AppError::new("io", "stub"))`.

Run (in `src-tauri`): `cargo test -p herdly-web`
Expected: FAIL on `assert_eq!(status_for("not_found"), StatusCode::NOT_FOUND)` (got `418`) and on `.unwrap()` of the stub's `Err` in `fake_records_opens_and_replays_through_the_sink`.

- [ ] **Step 3: Implement** `status_for`, `ApiError`, `WebPane`, `Core`, and `FakeBackend` as in Interfaces.

- [ ] **Step 4: Run it and see it pass**

Run: `cargo test -p herdly-web`
Expected: PASS.

- [ ] **Step 5: Move the developer gates to `--workspace`**

- `mise.toml`: `lint` runs `cargo clippy --workspace -- -D warnings`; `test:backend` runs `cargo test --workspace`; `test:integration` runs `cargo test --workspace -- --ignored --test-threads=1`.
- `README.md:59`: replace the line with ``cargo test --workspace` and `cargo clippy --workspace` in `src-tauri` cover the app, `herdly-core` and `herdly-web`.``
- Run: `cargo clippy --workspace --all-targets -- -D warnings` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/web mise.toml README.md
git commit -m "feat(web): herdly-web crate with the Backend trait over herdly-core"
```

---

### Task 3: State files and Paired devices

**Files:**
- Create: `src-tauri/web/src/store.rs`, `src-tauri/web/src/auth.rs`
- Modify: `src-tauri/web/src/lib.rs` (`pub mod store; pub mod auth;`)
- Test: `src-tauri/web/tests/auth.rs`

**Interfaces:**
- Consumes: `config::{PAIRING_TTL_SECS, LAST_SEEN_EVERY_SECS}`.
- Produces:
  - `store.rs`: `#[derive(Clone)] pub struct Store { pub dir: PathBuf }` with `pub fn open(dir: &Path) -> io::Result<Store>` (creates the dir with mode `0700`); `pub fn locked<T>(&self, f: impl FnOnce(&Store) -> io::Result<T>) -> io::Result<T>` (exclusive `libc::flock` on `<dir>/.lock`, created `0600`, held for `f`); `pub fn read_json<T: DeserializeOwned + Default>(&self, name: &str) -> io::Result<T>` (missing file → `T::default()`); `pub fn write_json<T: Serialize>(&self, name: &str, v: &T) -> io::Result<()>` (writes `<name>.tmp` with mode `0600`, then `rename`); `pub fn remove(&self, name: &str) -> io::Result<()>` (missing is fine); `pub fn mtime(&self, name: &str) -> Option<SystemTime>`. Callers that read-modify-write do it inside `locked`.
  - `auth.rs`:
    - `#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)] pub struct Device { pub id: String, pub name: String, pub cookie_sha256: String, pub created: i64, pub last_seen: i64 }`
    - `#[derive(Default, Serialize, Deserialize)] pub struct Devices { pub devices: Vec<Device> }` in `devices.json`
    - `#[derive(Serialize, Deserialize)] pub struct Pairing { pub token_sha256: String, pub expires: i64 }` in `pairing.json`
    - `#[derive(Clone, Debug, PartialEq, Serialize)] pub struct DeviceInfo { pub device_id: String, pub name: String }`
    - `pub fn sha256_hex(s: &str) -> String`; `pub fn random_token() -> String` (32 bytes from `getrandom::fill`, base64 URL-safe without padding, 43 chars)
    - `pub fn start_pairing(store: &Store, now: i64) -> io::Result<String>`: returns the token, writes `pairing.json` with `expires = now + PAIRING_TTL_SECS`, replacing any pending one
    - `pub fn complete_pairing(store: &Store, token: &str, user_agent: &str, now: i64) -> Result<(Device, String), AppError>`: on a matching, unexpired hash, appends a `Device` (`id` = first 8 hex chars of a fresh random token's SHA-256, `name` = the User-Agent cut to 80 chars, or `"unknown"` when empty), deletes `pairing.json`, returns the device and the cookie value (`random_token()`); otherwise `Err(forbidden "pairing link expired or used")` (code `forbidden`)
    - `pub fn list_devices(store: &Store) -> io::Result<Vec<Device>>`; `pub fn revoke(store: &Store, id: &str) -> io::Result<bool>`
    - `pub struct Auth` with `pub fn new(store: Store) -> Auth`; `pub fn check(&self, cookie: &str, now: i64) -> Option<DeviceInfo>` (looks the hash up in a cache reloaded when `devices.json`'s mtime differs from the cached one; when the device's `last_seen` is `LAST_SEEN_EVERY_SECS` or more behind `now`, rewrites it inside `locked` after re-reading the file, and never re-adds a device that is gone); `pub fn is_live(&self, device_id: &str) -> bool` (same reload); `pub fn store(&self) -> &Store`.

- [ ] **Step 1: Write the failing tests**

`src-tauri/web/tests/auth.rs`:

```rust
use herdly_web::auth::*;
use herdly_web::store::Store;
use std::os::unix::fs::PermissionsExt;

fn store() -> (tempfile::TempDir, Store) {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(&d.path().join("state")).unwrap();
    (d, s)
}

#[test]
fn state_dir_and_files_are_private() {
    let (_d, s) = store();
    start_pairing(&s, 1000).unwrap();
    assert_eq!(std::fs::metadata(&s.dir).unwrap().permissions().mode() & 0o777, 0o700);
    let f = std::fs::metadata(s.dir.join("pairing.json")).unwrap();
    assert_eq!(f.permissions().mode() & 0o777, 0o600);
}

#[test]
fn token_is_43_url_safe_chars_and_stored_only_hashed() {
    let (_d, s) = store();
    let t = start_pairing(&s, 1000).unwrap();
    assert_eq!(t.len(), 43);
    assert!(t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    let raw = std::fs::read_to_string(s.dir.join("pairing.json")).unwrap();
    assert!(!raw.contains(&t));
    assert!(raw.contains(&sha256_hex(&t)));
}

#[test]
fn pairing_link_works_once_and_expires_after_ten_minutes() {
    let (_d, s) = store();
    let t = start_pairing(&s, 1000).unwrap();
    let (dev, cookie) = complete_pairing(&s, &t, "Mozilla/5.0 (Linux; Android 15)", 1599).unwrap();
    assert_eq!(dev.name, "Mozilla/5.0 (Linux; Android 15)");
    assert_eq!(dev.cookie_sha256, sha256_hex(&cookie));
    assert!(!s.dir.join("pairing.json").exists());
    assert_eq!(complete_pairing(&s, &t, "x", 1599).unwrap_err().code, "forbidden");

    let t2 = start_pairing(&s, 2000).unwrap();
    assert_eq!(complete_pairing(&s, &t2, "x", 2600).unwrap_err().code, "forbidden");
}

#[test]
fn a_new_pair_replaces_the_pending_one() {
    let (_d, s) = store();
    let old = start_pairing(&s, 1000).unwrap();
    let new = start_pairing(&s, 1001).unwrap();
    assert_eq!(complete_pairing(&s, &old, "x", 1002).unwrap_err().code, "forbidden");
    assert!(complete_pairing(&s, &new, "x", 1002).is_ok());
}

#[test]
fn check_accepts_the_cookie_and_sees_a_revoke() {
    let (_d, s) = store();
    let t = start_pairing(&s, 1000).unwrap();
    let (dev, cookie) = complete_pairing(&s, &t, "phone", 1001).unwrap();
    let auth = Auth::new(s.clone());
    assert_eq!(auth.check(&cookie, 1002).map(|i| i.device_id), Some(dev.id.clone()));
    assert_eq!(auth.check("not-a-cookie", 1002), None);
    std::thread::sleep(std::time::Duration::from_millis(20)); // a distinct mtime
    assert!(revoke(&s, &dev.id).unwrap());
    assert_eq!(auth.check(&cookie, 1003), None);
    assert!(!auth.is_live(&dev.id));
}

#[test]
fn last_seen_is_written_at_most_hourly_and_never_resurrects_a_revoked_device() {
    let (_d, s) = store();
    let t = start_pairing(&s, 1000).unwrap();
    let (dev, cookie) = complete_pairing(&s, &t, "phone", 1000).unwrap();
    let auth = Auth::new(s.clone());
    auth.check(&cookie, 1000 + 3599);
    assert_eq!(list_devices(&s).unwrap()[0].last_seen, 1000);
    auth.check(&cookie, 1000 + 3600);
    assert_eq!(list_devices(&s).unwrap()[0].last_seen, 4600);

    // The cache still holds the device; a revoke lands; the next hourly write must not undo it.
    revoke(&s, &dev.id).unwrap();
    auth.check(&cookie, 4600 + 3600);
    assert!(list_devices(&s).unwrap().is_empty());
}
```

- [ ] **Step 2: Add the stubs and see the tests fail**

Stubs: `start_pairing` returns `Ok(String::new())` without writing; `complete_pairing` returns `Err(AppError::new("io", "stub"))`; `Store::open` creates the dir with default permissions.

Run: `cargo test -p herdly-web --test auth`
Expected: FAIL on `assert_eq!(…mode() & 0o777, 0o700)` and on `assert_eq!(t.len(), 43)` (got 0).

- [ ] **Step 3: Implement** `store.rs` and `auth.rs` as in Interfaces.

- [ ] **Step 4: Run it and see it pass**

Run: `cargo test -p herdly-web --test auth`
Expected: PASS (all six).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/web
git commit -m "feat(web): Paired devices, pairing tokens and locked state files"
```

---

### Task 4: Chat hub

**Files:**
- Create: `src-tauri/web/src/chat.rs`
- Modify: `src-tauri/web/src/lib.rs` (`pub mod chat;`)
- Test: `src-tauri/web/tests/chat_hub.rs`

**Interfaces:**
- Consumes: `Backend`, `WebPane`, `ChatSink`, `FakeBackend`, `testing::{located, pane}`, `config::{CHANNEL_CAP, PENDING_RETRY}`.
- Produces:
  - `pub type SocketId = u64;`
  - `pub struct ChatHub` with `pub fn new(backend: Arc<dyn Backend>) -> Arc<ChatHub>`;
    `pub async fn subscribe(self: &Arc<Self>, sock: SocketId, pane: WebPane) -> broadcast::Receiver<Arc<str>>`;
    `pub async fn unsubscribe(self: &Arc<Self>, sock: SocketId, pane: &WebPane)`;
    `pub async fn drop_socket(self: &Arc<Self>, sock: SocketId)` (unsubscribes it from every Pane);
    `pub async fn on_status(self: &Arc<Self>, ev: &PaneStatusEvent)`.
  - Frames on a Pane's channel: `chat_opened`, `chat`, `chat_error` exactly as in Global Constraints.

Rules (spec, "Chat hub"):
- One entry per Pane: `broadcast::Sender<Arc<str>>` (`CHANNEL_CAP`), `HashSet<SocketId>`, `Option<Located>`, a `tokio::sync::Mutex<()>` held across every open and every close of that Pane.
- `subscribe`: get or create the entry, take `rx = tx.subscribe()`, insert the socket, then (under the Pane mutex) open: `path = None` when the entry has no `Located`, else `Some(current.path)`. Return `rx`.
- Open success: store the `Located`, send `chat_opened`. When the result's `cached` is true and the requested `path` was `None`, call `locate`; when its `path` differs, open again with `Some(fresh.path)` on the same sink and send `chat_opened` with the fresh `Located`.
- Open failure: send `chat_error` with the error; keep the subscribers; no tail.
- The sink given to `open_chat` serialises each `ChatEvent` into a `chat` frame and sends it on the Pane's channel (send errors from having no receivers are ignored).
- `unsubscribe` / `drop_socket`: remove the socket; when the set becomes empty, under the Pane mutex call `close_chat` if an open succeeded, and drop the entry.
- `on_status` for a Pane whose `Located.pending` is true: locate now (under the mutex); if the result is not pending or its path differs, open on `Some(fresh.path)`; if it is still pending, spawn one more try after `PENDING_RETRY`. Panes not in the hub and non-pending Panes are ignored.

- [ ] **Step 1: Write the failing tests**

`src-tauri/web/tests/chat_hub.rs`:

```rust
use herdly_core::herdr::types::AgentStatus;
use herdly_core::transcript::{ChatEvent, ChatItem, Located};
use herdly_core::view::PaneStatusEvent;
use herdly_web::chat::ChatHub;
use herdly_web::testing::{located, pane, FakeBackend};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

fn hub() -> (Arc<FakeBackend>, Arc<ChatHub>) {
    let fake = Arc::new(FakeBackend::default());
    (fake.clone(), ChatHub::new(fake))
}

async fn next(rx: &mut Receiver<Arc<str>>) -> Value {
    let f = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
    serde_json::from_str(&f).unwrap()
}

#[tokio::test]
async fn first_subscriber_opens_with_no_path_and_gets_chat_opened() {
    let (fake, hub) = hub();
    let mut rx = hub.subscribe(1, pane("s", "p1")).await;
    let f = next(&mut rx).await;
    assert_eq!(f["type"], "chat_opened");
    assert_eq!(f["pane"], serde_json::json!({"session": "s", "pane_id": "p1"}));
    assert_eq!(f["located"]["path"], "/t/a.jsonl");
    assert_eq!(*fake.log.lock().unwrap(), vec!["open:p1:-", "opened:p1"]);
}

#[tokio::test]
async fn chat_events_reach_every_subscriber_as_chat_frames() {
    let (fake, hub) = hub();
    let mut a = hub.subscribe(1, pane("s", "p1")).await;
    let mut b = hub.subscribe(2, pane("s", "p1")).await;
    while next(&mut a).await["type"] != "chat_opened" {}
    fake.emit(&pane("s", "p1"), ChatEvent::Append { items: vec![ChatItem::System { text: "hi".into(), ts: None }] });
    for rx in [&mut a, &mut b] {
        loop {
            let f = next(rx).await;
            if f["type"] == "chat" {
                assert_eq!(f["event"]["type"], "append");
                assert_eq!(f["event"]["items"][0]["text"], "hi");
                break;
            }
        }
    }
}

#[tokio::test]
async fn a_second_subscriber_reopens_on_the_known_path() {
    let (fake, hub) = hub();
    let _a = hub.subscribe(1, pane("s", "p1")).await;
    let _b = hub.subscribe(2, pane("s", "p1")).await;
    assert_eq!(*fake.log.lock().unwrap(), vec!["open:p1:-", "opened:p1", "open:p1:/t/a.jsonl", "opened:p1"]);
}

#[tokio::test]
async fn the_same_socket_subscribing_twice_counts_once() {
    let (fake, hub) = hub();
    let _a = hub.subscribe(1, pane("s", "p1")).await;
    let _a2 = hub.subscribe(1, pane("s", "p1")).await;
    hub.unsubscribe(1, &pane("s", "p1")).await;
    assert_eq!(fake.log.lock().unwrap().last().unwrap(), "close:p1");
}

#[tokio::test]
async fn the_last_subscriber_leaving_closes_the_tail() {
    let (fake, hub) = hub();
    let _a = hub.subscribe(1, pane("s", "p1")).await;
    let _b = hub.subscribe(2, pane("s", "p1")).await;
    hub.unsubscribe(1, &pane("s", "p1")).await;
    assert!(!fake.log.lock().unwrap().iter().any(|l| l.starts_with("close")));
    hub.drop_socket(2).await;
    assert_eq!(fake.log.lock().unwrap().last().unwrap(), "close:p1");
}

#[tokio::test]
async fn open_and_close_of_one_pane_never_overlap() {
    let (fake, hub) = hub();
    *fake.open_delay.lock().unwrap() = Duration::from_millis(100);
    let h = hub.clone();
    let opening = tokio::spawn(async move { h.subscribe(1, pane("s", "p1")).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    hub.drop_socket(1).await;
    opening.await.unwrap();
    assert_eq!(*fake.log.lock().unwrap(), vec!["open:p1:-", "opened:p1", "close:p1"]);
}

#[tokio::test]
async fn cached_open_with_moved_transcript_reopens_on_fresh_path() {
    let (fake, hub) = hub();
    fake.open_results.lock().unwrap().push_back(Ok(Located { cached: true, ..located("/t/old.jsonl") }));
    fake.locate_results.lock().unwrap().push_back(Ok(located("/t/new.jsonl")));
    let mut rx = hub.subscribe(1, pane("s", "p1")).await;
    let mut paths = vec![];
    while paths.len() < 2 {
        let f = next(&mut rx).await;
        if f["type"] == "chat_opened" {
            paths.push(f["located"]["path"].as_str().unwrap().to_string());
        }
    }
    assert_eq!(paths, vec!["/t/old.jsonl", "/t/new.jsonl"]);
    assert!(fake.log.lock().unwrap().contains(&"open:p1:/t/new.jsonl".to_string()));
}

#[tokio::test]
async fn a_pending_transcript_is_located_again_on_a_status_event() {
    let (fake, hub) = hub();
    fake.open_results.lock().unwrap().push_back(Ok(Located { pending: true, ..located("/t/p.jsonl") }));
    fake.locate_results.lock().unwrap().push_back(Ok(located("/t/p.jsonl")));
    let _rx = hub.subscribe(1, pane("s", "p1")).await;
    hub.on_status(&PaneStatusEvent {
        pane: pane("s", "p1").to_ref(),
        status: AgentStatus::Working,
        previous: AgentStatus::Idle,
        title: "t".into(),
    })
    .await;
    let log = fake.log.lock().unwrap().clone();
    assert!(log.contains(&"locate:p1".to_string()));
    assert_eq!(log.iter().filter(|l| l.starts_with("open:p1")).count(), 2);
}

#[tokio::test]
async fn a_failed_open_sends_chat_error_and_a_retry_opens_again() {
    let (fake, hub) = hub();
    fake.open_results.lock().unwrap().push_back(Err(herdly_core::error::AppError::new("not_found", "no transcript")));
    let mut rx = hub.subscribe(1, pane("s", "p1")).await;
    let f = next(&mut rx).await;
    assert_eq!(f["type"], "chat_error");
    assert_eq!(f["error"]["code"], "not_found");
    let mut rx2 = hub.subscribe(1, pane("s", "p1")).await;
    assert_eq!(next(&mut rx2).await["type"], "chat_opened");
    hub.drop_socket(1).await;
    assert_eq!(fake.log.lock().unwrap().last().unwrap(), "close:p1");
}
```

- [ ] **Step 2: Add the stub and see the tests fail**

Stub: `subscribe` returns a receiver of a fresh channel and does nothing else; the other methods do nothing.

Run: `cargo test -p herdly-web --test chat_hub`
Expected: FAIL; the first test times out in `next` (`Elapsed`), and `a_second_subscriber_reopens_on_the_known_path` fails its `assert_eq!` on an empty log.

- [ ] **Step 3: Implement `ChatHub`** following the rules above.

- [ ] **Step 4: Run it and see it pass**

Run: `cargo test -p herdly-web --test chat_hub`
Expected: PASS (all nine).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/web
git commit -m "feat(web): Chat hub fanning one tail per Pane out to many sockets"
```

---

### Task 5: HTTP router: static files, pairing, auth, Origin, REST

**Files:**
- Create: `src-tauri/web/src/app.rs` (state + router + middleware), `src-tauri/web/src/api.rs` (REST handlers), `src-tauri/web/src/static_files.rs`
- Modify: `src-tauri/web/src/lib.rs`, `src-tauri/web/src/testing.rs` (add `state` and `send`)
- Test: `src-tauri/web/tests/http.rs`

**Interfaces:**
- Consumes: `Backend`, `WebPane`, `ApiError`, `status_for`, `unauthorized`, `forbidden`, `Auth`, `DeviceInfo`, `complete_pairing`, `Store`, `config::*`, `FakeBackend`.
- Produces:
  - `app.rs`: `pub struct Config { pub origin: String, pub static_dir: PathBuf }`; `pub struct AppState { pub backend: Arc<dyn Backend>, pub auth: Arc<Auth>, pub cfg: Config }` (Task 6 adds fields); `pub fn router(state: Arc<AppState>) -> axum::Router`.
  - `testing.rs`: `pub fn state(backend: Arc<FakeBackend>, dir: &Path) -> Arc<AppState>` (origin `http://192.0.2.10:7380`, static dir `<dir>/dist` holding `index.html` = `<!doctype html><title>Herdly</title>` and `assets/app-1a2b.js` = `console.log(1)`, store `<dir>/state`); `pub fn paired_cookie(state: &AppState) -> String` (runs `start_pairing` + `complete_pairing` on the state's store); `pub async fn send(app: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, String)`.

Routes:
- `GET /pair?t=<token>`: `complete_pairing` with the `User-Agent`; success → 303 to `/` with `Set-Cookie: herdly_web=<cookie>; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`; failure → 403, `text/plain`, body `pairing link expired or used`.
- `GET /api/me` → `DeviceInfo`. `GET /api/machines` → `backend.views()`.
- `GET /api/chat/page?session&pane_id&before&limit` → `backend.page(pane, before, min(limit, 200))`; `None` → 404 `not_found` `no open chat`.
- `POST /api/pane/read` `{session, pane_id}` → `call(session, "pane.read", {"pane_id", "source": "visible", "format": "text", "strip_ansi": true})`; returns `{"text": r["text"] or r["read"]["text"] or ""}`.
- `POST /api/pane/prompt` `{session, pane_id, text}` → `call(session, "agent.prompt", {"target": pane_id, "text"})` → `{}`.
- `POST /api/pane/keys` `{session, pane_id, keys}` → `call(session, "agent.send_keys", {"target": pane_id, "keys"})` → `{}`.
- `POST /api/pane/text` `{session, pane_id, text}` → `call(session, "pane.send_text", {"pane_id", "text"})` → `{}`.
- Static (fallback for every other GET): path mapped under `static_dir`; any `..` segment → 404; an unknown path → `index.html`. `index.html` gets `Cache-Control: no-cache` and the CSP; `assets/*` get `Cache-Control: public, max-age=31536000, immutable`. Content types: `html` `text/html; charset=utf-8`, `js` `text/javascript`, `css` `text/css`, `svg` `image/svg+xml`, `png` `image/png`, `ico` `image/x-icon`, `json` `application/json`, `woff2` `font/woff2`, else `application/octet-stream`.
- Every response: `X-Content-Type-Options: nosniff`. HTML responses: `Content-Security-Policy: default-src 'self'; connect-src 'self' ws://<origin host:port>; img-src 'self' data:; object-src 'none'; base-uri 'none'`.
- Body limit 1 MiB on every POST (413 beyond it).

- [ ] **Step 1: Write the failing tests**

`src-tauri/web/tests/http.rs`:

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use herdly_web::app::router;
use herdly_web::testing::{paired_cookie, send, state, FakeBackend};
use serde_json::{json, Value};
use std::sync::Arc;

const ORIGIN: &str = "http://192.0.2.10:7380";

fn setup() -> (tempfile::TempDir, Arc<FakeBackend>, axum::Router, String) {
    let d = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeBackend::default());
    let st = state(fake.clone(), d.path());
    let cookie = paired_cookie(&st);
    (d, fake, router(st), cookie)
}

fn post(path: &str, cookie: Option<&str>, origin: Option<&str>, body: Value) -> Request<Body> {
    let mut b = Request::post(path).header("content-type", "application/json");
    if let Some(c) = cookie { b = b.header("cookie", format!("herdly_web={c}")); }
    if let Some(o) = origin { b = b.header("origin", o); }
    b.body(Body::from(body.to_string())).unwrap()
}

fn get(path: &str, cookie: Option<&str>) -> Request<Body> {
    let mut b = Request::get(path);
    if let Some(c) = cookie { b = b.header("cookie", format!("herdly_web={c}")); }
    b.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn api_needs_a_paired_cookie() {
    let (_d, _f, app, cookie) = setup();
    let (s, _, body) = send(&app, get("/api/machines", None)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({"code": "unauthorized", "message": "not paired"}));
    assert_eq!(send(&app, get("/api/machines", Some("wrong"))).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&app, get("/api/machines", Some(&cookie))).await.0, StatusCode::OK);
    let (s, _, body) = send(&app, get("/api/me", Some(&cookie))).await;
    assert_eq!(s, StatusCode::OK);
    assert!(serde_json::from_str::<Value>(&body).unwrap()["device_id"].is_string());
}

#[tokio::test]
async fn a_post_from_another_origin_is_refused_before_any_herdr_call() {
    let (_d, fake, app, cookie) = setup();
    let body = json!({"session": "s", "pane_id": "p1", "text": "rm -rf"});
    let (s, _, _) = send(&app, post("/api/pane/prompt", Some(&cookie), Some("http://evil.example"), body.clone())).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(send(&app, post("/api/pane/prompt", Some(&cookie), None, body)).await.0, StatusCode::FORBIDDEN);
    assert!(fake.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn pane_routes_build_the_herdr_calls() {
    let (_d, fake, app, cookie) = setup();
    let c = Some(cookie.as_str());
    let o = Some(ORIGIN);
    send(&app, post("/api/pane/prompt", c, o, json!({"session": "s", "pane_id": "p1", "text": "hi"}))).await;
    send(&app, post("/api/pane/keys", c, o, json!({"session": "s", "pane_id": "p1", "keys": ["esc"]}))).await;
    send(&app, post("/api/pane/text", c, o, json!({"session": "s", "pane_id": "p1", "text": "x"}))).await;
    send(&app, post("/api/pane/read", c, o, json!({"session": "s", "pane_id": "p1"}))).await;
    assert_eq!(
        *fake.calls.lock().unwrap(),
        vec![
            ("s".into(), "agent.prompt".into(), json!({"target": "p1", "text": "hi"})),
            ("s".into(), "agent.send_keys".into(), json!({"target": "p1", "keys": ["esc"]})),
            ("s".into(), "pane.send_text".into(), json!({"pane_id": "p1", "text": "x"})),
            ("s".into(), "pane.read".into(), json!({"pane_id": "p1", "source": "visible", "format": "text", "strip_ansi": true})),
        ]
    );
}

#[tokio::test]
async fn read_returns_text_from_either_shape() {
    let (_d, fake, app, cookie) = setup();
    for (reply, want) in [(json!({"text": "A"}), "A"), (json!({"read": {"text": "B"}}), "B"), (json!({}), "")] {
        *fake.call_result.lock().unwrap() = Some(Ok(reply));
        let (s, _, body) = send(&app, post("/api/pane/read", Some(&cookie), Some(ORIGIN), json!({"session": "s", "pane_id": "p1"}))).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({"text": want}));
    }
}

#[tokio::test]
async fn herdr_errors_map_to_statuses() {
    let (_d, fake, app, cookie) = setup();
    *fake.call_result.lock().unwrap() = Some(Err(herdly_core::error::AppError::new("herdr_error", "boom")));
    let (s, _, body) = send(&app, post("/api/pane/keys", Some(&cookie), Some(ORIGIN), json!({"session": "s", "pane_id": "p1", "keys": ["esc"]}))).await;
    assert_eq!(s, StatusCode::BAD_GATEWAY);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["code"], "herdr_error");
}

#[tokio::test]
async fn chat_page_caps_the_limit_and_404s_without_an_open_chat() {
    let (_d, fake, app, cookie) = setup();
    let (s, _, _) = send(&app, get("/api/chat/page?session=s&pane_id=p1&before=500&limit=1000", Some(&cookie))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    *fake.page_result.lock().unwrap() = Some(vec![]);
    let (s, _, body) = send(&app, get("/api/chat/page?session=s&pane_id=p1&before=500&limit=1000", Some(&cookie))).await;
    assert_eq!((s, body.as_str()), (StatusCode::OK, "[]"));
    assert_eq!(fake.pages.lock().unwrap().last().unwrap().2, 200);
}

#[tokio::test]
async fn pairing_sets_the_cookie_once() {
    let d = tempfile::tempdir().unwrap();
    let st = state(Arc::new(FakeBackend::default()), d.path());
    let token = herdly_web::auth::start_pairing(st.auth.store(), herdly_web::config::now_secs()).unwrap();
    let app = router(st);
    let (s, h, _) = send(&app, get(&format!("/pair?t={token}"), None)).await;
    assert_eq!(s, StatusCode::SEE_OTHER);
    assert_eq!(h["location"], "/");
    let c = h["set-cookie"].to_str().unwrap();
    for part in ["herdly_web=", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=31536000"] {
        assert!(c.contains(part), "{c}");
    }
    let (s, _, body) = send(&app, get(&format!("/pair?t={token}"), None)).await;
    assert_eq!((s, body.as_str()), (StatusCode::FORBIDDEN, "pairing link expired or used"));
}

#[tokio::test]
async fn static_files_carry_cache_and_security_headers() {
    let (_d, _f, app, _c) = setup();
    let (s, h, body) = send(&app, get("/", None)).await;
    assert_eq!(s, StatusCode::OK);
    assert!(body.contains("<title>Herdly</title>"));
    assert_eq!(h["cache-control"], "no-cache");
    assert_eq!(h["x-content-type-options"], "nosniff");
    assert_eq!(
        h["content-security-policy"],
        "default-src 'self'; connect-src 'self' ws://192.0.2.10:7380; img-src 'self' data:; object-src 'none'; base-uri 'none'"
    );
    let (s, h, _) = send(&app, get("/assets/app-1a2b.js", None)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h["cache-control"], "public, max-age=31536000, immutable");
    assert_eq!(h["content-type"], "text/javascript");
    assert_eq!(send(&app, get("/assets/../../state/devices.json", None)).await.0, StatusCode::NOT_FOUND);
    let (s, _, body) = send(&app, get("/some/route", None)).await;
    assert_eq!(s, StatusCode::OK);
    assert!(body.contains("<title>Herdly</title>"));
}

#[tokio::test]
async fn bodies_over_one_mib_are_refused() {
    let (_d, fake, app, cookie) = setup();
    let big = "x".repeat(1024 * 1024 + 1);
    let (s, _, _) = send(&app, post("/api/pane/prompt", Some(&cookie), Some(ORIGIN), json!({"session": "s", "pane_id": "p1", "text": big}))).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(fake.calls.lock().unwrap().is_empty());
}
```

- [ ] **Step 2: Add the stub and see the tests fail**

Stub: `router` returns `Router::new()` (every request 404).

Run: `cargo test -p herdly-web --test http`
Expected: FAIL on `assert_eq!(s, StatusCode::UNAUTHORIZED)` (got `404 Not Found`) and the other status assertions.

- [ ] **Step 3: Implement** `app.rs`, `api.rs` and `static_files.rs` as in Interfaces. The cookie check is a middleware that puts `DeviceInfo` into request extensions; the Origin check a middleware on POST routes.

- [ ] **Step 4: Run it and see it pass**

Run: `cargo test -p herdly-web --test http`
Expected: PASS (all nine).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/web
git commit -m "feat(web): REST routes, pairing, cookie and Origin checks, static files"
```

---

### Task 6: Event hub and the `/ws` WebSocket

**Files:**
- Create: `src-tauri/web/src/hub.rs`, `src-tauri/web/src/ws.rs`
- Modify: `src-tauri/web/src/app.rs` (add `hub: Arc<Hub>`, `chats: Arc<ChatHub>` to `AppState`; route `GET /ws`), `src-tauri/web/src/testing.rs` (`state` builds them), `src-tauri/web/src/lib.rs`
- Test: `src-tauri/web/tests/ws.rs`

**Interfaces:**
- Consumes: `ChatHub::{subscribe, unsubscribe, drop_socket, on_status}`, `SocketId`, `AppState`, `router`, `Auth::{check, is_live}`, `testing::{state, paired_cookie}`, `herdly_core::machines::{UiEvent, Emit}`, `config::{CHANNEL_CAP, CLOSE_LAGGED, CLOSE_REVOKED, REVOKE_CHECK}`.
- Produces:
  - `hub.rs`: `pub struct Hub` with `pub fn new() -> (Arc<Hub>, mpsc::UnboundedReceiver<PaneStatusEvent>)`; `pub fn emit(self: &Arc<Self>) -> Emit` (serialises `UiEvent::Machine(v)` to a `machine` frame and `UiEvent::PaneStatus(e)` to a `pane_status` frame, sends them on its broadcast channel, and also sends each `PaneStatusEvent` on the returned mpsc); `pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>>`; `pub fn send_frame(&self, frame: Arc<str>)` (test seam: puts a ready frame on the channel).
  - `pub async fn forward_statuses(rx: mpsc::UnboundedReceiver<PaneStatusEvent>, chats: Arc<ChatHub>)` (calls `on_status` for each).
  - `ws.rs`: `pub async fn ws_handler(...)` mounted at `GET /ws` (Origin then cookie checks as in Global Constraints; 403/401 refuse the upgrade).
  - `AppState` gains `pub hub: Arc<Hub>, pub chats: Arc<ChatHub>`; `testing::state` creates them over the same `FakeBackend`; `testing::state` is also given `revoke_check: Duration` through a new `testing::state_with(backend, dir, revoke_check)` (default `REVOKE_CHECK`).

Socket behaviour:
- On upgrade: a fresh `SocketId` from an `AtomicU64`; send `{"type":"machines","views": backend.views()}` first.
- One writer task owns the socket's sink and reads an `mpsc::channel::<Out>(CHANNEL_CAP)` where `enum Out { Frame(Arc<str>), Close(u16) }`.
- The hub receiver and each subscribed Pane's receiver are forwarded into that mpsc; `RecvError::Lagged` from any of them, or a full mpsc, sends `Close(CLOSE_LAGGED)`.
- Incoming `subscribe` / `unsubscribe` frames call the Chat hub (unknown frames are ignored).
- Every `revoke_check` the socket checks `auth.is_live(device_id)`; false sends `Close(CLOSE_REVOKED)`.
- On close, `chats.drop_socket(id)` runs.

- [ ] **Step 1: Write the failing tests**

`src-tauri/web/tests/ws.rs`:

```rust
use futures_util::{SinkExt, StreamExt};
use herdly_web::app::router;
use herdly_web::testing::{paired_cookie, state_with, FakeBackend};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, protocol::frame::coding::CloseCode, Message};

async fn serve(revoke_check: Duration) -> (tempfile::TempDir, Arc<FakeBackend>, Arc<herdly_web::app::AppState>, String, String) {
    let d = tempfile::tempdir().unwrap();
    let fake = Arc::new(FakeBackend::default());
    let st = state_with(fake.clone(), d.path(), revoke_check);
    let cookie = paired_cookie(&st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(st.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (d, fake, st, cookie, format!("ws://{addr}/ws"))
}

fn request(url: &str, cookie: Option<&str>, origin: &str) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    let mut r = url.into_client_request().unwrap();
    r.headers_mut().insert("origin", origin.parse().unwrap());
    if let Some(c) = cookie {
        r.headers_mut().insert("cookie", format!("herdly_web={c}").parse().unwrap());
    }
    r
}

const ORIGIN: &str = "http://192.0.2.10:7380";

async fn next_json<S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin>(s: &mut S) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(2), s.next()).await.unwrap().unwrap().unwrap() {
            Message::Text(t) => return serde_json::from_str(&t).unwrap(),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn upgrade_needs_origin_and_cookie() {
    let (_d, _f, _st, cookie, url) = serve(Duration::from_secs(15)).await;
    assert!(tokio_tungstenite::connect_async(request(&url, Some(&cookie), "http://evil.example")).await.is_err());
    assert!(tokio_tungstenite::connect_async(request(&url, None, ORIGIN)).await.is_err());
    assert!(tokio_tungstenite::connect_async(request(&url, Some(&cookie), ORIGIN)).await.is_ok());
}

#[tokio::test]
async fn first_frame_is_the_machines_snapshot_then_subscribe_brings_chat_frames() {
    let (_d, fake, _st, cookie, url) = serve(Duration::from_secs(15)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(request(&url, Some(&cookie), ORIGIN)).await.unwrap();
    let first = next_json(&mut ws).await;
    assert_eq!(first, json!({"type": "machines", "views": []}));
    ws.send(Message::Text(json!({"type": "subscribe", "pane": {"session": "s", "pane_id": "p1"}}).to_string().into())).await.unwrap();
    assert_eq!(next_json(&mut ws).await["type"], "chat_opened");
    ws.send(Message::Text(json!({"type": "unsubscribe", "pane": {"session": "s", "pane_id": "p1"}}).to_string().into())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.log.lock().unwrap().last().unwrap(), "close:p1");
}

#[tokio::test]
async fn closing_the_socket_releases_its_chats() {
    let (_d, fake, _st, cookie, url) = serve(Duration::from_secs(15)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(request(&url, Some(&cookie), ORIGIN)).await.unwrap();
    next_json(&mut ws).await;
    ws.send(Message::Text(json!({"type": "subscribe", "pane": {"session": "s", "pane_id": "p1"}}).to_string().into())).await.unwrap();
    next_json(&mut ws).await;
    drop(ws);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fake.log.lock().unwrap().last().unwrap(), "close:p1");
}

#[tokio::test]
async fn a_lagging_socket_is_closed_with_4000() {
    let (_d, _f, st, cookie, url) = serve(Duration::from_secs(15)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(request(&url, Some(&cookie), ORIGIN)).await.unwrap();
    next_json(&mut ws).await;
    let big: Arc<str> = Arc::from(format!("{{\"type\":\"machine\",\"pad\":\"{}\"}}", "x".repeat(64 * 1024)).as_str());
    for _ in 0..5000 {
        st.hub.send_frame(big.clone());
    }
    let code = loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap() {
            Some(Ok(Message::Close(Some(f)))) => break f.code,
            Some(Ok(_)) => continue,
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(code, CloseCode::Library(4000));
}

#[tokio::test]
async fn a_revoked_device_is_closed_with_4401() {
    let (_d, _f, st, cookie, url) = serve(Duration::from_millis(100)).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(request(&url, Some(&cookie), ORIGIN)).await.unwrap();
    next_json(&mut ws).await;
    let id = herdly_web::auth::list_devices(st.auth.store()).unwrap()[0].id.clone();
    std::thread::sleep(Duration::from_millis(20));
    herdly_web::auth::revoke(st.auth.store(), &id).unwrap();
    let code = loop {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await.unwrap() {
            Some(Ok(Message::Close(Some(f)))) => break f.code,
            Some(Ok(_)) => continue,
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(code, CloseCode::Library(4401));
}
```

- [ ] **Step 2: Add the stub and see the tests fail**

Stub: route `/ws` returns `StatusCode::NOT_IMPLEMENTED`; `Hub` methods exist and do nothing.

Run: `cargo test -p herdly-web --test ws`
Expected: FAIL on `assert!(…connect_async(… ORIGIN)).await.is_ok())` and on `.unwrap()` of `connect_async` in the others (HTTP 501 handshake error).

- [ ] **Step 3: Implement** `hub.rs`, `forward_statuses`, `ws.rs` and the `AppState` additions as in Interfaces.

- [ ] **Step 4: Run it and see it pass**

Run: `cargo test -p herdly-web`
Expected: PASS (every test file, including Task 5's `http` with the new `AppState` fields).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/web
git commit -m "feat(web): WebSocket with machine, status and Chat frames"
```

---

### Task 7: CLI, startup, systemd unit, docs and a test against the real herdr

**Files:**
- Modify: `src-tauri/web/src/main.rs`
- Create: `src-tauri/web/src/cli.rs` (clap types + `run(cli: Cli) -> Result<(), String>`)
- Create: `web/herdly-web.service`
- Create: `web/README.md`
- Modify: `README.md` (one line under the intro, see Step 6)
- Test: `src-tauri/web/tests/cli.rs`, `src-tauri/web/tests/real_herdr.rs`

**Interfaces:**
- Consumes: `Core`, `Auth`, `Store`, `start_pairing`, `list_devices`, `revoke`, `Hub::new`, `Hub::emit`, `forward_statuses`, `ChatHub::new`, `AppState`, `Config`, `router`, `config::{DEFAULT_BIND, now_secs}`, `herdly_core::machines::MachineManager`, `herdly_core::transcript::ChatManager`.
- Produces:
  - `cli.rs`: `#[derive(Parser)] #[command(name = "herdly-web", args_conflicts_with_subcommands = true)] pub struct Cli { #[command(subcommand)] pub cmd: Option<Cmd>, #[command(flatten)] pub serve: ServeArgs }`; `pub enum Cmd { Serve(ServeArgs), Pair(PairArgs), Devices(StateArg), Revoke { id: String, #[command(flatten)] state: StateArg } }`; `pub struct ServeArgs { pub bind: String /* --bind, default DEFAULT_BIND */, pub origin: Option<String> /* --origin */, #[arg(long = "static")] pub static_dir: Option<PathBuf>, pub state: Option<PathBuf> /* --state */ }` (all fields `pub`: tests build it directly); `PairArgs { --bind, --origin, --state }`; `StateArg { --state }`. No subcommand runs `serve` with the top-level flags.
  - `pub fn state_dir(arg: Option<PathBuf>) -> PathBuf`: the arg, else `$XDG_STATE_HOME/herdly-web` when set and non-empty, else `$HOME/.local/state/herdly-web`.
  - `pub fn origin_for(bind: &str, origin: Option<String>) -> String`: the given origin, else `http://<bind>`.
  - `pub async fn build_serve(args: &ServeArgs) -> Result<(TcpListener, Arc<AppState>), String>`: validates `--static` (missing → `"--static is required"`; no `index.html` → `"<dir> has no index.html"`), binds (`"cannot bind <addr>: <io error>"`), then wires core exactly as `src-tauri/src/lib.rs:123-146`: `Hub::new()`; `MachineManager::new(<state>/machines.json, hub.emit())`; `let chats = Arc::new(ChatManager::default())`; `mgr.set_chat_manager(chats.clone())`; `Core { mgr, chats }`; `ChatHub::new(core)`; spawn `forward_statuses`; spawn `mgr.connect_at_startup()`. `serve` then runs `axum::serve`.
  - `pair` prints `<origin>/pair?t=<token>` on its own line, then the QR code (`qrcode` unicode `Dense1x2` renderer), then `expires in 10 minutes`.
  - `devices` prints one line per device: `<id>  <name>  created <RFC 3339 UTC>  last seen <RFC 3339 UTC>`; `revoke <id>` prints `revoked <id>` or exits 1 with `herdly-web: no device <id>`.
  - `main.rs`: `tracing_subscriber::fmt` to stderr, `Cli::parse()`, `run`; `Err(msg)` → `eprintln!("herdly-web: {msg}")` and exit 1.

- [ ] **Step 1: Write the failing tests**

`src-tauri/web/tests/cli.rs`:

```rust
use herdly_web::cli::{build_serve, origin_for, state_dir, ServeArgs};
use std::path::PathBuf;

fn args(bind: &str, static_dir: Option<PathBuf>, state: PathBuf) -> ServeArgs {
    ServeArgs { bind: bind.into(), origin: None, static_dir, state: Some(state) }
}

#[test]
fn origin_defaults_to_the_bind_address() {
    assert_eq!(origin_for("192.0.2.10:7380", None), "http://192.0.2.10:7380");
    assert_eq!(origin_for("192.0.2.10:7380", Some("http://devbox:7380".into())), "http://devbox:7380");
}

#[test]
fn state_dir_falls_back_to_local_state_under_home() {
    std::env::remove_var("XDG_STATE_HOME");
    std::env::set_var("HOME", "/home/u");
    assert_eq!(state_dir(None), PathBuf::from("/home/u/.local/state/herdly-web"));
    std::env::set_var("XDG_STATE_HOME", "/x");
    assert_eq!(state_dir(None), PathBuf::from("/x/herdly-web"));
    assert_eq!(state_dir(Some("/s".into())), PathBuf::from("/s"));
}

#[tokio::test]
async fn serve_refuses_a_missing_static_dir() {
    let d = tempfile::tempdir().unwrap();
    let err = build_serve(&args("127.0.0.1:0", None, d.path().join("st"))).await.err().unwrap();
    assert_eq!(err, "--static is required");
    let err = build_serve(&args("127.0.0.1:0", Some(d.path().to_path_buf()), d.path().join("st"))).await.err().unwrap();
    assert_eq!(err, format!("{} has no index.html", d.path().display()));
}

#[tokio::test]
async fn serve_refuses_an_address_it_cannot_bind() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("index.html"), "x").unwrap();
    let err = build_serve(&args("10.255.255.254:7380", Some(d.path().to_path_buf()), d.path().join("st"))).await.err().unwrap();
    assert!(err.starts_with("cannot bind 10.255.255.254:7380: "), "{err}");
}

#[test]
fn the_binary_exits_1_with_its_reason() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_herdly-web"))
        .args(["serve", "--bind", "127.0.0.1:0", "--state", "/tmp/herdly-web-test-state"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&out.stderr).trim_end(), "herdly-web: --static is required");
}
```

(`state_dir_falls_back_to_local_state_under_home` is the only test that changes the process environment; Step 4 runs this file with `--test-threads=1`.)

`src-tauri/web/tests/real_herdr.rs`:

```rust
#![cfg(unix)]
use herdly_web::cli::{build_serve, ServeArgs};
use std::time::Duration;

#[tokio::test]
#[ignore]
async fn lists_a_running_session_of_the_local_herdr() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("index.html"), "x").unwrap();
    let args = ServeArgs {
        bind: "127.0.0.1:0".into(),
        origin: None,
        static_dir: Some(d.path().to_path_buf()),
        state: Some(d.path().join("st")),
    };
    let (listener, st) = build_serve(&args).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cookie = herdly_web::testing::paired_cookie(&st);
    tokio::spawn(async move { axum::serve(listener, herdly_web::app::router(st)).await.unwrap() });
    let url = format!("http://{addr}/api/machines");
    for _ in 0..60 {
        let out = tokio::process::Command::new("curl")
            .args(["-s", "-H", &format!("cookie: herdly_web={cookie}"), &url])
            .output()
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
        if v[0]["sessions"].as_array().is_some_and(|s| s.iter().any(|s| s["running"] == true)) {
            assert_eq!(v[0]["id"], "local");
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    panic!("no running Session listed within 15 s");
}
```

- [ ] **Step 2: Add the stubs and see the tests fail**

Stubs: `origin_for` returns `String::new()`; `state_dir` returns `PathBuf::new()`; `build_serve` returns `Err(String::new())`; `run` returns `Ok(())`.

Run: `cargo test -p herdly-web --test cli -- --test-threads=1`
Expected: FAIL on `assert_eq!(origin_for(…), "http://192.0.2.10:7380")` (got `""`), on `assert_eq!(err, "--static is required")` (got `""`) and on `assert_eq!(out.status.code(), Some(1))` (got `Some(0)`).

- [ ] **Step 3: Implement** `cli.rs` and `main.rs` as in Interfaces.

- [ ] **Step 4: Run it and see it pass**

Run: `cargo test -p herdly-web --test cli -- --test-threads=1`
Expected: PASS (all five).

Run: `cargo test -p herdly-web --test real_herdr -- --ignored`
Expected: PASS (`default` and others are running on the devbox: `herdr session list`).

- [ ] **Step 5: Add the unit file**

`web/herdly-web.service`:

```ini
[Unit]
Description=Herdly Web (herdr from a phone)
After=network-online.target

[Service]
ExecStart=@REPO@/src-tauri/target/release/herdly-web serve --static @REPO@/web/dist
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- [ ] **Step 6: Write the docs**

`web/README.md` sections, in this order, each with its commands:
- **What it is**: one paragraph: Herdly Web serves the Pane list and Chat lens of this Machine's herdr to a Paired device over plain HTTP on the WireGuard address; see `docs/adr/0011-herdly-web-plain-http-over-wireguard.md` (the hub can read the traffic).
- **Build**: `cd src-tauri && cargo build --release -p herdly-web`; `cd web && pnpm install && pnpm build`.
- **Install** (from the main checkout, not `.worktrees/`): `sed "s#@REPO@#$PWD#g" web/herdly-web.service > ~/.config/systemd/user/herdly-web.service`; `systemctl --user daemon-reload`; `systemctl --user enable --now herdly-web`; optional `loginctl enable-linger $USER` to keep it running while logged out.
- **Pair a phone**: `src-tauri/target/release/herdly-web pair`, open the printed link (or scan the QR code) in Chrome on the phone within 10 minutes.
- **Devices and revoking**: `herdly-web devices`, `herdly-web revoke <id>`.
- **Upgrade**: `git pull`, rebuild both as in Build, `systemctl --user restart herdly-web`; the state in `~/.local/state/herdly-web` needs no migration.
- **Rollback**: `systemctl --user disable --now herdly-web`; `rm ~/.config/systemd/user/herdly-web.service`; `rm -r ~/.local/state/herdly-web`. The desktop app is unaffected.
- **Check**: `curl -i http://192.0.2.10:7380/api/machines` without a cookie returns `401`.
- **Flags**: `--bind` (default `192.0.2.10:7380`), `--origin` (default `http://<bind>`), `--static` (required for `serve`), `--state` (default `$XDG_STATE_HOME/herdly-web`, else `~/.local/state/herdly-web`).

Root `README.md`: after the paragraph that ends with the `herdly-core` sentence (line 57-59), add: `Herdly Web (`src-tauri/web/`, `web/`) serves this Machine's Pane list and Chat lens to a phone; see [web/README.md](web/README.md).`

- [ ] **Step 7: Commit**

```bash
git add src-tauri/web web/herdly-web.service web/README.md README.md src-tauri/Cargo.lock
git commit -m "feat(web): herdly-web CLI (serve, pair, devices, revoke), systemd unit and docs"
```

---

### Task 8: Web app scaffold, REST client, socket and store

**Files:**
- Create: `web/package.json`, `web/pnpm-lock.yaml` (generated), `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/config.ts`, `web/src/types.ts`, `web/src/api.ts`, `web/src/socket.ts`, `web/src/store.ts`, `web/src/test-setup.ts`
- Modify: `vite.config.ts:37` (root; `exclude: [...configDefaults.exclude, ".worktrees/**", "web/**"]`)
- Modify: `mise.toml` (task `test:web` = `pnpm --dir web test`; `[tasks.test] depends` gains `"test:web"`; task `typecheck:web` = `pnpm --dir web typecheck`, added to `check`'s depends)
- Test: `web/src/importGuard.test.ts`, `web/src/api.test.ts`, `web/src/socket.test.ts`, `web/src/store.test.ts`

**Interfaces:**
- Consumes (HTTP, from Herdly Web): the routes and frames in Global Constraints.
- Produces:
  - `web/package.json`: name `herdly-web-ui`, private, `"type": "module"`, scripts `dev: vite`, `build: tsc --noEmit && vite build`, `test: vitest run`, `typecheck: tsc --noEmit`; dependencies `react ^19.1.0`, `react-dom ^19.1.0`, `react-markdown ^10.1.0`, `remark-gfm ^4.0.1`, `rehype-highlight ^7.0.2`, `zustand ^5.0.15`; devDependencies `@vitejs/plugin-react ^6.0.2`, `vite ^8.0.16`, `vitest ^5.0.3`, `jsdom ^30.1.1`, `@testing-library/react ^16.3.3`, `@testing-library/jest-dom ^7.0.1`, `@types/react ^19.1.8`, `@types/react-dom ^19.1.6`, `@types/node ^26.6.3`, `typescript ~6.0.3`.
  - `web/vite.config.ts`: `resolve.alias { "@desktop": path.resolve(__dirname, "../src") }`; `test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] }`. `web/tsconfig.json`: the root `tsconfig.json`'s compiler options plus `"baseUrl": "."`, `"paths": { "@desktop/*": ["../src/*"] }`, `"types": ["vitest/globals", "@testing-library/jest-dom"]`, `"include": ["src"]`.
  - `web/src/test-setup.ts`: `import "@testing-library/jest-dom/vitest";` and the root setup's `afterEach(() => cleanup())`.
  - `types.ts`: `export interface WebPane { session: string; pane_id: string }`; `export const webKey = (p: WebPane) => \`${p.session}/${p.pane_id}\``; `export type Frame` (the six server frames); re-exports of the needed `@desktop/lib/types` types.
  - `api.ts`: `export class ApiError extends Error { constructor(public status: number, public code: string, message: string) }`; `getMe(): Promise<{device_id: string; name: string}>`; `getMachines(): Promise<MachineView[]>`; `chatPage(p: WebPane, before: number, limit?: number): Promise<ChatItem[]>`; `paneRead(p: WebPane): Promise<string>`; `panePrompt(p: WebPane, text: string)`; `paneKeys(p: WebPane, keys: string[])`; `paneText(p: WebPane, text: string)`. All use `fetch` with `credentials: "same-origin"`, JSON bodies, and throw `ApiError` from the `{code, message}` body on a non-2xx status.
  - `socket.ts`: `export type Conn = "connecting" | "open" | "down" | "unpaired"`; `export interface SocketDeps { open(url: string): WebSocketLike; me(): Promise<number> /* HTTP status of GET /api/me */; setTimeout(fn: () => void, ms: number): unknown }`; `export class Socket { constructor(url: string, on: { frame(f: Frame): void; conn(c: Conn): void }, deps?: Partial<SocketDeps>); start(): void; stop(): void; subscribe(p: WebPane): void; unsubscribe(p: WebPane): void }`. Rules: every connection attempt first calls `conn("connecting")`, and `onopen` calls `conn("open")`; subscriptions are remembered and re-sent after every reconnect; on close code 4401 → `conn("unpaired")`, no reconnect; on any other close or error → `conn("down")`, call `me()`; 401 → `conn("unpaired")`, else reconnect after the backoff (1000, 2000, 4000, 8000, 15000, 15000…), reset to 1000 after an `open`.
  - `store.ts` (zustand): `useWeb` with `conn: Conn`, `machines: MachineView[]`, `chats: Record<string, ChatView>` where `ChatView = { chat: ChatState; located: Located | null; error: AppError | null }`, actions `apply(f: Frame): void`, `setConn(c: Conn): void`, `prependOlder(key: string, items: ChatItem[], before: number): void`, `clearChat(key: string): void`. `apply`: `machines` replaces; `machine` replaces the view with the same `id`, or appends; `pane_status` updates that Pane's `status` and `title` in place; `chat_opened` sets `located` and clears `error`; `chat` runs `reduce` from `@desktop/chat/chatStore` (with `atBottom` false); `chat_error` sets `error`. `pane_status` also calls `seen.clear(key)` once Task 9 adds it (Task 9 owns that line).
  - `App.tsx`: renders `<NotPaired/>` when `conn === "unpaired"` (heading `Not paired`, text `Open a pairing link from herdly-web pair on the devbox.`), a top bar `Disconnected, reconnecting…` when `conn === "down"`, and a placeholder `<main/>` that Tasks 9-10 fill. `main.tsx` creates one `Socket` for `` `ws://${location.host}/ws` `` wired to the store.

- [ ] **Step 1: Write the failing tests**

`web/src/importGuard.test.ts`:

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_SRC = resolve(__dirname);
const DESKTOP_SRC = resolve(__dirname, "../../src");
const ALLOWED = ["lib/types", "chat/chatStore", "chat/checklist", "chat/prompt/screenPrompt", "chat/prompt/sendAnswer"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const specifiers = (src: string) => [...src.matchAll(/(?:import|export)[^"']*?from\s*["']([^"']+)["']/g)].map((m) => m[1]);
const resolveTs = (base: string) => [".ts", ".tsx"].map((e) => base + e).find((p) => { try { return statSync(p).isFile(); } catch { return false; } }) ?? base;

describe("imports from the desktop app", () => {
  it("use only the allowed modules", () => {
    const used = files(WEB_SRC).flatMap((f) => specifiers(readFileSync(f, "utf8"))).filter((s) => s.startsWith("@desktop/"));
    for (const s of used) expect(ALLOWED).toContain(s.slice("@desktop/".length));
  });

  it("reach only relative imports inside src/, never lib/ipc or Tauri", () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const s of specifiers(readFileSync(file, "utf8"))) {
        expect(s.startsWith("."), `${file} imports ${s}`).toBe(true);
        const next = resolveTs(resolve(dirname(file), s));
        expect(next.endsWith(join("lib", "ipc.ts"))).toBe(false);
        walk(next);
      }
    };
    for (const m of ALLOWED) walk(resolveTs(join(DESKTOP_SRC, m)));
    expect(seen.size).toBeGreaterThanOrEqual(ALLOWED.length);
  });
});
```

`web/src/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, paneKeys, paneRead } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("posts JSON with the pane and returns read text", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "screen" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await paneRead({ session: "s", pane_id: "p1" })).toBe("screen");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/pane/read");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ session: "s", pane_id: "p1" });
  });

  it("throws ApiError with status and code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "herdr_error", message: "boom" }), { status: 502 })));
    const e = await paneKeys({ session: "s", pane_id: "p1" }, ["esc"]).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.code, e.message]).toEqual([502, "herdr_error", "boom"]);
  });
});
```

`web/src/socket.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { Socket, type Conn } from "./socket";

class FakeWs {
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  onerror?: () => void;
  send(s: string) { this.sent.push(s); }
  close() {}
}

function rig(meStatus = 200) {
  const sockets: FakeWs[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const conns: Conn[] = [];
  const frames: unknown[] = [];
  const s = new Socket("ws://h/ws", { frame: (f) => frames.push(f), conn: (c) => conns.push(c) }, {
    open: () => { const w = new FakeWs(); sockets.push(w); return w as never; },
    me: vi.fn().mockResolvedValue(meStatus),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  });
  return { s, sockets, timers, conns, frames };
}

describe("Socket", () => {
  it("re-sends subscriptions after a reconnect", async () => {
    const r = rig();
    r.s.start();
    r.sockets[0].onopen!();
    r.s.subscribe({ session: "s", pane_id: "p1" });
    r.sockets[0].onclose!({ code: 1006 });
    await vi.waitFor(() => expect(r.timers.length).toBe(1));
    expect(r.timers[0].ms).toBe(1000);
    r.timers[0].fn();
    r.sockets[1].onopen!();
    expect(r.sockets[1].sent.map((x) => JSON.parse(x))).toEqual([{ type: "subscribe", pane: { session: "s", pane_id: "p1" } }]);
    expect(r.conns).toEqual(["connecting", "open", "down", "connecting", "open"]);
  });

  it("backs off 1s, 2s, 4s, 8s, 15s, 15s and resets after an open", async () => {
    const r = rig();
    r.s.start();
    for (let i = 0; i < 6; i++) {
      r.sockets[i].onclose!({ code: 1006 });
      await vi.waitFor(() => expect(r.timers.length).toBe(i + 1));
      r.timers[i].fn();
    }
    expect(r.timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    r.sockets[6].onopen!();
    r.sockets[6].onclose!({ code: 1006 });
    await vi.waitFor(() => expect(r.timers.length).toBe(7));
    expect(r.timers[6].ms).toBe(1000);
  });

  it("goes unpaired on close 4401 without reconnecting", async () => {
    const r = rig();
    r.s.start();
    r.sockets[0].onopen!();
    r.sockets[0].onclose!({ code: 4401 });
    expect(r.conns.at(-1)).toBe("unpaired");
    expect(r.timers).toEqual([]);
  });

  it("asks /api/me after a refused socket and goes unpaired on 401", async () => {
    const r = rig(401);
    r.s.start();
    r.sockets[0].onclose!({ code: 1006 });
    await vi.waitFor(() => expect(r.conns.at(-1)).toBe("unpaired"));
    expect(r.timers).toEqual([]);
  });

  it("passes frames through parsed", () => {
    const r = rig();
    r.s.start();
    r.sockets[0].onmessage!({ data: JSON.stringify({ type: "machines", views: [] }) });
    expect(r.frames).toEqual([{ type: "machines", views: [] }]);
  });
});
```

`web/src/store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useWeb } from "./store";

const pane = { session: "s", pane_id: "p1" };
const located = { agent: "claude", path: "/t/a.jsonl", ambiguous: false, candidates: [], pending: false };

beforeEach(() => useWeb.setState({ conn: "connecting", machines: [], chats: {} }));

describe("store", () => {
  it("applies chat frames in either order and replaces on every reset", () => {
    const { apply } = useWeb.getState();
    apply({ type: "chat", pane, event: { type: "reset", items: [{ kind: "system", text: "a" }], total: 1 } });
    apply({ type: "chat_opened", pane, located });
    apply({ type: "chat", pane, event: { type: "append", items: [{ kind: "system", text: "b" }] } });
    expect(useWeb.getState().chats["s/p1"].chat.items).toHaveLength(2);
    apply({ type: "chat", pane, event: { type: "reset", items: [{ kind: "system", text: "c" }], total: 9 } });
    const v = useWeb.getState().chats["s/p1"];
    expect(v.chat.items).toEqual([{ kind: "system", text: "c" }]);
    expect(v.chat.total).toBe(9);
    expect(v.located?.path).toBe("/t/a.jsonl");
  });

  it("records chat_error and clears it on the next chat_opened", () => {
    const { apply } = useWeb.getState();
    apply({ type: "chat_error", pane, error: { code: "not_found", message: "no transcript" } });
    expect(useWeb.getState().chats["s/p1"].error?.message).toBe("no transcript");
    apply({ type: "chat_opened", pane, located });
    expect(useWeb.getState().chats["s/p1"].error).toBeNull();
  });
});
```

- [ ] **Step 2: Add the stubs and see the tests fail**

Install (`pnpm install` in `web/`), then add the modules with every export from Interfaces; stub bodies: `paneRead` resolves `""`, `Socket.start` does nothing, `apply` does nothing.

Run: `pnpm --dir web test`
Expected: FAIL on `expect(await paneRead(…)).toBe("screen")` (got `""`), on `expect(r.timers.length).toBe(1)` (got 0), and on the store's `toHaveLength(2)` (`chats["s/p1"]` undefined). The import guard passes.

- [ ] **Step 3: Implement** `api.ts`, `socket.ts`, `store.ts`, `App.tsx`, `main.tsx` as in Interfaces; add `"web/**"` to the root `vite.config.ts` exclude and the mise tasks.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --dir web test` → PASS. Run: `pnpm --dir web typecheck` → exit 0. Run: `pnpm --dir web build` → `web/dist/index.html` exists. Run (root): `pnpm test` → the desktop suite passes and collects no file under `web/`.

- [ ] **Step 5: Commit**

```bash
git add web vite.config.ts mise.toml
git commit -m "feat(web-ui): app scaffold, REST client, reconnecting socket and store"
```

---

### Task 9: Pane list with statuses and seen `done`

**Files:**
- Create: `web/src/list/order.ts`, `web/src/list/seen.ts`, `web/src/list/PaneList.tsx`
- Modify: `web/src/store.ts` (`pane_status` calls `clearSeen(key)`), `web/src/App.tsx` (shows `PaneList` when no Chat is open; `open: WebPane | null` in the store with `openChat(p)` / `closeChat()`)
- Test: `web/src/list/order.test.ts`, `web/src/list/seen.test.ts`, `web/src/list/PaneList.test.tsx`

**Interfaces:**
- Consumes: `useWeb` (`machines`, `apply`), `WebPane`, `webKey`, `SEEN_KEY`, desktop types `MachineView`, `SessionView`, `PaneView`, `AgentStatus`.
- Produces:
  - `order.ts`: `export function orderSessions(ss: SessionView[]): SessionView[]` (running first, otherwise herdr's order, stable); `export interface PaneRow { pane: PaneView; workspace: string }`; `export function groupSession(s: SessionView): { waiting: PaneRow[]; workspaces: { label: string; panes: PaneRow[] }[] }` (`waiting` = every `blocked` Pane of the Session in herdr's order; `workspaces` = each Workspace with its other Panes across its Tabs, Workspaces left out when empty).
  - `seen.ts`: `export function markSeen(key: string): void` (stores `"done"` for the key under `SEEN_KEY`), `export function clearSeen(key: string): void`, `export function shownStatus(key: string, status: AgentStatus): AgentStatus` (`"idle"` when `status === "done"` and the key is marked, else `status`). Every `localStorage` access in try/catch; failures act as "nothing stored".
  - `PaneList.tsx`: `export function PaneList(props: { onOpen(p: WebPane): void })`. For each running/stopped Session (from `machines[0].sessions`, the only Machine): a header with the Session name (`(stopped)` after a stopped one's name); a `Waiting` group when `waiting` is non-empty; then each Workspace label with its rows. A row: Agent name (or `shell`), Pane title, a status badge with text `shownStatus(key, status)` and `data-status` of the same value. Tapping a row whose `agent` is `"claude"` or `"pi"` calls `markSeen(key)` when its status is `done` (and re-renders the list through a local state counter), then `onOpen`; other rows show `Chat lens supports Claude Code and pi only` under the row. When the local Machine has an `error`, a banner shows `error.message`.

- [ ] **Step 1: Write the failing tests**

`web/src/list/order.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupSession, orderSessions } from "./order";

const p = (id: string, status: string, agent: string | null = "claude") => ({ pane_id: id, terminal_id: "t" + id, title: id, cwd: null, agent, status });
const session = (name: string, running: boolean, workspaces: unknown[]) => ({ name, running, status: "idle", error: null, workspaces });
const ws = (label: string, panes: unknown[]) => ({ workspace_id: label, label, number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] });

describe("order", () => {
  it("puts running sessions first and keeps herdr's order otherwise", () => {
    const ss = [session("a", false, []), session("b", true, []), session("c", true, [])] as never[];
    expect(orderSessions(ss).map((s: { name: string }) => s.name)).toEqual(["b", "c", "a"]);
  });

  it("lifts blocked panes of every workspace into waiting", () => {
    const s = session("s", true, [ws("api", [p("1", "working"), p("2", "blocked")]), ws("web", [p("3", "blocked")]), ws("docs", [p("4", "blocked")])]);
    const g = groupSession(s as never);
    expect(g.waiting.map((r) => [r.pane.pane_id, r.workspace])).toEqual([["2", "api"], ["3", "web"], ["4", "docs"]]);
    expect(g.workspaces.map((w) => [w.label, w.panes.map((r) => r.pane.pane_id)])).toEqual([["api", ["1"]]]);
  });
});
```

`web/src/list/seen.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSeen, markSeen, shownStatus } from "./seen";

beforeEach(() => localStorage.clear());

describe("seen done", () => {
  it("shows a seen done pane as idle until its status changes", () => {
    expect(shownStatus("s/p1", "done")).toBe("done");
    markSeen("s/p1");
    expect(shownStatus("s/p1", "done")).toBe("idle");
    expect(shownStatus("s/p1", "blocked")).toBe("blocked");
    clearSeen("s/p1");
    expect(shownStatus("s/p1", "done")).toBe("done");
  });

  it("acts as nothing stored when localStorage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(shownStatus("s/p1", "done")).toBe("done");
    spy.mockRestore();
  });
});
```

`web/src/list/PaneList.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWeb } from "../store";
import { PaneList } from "./PaneList";

const p = (id: string, status: string, agent: string | null) => ({ pane_id: id, terminal_id: "t", title: "title " + id, cwd: null, agent, status });
const machine = (panes: unknown[], error: unknown = null) => ({
  id: "local", label: "local", kind: "local", state: "connected", error, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "herdly", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] }] }],
});

beforeEach(() => {
  localStorage.clear();
  useWeb.setState({ conn: "open", machines: [machine([p("1", "done", "claude"), p("2", "blocked", "claude"), p("3", "idle", null)])] as never, chats: {} });
});

describe("PaneList", () => {
  it("shows waiting first and opens a chat-capable pane, marking a done one seen", () => {
    const onOpen = vi.fn();
    render(<PaneList onOpen={onOpen} />);
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    const done = screen.getByText("title 1").closest("[data-pane]")!;
    expect(done.querySelector("[data-status]")!.getAttribute("data-status")).toBe("done");
    fireEvent.click(done);
    expect(onOpen).toHaveBeenCalledWith({ session: "default", pane_id: "1" });
    expect(screen.getByText("title 1").closest("[data-pane]")!.querySelector("[data-status]")!.getAttribute("data-status")).toBe("idle");
  });

  it("explains panes without a chat lens", () => {
    const onOpen = vi.fn();
    render(<PaneList onOpen={onOpen} />);
    fireEvent.click(screen.getByText("title 3"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText("Chat lens supports Claude Code and pi only")).toBeInTheDocument();
  });

  it("updates a badge from a pane_status frame and clears the seen mark", () => {
    render(<PaneList onOpen={() => {}} />);
    fireEvent.click(screen.getByText("title 1"));
    useWeb.getState().apply({ type: "pane_status", ev: { pane: { machine_id: "local", session: "default", pane_id: "1" }, status: "working", previous: "done", title: "title 1" } });
    useWeb.getState().apply({ type: "pane_status", ev: { pane: { machine_id: "local", session: "default", pane_id: "1" }, status: "done", previous: "working", title: "title 1" } });
    expect(screen.getByText("title 1").closest("[data-pane]")!.querySelector("[data-status]")!.getAttribute("data-status")).toBe("done");
  });

  it("shows the machine's error as a banner", () => {
    useWeb.setState({ machines: [machine([], { code: "herdr_not_found", message: "herdr not found" })] as never });
    render(<PaneList onOpen={() => {}} />);
    expect(screen.getByText("herdr not found")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Add the stubs and see the tests fail**

Stubs: `orderSessions` returns its input; `groupSession` returns `{ waiting: [], workspaces: [] }`; `shownStatus` returns `status`; `PaneList` renders `<div/>`.

Run: `pnpm --dir web test src/list`
Expected: FAIL on `toEqual(["b", "c", "a"])` (got `["a","b","c"]`), on `toBe("idle")` in seen, and on `getByText("Waiting")`.

- [ ] **Step 3: Implement** `order.ts`, `seen.ts`, `PaneList.tsx` and the store/App changes as in Interfaces.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --dir web test` → PASS. `pnpm --dir web typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat(web-ui): Pane list with live statuses and seen done marks"
```

---

### Task 10: Chat screen: Transcript, paging, Composer, errors

**Files:**
- Create: `web/src/chat/ChatScreen.tsx`, `web/src/chat/ItemView.tsx`, `web/src/chat/Markdown.tsx`, `web/src/chat/pending.ts`
- Modify: `web/src/App.tsx` (shows `ChatScreen` for `open`; subscribes on open, unsubscribes and `clearChat` on back)
- Test: `web/src/chat/pending.test.ts`, `web/src/chat/Markdown.test.tsx`, `web/src/chat/ChatScreen.test.tsx`

**Interfaces:**
- Consumes: `useWeb` (`chats`, `machines`, `prependOlder`, `apply`), `Socket.subscribe`, `api.{chatPage, panePrompt}`, `ApiError`, `CHAT_PAGE`, `PENDING_STALE_MS`, `@desktop/chat/checklist` (`checklist`, `checklistSummary`), `WebPane`, `webKey`.
- Produces:
  - `pending.ts`: `export interface Pending { id: number; text: string; sentAt: number }`; `export function settle(pending: Pending[], items: ChatItem[]): Pending[]` (each `user` item whose trimmed text equals a pending one's trimmed text removes the first such pending); `export function isStale(p: Pending, now: number): boolean` (`now - p.sentAt >= PENDING_STALE_MS`).
  - `Markdown.tsx`: `export function Markdown(props: { text: string })` with `react-markdown`, `remark-gfm`, `rehype-highlight`, no `rehype-raw`; `a` renders with `target="_blank" rel="noopener noreferrer"`.
  - `ItemView.tsx`: `export function ItemView(props: { item: ChatItem })`: `user` → a bubble with the text (and `[image]` per image); `assistant_text` → `Markdown`; `thinking` → `<details><summary>Thinking</summary>`; `tool_call` → `<details>` with `name` and `input_summary` in the summary, and checklist rows (`checklistSummary` in the summary) when `checklist(input)` is non-null; `tool_result` → `<details>` with the output (`[image]` per image); `system`, `shell_command`, `shell_output` → plain text blocks.
  - `ChatScreen.tsx`: `export function ChatScreen(props: { pane: WebPane; onBack(): void; onRetry(): void })`. Header: back button (`aria-label="Back"`), the Pane title, a status badge. Body: the items; scrolled to the top it calls `chatPage(pane, total - items.length, CHAT_PAGE)` once per distinct `before` while `before > 0`, and `prependOlder`. `located.ambiguous` shows `Several transcripts match; showing the newest`. `error` (from `chat_error`) or `chat.error` (tail ended) shows the message and a `Retry` button calling `onRetry`. Bottom bar: the Composer (textarea `aria-label="Message"`, `Send` button): Send POSTs `panePrompt`, clears the field, adds a Pending shown as a dimmed user bubble; `settle` runs on every items change; a pending older than `PENDING_STALE_MS` shows `not seen yet`; a failed POST keeps the text in the field and shows the error message. Task 11 adds the stop buttons and the prompt card to this bottom bar.

- [ ] **Step 1: Write the failing tests**

`web/src/chat/pending.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isStale, settle } from "./pending";

describe("pending messages", () => {
  it("settles the first pending whose text a user item carries", () => {
    const ps = [{ id: 1, text: "hi ", sentAt: 0 }, { id: 2, text: "hi", sentAt: 1 }, { id: 3, text: "other", sentAt: 2 }];
    expect(settle(ps, [{ kind: "user", text: "hi" }, { kind: "assistant_text", markdown: "hi" }]).map((p) => p.id)).toEqual([2, 3]);
  });
  it("is stale after 30 s", () => {
    expect(isStale({ id: 1, text: "x", sentAt: 0 }, 29_999)).toBe(false);
    expect(isStale({ id: 1, text: "x", sentAt: 0 }, 30_000)).toBe(true);
  });
});
```

`web/src/chat/Markdown.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("shows HTML as text and opens links safely", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> see [docs](https://example.com)'} />);
    expect(container.querySelector("img")).toBeNull();
    const a = screen.getByText("docs");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
```

`web/src/chat/ChatScreen.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useWeb } from "../store";
import { ChatScreen } from "./ChatScreen";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), chatPage: vi.fn(), panePrompt: vi.fn() }));

const pane = { session: "s", pane_id: "p1" };
const located = { agent: "claude", path: "/t/a.jsonl", ambiguous: false, candidates: [], pending: false };
const machine = { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes: [{ pane_id: "p1", terminal_id: "t1", title: "fix login", cwd: null, agent: "claude", status: "working" }] }] }] }] };

function open(items: unknown[], total = items.length) {
  useWeb.setState({ conn: "open", machines: [machine] as never, chats: {} });
  act(() => {
    useWeb.getState().apply({ type: "chat_opened", pane, located });
    useWeb.getState().apply({ type: "chat", pane, event: { type: "reset", items, total } as never });
  });
}

beforeEach(() => vi.mocked(api.panePrompt).mockReset());

describe("ChatScreen", () => {
  it("renders the transcript and appends live", () => {
    open([{ kind: "user", text: "fix the login" }, { kind: "assistant_text", markdown: "**done**" }]);
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    expect(screen.getByText("fix login")).toBeInTheDocument();
    expect(screen.getByText("done").tagName).toBe("STRONG");
    act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "append", items: [{ kind: "system", text: "compacted" }] } }));
    expect(screen.getByText("compacted")).toBeInTheDocument();
  });

  it("pages older items in at the top", async () => {
    vi.mocked(api.chatPage).mockResolvedValue([{ kind: "system", text: "older" }] as never);
    open([{ kind: "system", text: "newest" }], 501);
    const { container } = render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    fireEvent.scroll(container.querySelector("[data-transcript]")!, { target: { scrollTop: 0 } });
    await waitFor(() => expect(screen.getByText("older")).toBeInTheDocument());
    expect(api.chatPage).toHaveBeenCalledWith(pane, 500, 200);
  });

  it("sends a message, shows it pending, and settles it on the append", async () => {
    vi.mocked(api.panePrompt).mockResolvedValue(undefined as never);
    open([]);
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "run the tests" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(api.panePrompt).toHaveBeenCalledWith(pane, "run the tests"));
    expect(screen.getByText("run the tests").closest("[data-pending]")).not.toBeNull();
    act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "append", items: [{ kind: "user", text: "run the tests" }] } }));
    expect(screen.getByText("run the tests").closest("[data-pending]")).toBeNull();
  });

  it("keeps the text and shows the error when sending fails", async () => {
    vi.mocked(api.panePrompt).mockRejectedValue(new api.ApiError(502, "herdr_error", "pane gone"));
    open([]);
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(screen.getByText("pane gone")).toBeInTheDocument());
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("hello");
  });

  it("shows the ambiguity note, and Retry for both error shapes", () => {
    const onRetry = vi.fn();
    open([]);
    act(() => useWeb.getState().apply({ type: "chat_opened", pane, located: { ...located, ambiguous: true, candidates: ["/a", "/b"] } }));
    const { rerender } = render(<ChatScreen pane={pane} onBack={() => {}} onRetry={onRetry} />);
    expect(screen.getByText("Several transcripts match; showing the newest")).toBeInTheDocument();
    act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "error", error: { code: "io", message: "tail ended" } } }));
    rerender(<ChatScreen pane={pane} onBack={() => {}} onRetry={onRetry} />);
    fireEvent.click(screen.getByText("Retry"));
    act(() => useWeb.getState().apply({ type: "chat_error", pane, error: { code: "not_found", message: "no transcript" } }));
    expect(screen.getByText("no transcript")).toBeInTheDocument();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Add the stubs and see the tests fail**

Stubs: `settle` returns its input; `isStale` returns `false`; `Markdown` renders `<div>{text}</div>`; `ChatScreen` renders `<div/>`.

Run: `pnpm --dir web test src/chat`
Expected: FAIL on `toEqual([2, 3])` (got `[1, 2, 3]`), on `getAttribute("target")` (element not found: `getByText("docs")` throws), and on `getByText("fix login")`.

- [ ] **Step 3: Implement** `pending.ts`, `Markdown.tsx`, `ItemView.tsx`, `ChatScreen.tsx` and the App wiring as in Interfaces (`onRetry` in App calls `socket.subscribe(pane)`).

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --dir web test` → PASS. `pnpm --dir web typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat(web-ui): Chat screen with paging, Composer and pending messages"
```

---

### Task 11: Prompt card while blocked, Esc and Ctrl+C

**Files:**
- Create: `web/src/prompt/usePrompt.ts`, `web/src/prompt/PromptCard.tsx`, `web/src/chat/StopBar.tsx`
- Modify: `web/src/chat/ChatScreen.tsx` (bottom bar: `StopBar` always; `PromptCard` instead of the Composer's text field and Send while the Pane is `blocked`)
- Test: `web/src/prompt/usePrompt.test.tsx`, `web/src/prompt/PromptCard.test.tsx`, `web/src/chat/StopBar.test.tsx`

**Interfaces:**
- Consumes: `api.{paneRead, paneKeys, paneText}`, `PROMPT_POLL_MS`, `@desktop/chat/prompt/screenPrompt` (`readPrompt`, `ScreenPrompt`, `PromptAnswer`), `@desktop/chat/prompt/sendAnswer` (`sendAnswer`, `PromptIo`), `WebPane`, the Pane's `PaneView` from `useWeb`.
- Produces:
  - `usePrompt.ts`: `export function usePrompt(pane: WebPane, view: PaneView): { prompt: ScreenPrompt | null; answer(a: PromptAnswer): Promise<void>; busy: boolean; error: string | null }`. While `view.status === "blocked"`: read at once and on every change of `view.status` or `view.title`, then every `PROMPT_POLL_MS`, skipping a tick while a read is in flight or `document.hidden`; each read sets `prompt = readPrompt(view.agent, text)`, keeping the current object when the new one has the same `id`. When not blocked: no reads, `prompt = null`. `answer` calls `sendAnswer(io, view.agent, prompt, a)` with `io: PromptIo = { read: () => paneRead(pane), keys: (k) => paneKeys(pane, k), text: (t) => paneText(pane, t) }`; `{ sent: false, fresh }` replaces `prompt` with `fresh`; a thrown error sets `error` to its message.
  - `PromptCard.tsx`: `export function PromptCard(props: { prompt: ScreenPrompt; busy: boolean; error: string | null; onAnswer(a: PromptAnswer): void })`: the title, question and body; one button per option (label, description below) → `onAnswer({ option_index: i })`; with `multi_select`, checkboxes plus a `Submit` button → `onAnswer({ option_indices })`; when `custom_option_index !== null`, a text input (`aria-label="Answer"`) and an `Answer` button → `onAnswer({ custom_text })`; buttons disabled while `busy`; `error` shown below.
  - `StopBar.tsx`: `export function StopBar(props: { pane: WebPane })`: buttons `Esc` → `paneKeys(pane, ["esc"])`, `Ctrl+C` → `paneKeys(pane, ["ctrl+c"])`; a failure shows its message.

- [ ] **Step 1: Write the failing tests**

`web/src/prompt/usePrompt.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { usePrompt } from "./usePrompt";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), paneRead: vi.fn(), paneKeys: vi.fn(), paneText: vi.fn() }));

const pane = { session: "s", pane_id: "p1" };
const view = (status: string, title = "t") => ({ pane_id: "p1", terminal_id: "t1", title, cwd: null, agent: "claude", status }) as never;
const SCREEN = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api.paneRead).mockResolvedValue(SCREEN); });
afterEach(() => { vi.useRealTimers(); vi.mocked(api.paneRead).mockReset(); });

describe("usePrompt", () => {
  it("never reads the screen unless the pane is blocked", async () => {
    renderHook(() => usePrompt(pane, view("working")));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(api.paneRead).not.toHaveBeenCalled();
  });

  it("reads at once when blocked, then every 1500 ms, and builds a card", async () => {
    const { result } = renderHook(() => usePrompt(pane, view("blocked")));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.paneRead).toHaveBeenCalledTimes(1);
    expect(result.current.prompt).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(api.paneRead).toHaveBeenCalledTimes(2);
  });

  it("does not read while the page is hidden", async () => {
    renderHook(() => usePrompt(pane, view("blocked")));
    await act(() => vi.advanceTimersByTimeAsync(0));
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(() => vi.advanceTimersByTimeAsync(4500));
    expect(api.paneRead).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("stops reading and drops the card when the status leaves blocked", async () => {
    const { result, rerender } = renderHook(({ v }) => usePrompt(pane, v), { initialProps: { v: view("blocked") } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    rerender({ v: view("working") });
    await act(() => vi.advanceTimersByTimeAsync(4500));
    expect(result.current.prompt).toBeNull();
    expect(api.paneRead).toHaveBeenCalledTimes(1);
  });
});
```

`web/src/prompt/PromptCard.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptCard } from "./PromptCard";

const prompt = { id: "x", agent: "claude", kind: "approval", title: "Bash", question: "Do you want to proceed?", body: null,
  options: [{ label: "Yes", description: null }, { label: "No", description: "and tell Claude why" }], multi_select: false, custom_option_index: 2 } as never;

describe("PromptCard", () => {
  it("answers with the tapped option or typed text", () => {
    const onAnswer = vi.fn();
    render(<PromptCard prompt={prompt} busy={false} error={null} onAnswer={onAnswer} />);
    expect(screen.getByText("Do you want to proceed?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("No"));
    expect(onAnswer).toHaveBeenLastCalledWith({ option_index: 1 });
    fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "use pnpm" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenLastCalledWith({ custom_text: "use pnpm" });
  });

  it("disables options while busy", () => {
    render(<PromptCard prompt={prompt} busy={true} error="pane gone" onAnswer={() => {}} />);
    expect(screen.getByText("Yes").closest("button")).toBeDisabled();
    expect(screen.getByText("pane gone")).toBeInTheDocument();
  });
});
```

`web/src/chat/StopBar.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { StopBar } from "./StopBar";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), paneKeys: vi.fn().mockResolvedValue(undefined) }));

describe("StopBar", () => {
  it("sends esc and ctrl+c", async () => {
    render(<StopBar pane={{ session: "s", pane_id: "p1" }} />);
    fireEvent.click(screen.getByText("Esc"));
    fireEvent.click(screen.getByText("Ctrl+C"));
    await waitFor(() => expect(api.paneKeys).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.paneKeys).mock.calls.map((c) => c[1])).toEqual([["esc"], ["ctrl+c"]]);
  });
});
```

Add to `web/src/chat/ChatScreen.test.tsx` (same file as Task 10; it reuses `open`, `machine`, `pane`):

```tsx
it("replaces the Composer with the prompt card while blocked and keeps Esc and Ctrl+C", async () => {
  open([]);
  const blocked = structuredClone(machine);
  blocked.sessions[0].workspaces[0].tabs[0].panes[0].status = "blocked";
  act(() => useWeb.setState({ machines: [blocked] as never }));
  render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
  expect(screen.queryByLabelText("Message")).toBeNull();
  expect(screen.getByText("Esc")).toBeInTheDocument();
  expect(screen.getByText("Ctrl+C")).toBeInTheDocument();
});
```

(For this test, `vi.mock("../api", …)` in that file also mocks `paneRead` with `vi.fn().mockResolvedValue("Do you want to proceed?\n❯ 1. Yes\n  2. No\n")`.)

- [ ] **Step 2: Add the stubs and see the tests fail**

Stubs: `usePrompt` returns `{ prompt: null, answer: async () => {}, busy: false, error: null }`; `PromptCard` and `StopBar` render `<div/>`.

Run: `pnpm --dir web test src/prompt src/chat`
Expected: FAIL on `expect(api.paneRead).toHaveBeenCalledTimes(1)` (got 0), on `getByText("Do you want to proceed?")`, on `getByText("Esc")`, and on `expect(screen.queryByLabelText("Message")).toBeNull()`.

- [ ] **Step 3: Implement** `usePrompt`, `PromptCard`, `StopBar` and the `ChatScreen` bottom bar as in Interfaces.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --dir web test` → PASS. `pnpm --dir web typecheck` → exit 0. `pnpm --dir web build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat(web-ui): prompt card while blocked, Esc and Ctrl+C"
```

---

### Task 12: Live verification

**Files:**
- None created. Uses the built `herdly-web` and `web/dist`.

**Interfaces:**
- Consumes: the `herdly-web` binary (`serve`), `web/dist`.
- Produces: the outputs below, quoted in the final report.

- [ ] **Step 1: Build**

Run (in `src-tauri`): `cargo build --release -p herdly-web` → exit 0. Run: `pnpm --dir web build` → exit 0.

- [ ] **Step 2: Run against the real herdr on a throwaway state dir**

Run in the background: `src-tauri/target/release/herdly-web serve --static web/dist --state "$TMPDIR/herdly-web-live"` (`TMPDIR` = the session scratch directory; default bind `192.0.2.10:7380`).
Expected: it keeps running; no `herdly-web:` error line.

- [ ] **Step 3: Check from the outside**

- `curl -si http://192.0.2.10:7380/ | head -20` → `200`, `cache-control: no-cache`, `content-security-policy: default-src 'self'; connect-src 'self' ws://192.0.2.10:7380; …`, `x-content-type-options: nosniff`.
- `curl -si http://192.0.2.10:7380/api/machines` → `401` with `{"code":"unauthorized","message":"not paired"}`.
- `curl -si -X POST -H 'origin: http://evil.example' -H 'content-type: application/json' -d '{"session":"default","pane_id":"x","text":"x"}' http://192.0.2.10:7380/api/pane/prompt` → `403`.
- `curl -si http://127.0.0.1:7380/` → connection refused (bound only to the WireGuard address).
- `cargo test -p herdly-web --test real_herdr -- --ignored` (in `src-tauri`) → PASS.

- [ ] **Step 4: Stop the process and clean up**

Stop the background `serve`; `command rm -rf "$TMPDIR/herdly-web-live"`.

- [ ] **Step 5: Stop here for the user**

Do not run `systemctl --user enable --now herdly-web`, `loginctl enable-linger`, or `herdly-web pair` against `~/.local/state/herdly-web`: each is an ask-before step in the spec. Report them to the user as the remaining steps, with the phone check: after pairing, the list shows `default`, `bluematrix`, `pegabot`, `tasipay`; a Claude Code Pane's Chat opens; Esc reaches it.
