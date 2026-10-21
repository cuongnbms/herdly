# herdly-core split Implementation Plan

> **For agentic workers:** Execute this plan task by task with the executing-plans skill. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Tauri-free backend of `src-tauri/` into a `herdly-core` crate, which the desktop app depends on unchanged in UI and behaviour and a future web server can reuse.

**Architecture:** `src-tauri/Cargo.toml` becomes a workspace root (`members = ["core"]`) and stays the Tauri app package. Thirteen modules move with `git mv` into `src-tauri/core/src/` in one atomic task (their imports form a cycle `herdr ↔ transport ↔ view`, and `machines`' tests use the `#[cfg(test)]` module `herdr::fake`, so no staged order compiles). The app re-exports them (`pub use herdly_core::{…}`), so every `crate::machines::…` path in app code, including macOS-only code this Linux box cannot compile, stays untouched. Then the Pane-level logic in `commands.rs` (foreground cwd, transcript locating, the `chat_open` orchestration, the Chat page size, Files root resolution) moves onto `MachineManager` in core.

**Tech Stack:** Rust 2021, Cargo workspaces, Tauri 2, tokio, serde; clippy 0.1.95 / cargo 1.95.0 on Linux (webkit2gtk 4.1 present).

**Spec:** `docs/superpowers/specs/2026-10-21-herdly-core-split-design.md`

## Global Constraints

- **Full suite:**
  - `cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast`
  - `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
  - Gate: after every task. Known state at HEAD 6cee374 on this Linux box: tests 564 passed, 1 failed (`quota::credentials::tests::opencode_db_reads_the_active_go_key_after_a_clean_exit`, `assertion failed: !d.path().join("opencode.db-wal").exists()` at `src/quota/credentials.rs:302`: a Linux sqlite3 behaviour that predates this plan and stays out of scope). Clippy fails with 6 errors until Task 1 and must be clean from Task 1 on. "As before" means: the same single test failure, every other test passing, the total count equal to the baseline plus the tests this plan adds.
- The workspace root has `default-members = [".", "core"]`, so plain `cargo test` / `cargo clippy` in `src-tauri` (README "Development", `mise run test:backend`, `mise run lint`) cover both crates. Never rely on `--workspace` instead.
- Nothing changes under `src/` (the frontend), `package.json`, `pnpm-lock.yaml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/`, `src-tauri/icons/` or `.github/`.
- `herdly-core` depends on no Tauri crate and no macOS-only crate. Check: `cargo tree --manifest-path src-tauri/Cargo.toml -p herdly-core --prefix none | grep -E '^(tauri|wry|tao|webkit2gtk|objc2|block2|core-foundation|core-text) '` prints nothing (exit 1).
- App code reaches core modules only through the re-export in `src-tauri/src/lib.rs`. Do not rewrite app imports to `herdly_core::…`: `notify.rs`, `mouse.rs`, `fonts.rs` and `synthetic_keys.rs` hold macOS-only code that does not compile here, and an untouched path cannot break there.
- The app's `[dependencies]` stay as they are, plus `herdly-core`. Trimming dependencies the app no longer uses is out of scope (macOS-only code may use them and cannot be checked here).
- Files move with `git mv`. A moved file's content changes only where a task says so. Widen visibility only where the app crosses the crate boundary: `MachineManager::cancel_reconnect` becomes `pub`; every other `pub(crate)` stays.
- Moved code keeps its error codes and messages word for word.
- Log lines' target changes from `herdly_lib::<module>` to `herdly_core::<module>`. Accepted: the only filter is `EnvFilter::new("info")` (`src-tauri/src/lib.rs` `init_logging`), which names no crate.
- Formatting: `rustfmt --edition 2021 <file>` only on `machines.rs`, `commands.rs`, `mouse.rs`, `synthetic_keys.rs`, `html.rs` and the integration tests (rustfmt-clean today). Never run it on any `lib.rs` or `mod.rs`, `notify.rs` or anything under `transcript/` (not rustfmt-clean, and rustfmt follows `mod` declarations into every child); hand-format edits there to match the lines around them. Never bare `cargo fmt`. Run `git status` before `git add`.
- Shell snippets are bash (`bash -c '…'` if your shell is zsh). `rm` is aliased to `rm -I` here: use `command rm -f`.

## Review Focus

- The frontend allowlist test, once moved, still reads the TypeScript sources: in core, `CARGO_MANIFEST_DIR/../src` is `src-tauri/src`, holds no `.ts`, and the test would pass with nothing checked. Pinned by the non-empty assertion in Task 2.
- `cargo test` in `src-tauri` silently running only the app's tests after the workspace exists → `default-members`; Task 3 checks the summed count equals the baseline.
- Reopening the Chat of a Pane whose tail still runs returns `cached: true` without asking herdr again (`agent.get` count unchanged); Task 5.
- Reopening a transcript whose tail was frozen by opening another file reuses the kept location, `cached: true`, no `agent.get`; Task 5.
- A just-started Claude: locating waits for herdr to report the session instead of picking another pane's transcript; a chosen path survives a failed `agent.get`; Task 4.

---

### Task 1: Clippy clean on Linux, and the baseline recorded

Clippy 0.1.95 on Linux fails at HEAD with 6 errors that predate the split: 5 `dead_code` errors on items only the macOS code uses, 1 `type_complexity`. Fixing them first means every later gate is green, so a new lint is the task's own.

**Files:**
- Modify: `src-tauri/src/mouse.rs:9` (`fn direction`)
- Modify: `src-tauri/src/notify.rs:15` (`fn activate`)
- Modify: `src-tauri/src/synthetic_keys.rs:40,43,45` (`static BYPASS`, `struct Bypassing`, `impl Bypassing`)
- Modify: `src-tauri/src/transcript/mod.rs:243,452` (`ChatManager`, `close_machine`)
- Create (untracked, `tmp/` is gitignored): `tmp/core-split-baseline.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `tmp/core-split-baseline.md`, read by Task 6.

- [ ] **Step 1: See clippy fail**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: exit 101, `could not compile \`herdly\` (lib) due to 6 previous errors`, at `src/mouse.rs:9`, `src/notify.rs:15`, `src/synthetic_keys.rs:40`, `:43`, `:46`, `src/transcript/mod.rs:452`.

- [ ] **Step 2: Allow the macOS-only items' dead code off macOS**

Put `#[cfg_attr(not(target_os = "macos"), allow(dead_code))]` on the line above each of: `fn direction` (`mouse.rs`), `fn activate` (`notify.rs`), `static BYPASS`, `struct Bypassing` and `impl Bypassing` (`synthetic_keys.rs`), below their doc comments. No other change: on macOS they stay linted as before.

- [ ] **Step 3: Name `close_machine`'s tuple type**

In `src-tauri/src/transcript/mod.rs`, directly above the `/// One live transcript tail per open Pane…` doc comment of `ChatManager`, add:

```rust
/// A Machine's tails, taken out under the lock and ended after it: open, parked, frozen.
type MachineTails = (Vec<Entry>, VecDeque<(PaneRef, Entry)>, VecDeque<(PaneRef, Frozen)>);
```

and in `close_machine` change the binding's annotation to `let (open, parked, frozen): MachineTails = {`. Hand-format (no rustfmt on this file).

- [ ] **Step 4: Run clippy and the tests**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
Expected: exit 0, `Finished`, no `warning:` lines.

Run: `cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast`
Expected: lib `564 passed; 1 failed` (the quota test named in Global Constraints); `attach_herdr` and `ssh_localhost` `0 passed; … ignored`.

- [ ] **Step 5: Record the baseline**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --test-threads=1` (needs the local herdr at `~/.local/bin/herdr`, 0.9.5; `ssh_localhost` does its work only when `HERDLY_SSH_TEST` is set, so note whether it was).

Write `tmp/core-split-baseline.md` (create `tmp/` if absent) with: the HEAD sha; each `test result:` line of the Step 4 test run with its `Running …` line; the clippy result; each `test result:` line of the `--ignored` run; whether `HERDLY_SSH_TEST` was set.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/mouse.rs src-tauri/src/notify.rs src-tauri/src/synthetic_keys.rs src-tauri/src/transcript/mod.rs
git commit -m "chore(clippy): clean on Linux with clippy 0.1.95"
```

### Task 2: Keep the app-only pieces out of the modules that move

Everything still lives in one crate; this task makes the next one pure renames.

**Files:**
- Move: `src-tauri/src/files/html.rs` → `src-tauri/src/html.rs`
- Modify: `src-tauri/src/files/mod.rs:9` (drop `pub mod html;`)
- Modify: `src-tauri/src/lib.rs:1-19` (module list), `:39`, `:149`, tests module at `:225`
- Modify: `src-tauri/src/commands.rs:2-25` (import of `HtmlPages`)
- Modify: `src-tauri/src/machines.rs:686` (`cancel_reconnect`), `:1532-1571` (test leaves)

**Interfaces:**
- Consumes: nothing.
- Produces: app module `crate::html` with `HtmlPages` (unchanged API); `pub fn MachineManager::cancel_reconnect(&self, id: &str)`; test `tests::frontend_methods_are_allowed` in `src-tauri/src/lib.rs`.

- [ ] **Step 1: Move `html.rs` to the app's top level**

```bash
git mv src-tauri/src/files/html.rs src-tauri/src/html.rs
```

Remove `pub mod html;` from `src-tauri/src/files/mod.rs`. Add `pub mod html;` to `src-tauri/src/lib.rs`'s module list in alphabetical place (after `pub mod herdr;`). Change `files::html::HtmlPages` to `html::HtmlPages` at `lib.rs:39` and `lib.rs:149`. In `commands.rs`, remove `html::HtmlPages,` from the `files::{…}` group and add `html::HtmlPages,` as its own entry of the `use crate::{…}` list, after the `herdr::rpc,` line. `html.rs`'s content does not change (it imports only `std` and `tauri::http`).

- [ ] **Step 2: Move the frontend allowlist test into the app, and make it fail when it reads nothing**

Cut `frontend_methods_are_allowed` (its doc comment, `#[test]` and body, `machines.rs:1532-1571`) and paste it into `mod tests` of `src-tauri/src/lib.rs`, below `the_quit_item_names_the_app`. Add to that tests module:

```rust
    use crate::machines::ALLOWED_METHODS;
    use std::path::{Path, PathBuf};
```

In the test, directly after the `walk(…)` call, add:

```rust
        assert!(!files.is_empty(), "no frontend sources under ../src");
```

`CARGO_MANIFEST_DIR` is now always `src-tauri`, so `../src` stays the frontend.

- [ ] **Step 3: Make `cancel_reconnect` public**

`machines.rs:686`: `pub(crate) fn cancel_reconnect` → `pub fn cancel_reconnect`. It is the one crate-private item the app calls (`commands.rs:226`).

- [ ] **Step 4: Run the moved test, then see it catch a missing method**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib frontend_methods_are_allowed`
Expected: PASS, `1 passed`.

Temporarily delete the `"pane.split",` line from `ALLOWED_METHODS` (`machines.rs`); `src/agents/AgentList.tsx` uses it.
Run the same command. Expected: FAIL, `not in ALLOWED_METHODS: ["pane.split (…src/agents/AgentList.tsx)"…`.
Restore the line (`git diff src-tauri/src/machines.rs` shows only the test removal and the `pub`).

- [ ] **Step 5: Format, run the Full suite**

Run: `rustfmt --edition 2021 src-tauri/src/machines.rs src-tauri/src/commands.rs src-tauri/src/html.rs`, then `git status`: only the files of this task changed.
Full suite: the Global Constraints baseline (same 565 tests, same single failure; the html tests now run as `html::tests::…`), clippy clean.

- [ ] **Step 6: Commit**

```bash
git add -A src-tauri/src
git commit -m "refactor: keep the webview scheme and the frontend allowlist test in the app"
```

### Task 3: Move the backend into the `herdly-core` crate

**Files:**
- Create: `src-tauri/core/Cargo.toml`, `src-tauri/core/src/lib.rs`
- Modify: `src-tauri/Cargo.toml` (workspace, dependency), `src-tauri/Cargo.lock` (cargo updates it)
- Move (`git mv`, from `src-tauri/src/` to `src-tauri/core/src/`): `attach.rs`, `complete/`, `error.rs`, `files/`, `git/`, `herdr/`, `machines.rs`, `pi.rs`, `quota/`, `sshconfig.rs`, `transcript/`, `transport/`, `view.rs`
- Move: `src-tauri/tests/fixtures/` → `src-tauri/core/tests/fixtures/`; `src-tauri/tests/attach_herdr.rs`, `src-tauri/tests/ssh_localhost.rs` → `src-tauri/core/tests/`
- Modify: `src-tauri/src/lib.rs:1-19` (module list)
- Modify: `README.md` ("Development" section)

**Interfaces:**
- Consumes: Task 2's state (no `files::html`, allowlist test in the app, `cancel_reconnect` public).
- Produces: crate `herdly_core` (package `herdly-core`, path `src-tauri/core`) with `pub mod` `attach`, `complete`, `error`, `files`, `git`, `herdr`, `machines`, `pi`, `quota`, `sshconfig`, `transcript`, `transport`, `view`, their APIs unchanged; the app re-exports them, so `herdly_lib::machines` etc. still resolve.

- [ ] **Step 1: Write `src-tauri/core/Cargo.toml`**

```toml
[package]
name = "herdly-core"
version = "0.1.0"
description = "Herdly's backend without Tauri: herdr RPC, transcripts, attach, git, files"
authors = ["Cuong Nguyen"]
edition = "2021"
publish = false

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
base64 = "0.22"
tokio = { version = "1", features = ["full"] }
notify = "8"
async-trait = "0.1"
thiserror = "2"
portable-pty = "0.9"
tracing = "0.1"
libc = "0.2"
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
chrono = { version = "0.4", default-features = false, features = ["std", "clock"] }
tar = "0.4"
tempfile = "3"
uuid = { version = "1", features = ["v4"] }
```

Version requirements are copied from the app's `Cargo.toml` so the lockfile resolves the same versions. `tempfile` is a normal dependency (`files/transfer.rs` uses it outside tests).

- [ ] **Step 2: Make `src-tauri/Cargo.toml` the workspace root**

Between the `[package]` table and `[lib]`, add:

```toml
[workspace]
members = ["core"]
default-members = [".", "core"]
```

As the first line of `[dependencies]`: `herdly-core = { path = "core" }`. `[profile.release]` stays where it is (the workspace root, so it applies to the whole build).

- [ ] **Step 3: Move the modules, fixtures and integration tests**

```bash
cd src-tauri
mkdir -p core/src core/tests
for m in attach.rs complete error.rs files git herdr machines.rs pi.rs quota sshconfig.rs transcript transport view.rs; do git mv "src/$m" "core/src/$m"; done
git mv tests/fixtures core/tests/fixtures
git mv tests/attach_herdr.rs tests/ssh_localhost.rs core/tests/
```

The `include_str!("../tests/fixtures/…")` (in `machines.rs`) and `include_str!("../../tests/fixtures/…")` (in `herdr/*`, `transcript/*`) paths stay valid as they are: each file moved one level down together with the fixtures.

- [ ] **Step 4: Write `src-tauri/core/src/lib.rs`**

```rust
//! Herdly's backend without Tauri: Machines and their herdr Sessions, transcripts (Chat),
//! terminal attach, git and files over a Machine's transport. The desktop app and any other
//! front end drive it through `machines::MachineManager`.
pub mod attach;
pub mod complete;
pub mod error;
pub mod files;
pub mod git;
pub mod herdr;
pub mod machines;
pub mod pi;
pub mod quota;
pub mod sshconfig;
pub mod transcript;
pub mod transport;
pub mod view;
```

- [ ] **Step 5: Re-export core from the app**

In `src-tauri/src/lib.rs`, the module list becomes exactly:

```rust
pub mod commands;
pub mod fonts;
pub mod html;
pub mod layout;
pub mod mouse;
pub mod notify;
pub mod synthetic_keys;

// The Tauri-free backend lives in `herdly-core`; re-exported so `crate::machines::…` and the
// other app paths keep resolving.
pub use herdly_core::{
    attach, complete, error, files, git, herdr, machines, pi, quota, sshconfig, transcript,
    transport, view,
};
```

Nothing else in the app changes (`use attach::AttachManager;` and `use machines::{…}` in `lib.rs` resolve through the re-export).

- [ ] **Step 6: Point the integration tests at core**

In `src-tauri/core/tests/attach_herdr.rs` and `ssh_localhost.rs`: `herdly_lib::` → `herdly_core::` in every `use`. In their first doc lines, the run commands become `cargo test -p herdly-core --test attach_herdr -- --ignored --test-threads=1` and `HERDLY_SSH_TEST=1 cargo test -p herdly-core --test ssh_localhost -- --ignored --test-threads=1`.

- [ ] **Step 7: Mention the crate in the README**

In `README.md` "Development", directly after the closing fence of the command block, add the paragraph:

    The backend without Tauri is the `herdly-core` crate in `src-tauri/core/` (herdr RPC,
    transcripts, attach, git, files); the app in `src-tauri/src/` is the Tauri layer over it.
    `cargo test` and `cargo clippy` in `src-tauri` cover both crates.

- [ ] **Step 8: Build core alone, without Tauri**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-core --no-fail-fast`
Expected: no `Compiling tauri` line; lib `N passed; 1 failed` (the quota test) where N = 564 − the app's passing unit tests; `attach_herdr` and `ssh_localhost` `0 passed; … ignored`.

Run: the `cargo tree … -p herdly-core …` check from Global Constraints. Expected: no output, exit 1.

- [ ] **Step 9: Full suite, and the counts add up**

Full suite. Expected: two unit-test runs (`herdly_lib`, `herdly_core`) whose passed counts sum to 564, with the one quota failure in `herdly_core`; `frontend_methods_are_allowed` passes in `herdly_lib`; clippy clean.

- [ ] **Step 10: Check the move is renames**

```bash
git add -A src-tauri README.md
git diff --cached -M --stat
git diff --cached -M --diff-filter=R -- src-tauri/core
git diff --cached -M --diff-filter=AMD --name-status -- src-tauri/core
```

Expected: in `--stat`, every moved file shows as `src/… => core/src/…` (and `tests/… => core/tests/…`), and the new files are `core/Cargo.toml` and `core/src/lib.rs`. The second command prints hunks only for the two integration tests (`herdly_lib` → `herdly_core`, the run commands); no module under `core/src` shows a hunk (Task 2 already made `cancel_reconnect` public). The third prints exactly `A src-tauri/core/Cargo.toml` and `A src-tauri/core/src/lib.rs`. `git status` shows nothing under `src/` (the frontend).

- [ ] **Step 11: Commit**

```bash
git commit -m "refactor: move the Tauri-free backend into the herdly-core crate"
```

### Task 4: Pane lookups move from `commands.rs` onto `MachineManager`

**Files:**
- Modify: `src-tauri/core/src/machines.rs` (imports at `:2-23`, a `SESSION_WAIT` const after `HEALTH_EVERY` at `:59`, three methods, tests)
- Modify: `src-tauri/src/commands.rs` (`find_pane`, `SESSION_WAIT`, `foreground_cwd`, `locate_pane` at HEAD `:357-440`; `files_root` at HEAD `:797-800`; their callers)

**Interfaces:**
- Consumes: `herdly_core::machines::MachineManager` (`pane_view`, `transport`, `session`, `info`, `call`), `herdly_core::transcript::locate::{awaiting_session, locate_in, Located}`, `herdly_core::files::paths::resolve_root`, `herdly_core::herdr::rpc::snapshot`.
- Produces, on `impl MachineManager` in `src-tauri/core/src/machines.rs`:
  - `pub async fn foreground_cwd(&self, pane: &PaneRef) -> Option<String>`
  - `pub fn files_root(&self, id: &str, root: &str) -> AppResult<String>`
  - `pub async fn locate_pane(&self, pane: &PaneRef, path: Option<String>) -> AppResult<Located>`
  - test helpers in `machines.rs`'s `mod tests`: `struct TailT(FakeT)`, `type AgentGet`, `fn pane_ref(id: &str) -> PaneRef`, `fn fixture_snap() -> Value`, `struct PaneMgr { mgr: Arc<MachineManager>, .. }` with `fn asked(&self) -> u32` (the `agent.get` calls for Pane w1:p1); keep the `PaneMgr` alive for the whole test (its fake herdr and temp dir go with it), `async fn pane_mgr(snap: Value, agent_get: AgentGet) -> PaneMgr`

- [ ] **Step 1: Write the failing tests**

At the end of `mod tests` in `src-tauri/core/src/machines.rs`:

```rust
    /// Runs the transcript tail script on this machine: a tail's one transport call is its
    /// `herdr-tail` script (transcript/tail.rs `read`). The probe and session list stay
    /// scripted by `FakeT`.
    struct TailT(FakeT);
    #[async_trait::async_trait]
    impl Transport for TailT {
        fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
            if argv.join(" ").contains("herdr-tail") {
                argv.to_vec()
            } else {
                self.0.wrap(argv, tty)
            }
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            self.0.local_socket(s).await
        }
        async fn release_socket(&self, s: &SessionEntry) -> AppResult<()> {
            self.0.release_socket(s).await
        }
    }

    type AgentGet = Arc<dyn Fn() -> Result<Value, (String, String)> + Send + Sync>;

    fn pane_ref(id: &str) -> PaneRef {
        PaneRef {
            machine_id: "local".into(),
            session: "default".into(),
            pane_id: id.into(),
        }
    }

    fn fixture_snap() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap()
    }

    struct PaneMgr {
        mgr: Arc<MachineManager>,
        asked: Arc<std::sync::atomic::AtomicU32>,
        _herdr: FakeHerdr,
        _dir: tempfile::TempDir,
    }
    impl PaneMgr {
        /// `agent.get` calls for Pane w1:p1; the pi probe asks about other panes.
        fn asked(&self) -> u32 {
            self.asked.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    /// The `local` Machine connected to a herdr serving `snap` and answering `agent.get` for
    /// Pane w1:p1 with `agent_get`, once that Pane is in its view.
    async fn pane_mgr(snap: Value, agent_get: AgentGet) -> PaneMgr {
        let asked: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        let count = asked.clone();
        let herdr = FakeHerdr::start(Arc::new(move |m, p| match m {
            "session.snapshot" => Ok(json!({"type":"session_snapshot","snapshot": snap.clone()})),
            "agent.get" if p["target"] == "w1:p1" => {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                agent_get()
            }
            "agent.get" => Ok(json!({"agent": null})),
            _ => Ok(json!({"type":"ok"})),
        }));
        let dir = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(dir.path().join("m.json"), Arc::new(|_| {}));
        let sock = herdr.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(TailT(FakeT { sock: sock.clone() })) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        assert!(wait_for(|| mgr.pane_view(&pane_ref("w1:p1")).is_ok()).await);
        PaneMgr {
            mgr,
            asked,
            _herdr: herdr,
            _dir: dir,
        }
    }

    #[tokio::test]
    async fn foreground_cwd_reads_the_panes_live_snapshot() {
        let mut snap = fixture_snap();
        snap["panes"][0]["foreground_cwd"] = json!("/work/sub");
        let p = pane_mgr(snap, Arc::new(|| Ok(json!({})))).await;
        let mgr = &p.mgr;
        assert_eq!(
            mgr.foreground_cwd(&pane_ref("w1:p1")).await.as_deref(),
            Some("/work/sub")
        );
        assert_eq!(mgr.foreground_cwd(&pane_ref("w1:p2")).await, None);
        let ghost = PaneRef {
            machine_id: "ghost".into(),
            ..pane_ref("w1:p1")
        };
        assert_eq!(mgr.foreground_cwd(&ghost).await, None);
    }

    #[tokio::test]
    async fn files_root_resolves_against_the_machines_home() {
        let p = pane_mgr(fixture_snap(), Arc::new(|| Ok(json!({})))).await;
        let mgr = &p.mgr;
        assert_eq!(mgr.files_root("local", "~/proj/").unwrap(), "/h/proj");
        assert_eq!(mgr.files_root("local", "/srv").unwrap(), "/srv");
        assert_eq!(mgr.files_root("local", "rel").unwrap_err().code, "invalid");
        assert_eq!(mgr.files_root("ghost", "~").unwrap_err().code, "not_found");
    }

    #[tokio::test]
    async fn locate_pane_keeps_a_chosen_path() {
        let p = pane_mgr(fixture_snap(), Arc::new(|| Ok(json!({"agent": {"agent": "pi"}})))).await;
        let mgr = &p.mgr;
        let l = mgr
            .locate_pane(&pane_ref("w1:p1"), Some("/t/a.jsonl".into()))
            .await
            .unwrap();
        assert_eq!(
            l,
            Located {
                agent: "pi".into(),
                path: "/t/a.jsonl".into(),
                ambiguous: false,
                candidates: vec![],
                pending: false,
                cached: false,
            }
        );
    }

    #[tokio::test]
    async fn a_chosen_path_survives_a_failed_agent_get() {
        let p = pane_mgr(
            fixture_snap(),
            Arc::new(|| Err(("not_found".into(), "no agent".into()))),
        )
        .await;
        let mgr = &p.mgr;
        let l = mgr
            .locate_pane(&pane_ref("w1:p1"), Some("/t/a.jsonl".into()))
            .await
            .unwrap();
        assert_eq!(l.agent, "claude", "the pane's own agent: the fixture's w1:p1 runs claude");
        assert_eq!(l.path, "/t/a.jsonl");
        assert!(mgr.locate_pane(&pane_ref("w1:p1"), None).await.is_err());
    }

    #[tokio::test]
    async fn locate_pane_waits_for_a_just_started_claudes_session() {
        let seen: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        let p = pane_mgr(
            fixture_snap(),
            Arc::new(move || {
                Ok(if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    json!({"agent": {"agent": "claude", "agent_session": null}})
                } else {
                    json!({"agent": {"agent": "claude",
                        "agent_session": {"kind": "path", "value": "/t/s1.jsonl"}}})
                })
            }),
        )
        .await;
        let l = p.mgr.locate_pane(&pane_ref("w1:p1"), None).await.unwrap();
        assert_eq!(l.path, "/t/s1.jsonl", "the session herdr reported, not a guess");
        assert!(!l.ambiguous);
        assert_eq!(p.asked(), 2);
    }
```

- [ ] **Step 2: Add the stubs and see the tests fail**

In `impl MachineManager`, after `session` (the `// ---- queries` section), add:

```rust
    pub async fn foreground_cwd(&self, pane: &PaneRef) -> Option<String> {
        None
    }

    pub fn files_root(&self, id: &str, root: &str) -> AppResult<String> {
        Err(AppError::new("io", "stub"))
    }

    pub async fn locate_pane(&self, pane: &PaneRef, path: Option<String>) -> AppResult<Located> {
        Err(AppError::new("io", "stub"))
    }
```

with `Located` imported: `transcript::ChatManager` in the `use crate::{…}` list becomes `transcript::{self, ChatManager, Located}`, and add `files::paths::resolve_root`.

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-core --lib -- machines::tests::foreground_cwd machines::tests::files_root machines::tests::locate_pane machines::tests::a_chosen_path`
Expected: 5 FAIL: `foreground_cwd_reads_the_panes_live_snapshot` on its first `assert_eq!` (left `None`); `files_root_…` on `unwrap()` of `Err(AppError { code: "io", message: "stub" })`; the three `locate_pane`/`chosen_path` tests on `unwrap()` of the same error.

- [ ] **Step 3: Move the bodies from `commands.rs`**

- `foreground_cwd`: the body of `commands.rs` `foreground_cwd` (HEAD `:365-379`) with `mgr` → `self`, and its doc comment.
- `files_root`: `resolve_root(&self.info(id)?.home, root)`, doc comment `/// Resolves a Files root on Machine \`id\` against its home; every \`files_*\` command goes through it.`
- `locate_pane`: the body of `commands.rs` `locate_pane` (HEAD `:382-439`) with `mgr` → `self`, `find_pane(mgr, pane_ref)?` → `self.pane_view(pane)?`, `foreground_cwd(mgr, pane_ref)` → `self.foreground_cwd(pane)`, its doc comment and the comment on the wait loop kept.
- `SESSION_WAIT`: `const SESSION_WAIT: Duration = Duration::from_secs(3);` with its doc comment, after `HEALTH_EVERY` in `machines.rs`; the 250 ms poll stays `Duration::from_millis(250)` inline.

- [ ] **Step 4: Run them and see them pass**

Run: the Step 2 command.
Expected: 5 passed.

- [ ] **Step 5: Call them from `commands.rs`**

Delete `find_pane`, `SESSION_WAIT`, `foreground_cwd`, `locate_pane` and `files_root` from `commands.rs` (`CHAT_PAGE` stays; Task 5 moves it). Then:
- `find_pane(&mgr, &pane_ref)?` → `mgr.pane_view(&pane_ref)?` (in `complete_commands`, `complete_files`, `complete_entries`, `chat_git_status`);
- `foreground_cwd(&mgr, &pane_ref).await` → `mgr.foreground_cwd(&pane_ref).await` (same four commands);
- `locate_pane(&mgr, &pane_ref, None).await` → `mgr.locate_pane(&pane_ref, None).await` (`chat_locate`), and `locate_pane(&mgr, &pane_ref, path).await?` → `mgr.locate_pane(&pane_ref, path).await?` (`chat_open`);
- every `files_root(&mgr, &machine_id, &X)?` → `mgr.files_root(&machine_id, &X)?` (15 sites: `git_*` and `files_*`).

Remove the imports the compiler then reports unused (expect `paths::{check_rel, resolve_root}` → `paths::check_rel`). No command's signature, argument names or return type changes.

- [ ] **Step 6: Format, Full suite**

Run: `rustfmt --edition 2021 src-tauri/core/src/machines.rs src-tauri/src/commands.rs`, then `git status`: only those two files changed.
Full suite: baseline + 5 tests passing, the one quota failure, clippy clean. `grep -n 'fn find_pane\|fn foreground_cwd\|fn locate_pane\|fn files_root\|SESSION_WAIT' src-tauri/src/commands.rs` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/core/src/machines.rs src-tauri/src/commands.rs
git commit -m "refactor(core): Pane lookups and Files roots move onto MachineManager"
```

### Task 5: Opening a Chat moves into core

**Files:**
- Modify: `src-tauri/core/src/machines.rs` (one method, tests)
- Modify: `src-tauri/core/src/transcript/mod.rs` (a `CHAT_PAGE` const, above `ChatManager`)
- Modify: `src-tauri/src/commands.rs` (`CHAT_PAGE` at HEAD `:355`, `chat_open` at HEAD `:631-673`, `chat_page`)

**Interfaces:**
- Consumes: `MachineManager::locate_pane(&self, pane: &PaneRef, path: Option<String>) -> AppResult<Located>` and the test helpers in `machines.rs`'s `mod tests`: `type AgentGet = Arc<dyn Fn() -> Result<Value, (String, String)> + Send + Sync>`, `fn pane_ref(id: &str) -> PaneRef` (machine `local`, session `default`), `fn fixture_snap() -> Value`, `async fn pane_mgr(snap: Value, agent_get: AgentGet) -> PaneMgr` (a connected `local` Machine whose transport runs the tail script locally; `PaneMgr.mgr: Arc<MachineManager>`, `PaneMgr::asked(&self) -> u32` counts `agent.get` calls for w1:p1); `ChatManager::{reattach_cached, frozen_located, open_tail, set_located, page}`, `transcript::{parser_for, Sink}`.
- Produces:
  - `pub async fn MachineManager::open_chat(&self, chats: &ChatManager, pane: &PaneRef, path: Option<String>, sink: transcript::Sink) -> AppResult<Located>`
  - `pub const herdly_core::transcript::CHAT_PAGE: usize = 200`

- [ ] **Step 1: Write the failing tests**

At the end of `mod tests` in `src-tauri/core/src/machines.rs`:

```rust
    fn claude_at(path: &str) -> AgentGet {
        let path = path.to_string();
        Arc::new(move || {
            Ok(json!({"agent": {"agent": "claude",
                "agent_session": {"kind": "path", "value": path}}}))
        })
    }

    async fn open_at(mgr: &MachineManager, chats: &ChatManager, path: &str) -> Located {
        mgr.open_chat(chats, &pane_ref("w1:p1"), Some(path.into()), Arc::new(|_| {}))
            .await
            .unwrap()
    }

    fn opened(path: &str, cached: bool) -> Located {
        Located {
            agent: "claude".into(),
            path: path.into(),
            ambiguous: false,
            candidates: vec![],
            pending: false,
            cached,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn open_chat_reuses_a_running_tail_then_a_frozen_location() {
        let t = tempfile::tempdir().unwrap();
        let a: String = t.path().join("a.jsonl").to_string_lossy().into();
        let b: String = t.path().join("b.jsonl").to_string_lossy().into();
        std::fs::write(&a, "").unwrap();
        std::fs::write(&b, "").unwrap();
        let p = pane_mgr(fixture_snap(), claude_at(&a)).await;
        let (mgr, chats) = (&p.mgr, ChatManager::default());

        assert_eq!(open_at(mgr, &chats, &a).await, opened(&a, false), "a fresh tail");
        assert_eq!(p.asked(), 1);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            open_at(mgr, &chats, &a).await,
            opened(&a, true),
            "the running tail"
        );
        assert_eq!(p.asked(), 1, "not located again");

        assert_eq!(
            open_at(mgr, &chats, &b).await,
            opened(&b, false),
            "another file freezes the first"
        );
        assert_eq!(p.asked(), 2);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            open_at(mgr, &chats, &a).await,
            opened(&a, true),
            "the frozen tail, resumed"
        );
        assert_eq!(p.asked(), 2, "its kept location, not located again");
    }

    #[tokio::test]
    async fn open_chat_refuses_an_agent_without_a_parser() {
        let p = pane_mgr(fixture_snap(), Arc::new(|| Ok(json!({"agent": {"agent": "zsh"}})))).await;
        let mgr = &p.mgr;
        let chats = ChatManager::default();
        let e = mgr
            .open_chat(&chats, &pane_ref("w1:p1"), Some("/t/a.jsonl".into()), Arc::new(|_| {}))
            .await
            .unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("not_found", "no transcript parser for agent 'zsh'")
        );
        assert!(chats.page(&pane_ref("w1:p1"), 0, 1).is_none(), "nothing opened");
    }
```

- [ ] **Step 2: Add the stub and see the tests fail**

In `impl MachineManager`, after `locate_pane`:

```rust
    pub async fn open_chat(
        &self,
        chats: &ChatManager,
        pane: &PaneRef,
        path: Option<String>,
        sink: transcript::Sink,
    ) -> AppResult<Located> {
        Err(AppError::new("io", "stub"))
    }
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p herdly-core --lib machines::tests::open_chat`
Expected: 2 FAIL: `open_chat_reuses_…` on `unwrap()` of `Err(AppError { code: "io", message: "stub" })`; `open_chat_refuses_…` on its `assert_eq!` (left `("io", "stub")`).

- [ ] **Step 3: Move the orchestration from `chat_open`**

Body: `chat_open`'s code after the sink is built (HEAD `commands.rs:651-673`), in the same order: `chats.reattach_cached` → return it with `cached: true`; else `chats.frozen_located` (frozen = true) or `self.locate_pane(pane, path)` (frozen = false); `self.transport(&pane.machine_id)?`; `transcript::parser_for(&located.agent)` or `AppError::new("not_found", format!("no transcript parser for agent '{}'", located.agent))`; `chats.open_tail(…)`; `cached = frozen && kept`; `chats.set_located(pane, &located)`; return `Located { cached, ..located }`. Keep the two comments (`// Locating costs round trips…`, `// A frozen tail whose state never arrived…`). Doc comment: `/// Opens the transcript of the agent in a Pane onto \`sink\`: the Pane's running tail when it qualifies, else a frozen tail's kept location, else located afresh. \`cached\` says no locating happened.`

- [ ] **Step 4: Run them and see them pass**

Run: the Step 2 command.
Expected: 2 passed.

- [ ] **Step 5: The page size moves to core**

In `src-tauri/core/src/transcript/mod.rs`, directly above `MachineTails`' doc comment (Task 1), add:

```rust
/// Chat items per page the Chat lens asks for.
pub const CHAT_PAGE: usize = 200;
```

Hand-format (no rustfmt on this file).

- [ ] **Step 6: `chat_open` and `chat_page` call core**

In `commands.rs`: delete `const CHAT_PAGE`. `chat_page` passes `transcript::CHAT_PAGE`. `chat_open` keeps its signature and builds `pane_ref` (now with `machine_id` moved in, no `.clone()`) and `sink` as before, then ends with `mgr.open_chat(&chats, &pane_ref, path, sink).await`. Remove imports the compiler reports unused.

- [ ] **Step 7: Format, Full suite**

Run: `rustfmt --edition 2021 src-tauri/core/src/machines.rs src-tauri/src/commands.rs`, then `git status`: only `machines.rs`, `commands.rs` and `transcript/mod.rs` changed.
Full suite: baseline + 7 tests passing (5 from Task 4, 2 here), the one quota failure, clippy clean. `grep -n 'reattach_cached\|frozen_located\|open_tail\|set_located\|CHAT_PAGE: ' src-tauri/src/commands.rs` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/core/src/machines.rs src-tauri/core/src/transcript/mod.rs src-tauri/src/commands.rs
git commit -m "refactor(core): opening a Chat moves onto MachineManager"
```

### Task 6: Final verification against the baseline

No code changes unless a check fails; a failing check goes back to the task that owns it.

**Files:**
- Read: `tmp/core-split-baseline.md` (Task 1)

**Interfaces:**
- Consumes: everything above.
- Produces: the comparison, appended to `tmp/core-split-baseline.md` under `## After`.

- [ ] **Step 1: Full suite against the baseline**

Run both Full suite commands. Expected: `herdly_lib` + `herdly_core` passed = 564 + 7 = 571; failed = 1, the quota test; clippy exit 0.

- [ ] **Step 2: The integration tests against real herdr**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --test-threads=1`, with `HERDLY_SSH_TEST` set exactly as in the baseline run.
Expected: the same `test result:` counts as the baseline's `--ignored` lines, now under `core/tests/`. `herdr session list` afterwards shows no `herdly-test-*` session.

- [ ] **Step 3: Core is free of Tauri**

Run: the `cargo tree … -p herdly-core …` check from Global Constraints. Expected: no output, exit 1.

- [ ] **Step 4: The frontend and the release setup are untouched**

Run: `git diff 6cee374 --stat -- src package.json pnpm-lock.yaml src-tauri/tauri.conf.json src-tauri/capabilities src-tauri/icons .github`
Expected: no output.

Run: `pnpm test` and `pnpm typecheck`. Expected: both exit 0.

- [ ] **Step 5: `tauri build` works with the workspace**

Run: `pnpm tauri build --no-bundle`
Expected: exit 0, with `src-tauri/target/release/herdly` built under the root `[profile.release]` (LTO). `.github/workflows/release.yml` needs no change: `rust-cache` `workspaces: src-tauri` is still the workspace root.

- [ ] **Step 6: Write the comparison**

Append `## After` to `tmp/core-split-baseline.md`: each command of Steps 1–5 with its result next to the baseline line. In the final report, list what this Linux box could not check, for the user to check on macOS with `mise run dev`: a Chat opens on a Claude Pane and on a pi Pane; reopening it is instant (cached); the Files panel and Git view list a folder; slash and `@` completion work in the Chat input; a notification click selects its Pane; the mouse Back/Forward buttons move through history.
