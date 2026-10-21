# Herdly Web

## What it is

Herdly Web serves the Pane list and Chat lens of this Machine's herdr to a Paired device over plain HTTP on the WireGuard address. The hub can read the traffic; see `docs/adr/0011-herdly-web-plain-http-over-wireguard.md`.

## Build

From the repo root:

```sh
(cd src-tauri && cargo build --release -p herdly-web)
(cd web && pnpm install && pnpm build)
```

## Install

From the repo root of the main checkout, not `.worktrees/`:

```sh
mkdir -p ~/.config/systemd/user
sed "s#@REPO@#$PWD#g" web/herdly-web.service > ~/.config/systemd/user/herdly-web.service
systemctl --user daemon-reload
systemctl --user enable --now herdly-web
```

Optional, to keep it running while logged out:

```sh
loginctl enable-linger $USER
```

## Pair a phone

```sh
src-tauri/target/release/herdly-web pair
```

Open the printed link (or scan the QR code) in Chrome on the phone within 10 minutes.

## Devices and revoking

```sh
src-tauri/target/release/herdly-web devices
src-tauri/target/release/herdly-web revoke <id>
```

## Upgrade

```sh
git pull
# rebuild both as in Build
systemctl --user restart herdly-web
```

The state in `~/.local/state/herdly-web` needs no migration.

## Rollback

```sh
systemctl --user disable --now herdly-web
rm ~/.config/systemd/user/herdly-web.service
rm -r ~/.local/state/herdly-web
```

The desktop app is unaffected.

## Check

```sh
curl -i http://192.0.2.10:7380/api/machines
```

Without a cookie this returns `401`.

## Flags

- `--bind`: default `192.0.2.10:7380`.
- `--origin`: default `http://<bind>`.
- `--static`: required for `serve`.
- `--state`: default `$XDG_STATE_HOME/herdly-web`, else `~/.local/state/herdly-web`.
