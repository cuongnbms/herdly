# herdly-core split

Date: 2026-10-21
Status: approved design (from the 2026-10-21 feasibility survey)

## Purpose

The user wants to manage herdr on a devbox from a phone. The plan is a separate web server on
the devbox that drives only that machine's local herdr, plus a separate mobile web UI. Both are
out of scope here. This step moves the Tauri-free backend logic (herdr RPC, transcript/Chat,
attach, git, files) into a `herdly-core` crate that the Tauri app and the future web server can
both depend on.

The desktop app's UI and behaviour do not change. The user: "I don't want to change this app
because I want it optimized for desktop."

## Decisions

- **Separate web app; the desktop UI stays as it is.** Phone use differs (watch agent status,
  answer in Chat, approve prompts, read diffs). Rejected: making the desktop UI responsive.
- **Reuse the Rust core; no second server written from scratch.** The hard part is ~25k lines
  of backend, including transcript parsing for Claude and pi, which breaks whenever an agent
  changes its format; two copies would be maintained twice. Rejected: an independent server;
  SSH plus the herdr TUI on the phone (works today, but painful on a phone, and no Chat lens).
- **Layout.** `src-tauri/Cargo.toml` becomes the `[workspace]` root with `members = ["core"]`
  and stays the Tauri app package. Core lives in `src-tauri/core/`. `[profile.release]` (LTO)
  stays at the root, so `tauri build` and `.github/workflows/release.yml` keep working.
- **Module placement.**
  - Core: `attach`, `complete`, `error`, `files` (except `html.rs`), `git`, `herdr`,
    `machines`, `pi`, `quota`, `sshconfig`, `transcript`, `transport`, `view`.
  - App: `commands`, `lib`, `main`, `mouse`, `notify`, `fonts`, `synthetic_keys`, `layout`
    (sidebar layout), `files/html.rs` (the webview's `herdly-html` URI scheme).
  - The macOS-only dependencies (`core-foundation`, `core-text`, `objc2*`, `block2`) stay in
    the app.
- **Non-Tauri logic leaves `commands.rs` for core,** so the web server need not duplicate it:
  the Pane's foreground cwd, locating a Pane's transcript (with the wait for a just-started
  Claude's session), the `chat_open` orchestration (reattach a cached tail, else reuse a frozen
  location, else locate; then open the tail and record the location), the Chat page size, and
  resolving a Files root on a Machine. What stays in `commands.rs` is argument parsing, the
  core call, and `Channel`/`ChannelSink`.
- **Performance.** A crate split costs nothing at runtime: one binary, LTO, no extra IPC. The
  web server will be a separate process on the devbox.

## Done when

- The desktop app builds and behaves exactly as before.
- `cargo test`, `cargo clippy -- -D warnings` and the `--ignored` integration tests pass as
  they did before the split.
- `herdly-core` builds and passes its tests on Linux without Tauri.

## Out of scope

- The web server and the mobile UI. Where the web server lives (a member of this workspace, or
  its own repository with a git dependency on `herdly-core`) is still open.
- Notes for that design: `ChatManager` keeps one sink per Pane, so the web server must fan
  events out to several clients; `AttachManager` allows one attach per terminal; the
  notify-on-blocked/done rule lives in the frontend (`src/notify.ts`).
