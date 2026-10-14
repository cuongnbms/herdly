# HTML preview in the File viewer

Date: 2026-10-14
Status: approved

## Purpose

Agents often write a report as a single self-contained `.html` file (inline CSS and JS, data
embedded, sometimes a chart library from a CDN). Today the File viewer shows it only as source.
This adds a rendered view, modelled on Obsidian's
[HTML Page Viewer](https://github.com/viggomeesters/obsidian-html-page-viewer): a sandboxed
frame, scripts off by default, a per-file **Scripts** switch to turn them on.

The file comes from a Machine, so it is untrusted. The webview can call `herdr_call`, which allows
`pane.send_text`; a page must never reach it. [ADR 0004](../../adr/0004-webview-csp.md) keeps
that path closed and says a policy change needs a new ADR: [ADR 0009](../../adr/0009-html-preview-own-scheme.md).

## Scope

In:

- `.html` / `.htm` files get the **Render / Source** group that markdown has; Render is the default.
- Render shows the file in a sandboxed `<iframe>` served by a custom URI scheme with its own CSP.
- A **Scripts** button (Render only, not in Edit mode). Off: no JavaScript, no network. On:
  inline scripts run, and scripts, styles, images and fonts may load over `https:`.
- **Scripts** is off every time the file is shown again (another Open item and back, another file).

Out (non-goals):

- Relative assets (`<img src="chart.png">`, `<link href="style.css">`, links to sibling pages).
  The frame serves one document; anything else is a 404.
- `fetch`/XHR/WebSocket from the page (`connect-src 'none'` even with Scripts on).
- Forms, popups, `target="_blank"` links, top-level navigation, navigation to `http(s):`.
- Find inside the rendered page; keeping the page's scroll position across reloads.
- Remembering Scripts per file or across restarts.

## Backend (`src-tauri/src/files/html.rs`)

A managed `HtmlPages` store: `Mutex` around an insertion-ordered map `token → Page { html: String, scripts: bool }`,
at most 16 entries (inserting a 17th drops the oldest; a safety net for a missed `drop`). Tokens
are 128 random bits, hex.

Commands (registered in `lib.rs`, wrapped in `src/lib/ipc.ts` as `filesHtmlPut` / `filesHtmlDrop`):

- `files_html_put(html: String, scripts: bool) -> String` stores a page, returns its token.
- `files_html_drop(token: String)` removes it; an unknown token is not an error.

URI scheme `herdly-html` (`register_uri_scheme_protocol`; URL `herdly-html://localhost/<token>`).
For a known token it answers `200` with:

- `Content-Type: text/html; charset=utf-8`
- `Content-Security-Policy`:
  - Scripts off: `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'`
  - Scripts on: `default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
- `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`

Any other path, an unknown token, or a method other than GET answers `404` with an empty body.
Scripts is a property of the stored page, not of the URL, so a page cannot raise its own rights by
navigating to another URL.

## Webview policy (`src-tauri/tauri.conf.json`)

`csp` and `devCsp` both gain `frame-src herdly-html:`. Nothing else changes. `frame-src` also
governs where a frame may navigate, so a link or `location =` to an `https:` URL inside the page
is blocked by the app's policy.

Layers that keep a page away from `herdr_call`:

1. `sandbox` without `allow-same-origin`: the frame has an opaque origin, `parent.document` throws.
2. Tauri's IPC and init scripts are injected into the main frame only (`for_main_frame_only: true`
   in tauri 2.12 `manager/webview.rs`, and in the dialog, opener and notification plugins'
   `js_init_script`), so the frame has no `__TAURI_INTERNALS__`.
3. The page's own CSP has `connect-src 'none'`, so it cannot reach `ipc://` either.

## Frontend

### `src/files/HtmlView.tsx`

`HtmlView({ text, scripts })`: on mount and whenever `text` or `scripts` changes it calls
`filesHtmlPut(text, scripts)`, renders
`<iframe className="files-html" src="herdly-html://localhost/<token>" sandbox={scripts ? "allow-scripts" : ""} title="HTML preview">`,
and drops the previous token (also on unmount). While the first token is pending it renders the
empty frame wrapper; a failed `put` shows a `files-notice` with the error. Put calls that resolve
after a newer one, or after unmount, drop their token at once.

A reload (Files watch, ⌘R) gives a new `text`, so a new token and a reloaded frame; the page's
scroll position is lost, since a cross-origin frame's scroll cannot be read.

### `src/files/FileView.tsx`

`isHtml(rel)` (`/\.html?$/i`) beside `isMarkdown`, exported with it. A new `scripts` prop.
`content.kind === "text"`, `isHtml(rel)`, `mode === "render"` and not `content.truncated` →
`<HtmlView>`; otherwise the existing `TextView`.

### `src/files/FileViewer.tsx`

- `html = isHtml(rel)`. The Render/Source group shows for `(md || html) && !draft && text`; its
  `aria-label` is "Markdown view" or "HTML view".
- Default mode: an HTML file that is truncated is always Source (and the group is hidden); the
  `HIGHLIGHT_LIMIT` rule ("large → source") does not apply to HTML, the frame parses it, not React.
- `const [scripts, setScripts] = useState(false)`. `App.tsx` mounts `FileViewer` with
  `key={itemKey(item)}`, so another Open item, or another file, starts with Scripts off. A
  **Scripts** toggle button (`aria-pressed`) after the mode group when `html && mode === "render" && !draft`.
- Find: an HTML file in Render is not `searchable`. ⌘F on it switches to Source and opens the
  FindBar (the mode change is stored like a click on Source).

### `src/styles.css`

`.files-html`: fills `.files-view`, no border, white background (pages assume a white canvas;
the app's dark theme is not applied inside).

## Testing

- **Rust** (`html.rs` unit tests): put → handler returns 200, the HTML, `text/html; charset=utf-8`
  and the exact CSP for each mode; drop → 404; unknown token, other path, POST → 404; the 17th put
  evicts the first.
- **Vitest** (`HtmlView.test.tsx`, additions to `FileView.test.tsx`, `FileViewer.test.tsx`), IPC mocked:
  - iframe `src` and `sandbox` per Scripts value; `put` again and `drop` the old token when text or
    Scripts changes; `drop` on unmount; a late `put` is dropped.
  - `.html` shows Render/Source, Render by default even past `HIGHLIGHT_LIMIT`; truncated → Source
    with no group; Scripts button only in Render and not in Edit mode; Scripts resets on another file.
  - ⌘F in HTML Render switches to Source with the FindBar open.
- **Headless WKWebView probe** (`tmp/html-probe/`, not committed; same Swift runner shape as
  `tmp/csp-probe`): the app policy as a response header on the parent, the frame served by a
  `WKURLSchemeHandler` for `herdly-html` with the two policies. Checks: the frame loads under
  `frame-src herdly-html:`; an inline script runs only with Scripts on; a remote `<img>` and an
  `https:` script make no request with Scripts off; `parent.document` throws; `location = "https://…"`
  from the frame is blocked; `fetch` is blocked in both modes.
- **Residual**: the probe does not run Tauri's own injection pipeline. Open the app once after
  merging, render a report with Scripts off and on, and check the Web Inspector console.
