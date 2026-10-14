# 0009: Render HTML files in a sandboxed frame served by its own scheme, accepting a `frame-src` in the app policy

> Status: Accepted · Date: 2026-10-14

## Context

The File viewer should render `.html` files that Agents write, with the page's own scripts off by
default and on when the user asks. The file comes from a Machine and is untrusted; the webview can
call `herdr_call` (`pane.send_text`), which [0004](./0004-webview-csp.md) protects with
`script-src 'self'` and no `frame-src` (so `default-src 'self'`).

A `srcdoc:` or `blob:` frame inherits the parent's policy, so with `script-src 'self'` no inline or
CDN script can ever run inside it, whatever its `sandbox` says. Scripts can only run in a frame whose
document is served with its own `Content-Security-Policy` header.

Source: [design spec](../superpowers/specs/2026-10-14-files-html-preview-design.md)

## Decision

A custom URI scheme `herdly-html` serves a page the frontend stored by token, with one of two
policies chosen when it was stored (Scripts off: no script, no network; Scripts on:
`script-src 'unsafe-inline' https:` and `https:` styles, images and fonts, `connect-src 'none'`).
The frame is always `sandbox`ed without `allow-same-origin`. The app policy (`csp` and `devCsp`)
gains exactly `frame-src herdly-html:`; all of 0004 otherwise stands.

This wins over relaxing the app's own `script-src` because the page runs in an opaque origin with
no Tauri IPC (Tauri injects its init and IPC scripts into the main frame only), so the app keeps
0004's guarantee that no injected script runs beside `herdr_call`.

## Consequences

- `frame-src herdly-html:` also limits where the frame may navigate: links and `location =` to
  `http(s):` inside a page are blocked, not opened.
- Relative assets do not load (the scheme serves one document per token). Supporting them later
  means the handler reads sibling files from the Machine, and needs a scope rule for what a page
  with Scripts on may read.
- With Scripts on, a page can still send data out through an `https:` image or script URL. The
  user turned Scripts on for that file; `connect-src 'none'` closes `fetch`/XHR/WebSocket only.
- If Tauri ever injects its IPC into all frames, layer 2 is gone; the opaque origin and the page's
  `connect-src 'none'` still stand. Re-check `for_main_frame_only` when upgrading tauri.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| `srcdoc` frame only | Inherits `script-src 'self'`; Scripts on could never work. |
| `'unsafe-inline'` / `https:` in the app's `script-src` | Undoes 0004: any injected script in the app could run and call `herdr_call`. |
| Scripts on chosen by a URL query on the scheme | A page could navigate itself to the "on" URL; the mode lives with the stored page instead. |
