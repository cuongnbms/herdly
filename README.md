# Herdly

A macOS desktop client for the [herdr](https://herdr.dev) terminal multiplexer. It shows the local machine and any number of SSH machines in one sidebar (machines, sessions, workspaces, tabs, panes with agent status), and opens a pane as a real terminal or as a Chat lens for coding agents, and browses the selected workspace's files in a Files panel under the agent list, opening them as tabs next to the open agents. Built with Tauri v2, React 19 and zustand 5.

![Chat lens answering an agent's question](docs/screenshots/chat.png)

| Agent Dashboard | Terminal lens |
|---|---|
| ![Agent Dashboard](docs/screenshots/dashboard.png) | ![Terminal lens](docs/screenshots/terminal.png) |

| Files: rendered markdown | Files: Go to file and find |
|---|---|
| ![The File viewer showing rendered markdown with an outline](docs/screenshots/files-markdown.png) | ![The Files panel with Go to file, and find in a source file](docs/screenshots/files-code.png) |

## Files

Press **Edit** (⌘⇧E) on a text file to change it. ⌘S saves, Esc or **Done** leaves. If an Agent changed the file since you opened it, Save stops and offers **Reload** or **Overwrite**.

## Install

1. Install [herdr](https://herdr.dev) (see Requirements below).
2. Download `Herdly_<version>_universal.dmg` from the [latest release](https://github.com/cuongnbms/herdly/releases/latest). It runs on both Apple Silicon and Intel Macs.
3. Open the `.dmg` and drag Herdly into Applications.
4. The app is not notarized by Apple, so macOS blocks the first launch. Clear the quarantine flag once:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Herdly.app
   ```

   Or try to open Herdly, then go to System Settings → Privacy & Security and click **Open Anyway**.

To update, download the new `.dmg`, replace the app in Applications and run the `xattr` command again.

## Requirements

- macOS.
- [herdr](https://herdr.dev) 0.9.x or newer, speaking protocol 22 (any other protocol is reported as `incompatible`).
- OpenSSH (`ssh` on the PATH) for remote machines.
- Remote machines run Linux or macOS with a POSIX-compatible login shell (bash, zsh or sh), and their `sshd` must allow Unix socket forwarding: `AllowStreamLocalForwarding yes` in `sshd_config`.

Passphrase and host-key prompts are handled by the interactive Connect dialog, so keys that need a passphrase and first-time hosts work without preparing the SSH agent.

## Development

```sh
pnpm install
pnpm tauri dev      # run the app with hot reload
pnpm test           # frontend tests (vitest)
pnpm typecheck
cd src-tauri
cargo test --workspace          # backend tests
cargo clippy --workspace -- -D warnings
cargo test --workspace -- --ignored --test-threads=1   # integration tests against a real local herdr
pnpm tauri build    # produces src-tauri/target/release/bundle/macos/Herdly.app
```

The backend without Tauri is the `herdly-core` crate in `src-tauri/core/` (herdr RPC,
transcripts, attach, git, files); the app in `src-tauri/src/` is the Tauri layer over it.
`cargo test --workspace` and `cargo clippy --workspace` in `src-tauri` cover the app, `herdly-core` and `herdly-web`.
In a worktree, `mise run lint`, `test:backend` and `test:integration` use the main checkout's `src-tauri/target` (`scripts/main-target.sh`), so a fresh worktree reuses the dependencies main already built.

Herdly Web (`src-tauri/web/`, `web/`) serves this Machine's Pane list, Chat lens and mobile Terminal lens to a phone; see [web/README.md](web/README.md). Its manual phone checks are [docs/mobile-terminal-checklist.md](docs/mobile-terminal-checklist.md).

To use a local build day to day, `mise run sign:setup` once, then `mise run install:app`. The
install signs Herdly.app with that local identity: an ad-hoc signed build is a new app to macOS
on every install, so it would ask again for each permission (network volumes, Desktop, ...).
The first signing asks once for keychain access to the key: choose "Always Allow".

### Releasing

Bump `version` in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, commit, then push a matching tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds a universal, ad-hoc signed `.dmg` and attaches it to a draft GitHub Release. Review the draft and publish it.

The ignored integration tests start isolated sessions named `herdly-test-*` on the local herdr and always stop and delete them. The SSH test only runs when `HERDLY_SSH_TEST` is set.

## Known limits

- Remote shells must be POSIX-compatible (no fish or nushell as login shell).
- The Chat lens supports Claude Code and pi only; other agents open in the Terminal lens.
- A terminal that is attached elsewhere is held: use Take over to attach it here.

Herdly Web's mobile Terminal lens has its own limits, documented in [web/README.md](web/README.md):
input typed while the page is backgrounded is gone, the reported exit code is the attach
command's, an application's terminal modes are not mirrored, and it is meant for the trusted
WireGuard network only.

See `GLOSSARY.md` for the domain vocabulary, `docs/` for the design spec and ADRs, and `THIRD_PARTY_NOTICES.md` for upstream credits.
