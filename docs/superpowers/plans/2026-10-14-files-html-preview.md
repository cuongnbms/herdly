# HTML preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `.html` / `.htm` files in the File viewer in a sandboxed frame, with the page's scripts off by default and a per-file **Scripts** switch.

**Architecture:** The frontend stores the file's text in a Rust-side page store and gets a token; a custom URI scheme `herdly-html` serves that page with its own CSP (one of two, fixed when stored). The frame is sandboxed without `allow-same-origin`; the app policy gains only `frame-src herdly-html:`.

**Tech Stack:** Tauri 2.12 (Rust, `tauri::http`, `uuid`), React 19 + TypeScript, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-14-files-html-preview-design.md` (decision record: `docs/adr/0009-html-preview-own-scheme.md`)

## Global Constraints

- Work on `main` (the user chose it); commit after each task with Conventional Commits, scope `files` (`feat(files): …`, `test(files): …`), ending with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Scheme name `herdly-html`; page URL is exactly `herdly-html://localhost/<token>`; tokens are `uuid::Uuid::new_v4().simple().to_string()`.
- IPC command names `files_html_put(html, scripts) -> token` and `files_html_drop(token)`; TS wrappers `filesHtmlPut` / `filesHtmlDrop` in `src/lib/ipc.ts`.
- Iframe `sandbox` is exactly `""` (Scripts off) or `"allow-scripts"` (Scripts on). Never add `allow-same-origin`, `allow-popups`, `allow-forms` or `allow-top-navigation`.
- The two page policies are the constants `CSP_OFF` / `CSP_ON` in `src-tauri/src/files/html.rs`, copied verbatim from the spec; nothing else defines them.
- `isMarkdown` and `isHtml` live once in `src/files/kinds.ts`; `FileView.tsx` and `FileViewer.tsx` import them (both currently define `isMarkdown` locally).
- A page that cannot be stored shows `Cannot show this page: <message>` in a `files-notice` with `role="alert"`, where `<message>` is `String(e?.message ?? e)`.
- Rust: run `cargo fmt` only on files you edited; bare `cargo fmt` rewrites unrelated `src-tauri` files, revert those.

## Review Focus

- A reload (Files watch, ⌘R) or a Scripts click while the previous `put` is still pending: the frame must end on the newest page and every older token must be dropped (HtmlView "late put" test, Task 3).
- A file cut at 2 MB: must never reach the frame, since truncated HTML renders broken (FileView and FileViewer truncated tests, Tasks 3–4).
- A large but uncut HTML report (past `HIGHLIGHT_LIMIT`): must still open in Render (FileViewer test, Task 4).
- A page navigating itself to another `herdly-html` URL to gain scripts: the mode lives with the stored page, so a different path or token never serves the "on" policy for an "off" page (Rust 404 tests, Task 1).
- Leaked pages if a `drop` is missed: the store keeps at most 16 (Rust eviction test, Task 1).

---

### Task 1: Page store and scheme response (`files::html`)

**Files:**
- Create: `src-tauri/src/files/html.rs`
- Modify: `src-tauri/src/files/mod.rs` (add `pub mod html;` in the sorted `pub mod` list)

**Interfaces:**
- Produces:
  - `pub const MAX_PAGES: usize = 16;`
  - `pub const CSP_OFF: &str` / `pub const CSP_ON: &str` (values in Step 1's test)
  - `#[derive(Default)] pub struct HtmlPages` (a `std::sync::Mutex<VecDeque<(String, Page)>>` inside; `Page { html: String, scripts: bool }` private)
  - `impl HtmlPages { pub fn put(&self, html: String, scripts: bool) -> String; pub fn drop_page(&self, token: &str); pub fn respond(&self, method: &tauri::http::Method, path: &str) -> tauri::http::Response<Vec<u8>> }`

- [ ] **Step 1: Write the failing tests** at the bottom of `src-tauri/src/files/html.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::{Method, Response};

    fn header<'a>(r: &'a Response<Vec<u8>>, name: &str) -> &'a str {
        r.headers().get(name).unwrap().to_str().unwrap()
    }

    #[test]
    fn policies_are_the_specs() {
        assert_eq!(
            CSP_OFF,
            "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'"
        );
        assert_eq!(
            CSP_ON,
            "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        );
    }

    #[test]
    fn serves_a_stored_page_with_the_policy_it_was_stored_with() {
        let pages = HtmlPages::default();
        let off = pages.put("<p>off</p>".into(), false);
        let on = pages.put("<p>on</p>".into(), true);

        let r = pages.respond(&Method::GET, &format!("/{off}"));
        assert_eq!(r.status(), 200);
        assert_eq!(r.body(), b"<p>off</p>");
        assert_eq!(header(&r, "content-type"), "text/html; charset=utf-8");
        assert_eq!(header(&r, "content-security-policy"), CSP_OFF);
        assert_eq!(header(&r, "x-content-type-options"), "nosniff");
        assert_eq!(header(&r, "cache-control"), "no-store");

        let r = pages.respond(&Method::GET, &format!("/{on}"));
        assert_eq!(r.body(), b"<p>on</p>");
        assert_eq!(header(&r, "content-security-policy"), CSP_ON);
    }

    #[test]
    fn tokens_are_distinct_32_hex_digits() {
        let pages = HtmlPages::default();
        let (a, b) = (pages.put("a".into(), false), pages.put("a".into(), false));
        assert_ne!(a, b);
        for t in [&a, &b] {
            assert_eq!(t.len(), 32);
            assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn anything_but_a_get_of_a_stored_token_is_404() {
        let pages = HtmlPages::default();
        let t = pages.put("<p>x</p>".into(), true);
        for (method, path) in [
            (Method::POST, format!("/{t}")),
            (Method::GET, "/".to_string()),
            (Method::GET, format!("/{t}/style.css")),
            (Method::GET, format!("/{t}?scripts=1")),
            (Method::GET, "/00000000000000000000000000000000".to_string()),
        ] {
            let r = pages.respond(&method, &path);
            assert_eq!(r.status(), 404, "{method} {path}");
            assert!(r.body().is_empty());
        }
    }

    #[test]
    fn a_dropped_page_is_404_and_dropping_twice_is_fine() {
        let pages = HtmlPages::default();
        let t = pages.put("<p>x</p>".into(), false);
        pages.drop_page(&t);
        pages.drop_page(&t);
        assert_eq!(pages.respond(&Method::GET, &format!("/{t}")).status(), 404);
    }

    #[test]
    fn storing_past_the_limit_evicts_the_oldest() {
        let pages = HtmlPages::default();
        let tokens: Vec<String> = (0..=MAX_PAGES).map(|i| pages.put(format!("{i}"), false)).collect();
        assert_eq!(pages.respond(&Method::GET, &format!("/{}", tokens[0])).status(), 404);
        for t in &tokens[1..] {
            assert_eq!(pages.respond(&Method::GET, &format!("/{t}")).status(), 200);
        }
    }
}
```

Note `respond` takes the URI *path* only (`req.uri().path()`), so `"/{t}?scripts=1"` reaches it only if a caller passes a query; it must still be 404 because the path segment is not exactly a stored token.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test files::html`
Expected: compile errors (`HtmlPages`, `CSP_OFF`, … not found).

- [ ] **Step 3: Implement `HtmlPages`, `CSP_OFF`, `CSP_ON`, `MAX_PAGES` in `src-tauri/src/files/html.rs`**

Module doc comment: one or two lines naming the scheme, that Scripts is fixed per stored page, and ADR-0009. `respond`: the path must be `/` followed by a stored token and nothing else; build responses with `tauri::http::Response::builder()`. `put` pushes to the back and pops the front while `len > MAX_PAGES`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test files::html`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd src-tauri && cargo fmt -- src/files/html.rs src/files/mod.rs && cd ..
git add src-tauri/src/files/html.rs src-tauri/src/files/mod.rs
git commit -m "feat(files): a page store that serves stored HTML with a per-page policy"
```

---

### Task 2: Wire the scheme, commands, app policy and IPC wrappers

**Files:**
- Modify: `src-tauri/src/commands.rs` (two commands, next to `files_unwatch` ~line 864)
- Modify: `src-tauri/src/lib.rs` (register commands after `commands::files_write`, `register_uri_scheme_protocol` on the builder, `app.manage` next to `FilesWatch` ~line 132)
- Modify: `src-tauri/tauri.conf.json` (`app.security.csp` and `app.security.devCsp`)
- Modify: `src/lib/ipc.ts` (after `filesImage`)
- Modify: `docs/adr/0004-webview-csp.md` (one line under its Decision JSON pointing to 0009)
- Test: `src/lib/ipc.test.ts`

**Interfaces:**
- Consumes: `files::html::HtmlPages::{put, drop_page, respond}` (Task 1).
- Produces:
  - Rust commands `files_html_put(pages: State<'_, Arc<HtmlPages>>, html: String, scripts: bool) -> String` and `files_html_drop(pages: State<'_, Arc<HtmlPages>>, token: String)` (sync, like `files_unwatch`).
  - TS: `export const filesHtmlPut = (html: string, scripts: boolean) => invoke<string>("files_html_put", { html, scripts });` and `export const filesHtmlDrop = (token: string) => invoke<void>("files_html_drop", { token });`

- [ ] **Step 1: Write the failing test** inside `describe("files ipc", …)` in `src/lib/ipc.test.ts` (add `filesHtmlDrop, filesHtmlPut` to the existing `./ipc` import; `invoke` is already mocked there)

```ts
it("stores and drops an HTML page under its token", async () => {
  await filesHtmlPut("<p>x</p>", true);
  expect(invoke).toHaveBeenLastCalledWith("files_html_put", { html: "<p>x</p>", scripts: true });
  await filesHtmlDrop("abc");
  expect(invoke).toHaveBeenLastCalledWith("files_html_drop", { token: "abc" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/ipc.test.ts`
Expected: FAIL (`filesHtmlPut` is not exported).

- [ ] **Step 3: Add the TS wrappers, the Rust commands, and the wiring**

- `lib.rs`: `.register_uri_scheme_protocol("herdly-html", |ctx, req| ctx.app_handle().state::<Arc<files::html::HtmlPages>>().respond(req.method(), req.uri().path()))` on the builder; `app.manage(Arc::new(files::html::HtmlPages::default()));` in `setup`; `commands::files_html_put, commands::files_html_drop` in `generate_handler!`.
- `tauri.conf.json`: append `; frame-src herdly-html:` to the end of both `csp` and `devCsp` strings. Change nothing else in them.
- `docs/adr/0004-webview-csp.md`: under the Decision's JSON block add `Amended by [0009](./0009-html-preview-own-scheme.md): both policies also have \`frame-src herdly-html:\`.`

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/lib/ipc.test.ts` → PASS.
Run: `cd src-tauri && cargo build` → builds with no new warnings.
Run: `grep -c "frame-src herdly-html:" src-tauri/tauri.conf.json` → `2`.

- [ ] **Step 5: Commit**

```bash
cd src-tauri && cargo fmt -- src/lib.rs src/commands.rs && cd ..
git add src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/tauri.conf.json src/lib/ipc.ts src/lib/ipc.test.ts docs/adr/0004-webview-csp.md
git commit -m "feat(files): serve stored HTML pages over herdly-html and allow it as a frame source"
```

---

### Task 3: `HtmlView`, file kinds, and FileView routing

**Files:**
- Create: `src/files/kinds.ts`, `src/files/HtmlView.tsx`, `src/files/HtmlView.test.tsx`
- Modify: `src/files/FileView.tsx` (import `isMarkdown`/`isHtml` from `./kinds`, drop its local `isMarkdown`; new optional prop `scripts?: boolean`, default `false`)
- Modify: `src/files/FileView.test.tsx`
- Modify: `src/styles.css` (after `.files-view` ~line 1402)

**Interfaces:**
- Consumes: `filesHtmlPut`, `filesHtmlDrop` from `../lib/ipc` (Task 2).
- Produces:
  - `src/files/kinds.ts`: `export const isMarkdown = (rel: string) => /\.(md|markdown)$/i.test(rel);` and `export const isHtml = (rel: string) => /\.html?$/i.test(rel);`
  - `export function HtmlView({ text, scripts }: { text: string; scripts: boolean })`
  - `FileView` prop `scripts?: boolean`. Routing: `content.kind === "text"` and `isHtml(rel)` and `mode === "render"` and `!content.truncated` → `<HtmlView text={content.text} scripts={scripts} />`; otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

`src/files/HtmlView.test.tsx`:

```tsx
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { invoke } from "@tauri-apps/api/core";
import { HtmlView } from "./HtmlView";

let n = 0;
const args = (cmd: string) => vi.mocked(invoke).mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
const frame = () => document.querySelector("iframe.files-html") as HTMLIFrameElement | null;
const shows = (token: string) => waitFor(() => expect(frame()?.getAttribute("src")).toBe(`herdly-html://localhost/${token}`));

describe("HtmlView", () => {
  beforeEach(() => {
    n = 0;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "files_html_put" ? `t${++n}` : undefined));
  });

  it("shows the stored page in a frame that may run nothing", async () => {
    render(<HtmlView text="<p>a</p>" scripts={false} />);
    await shows("t1");
    expect(frame()!.getAttribute("sandbox")).toBe("");
    expect(frame()!.getAttribute("title")).toBe("HTML preview");
    expect(args("files_html_put")).toEqual([{ html: "<p>a</p>", scripts: false }]);
  });

  it("with Scripts on the frame may run scripts and nothing more", async () => {
    render(<HtmlView text="<p>a</p>" scripts />);
    await shows("t1");
    expect(frame()!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(args("files_html_put")).toEqual([{ html: "<p>a</p>", scripts: true }]);
  });

  it("stores the page again and drops the old one when the text or Scripts changes", async () => {
    const { rerender } = render(<HtmlView text="a" scripts={false} />);
    await shows("t1");
    rerender(<HtmlView text="b" scripts={false} />);
    await shows("t2");
    rerender(<HtmlView text="b" scripts />);
    await shows("t3");
    expect(args("files_html_drop")).toEqual([{ token: "t1" }, { token: "t2" }]);
  });

  it("drops its page when it goes away", async () => {
    const { unmount } = render(<HtmlView text="a" scripts={false} />);
    await shows("t1");
    unmount();
    expect(args("files_html_drop")).toEqual([{ token: "t1" }]);
  });

  it("drops a page that arrives after a newer one was asked for", async () => {
    let release!: (token: string) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => (release = r as (token: string) => void)));
    const { rerender } = render(<HtmlView text="a" scripts={false} />);
    rerender(<HtmlView text="b" scripts={false} />);
    await shows("t1");
    await act(async () => release("late"));
    expect(args("files_html_drop")).toContainEqual({ token: "late" });
    expect(frame()!.getAttribute("src")).toBe("herdly-html://localhost/t1");
  });

  it("says why when the page cannot be stored", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("boom"));
    render(<HtmlView text="a" scripts={false} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Cannot show this page: boom");
    expect(frame()).toBeNull();
  });
});
```

Add to `src/files/FileView.test.tsx` (add `waitFor` to its testing-library import and `import { invoke } from "@tauri-apps/api/core";` after the existing `vi.mock`):

```tsx
  it("renders an HTML file in a frame in render mode and as source otherwise", async () => {
    vi.mocked(invoke).mockResolvedValue("t1");
    const content = { kind: "text" as const, text: "<h1>Hi</h1>", truncated: false, size: 11, mtime: 1, cksum: null, editable: false };
    const { container, rerender } = render(<FileView {...base} rel="r.HTML" mode="render" content={content} />);
    await waitFor(() => expect(container.querySelector("iframe.files-html")?.getAttribute("sandbox")).toBe(""));
    rerender(<FileView {...base} rel="r.HTML" mode="source" content={content} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".files-text")).not.toBeNull();
  });
  it("passes Scripts on to the frame of an .htm file", async () => {
    vi.mocked(invoke).mockResolvedValue("t1");
    const content = { kind: "text" as const, text: "<p>x</p>", truncated: false, size: 8, mtime: 1, cksum: null, editable: false };
    const { container } = render(<FileView {...base} rel="r.htm" mode="render" scripts content={content} />);
    await waitFor(() => expect(container.querySelector("iframe.files-html")?.getAttribute("sandbox")).toBe("allow-scripts"));
  });
  it("shows a cut HTML file as source even in render mode", () => {
    const content = { kind: "text" as const, text: "<p>cut", truncated: true, size: 3e6, mtime: 1, cksum: null, editable: false };
    const { container } = render(<FileView {...base} rel="r.html" mode="render" content={content} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".files-text")).not.toBeNull();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/files/HtmlView.test.tsx src/files/FileView.test.tsx`
Expected: FAIL (`./HtmlView` not found; FileView renders source for `.html`).

- [ ] **Step 3: Implement `kinds.ts`, `HtmlView`, the FileView route, and the CSS**

- `HtmlView`: one effect keyed on `[text, scripts]` that calls `filesHtmlPut`, and in its cleanup marks itself stale; a resolved token from a stale call is dropped at once, a current one replaces the shown token and the previous token is dropped. Unmount drops the shown token. Before the first token: render only the wrapper `<div className="files-html-wrap">`. The iframe: `<iframe className="files-html" src={`herdly-html://localhost/${token}`} sandbox={scripts ? "allow-scripts" : ""} title="HTML preview" />` where `scripts` is the value the shown token was stored with. Error: Global Constraints wording.
- `src/styles.css`: `.files-html-wrap { flex: 1; min-height: 0; display: flex; }` and `.files-html { flex: 1; width: 100%; border: 0; background: #fff; }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/files/HtmlView.test.tsx src/files/FileView.test.tsx`
Expected: PASS (6 + the existing FileView tests + 3).

- [ ] **Step 5: Commit**

```bash
git add src/files/kinds.ts src/files/HtmlView.tsx src/files/HtmlView.test.tsx src/files/FileView.tsx src/files/FileView.test.tsx src/styles.css
git commit -m "feat(files): render HTML files in a sandboxed frame"
```

---

### Task 4: FileViewer toolbar: Render / Source, Scripts, ⌘F

**Files:**
- Modify: `src/files/FileViewer.tsx` (drop local `isMarkdown` line 26, import from `./kinds`; mode default ~line 145-150; keys handler `k === "f"` branch; toolbar mode group ~line 296)
- Test: `src/files/FileViewer.test.tsx`

**Interfaces:**
- Consumes: `isMarkdown`, `isHtml` from `./kinds`; `FileView` prop `scripts` (Task 3).
- Produces: nothing used by later tasks.

Behaviour to implement (from the spec):
- `html = isHtml(rel)`; `htmlCut = html && shown?.truncated === true`.
- Mode: `htmlCut` → always `"source"`; otherwise `chosen ?? (((large && !html) || toLine) ? "source" : "render")`.
- Mode group shows for `(md || (html && !htmlCut)) && !draft && shown?.kind === "text"`, `aria-label` `"Markdown view"` for md, `"HTML view"` for html.
- `const [scripts, setScripts] = useState(false)`; a `<button type="button" aria-pressed={scripts} onClick={…}>Scripts</button>` right after the mode group, only when `html && !htmlCut && mode === "render" && !draft`; pass `scripts` to `FileView`.
- `searchable` is also false for `html && mode === "render"`. ⌘F on an HTML file in Render calls `setMode("source")` and then opens the FindBar as for any searchable file.

- [ ] **Step 1: Write the failing tests**

In the `vi.mock("@tauri-apps/api/core", …)` at the top of `src/files/FileViewer.test.tsx`, before `return [];` add:

```ts
    if (cmd === "files_html_put") return "t";
```

Add inside `describe("FileViewer", …)`:

```tsx
  const frame = () => document.querySelector("iframe.files-html");

  it("opens an HTML file rendered, even past the highlight limit, with Scripts off until clicked", async () => {
    texts["r.html"] = "<h1>R</h1>" + "x".repeat(HIGHLIGHT_LIMIT);
    render(<FileViewer item={file("r.html")} online />);
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(screen.getByRole("group", { name: "HTML view" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Render" }).getAttribute("aria-pressed")).toBe("true");
    const scripts = screen.getByRole("button", { name: "Scripts" });
    expect(scripts.getAttribute("aria-pressed")).toBe("false");
    expect(frame()!.getAttribute("sandbox")).toBe("");
    fireEvent.click(scripts);
    expect(scripts.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(frame()!.getAttribute("sandbox")).toBe("allow-scripts"));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.queryByRole("button", { name: "Scripts" })).toBeNull();
    expect(frame()).toBeNull();
  });

  it("starts with Scripts off again when the file is shown again", async () => {
    texts["r.html"] = "<p>r</p>";
    const { rerender } = render(<FileViewer key="r" item={file("r.html")} online />);
    fireEvent.click(await screen.findByRole("button", { name: "Scripts" }));
    rerender(<FileViewer key="other" item={file("a.txt")} online />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Scripts" })).toBeNull());
    rerender(<FileViewer key="r" item={file("r.html")} online />);
    expect((await screen.findByRole("button", { name: "Scripts" })).getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a cut HTML file as source only", async () => {
    texts["cut.html"] = "<p>cut";
    truncated.add("cut.html");
    render(<FileViewer item={file("cut.html")} online />);
    await waitFor(() => expect(document.querySelector(".files-text")).not.toBeNull());
    expect(screen.queryByRole("group", { name: "HTML view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scripts" })).toBeNull();
    expect(frame()).toBeNull();
  });

  it("⌘F on a rendered HTML file switches to Source and finds there", async () => {
    texts["f.html"] = "<p>needle</p>";
    render(<FileViewer item={file("f.html")} online />);
    await waitFor(() => expect(frame()).not.toBeNull());
    press("f");
    expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByPlaceholderText("Find in file"), { target: { value: "needle" } });
    expect(document.querySelector(".files-find-count")!.textContent).toBe("1 / 1");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/files/FileViewer.test.tsx`
Expected: the 4 new tests FAIL (no "HTML view" group / no frame); existing tests pass.

- [ ] **Step 3: Implement the behaviour above in `src/files/FileViewer.tsx`**

- [ ] **Step 4: Run the whole suite and the type check**

Run: `pnpm vitest run` → all pass.
Run: `pnpm typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/files/FileViewer.tsx src/files/FileViewer.test.tsx
git commit -m "feat(files): HTML files get Render / Source and a Scripts switch"
```

---

### Task 5: Headless WKWebView probe of the policies (not committed)

**Files:**
- Create (untracked, under `tmp/html-probe/`, like `tmp/csp-probe/`): `main.swift`, `parent.html`, `page-off.html`, `page-on.html`
- Modify: `docs/superpowers/specs/2026-10-14-files-html-preview-design.md` (Status line only)

**Interfaces:**
- Consumes: the exact policy strings — the app `csp` from `src-tauri/tauri.conf.json` (after Task 2) and `CSP_OFF` / `CSP_ON` from `src-tauri/src/files/html.rs`.

The runner (reuse `tmp/csp-probe`'s Swift runner if present) loads `parent.html` from `probe://localhost/` with the app `csp` as a `Content-Security-Policy` response header, plus `'nonce-probe'` in `script-src` for the probe's own listener only. It registers a `WKURLSchemeHandler` for `herdly-html` serving `/off` with `CSP_OFF` and `/on` with `CSP_ON`, and logs to stdout every `securitypolicyviolation` (parent and frames, via `postMessage` to the parent and a `WKScriptMessageHandler`) and every URL the handlers are asked for. `parent.html` embeds `<iframe sandbox="" src="herdly-html://localhost/off">` and `<iframe sandbox="allow-scripts" src="herdly-html://localhost/on">`. Each page has an inline script that posts `ran`, tries `parent.document` and posts the error name, calls `fetch("https://canary.invalid/f")`, then sets `location = "https://canary.invalid/nav"`; plus `<img src="https://canary.invalid/i.png">` and `<script src="https://canary.invalid/s.js">`.

- [ ] **Step 1: Build and run the probe**

Run: `swiftc -o tmp/html-probe/probe tmp/html-probe/main.swift && tmp/html-probe/probe`
Expected output, all of it:
- both frames load (no `frame-src` violation on the parent for `herdly-html:`);
- `off`: no `ran`; `img-src` and `script-src` violations for the canaries;
- `on`: `ran`; `parent.document` → `SecurityError`; `connect-src` violation for the `fetch`; the `https:` `<img>`/`<script>` are attempted (allowed by `CSP_ON`);
- the `location = "https://…"` navigation is blocked by the parent's `frame-src` (violation on the parent, the frame stays on `herdly-html://localhost/on`).

If any line differs, stop and report it; do not change the policies to make the probe pass.

- [ ] **Step 2: Mark the spec implemented and commit**

Change the spec's `Status: approved` to `Status: implemented`.

```bash
git add docs/superpowers/specs/2026-10-14-files-html-preview-design.md
git commit -m "docs(files): HTML preview implemented"
```

Then tell the user the residual check from the spec: open the app once, render a report with Scripts off and on, and look at the Web Inspector console.
