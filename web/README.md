# Herdly Web

## What it is

Herdly Web serves the Pane list and Chat lens of this Machine's herdr to a Paired device over plain HTTP on the WireGuard address, and serves the **Terminal lens**: a live terminal for a Pane on this Machine, driven from a phone browser. The hub can read the traffic; see `docs/adr/0011-herdly-web-plain-http-over-wireguard.md`.

## The Mobile Terminal lens

A Pane opens in the Chat lens when its Agent has one and in the Terminal lens otherwise; the
header's **Chat/Terminal** selector switches it, and the choice is remembered per Session and
Pane in this browser's local storage (key prefix `herdly-web:lens:v1:`). Storage failure is
harmless: the Pane just follows its Agent again.

- **Exclusive attach, Held, Take over.** herdr allows one attached client per terminal. A
  Terminal already attached elsewhere (the desktop app, another phone) shows *Another device is
  attached to this terminal* with a **Take over** button. Taking over wins the terminal here and
  **interrupts the desktop**: the desktop's terminal reports that it was taken over and stops
  mirroring. The reverse also applies — opening the same Pane on the desktop takes it from the
  phone, and the phone shows the Held banner.
- **Keyboard and key bar.** The phone's own keyboard types into the Pane, Vietnamese IME
  composition included. The key bar above it sends Esc, Tab, Ctrl and the four arrows as
  touch-sized targets; Ctrl is one-shot and applies to the next character (`Ctrl` then `c` sends
  `U+0003`).
- **Input is lost across a reconnect.** Every fresh attempt (mount, Reattach, Take over, the
  automatic retry after a drop, returning to the foreground) starts a new xterm and a new
  terminal attempt: output from two attempts is never concatenated, and **nothing typed during
  the gap is replayed**. Type again after the banner clears.
- **Releasing on backgrounding.** A hidden page (lock screen, app switch) releases its attach, so
  a phone never holds a Machine's terminal while it is away. Coming back opens a normal attempt,
  which can land on the Held banner if something took the terminal meanwhile.
- **Best-effort final output.** When a command exits, the last output is forwarded before the
  socket closes and the banner reports the exit; a hard kill of the Pane can still cut it short.
- **The exit code shown is the attach command's.** Measured with herdr 0.9.5, `herdr terminal
  attach` exits 1 whatever the Pane's process returned.
- **Terminal modes are not mirrored.** herdr 0.9.5's attach stream carries the Pane's screen but
  not its DECSET modes, so the key bar's arrows always send the normal-mode cursor key and a TUI's
  mouse reporting is not driven from the phone.
- **Terminal queries are answered by herdr, not by the browser.** herdr runs its own terminal
  emulation for each Pane, so a query a program in the Pane writes (`ESC[c`, `ESC[5n`, a DECRQSS,
  an OSC colour query) is answered inside herdr and only the answer reaches the Pane's screen. The
  one query that reaches a client is herdr's own startup probe, which `herdly-core`'s attach reader
  recognises and answers itself. Measured with herdr 0.9.5: a Pane printing `ESC[c` after attach
  produces `ESC[?62;22c` in the Pane's own output, and the browser's stream never carries the
  query.
- **Inline styles only.** The CSP the server sends for HTML is `default-src 'self'; connect-src
  'self' ws://<origin>; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none';
  base-uri 'none'`. `'unsafe-inline'` is for xterm's runtime-generated styles and style
  attributes only: inline **scripts** are still blocked, and the browser smoke asserts that.
- **Same trusted-network implications.** Unchanged: plain HTTP on the WireGuard address, so the
  hub can read the terminal traffic. Pair devices, revoke the ones you stop using, and never
  expose the port.

## Requirements

- Linux with systemd (it runs as a user service).
- herdr in `~/.local/bin`, `/usr/local/bin` or `/usr/bin`: the service's `PATH` holds only these.
- The WireGuard interface up with the bind address (`192.0.2.10` by default), and the phone on the same WireGuard network.
- `cargo` and `pnpm` to build.

## Build

From the repo root of the main checkout, not `.worktrees/` (the service and the `herdly-web` command point into it):

```sh
(cd src-tauri && cargo build --release -p herdly-web)
(cd web && pnpm install && pnpm build)
```

## Put `herdly-web` on the PATH

```sh
mkdir -p ~/.local/bin
ln -s "$PWD/src-tauri/target/release/herdly-web" ~/.local/bin/herdly-web
```

The link follows every rebuild, so the command and the service always run the same binary. The commands below assume it; without it, use `src-tauri/target/release/herdly-web`.

## Install

From the repo root of the main checkout:

```sh
mkdir -p ~/.config/systemd/user
sed "s#@REPO@#$PWD#g" web/herdly-web.service > ~/.config/systemd/user/herdly-web.service
systemctl --user daemon-reload
systemctl --user enable --now herdly-web
```

To keep it running while logged out:

```sh
loginctl enable-linger $USER
```

If the service starts before the WireGuard interface is up, the bind fails and systemd retries every 5 seconds.

## Check

```sh
systemctl --user status herdly-web
curl -i http://192.0.2.10:7380/api/machines
```

The service is `active (running)`, and without a cookie the request returns `401`. Logs: `journalctl --user -u herdly-web`.

## Pair a phone

```sh
herdly-web pair
```

Open the printed link (or scan the QR code) in Chrome on the phone within 10 minutes, with WireGuard on.

## Android shell

`android/` wraps Herdly Web in a full-screen WebView. The **Android** workflow (`.github/workflows/android.yml`) builds it on every push that touches `android/`, or by hand from the Actions tab once the workflow is on `main`; the APK is the run's `herdly-android-debug` artifact (a zip; unzip it to get `app-debug.apk`).

1. Install the APK on the phone (allow installs from unknown sources).
2. Run `herdly-web pair`, scan the QR code with any scanner, and copy the link instead of opening it.
3. Open Herdly and paste the link. The app pairs as its own device, separate from Chrome.

Long-press the app icon and pick "Pair or change server" to paste a new link. Android 12 and later open `http://` links in the browser rather than offering an app, so pasting is the only way in.

The APK is debug-signed with the runner's throwaway key, so an APK from a later run will not install over an earlier one: uninstall first, then pair again. To build locally with the Android SDK and JDK 17: `cd android && ./gradlew assembleDebug`.

## Devices and revoking

```sh
herdly-web devices
herdly-web revoke <id>
```

## Upgrade

A release that changes the Terminal lens changes **both halves**: the `herdly-web` binary and the
`web/dist` assets. They are versioned together because the socket protocol and the assets that
speak it must match; upgrading only one leaves a browser talking yesterday's protocol to today's
server (or the reverse). **The desktop app needs no upgrade** for any of this: it is unchanged.

```sh
# from the repo root of the main checkout, after updating the checkout
git pull
(cd src-tauri && cargo build --release -p herdly-web)
(cd web && pnpm install --frozen-lockfile && pnpm build)
systemctl --user restart herdly-web
```

Both halves are now the new ones (the `herdly-web` link follows the rebuild, and `web/dist` is
read from disk on each request). Devices stay paired: the state in `~/.local/state/herdly-web`
needs no migration. Reload the phone's page after the restart; an open Terminal lens reconnects
on its own.

## Rollback

Rolling back is **non-destructive**: nothing is deleted, nothing about the desktop changes, and
the pairing state is kept, so a rollback does not require re-pairing the phone.

```sh
# keep the current pair of artifacts, then put back the previous pair
git checkout <previous-release-tag>          # the commit whose binary+assets you trust
(cd src-tauri && cargo build --release -p herdly-web)
(cd web && pnpm install --frozen-lockfile && pnpm build)
systemctl --user restart herdly-web
```

If you keep packaged artifacts per release instead, put the previous `herdly-web` binary and the
previous `web/dist` back as a pair (same directory the service's `--static` points at) and restart
the service. Do not mix a binary with the other release's assets. To stop using Herdly Web
entirely, the destructive removal is still documented below and is **not** part of a rollback.

## Uninstall

Uninstalling removes the service, the command and the local state (paired devices and pairing
tokens). Do this only when you want Herdly Web gone, never as a rollback.

```sh
systemctl --user disable --now herdly-web
rm ~/.config/systemd/user/herdly-web.service
rm ~/.local/bin/herdly-web
rm -r ~/.local/state/herdly-web
```

The desktop app is unaffected.

## Flags

- `--bind`: default `192.0.2.10:7380`.
- `--origin`: default `http://<bind>`.
- `--static`: required for `serve`.
- `--state`: default `$XDG_STATE_HOME/herdly-web`, else `~/.local/state/herdly-web`.

To change a flag for the service, edit `ExecStart` in `~/.config/systemd/user/herdly-web.service`, then `systemctl --user daemon-reload && systemctl --user restart herdly-web`.

## Verification

The Terminal lens has two automated proofs and one it cannot have:

```sh
# The real production bundle through the real Rust middleware and a real herdr Session.
# Builds `web/dist` and `herdly-web`, starts only temporary local fixtures, and exits non-zero on
# a failed assertion. Works from the repo root as well: node web/scripts/terminal-smoke.mjs
node web/scripts/terminal-smoke.mjs

# Real herdr lifecycle (attach, Held, takeover, resize, exit, SIGTERM with a live attach).
cargo test --manifest-path src-tauri/Cargo.toml -p herdly-web \
  --test terminal_herdr -- --ignored --test-threads=1

# The same lifecycle over the real AttachManager/PTY path: a reader with no ACK pauses past the
# 1 MiB high water mark, an ACK resumes it, and a Pane exiting underneath it still completes
# bounded with a normal close.
cargo test --manifest-path src-tauri/Cargo.toml -p herdly-web --test terminal_ws
```

The smoke builds `web/dist` itself (in `web/`, so it is that project's bundle) and builds
`herdly-web` first, so it works from a fresh checkout and from either the repo root or `web/`.
Both are opt-in because they need a `herdr` binary and start a server: set `HERDR_TEST_BIN` to
the binary (else `herdr` from `PATH`), and `CHROMIUM` to a browser executable for the smoke (else
the Playwright cache is used). They create a private Session, `HOME`, `XDG_CONFIG_HOME` and
`XDG_STATE_HOME` under a temporary directory and remove them afterwards; they never touch your
Session, your server or the running service.

The smoke proves the DOM and rendering contract in **Chromium**. It is **not** evidence for iOS
Safari or Android Chrome: the keyboard, IME, safe-area, mouse-reporting and background/resume
behaviour on real devices is `docs/mobile-terminal-checklist.md`, and every row there stays
*awaiting a real phone* until someone runs it on hardware.
