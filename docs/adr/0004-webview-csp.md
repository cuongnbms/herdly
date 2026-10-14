# 0004: A Content Security Policy for the webview

> Status: Accepted · Date: 2026-10-03

## Context

Until now the webview ran with `"csp": null`, so nothing limited what a page could load or run.
That leaves two risks:

- **XSS escalates to command execution.** The webview can call `herdr_call`, which allows
  `pane.send_text`. If anything injected script into the page (a crafted Transcript, a markdown
  or mermaid escape), the script could type commands into any Pane on any Machine.
- **Zero-click image leaks.** A remote image in chat content is fetched as soon as it renders,
  which tells its host that the chat was opened and from where. Markdown images are handled by
  their own layer (they render as links, never as `<img>`; see the security spec, item 2). Mermaid
  is not: a diagram can reach a remote URL through CSS `url()` in a `classDef` or `style`, through
  `feImage`, or through a label. Only `img-src` closes those paths.

Source: [design spec](../superpowers/specs/2026-10-03-security-hardening-design.md), section 1.

## Decision

`src-tauri/tauri.conf.json`, `app.security`:

```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
"devCsp": "default-src 'self'; script-src 'self' http://localhost:1420; style-src 'self' 'unsafe-inline' http://localhost:1420; img-src 'self' blob: data: http://localhost:1420; font-src 'self' data: http://localhost:1420; connect-src ipc: http://ipc.localhost http://localhost:1420 ws://localhost:1420; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
"dangerousDisableAssetCspModification": ["style-src"]
```

Amended by [0009](./0009-html-preview-own-scheme.md): both policies also have `frame-src herdly-html:`.

Why each source is there:

| Directive | Sources | Why |
|-----------|---------|-----|
| `default-src` | `'self'` | Anything not listed below comes only from the app bundle. |
| `script-src` | `'self'` | The built `index.html` has no inline script. The bundle has no `eval`, no `new Function` and no WebAssembly. Tauri adds hashes of the bundled scripts on top; that is left on. |
| `style-src` | `'self' 'unsafe-inline'` | Mermaid puts a `<style>` in every diagram and `style="…"` on its nodes; xterm creates `<style>` elements for its theme, dimensions and scrollbar; the agent marks and the mermaid SVG are inserted as HTML (`dangerouslySetInnerHTML`), so their `style` attributes are parsed, not set through CSSOM. Inline CSS cannot run script, and any remote `url()` inside it is still stopped by `img-src`/`font-src`. |
| `img-src` | `'self' blob: data:` | `blob:` is used for chat images and the Composer's pasted images (bytes from `chat_image` turned into object URLs). `data:` is used by the inline agent SVG marks (maki's mark embeds a PNG). No `http:`/`https:`, so no remote GET happens, whatever produced the request: an `<img>`, a CSS `url()` or an SVG `<image>`/`feImage`. |
| `font-src` | `'self' data:` | Vite inlines the two smallest JetBrains Mono subsets (the Vietnamese ones, under 4 KiB) into the CSS as `url(data:font/woff2…)`. Without `data:` they are blocked. Fonts installed on the Mac go through `new FontFace(name, bytes)`, which is not a URL load. |
| `connect-src` | `ipc: http://ipc.localhost` | Tauri IPC (`invoke`): tauri `scripts/core.js` builds the URL with `convertFileSrc(cmd, 'ipc')`, which is `ipc://localhost/<cmd>` on macOS and `http://ipc.localhost/<cmd>` on Windows. The frontend makes no other `fetch`, XHR or WebSocket calls. The only other `fetch` in the bundle is Vite's modulepreload polyfill. It returns early when `relList.supports('modulepreload')` is true, which it is on WebKit with modulepreload support (Safari 17+), so it never runs here. If it did run, `connect-src` (which has no `'self'`) would block it, and a blocked preload is harmless because the module still loads under `script-src`. That is why `connect-src` needs no `'self'`. Note: when CSP blocks the `ipc:` fetch, Tauri's IPC falls back to postMessage without an error (tauri `scripts/ipc-protocol.js` ~58-67, "IPC custom protocol failed… will now use the postMessage interface"). A wrong `connect-src` would therefore not show up as broken IPC. That is why the `ipc:` source was checked against `scripts/core.js` rather than observed. |
| `object-src` | `'none'` | No plugins or embeds. |
| `base-uri` | `'self'` | An injected `<base>` cannot redirect relative URLs. |
| `form-action` | `'none'` | The app submits no forms. |
| `frame-ancestors` | `'none'` | Nothing frames the app. This only works because Tauri sends the policy as a response header on macOS (a `<meta>` policy ignores it). |

`devCsp` is the same policy with `http://localhost:1420` (Vite) added to the directives that load
from it, and `ws://localhost:1420` for HMR. Anything only Vite dev needs goes in `devCsp`, never
in `csp`.

### Why `dangerousDisableAssetCspModification: ["style-src"]`

When Tauri serves an HTML asset, it puts a nonce on every `<style>` element in that file and adds
the nonce to `style-src` (`inject_nonce_token`, defined in tauri-utils 2.10 `html2.rs` and called from tauri-codegen 2.7 `context.rs`; then tauri 2.12 `set_csp`). Under
CSP, a nonce in a directive makes the browser ignore `'unsafe-inline'`. Every inline style that
mermaid, xterm and the inserted SVG create at runtime would then be blocked.

Today the built `index.html` has no `<style>` element, so Tauri would leave `style-src` alone even
without the flag. The flag pins the current behaviour: if a `<style>` ever lands in `index.html`
(a Vite plugin, a hand edit), Tauri must not silently switch off `'unsafe-inline'` and blank the
diagrams and terminals. `script-src` modification stays on. The flag does not allow anything that
`'unsafe-inline'` does not already allow.

The probe's Run A shows what happens without the flag once a nonce is in `style-src`: 127
`style-src-attr`/`style-src-elem` violations. They come from xterm's `<style>` elements, mermaid's
`<style>` and d3 `style` attributes, and React `innerHTML` for the SVGs. Mermaid nodes then lost their
theme fill (computed `fill` dropped to black). React `style={}` was not blocked, because it goes
through CSSOM.

## Verification

The app was not launched for this decision. Instead:

1. **Bundle audit** of `pnpm build` at dev `7f4fa9c`: no `eval`/`new Function`, no WebAssembly; `fetch`
   only in the modulepreload polyfill; the elk chunk's `new Worker` runs only with an explicit worker
   URL; two `url(data:font/woff2…)` in the CSS.
2. **Real-WKWebView probe** (`tmp/csp-probe/`, not committed). It is a Vite build of a small entry
   that mounts the real `ChatItemView`, `ChatImages` and agent marks, plus an xterm `Terminal` with
   fit, unicode11 and WebGL, mirroring `TerminalLens`. Its markdown fixture has a mermaid flowchart
   with a `<br>` label and a `classDef`, a KaTeX label, a `flowchart-elk` diagram, highlighted code,
   a remote image, a relative image and a link. IPC is mocked (`chat_image` returns PNG bytes for the
   `blob:` image). A Swift runner serves the build from `probe://localhost` through a
   `WKURLSchemeHandler`, as Tauri serves `tauri://localhost`, and sends the policy as a
   `Content-Security-Policy` response header. The page reports every `securitypolicyviolation`.
   - Run A, `style-src` plus a nonce: 127 inline-style violations (above).
   - Run B, the final `csp` (only `'nonce-probe'` added to `script-src`, for the probe's own
     listener): zero violations other than the canaries. Mermaid (all three diagrams, including elk
     and KaTeX), highlighting, the `blob:` and `data:` images, xterm with a WebGL2 context and the
     fonts all rendered. The markdown remote image became a link, with no `<img>` and no request.
   - Canaries: a hard-coded `<img src="https://canary.invalid/x.png">`, an element with
     `style="background:url(https://canary.invalid/y.png)"` (the mermaid CSS vector) and a
     `fetch("https://canary.invalid/c")`. In Run B all three fired (`img-src`, `img-src`,
     `connect-src`), so the policy blocks what it must.
   - Run C, `font-src 'self'` without `data:`: `font-src` violations for `data`, which confirms that
     source is needed.
3. `pnpm tauri build --debug --no-bundle` compiled with this config, so Tauri accepted the keys. The
   binary was not run.

## Consequences

- Injected script cannot load from or talk to anywhere outside the bundle and IPC. It still cannot
  run inline. Remote images and CSS `url()`s make no request.
- **Residual risk.** The probe did not exercise Tauri's own injection pipeline (its script hashes
  and init scripts), the full app (sidebar, dashboard, dialogs, Composer, PromptPanel) or `devCsp`.
  Run the app once after merging. A broken CSP shows up as missing styles, unstyled diagrams or a
  blank pane, plus `securitypolicyviolation` messages in the Web Inspector console. Reverting is
  `"csp": null`.
- **`devCsp` heads-up.** On desktop, `pnpm tauri dev` loads `http://localhost:1420` straight from
  Vite. Tauri attaches the CSP header only to assets it serves itself over `tauri://` (tauri 2.12
  `get_app_url`/`get_asset`; the dev proxy is mobile-only). So `devCsp` is not applied in desktop dev
  today, and dev runs with no CSP. If it ever is applied (a Vite `server.headers` policy, or a
  future Tauri version), `@vitejs/plugin-react` injects an inline
  `<script type="module">` (the React Refresh preamble) into `index.html` in dev, which
  `script-src 'self' http://localhost:1420` blocks. The fix then belongs in `devCsp` only, for
  example a hash of the preamble. Never add `'unsafe-inline'` to `script-src` in `csp`.
- **Adding a remote origin** to any directive in `csp` (an image CDN, a font host, an API) needs a
  new ADR that supersedes this one. So does adding `'unsafe-eval'`, `'unsafe-inline'` in
  `script-src`, or `http:`/`https:` in `img-src`.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| No `'unsafe-inline'` in `style-src` (nonces or hashes only) | Mermaid, d3 and xterm create inline styles at runtime that no build-time hash or nonce can cover. Diagrams and terminals would lose their styling. |
| `img-src` with `https:` so remote markdown images can show | Re-opens the zero-click leak for every path that reaches `img-src`, including mermaid CSS, which the markdown layer does not see. |
| Leave Tauri's `style-src` modification on | Works only while `index.html` has no `<style>`. The first one would silently disable `'unsafe-inline'` and break every diagram and terminal. |
