# Herdly Web

## What it is

Herdly Web serves the Pane list and Chat lens of this Machine's herdr to a Paired device over plain HTTP on the WireGuard address. The hub can read the traffic; see `docs/adr/0011-herdly-web-plain-http-over-wireguard.md`.

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

## Devices and revoking

```sh
herdly-web devices
herdly-web revoke <id>
```

## Upgrade

```sh
git pull
# rebuild both as in Build
systemctl --user restart herdly-web
```

The `herdly-web` link needs no change. The state in `~/.local/state/herdly-web` needs no migration.

## Rollback

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
