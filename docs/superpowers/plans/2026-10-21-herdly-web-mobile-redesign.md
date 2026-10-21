# Herdly Web Mobile Redesign Implementation Plan

> **For agentic workers:** Execute this plan task by task with the executing-plans skill. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle Herdly Web's phone UI after the desktop app and rework its UX: a status-first Pane list, folded work blocks in the Transcript, a Send/Stop Composer with per-Pane drafts, a header with a ⋯ menu, a need-you chip and a Pane sheet, and small client-side conveniences.

**Architecture:** Frontend only, all in `web/`. One plain stylesheet `web/src/styles.css` with tokens copied from the desktop; components switch from inline styles to `className`. The Transcript reuses the desktop's pure `src/chat/workBlocks.ts` through the `@desktop` alias. No server, no desktop change.

**Tech Stack:** React 19, Vite 8, zustand 5, react-markdown 10 + rehype-highlight, vitest 5 + testing-library + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-21-herdly-web-mobile-redesign-design.md`

## Global Constraints

- **Full suite:**
  - `pnpm --dir web test`
  - `pnpm --dir web typecheck`
  Gate: after every task.
- **Setup:** the worktree has no `web/node_modules`; run `pnpm --dir web install` once before the first task.
- A task's own tests run with `pnpm --dir web exec vitest run <path relative to web/>`, e.g. `pnpm --dir web exec vitest run src/list/order.test.ts`.
- Nothing under `src/` or `src-tauri/` is edited. Desktop code is used only through `@desktop/<module>` imports of the modules listed in `ALLOWED` in `web/src/importGuard.test.ts`.
- zustand 5: a `useWeb` selector returns a store reference or a primitive, never a freshly built object or array (that loops the render). Derive lists with `useMemo` from `useWeb((s) => s.machines)`.
- All CSS goes in `web/src/styles.css`, one commented section per component (`/* ---------- Pane list ---------- */`). Colours, radii, shadows and easing come only from the `:root` tokens (`var(--…)`), plus the agent-mark colours `#d97757` and `#fff` named in Task 4. No new inline `style` objects; an element a task rewrites loses its inline style; Task 11 removes whatever is left. The Composer textarea's computed `height` is set from an effect, not a JSX prop.
- Status tones: `blocked` → `--amber`, `working` → `--blue`, `done` → `--green`, `idle` and `unknown` → `--grey`. Status UI uses the `.status` element from Task 1: `<span class="status" data-status={status}>{status}</span>`.
- Tap targets are at least 44×44 px. Icon-only buttons have an `aria-label`.
- UI text is English and matches the strings in the tests exactly.
- Load-bearing selectors stay: `data-pane`, `data-status`, `data-transcript`, `data-pending`, `data-prompt`, `aria-label="Back"`, `aria-label="Message"`, `aria-label="Answer"`, `role="alert"`.
- Timings and limits live in `web/src/config.ts`: `COPIED_MS = 1500`, `CTRL_C_CONFIRM_MS = 3000`, `VIBRATE_MS = 200`, `COMPOSER_MAX_ROWS = 6`, `DRAFT_PREFIX = "herdly-web:draft:"`.
- `CHAT_AGENTS` and `canChat` live in `web/src/config.ts` (Task 1). Every "can this Pane open a Chat" check uses `canChat`.
- Commit messages follow the repo: `feat(web-ui): …`, `fix(web-ui): …`, `test(web-ui): …`; no attribution lines.

## Review Focus

- Switching from Pane A to Pane B by the sheet or the chip → B shows its own draft, no pending bubble or prompt card from A; pinned by the App tests in Task 6 (switch) and Task 7 (drafts).
- An Append while a live work block is open → narration already shown is not parsed again; pinned in Task 8.
- `pnpm build` → no font is inlined as `data:` (the CSP would block it); pinned in Task 1 (unit) and Task 12 (built CSS).
- One tap on Ctrl+C → nothing is sent until a second tap within 3 s; pinned in Task 6.
- Another blocked Pane whose agent is not Claude or pi → not counted by the need-you chip and never opened by it; pinned in Task 6.

---

### Task 1: Visual foundation

**Files:**
- Create: `web/src/styles.css`
- Create: `web/src/fonts/` (copies of `src/fonts/fonts.css` and the six `src/fonts/*.woff2`)
- Create: `web/src/config.test.ts`
- Modify: `web/src/config.ts`
- Modify: `web/vite.config.ts`
- Modify: `web/index.html`
- Modify: `web/src/main.tsx`
- Modify: `web/src/chat/highlight.css`
- Modify: `web/src/list/PaneList.tsx:5` (import `canChat` instead of its local `CHAT_AGENTS`)

**Interfaces:**
- Produces: `CHAT_AGENTS: string[]`, `canChat(p: { agent: string | null }): boolean`, `assetsInline(file: string): false | undefined`, `COPIED_MS`, `CTRL_C_CONFIRM_MS`, `VIBRATE_MS`, `COMPOSER_MAX_ROWS`, `DRAFT_PREFIX` in `web/src/config.ts`; the CSS tokens and the shared classes `.status`, `.btn`, `.icon-btn`, `.banner`, `.banner-err`, `.banner-warn` in `web/src/styles.css`.

- [ ] **Step 1: Write the failing test** `web/src/config.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { assetsInline, canChat, CHAT_AGENTS } from "./config";

describe("canChat", () => {
  it("accepts Claude Code and pi only", () => {
    expect(CHAT_AGENTS).toEqual(["claude", "pi"]);
    expect(canChat({ agent: "claude" })).toBe(true);
    expect(canChat({ agent: "pi" })).toBe(true);
    expect(canChat({ agent: "codex" })).toBe(false);
    expect(canChat({ agent: null })).toBe(false);
  });
});

describe("vite build", () => {
  it("never inlines a font, so the CSP's default-src 'self' can load it", () => {
    expect(assetsInline("/w/src/fonts/jetbrains-mono-vietnamese-400-normal.woff2")).toBe(false);
    expect(assetsInline("/w/src/icon.svg")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --dir web exec vitest run src/config.test.ts`
Expected: FAIL: `canChat` and `assetsInline` are not exported (`TypeError: ... is not a function`).

- [ ] **Step 3: Implement config and the build setting**

- `web/src/config.ts`: add `CHAT_AGENTS = ["claude", "pi"]`, `canChat(p: { agent: string | null }): boolean` (true when `p.agent` is in `CHAT_AGENTS`), `assetsInline(file: string): false | undefined` (`false` for a path ending `.woff2`, else `undefined`, which leaves Vite's default), and the five constants from Global Constraints.
- `web/src/list/PaneList.tsx`: drop its local `CHAT_AGENTS` and use `canChat(pane)` where it checks `CHAT_AGENTS.includes`.
- `web/vite.config.ts`: `import { assetsInline } from "./src/config";` and add `build: { assetsInlineLimit: assetsInline }`. The build in Step 6 proves the wiring.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --dir web exec vitest run src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Add the stylesheet, fonts and page meta**

- Copy `src/fonts/fonts.css` and the six `src/fonts/*.woff2` into `web/src/fonts/` unchanged.
- `web/src/styles.css`, imported once from `web/src/main.tsx` (`import "./styles.css";`, before `App`):
  - `@import "./fonts/fonts.css";` first.
  - `:root` tokens copied from `src/styles.css:1-80` with the values unchanged, keeping only: `--surface-0`, `--surface-1`, `--surface-2`, `--surface-3`, `--surface-code`, `--hover`, `--active`, `--fg`, `--fg-2`, `--fg-3`, `--line`, `--line-2`, `--line-3`, `--accent`, `--accent-fg`, `--accent-soft`, `--ring`, `--amber`, `--blue`, `--green`, `--grey`, `--err`, `--err-fg`, `--scrim`, `--link`, `--code-head`, `--code-inline`, every `--hl-*`, `--r-sm`, `--r-md`, `--r-lg`, every `--shadow-*`, `--ease`, `--t-fast`, `--t`, `--mono`. A comment above says `/* Copied from src/styles.css:1-80; keep the values in sync by hand. */`.
  - Base: `*, *::before, *::after { box-sizing: border-box }`; `html, body, #root { margin: 0; height: 100%; background: var(--surface-0); color: var(--fg); color-scheme: dark }`; body font `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`, 15px, line-height 1.5; `-webkit-tap-highlight-color: transparent`; `code, pre, kbd { font-family: var(--mono) }`; `::selection` uses `--accent-soft`.
  - `button`: inherit font and colour, no default border or background, `cursor: pointer`, `:focus-visible { outline: none; box-shadow: var(--ring) }`, `:disabled { opacity: .45; cursor: default }`.
  - `.btn`: min-height 44px, padding 0 14px, `--surface-2` background, `1px solid var(--line-2)` border, `--r-md` radius, `:active` → `--surface-3`.
  - `.icon-btn`: 44×44, round, centred content, transparent; `:active` → `--active`.
  - `.status`: inline-flex, gap 6px, font-size 12px, `color: var(--tone)`; `::before` an 8px circle in `var(--tone)`; `[data-status="blocked"] { --tone: var(--amber) }`, working `--blue`, done `--green`, idle and unknown `--grey`.
  - `.banner`: padding 10px 16px, font-size 14px, flex row, gap 8px, align center; `.banner-err` background `color-mix(in srgb, var(--err) 18%, transparent)`, colour `--err-fg`; `.banner-warn` background `color-mix(in srgb, var(--amber) 16%, transparent)`, colour `--amber`.
- `web/src/chat/highlight.css`: map `.hljs-comment, .hljs-quote` → `--hl-comment` (italic); `.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag` → `--hl-keyword`; `.hljs-string, .hljs-regexp, .hljs-addition` → `--hl-string`; `.hljs-number, .hljs-symbol, .hljs-bullet` → `--hl-number`; `.hljs-title, .hljs-section, .hljs-name` → `--hl-title`; `.hljs-type, .hljs-built_in` → `--hl-type`; `.hljs-attr, .hljs-attribute` → `--hl-attr`; `.hljs-meta` → `--hl-meta`; `.hljs-deletion` → `--err`; keep emphasis and strong. Delete the `prefers-color-scheme` block.
- `web/index.html`: the viewport meta becomes `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`; add `<meta name="theme-color" content="#1a1b1f" />`.

- [ ] **Step 6: Build and check no font is inlined**

Run: `pnpm --dir web build`
Expected: exit 0.
Run: `grep -c 'data:font' web/dist/assets/*.css`
Expected: `0`.
Run: `ls web/dist/assets | grep -c woff2`
Expected: `6`.

- [ ] **Step 7: Commit**

```bash
git add web/src/styles.css web/src/fonts web/src/config.ts web/src/config.test.ts web/vite.config.ts web/index.html web/src/main.tsx web/src/chat/highlight.css web/src/list/PaneList.tsx
git commit -m "feat(web-ui): desktop tokens, fonts and base styles"
```

---

### Task 2: UI primitives (icons, copy, Sheet)

**Files:**
- Create: `web/src/ui/icons.tsx`
- Create: `web/src/ui/copy.ts`, `web/src/ui/copy.test.ts`
- Create: `web/src/ui/CopyButton.tsx`, `web/src/ui/CopyButton.test.tsx`
- Create: `web/src/ui/Sheet.tsx`, `web/src/ui/Sheet.test.tsx`
- Modify: `web/src/styles.css` (sections "Copy button", "Sheet")

**Interfaces:**
- Consumes: `COPIED_MS` from `web/src/config.ts`.
- Produces:
  - `BackIcon`, `ChevronIcon`, `SendIcon`, `StopIcon`, `MoreIcon`, `ArrowDownIcon`: `(props: SVGProps<SVGSVGElement>) => JSX.Element`, 20×20, `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `strokeWidth={2}`, round caps and joins, `aria-hidden="true"`. `StopIcon` is a filled rounded square (`fill="currentColor"`).
  - `copyText(text: string): boolean`.
  - `CopyButton({ text, className }: { text: string | (() => string); className?: string }): JSX.Element`.
  - `Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }): JSX.Element`.

- [ ] **Step 1: Write the failing tests**

`web/src/ui/copy.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copy";

afterEach(() => {
  delete (document as { execCommand?: unknown }).execCommand;
});

describe("copyText", () => {
  it("copies through a selected off-screen textarea and removes it", () => {
    let seen: string | null = null;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((cmd: string) => {
        seen = cmd === "copy" ? (document.activeElement as HTMLTextAreaElement).value : null;
        return true;
      }),
    });
    expect(copyText("pnpm test")).toBe(true);
    expect(seen).toBe("pnpm test");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns false when the browser refuses or throws, and still removes the textarea", () => {
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    expect(copyText("x")).toBe(false);
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => { throw new Error("no"); }) });
    expect(copyText("x")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});
```

`web/src/ui/CopyButton.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as copy from "./copy";
import { CopyButton } from "./CopyButton";

vi.mock("./copy", () => ({ copyText: vi.fn() }));
afterEach(() => vi.useRealTimers());

describe("CopyButton", () => {
  it("copies the text as it is at tap time and says so for 1.5 s", () => {
    vi.useFakeTimers();
    vi.mocked(copy.copyText).mockReturnValue(true);
    let text = "first";
    render(<CopyButton text={() => text} />);
    text = "second";
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copy.copyText).toHaveBeenCalledWith("second");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("says when copying failed", () => {
    vi.mocked(copy.copyText).mockReturnValue(false);
    render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button", { name: "Copy failed" })).toBeInTheDocument();
  });
});
```

`web/src/ui/Sheet.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

describe("Sheet", () => {
  it("is a labelled modal dialog that closes on the scrim and on Escape, not on its content", () => {
    const onClose = vi.fn();
    render(<Sheet title="Panes" onClose={onClose}><p>inside</p></Sheet>);
    const dialog = screen.getByRole("dialog", { name: "Panes" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Panes")).toBeInTheDocument();
    fireEvent.click(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector("[data-scrim]")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Add stubs and see the tests fail**

Add `copyText` returning `false` without touching the DOM, `CopyButton` rendering `<button type="button">Copy</button>` that does nothing, and `Sheet` rendering `<div>{children}</div>`.
Run: `pnpm --dir web exec vitest run src/ui`
Expected: FAIL on `expect(copyText("pnpm test")).toBe(true)`, on `toHaveBeenCalledWith("second")`, and on `getByRole("dialog", { name: "Panes" })`.

- [ ] **Step 3: Implement**

- `copy.ts`: create a `<textarea readonly>` with the text, positioned `fixed` at `top: 0; left: -9999px`, append to `document.body`, `focus()`, `select()`, call `document.execCommand("copy")` in try/catch, remove the textarea in `finally`, return the call's boolean result (false on throw). The `style` assignment here is DOM code, not a React inline style.
- `CopyButton.tsx`: `<button type="button" class="copy-btn {className}">` whose text is `Copy`, then `Copied` or `Copy failed` for `COPIED_MS`, then `Copy` again; reads `text` (calling it when a function) at click time; clears its timer on unmount.
- `icons.tsx`: the six icons from Interfaces (back: a left chevron; chevron: a right chevron, rotated by CSS when open; send: an up arrow; more: three horizontal dots; arrow-down: a down arrow).
- `Sheet.tsx`: renders `<div class="sheet-root"><div class="sheet-scrim" data-scrim onClick={onClose} /><div class="sheet" role="dialog" aria-modal="true" aria-label={title}><div class="sheet-grab" /><div class="sheet-title">{title}</div><div class="sheet-body">{children}</div></div></div>`; a `keydown` listener on `document` calls `onClose` for `Escape` and is removed on unmount.
- CSS: `.copy-btn` small (font-size 12px, min-height 32px within a 44px tap area via padding, `--fg-2`, `--surface-2`, `--r-sm`). `.sheet-root` fixed inset 0, z-index 30; `.sheet-scrim` absolute inset 0, `--scrim` background; `.sheet` absolute bottom 0, full width, max-height 80dvh, overflow-y auto, `--surface-1`, top radius `--r-lg`, `--shadow-dialog`, padding-bottom `env(safe-area-inset-bottom)`, slides up with `transform` over `var(--t)` `var(--ease)`; `.sheet-grab` 36×4 px, `--line-3`, centred, margin 8px auto; `.sheet-title` 13px, `--fg-2`, uppercase, padding 4px 16px 8px.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm --dir web exec vitest run src/ui`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/ui web/src/styles.css
git commit -m "feat(web-ui): icons, copy without the clipboard API, bottom sheet"
```

---

### Task 3: Group Panes by status

**Files:**
- Modify: `web/src/list/order.ts` (replace `groupSession`)
- Modify: `web/src/list/order.test.ts` (replace the `groupSession` tests)
- Modify: `web/src/list/PaneList.tsx` (only as needed to keep compiling; Task 4 rewrites it)

**Interfaces:**
- Produces, in `web/src/list/order.ts`:
  - `interface PaneRow { session: string; workspace: string; workspace_id: string; pane: PaneView; status: AgentStatus }` (`status` is the shown status).
  - `interface StatusGroups { needs: PaneRow[]; working: PaneRow[]; done: PaneRow[]; idle: PaneRow[]; stopped: string[]; failed: { name: string; message: string }[] }`.
  - `groupByStatus(sessions: SessionView[], shown?: (key: string, s: AgentStatus) => AgentStatus): StatusGroups`: `shown` defaults to returning `s`; `key` is `webKey({ session, pane_id })`.
  - `findRow(sessions: SessionView[], pane: WebPane): PaneRow | null` (raw status).
  - `rowPane(r: PaneRow): WebPane`.
  - `orderSessions` is kept as it is.

- [ ] **Step 1: Write the failing test**: replace `web/src/list/order.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { findRow, groupByStatus, orderSessions, rowPane } from "./order";

const p = (id: string, status: string, agent: string | null = "claude") => ({ pane_id: id, terminal_id: "t" + id, title: id, cwd: null, agent, status });
const session = (name: string, running: boolean, workspaces: unknown[], error: unknown = null) => ({ name, running, status: "idle", error, workspaces });
const ws = (label: string, panes: unknown[], id = label) => ({ workspace_id: id, label, number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] });
const ids = (rows: { pane: { pane_id: string } }[]) => rows.map((r) => r.pane.pane_id);

describe("order", () => {
  it("puts running sessions first and keeps herdr's order otherwise", () => {
    const ss = [session("a", false, []), session("b", true, []), session("c", true, [])] as never[];
    expect(orderSessions(ss).map((s: { name: string }) => s.name)).toEqual(["b", "c", "a"]);
  });

  it("groups Panes by status across Sessions, running Sessions first, then herdr's order", () => {
    const ss = [
      session("old", false, []),
      session("b", true, [ws("api", [p("1", "working"), p("2", "blocked")]), ws("web", [p("3", "done"), p("4", "idle", null)])]),
      session("a", true, [ws("docs", [p("5", "unknown"), p("6", "blocked")])]),
    ];
    const g = groupByStatus(ss as never);
    expect(ids(g.needs)).toEqual(["2", "6"]);
    expect(ids(g.working)).toEqual(["1"]);
    expect(ids(g.done)).toEqual(["3"]);
    expect(ids(g.idle)).toEqual(["4", "5"]);
    expect(g.stopped).toEqual(["old"]);
    expect(g.failed).toEqual([]);
    expect(g.needs[0]).toMatchObject({ session: "b", workspace: "api", workspace_id: "api", status: "blocked" });
    expect(rowPane(g.needs[1])).toEqual({ session: "a", pane_id: "6" });
  });

  it("files a Pane under its shown status", () => {
    const s = session("s", true, [ws("w", [p("1", "done"), p("2", "done")])]);
    const g = groupByStatus([s] as never, (key, st) => (key === "s/1" ? "idle" : st));
    expect(ids(g.done)).toEqual(["2"]);
    expect(ids(g.idle)).toEqual(["1"]);
    expect(g.idle[0].status).toBe("idle");
    expect(g.idle[0].pane.status).toBe("done");
  });

  it("lists a running Session that failed to load, and keeps two Workspaces with one label apart", () => {
    const ss = [
      session("x", true, [], { code: "herdr_error", message: "socket gone" }),
      session("s", true, [ws("herdly", [p("1", "idle")], "w1"), ws("herdly", [p("2", "idle")], "w2")]),
    ];
    const g = groupByStatus(ss as never);
    expect(g.failed).toEqual([{ name: "x", message: "socket gone" }]);
    expect(g.stopped).toEqual([]);
    expect(g.idle.map((r) => r.workspace_id)).toEqual(["w1", "w2"]);
  });

  it("finds a Pane's row by Session and pane id", () => {
    const ss = [session("a", true, [ws("api", [p("1", "working")])]), session("b", true, [ws("web", [p("1", "idle")])])];
    expect(findRow(ss as never, { session: "b", pane_id: "1" })).toMatchObject({ session: "b", workspace: "web", status: "idle" });
    expect(findRow(ss as never, { session: "c", pane_id: "1" })).toBeNull();
  });
});
```

- [ ] **Step 2: Add stubs and see it fail**

Add `groupByStatus` returning every list empty, `findRow` returning `null`, and `rowPane` returning `{ session: "", pane_id: "" }`. Make `PaneList.tsx` compile by keeping a private copy of the old grouping inside it until Task 4.
Run: `pnpm --dir web exec vitest run src/list/order.test.ts`
Expected: FAIL on `expect(ids(g.needs)).toEqual(["2", "6"])` (got `[]`).

- [ ] **Step 3: Implement `groupByStatus`, `findRow`, `rowPane` in `web/src/list/order.ts`**

Walk `orderSessions(sessions)`. A Session with `running === false` goes to `stopped` by name. A running one with a non-null `error` and no Workspaces goes to `failed` with `error.message`. Every Pane of every Tab of every Workspace becomes a `PaneRow` with `workspace = w.label` and `status = shown(webKey(...), pane.status)`, pushed to `needs` for `blocked`, `working`, `done`, else `idle`. Delete `groupSession`.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --dir web exec vitest run src/list/order.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/list/order.ts web/src/list/order.test.ts web/src/list/PaneList.tsx
git commit -m "feat(web-ui): group Panes by status across Sessions"
```

---

### Task 4: Pane list screen

**Files:**
- Create: `web/src/list/PaneCard.tsx`
- Create: `web/src/list/PaneGroups.tsx`
- Modify: `web/src/list/PaneList.tsx` (rewrite)
- Modify: `web/src/list/PaneList.test.tsx`
- Modify: `web/src/styles.css` (section "Pane list")

**Interfaces:**
- Consumes: `groupByStatus`, `rowPane`, `PaneRow`, `StatusGroups` from `web/src/list/order.ts`; `shownStatus`, `markSeen` from `web/src/list/seen.ts`; `canChat` from `web/src/config.ts`; `.status` and `.banner` classes.
- Produces:
  - `PaneCard({ row, current, hint, onTap }: { row: PaneRow; current: boolean; hint: boolean; onTap(): void }): JSX.Element`: an `<li>` holding `<button data-pane={key} aria-current={current ? "true" : undefined}>`.
  - `AgentMark({ agent }: { agent: string | null }): JSX.Element`, exported from `PaneCard.tsx`.
  - `PaneGroups({ machine, current, onOpen }: { machine: MachineView | undefined; current: string | null; onOpen(p: WebPane): void }): JSX.Element`.
  - `PaneList({ onOpen }: { onOpen(p: WebPane): void })`: same signature as today.

- [ ] **Step 1: Write the failing test**: replace `web/src/list/PaneList.test.tsx` with:

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWeb } from "../store";
import { PaneList } from "./PaneList";

const p = (id: string, status: string, agent: string | null) => ({ pane_id: id, terminal_id: "t", title: "title " + id, cwd: null, agent, status });
const ws = (panes: unknown[], id = "w") => ({ workspace_id: id, label: "herdly", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] });
const machine = (panes: unknown[], error: unknown = null, more: unknown[] = []) => ({
  id: "local", label: "local", kind: "local", state: "connected", error, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [ws(panes)] }, ...more],
});
const card = (title: string) => screen.getByText(title).closest("[data-pane]")!;
const shown = (title: string) => card(title).querySelector("[data-status]")!.getAttribute("data-status");

beforeEach(() => {
  localStorage.clear();
  useWeb.setState({ conn: "open", machines: [machine([p("1", "done", "claude"), p("2", "blocked", "claude"), p("3", "idle", null)])] as never, chats: {} });
});

describe("PaneList", () => {
  it("shows Needs you first with its count and opens a chat-capable pane, marking a done one seen", () => {
    const onOpen = vi.fn();
    render(<PaneList onOpen={onOpen} />);
    const heads = [...document.querySelectorAll("h2")].map((h) => h.firstElementChild?.textContent);
    expect(heads).toEqual(["Needs you", "Done", "Idle"]);
    expect(screen.getByText("Needs you").nextElementSibling?.textContent).toBe("1");
    expect(shown("title 1")).toBe("done");
    fireEvent.click(card("title 1"));
    expect(onOpen).toHaveBeenCalledWith({ session: "default", pane_id: "1" });
    expect(shown("title 1")).toBe("idle");
  });

  it("explains panes without a chat lens", () => {
    const onOpen = vi.fn();
    render(<PaneList onOpen={onOpen} />);
    fireEvent.click(screen.getByText("title 3"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText("Chat lens supports Claude Code and pi only")).toBeInTheDocument();
  });

  it("updates a badge from a pane_status frame and clears the seen mark", () => {
    render(<PaneList onOpen={() => {}} />);
    fireEvent.click(screen.getByText("title 1"));
    const status = (s: string, previous: string) => act(() => useWeb.getState().apply({ type: "pane_status", ev: { pane: { machine_id: "local", session: "default", pane_id: "1" }, status: s, previous, title: "title 1" } } as never));
    status("working", "done");
    expect(shown("title 1")).toBe("working");
    status("done", "working");
    expect(shown("title 1")).toBe("done");
  });

  it("shows the machine's error as a banner", () => {
    useWeb.setState({ machines: [{ ...machine([], { code: "herdr_not_found", message: "herdr not found" }), state: "error" }] as never });
    render(<PaneList onOpen={() => {}} />);
    expect(screen.getByText("herdr not found")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it("names each card's Session and Workspace, so two Workspaces sharing a label stay apart", () => {
    const m = machine([p("1", "idle", "claude")]);
    m.sessions[0].workspaces = [ws([p("1", "idle", "claude")], "w1"), ws([p("2", "idle", "claude")], "w2")];
    useWeb.setState({ machines: [m] as never });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<PaneList onOpen={() => {}} />);
      expect(screen.getAllByText("default › herdly")).toHaveLength(2);
      expect(screen.getByText("title 1")).toBeInTheDocument();
      expect(screen.getByText("title 2")).toBeInTheDocument();
      expect(errors.mock.calls.map((c) => String(c[0])).filter((t) => t.includes("same key"))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("lists stopped Sessions and Sessions that failed to load", () => {
    const more = [
      { name: "carex", running: false, status: "unknown", error: null, workspaces: [] },
      { name: "probe", running: false, status: "unknown", error: null, workspaces: [] },
      { name: "tasipay", running: true, status: "unknown", error: { code: "herdr_error", message: "socket gone" }, workspaces: [] },
    ];
    useWeb.setState({ machines: [machine([p("1", "idle", "claude")], null, more)] as never });
    render(<PaneList onOpen={() => {}} />);
    expect(screen.getByText("Stopped: carex, probe")).toBeInTheDocument();
    expect(screen.getByText("tasipay: socket gone")).toBeInTheDocument();
  });

  it("says No Panes only once a machine view has arrived", () => {
    useWeb.setState({ machines: [] });
    const { rerender } = render(<PaneList onOpen={() => {}} />);
    expect(screen.queryByText("No Panes")).toBeNull();
    useWeb.setState({ machines: [machine([])] as never });
    rerender(<PaneList onOpen={() => {}} />);
    expect(screen.getByText("No Panes")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --dir web exec vitest run src/list/PaneList.test.tsx`
Expected: FAIL: the first test fails on the heading list (got `["default"]`-style headings from today's tree), and the stopped, failed and "No Panes" tests fail on their `getByText`.

- [ ] **Step 3: Implement `PaneCard`, `PaneGroups`, `PaneList`**

- `PaneCard`: the button's children are `AgentMark`, then a `.pane-card-text` column with the title (`.pane-card-title`, one line, ellipsis) and `${row.session} › ${row.workspace}` (`.pane-card-sub`), then `<span class="status" data-status={row.status}>{row.status}</span>`. Classes on the button: `pane-card`, plus `pane-card-blocked` when `row.status === "blocked"`, `pane-card-dim` when `!canChat(row.pane)`. When `hint` is true, the `<li>` also holds `<div class="pane-card-hint">Chat lens supports Claude Code and pi only</div>`. The key is `webKey(rowPane(row))`.
- `AgentMark`: a 28 px rounded square `.agent-mark` with a glyph: `claude` → `✳` on `#d97757`, `pi` → `π` on `var(--accent)`, anything else → `>_` on `var(--surface-3)`, via classes `.agent-claude`, `.agent-pi`, `.agent-other`.
- `PaneGroups`: `const groups = useMemo(() => groupByStatus(machine?.sessions ?? [], shownStatus), [machine, bump])` where `bump` is a counter state increased after `markSeen`. Each non-empty group renders `<section><h2 class="group-head"><span>{label}</span><span class="group-count">{n}</span></h2><ul class="pane-cards">…</ul></section>` with labels `Needs you`, `Working`, `Done`, `Idle`. Tapping a card: when `!canChat(row.pane)` set the hint key and stop; when `row.pane.status === "done"`, `markSeen(key)` and bump; then `onOpen(rowPane(row))`. Then one `<p class="session-failed">{name}: {message}</p>` per failed Session and `<p class="sessions-stopped">Stopped: {names joined by ", "}</p>` when any are stopped. Groups' heading text is in title case in the DOM; CSS uppercases it.
- `PaneList`: `const machine = useWeb((s) => s.machines[0])`; a sticky `<header class="list-header">` with `<h1 class="list-title">Herdly</h1>` (an `h1`: the test reads the group headings as the page's `h2`s) and, when `machine` exists, `<span class="conn-dot" data-ok={machine.state === "connected"} />` and the machine label; the machine error as today but in `<div role="alert" class="banner banner-err"><strong>{state}</strong>: <span>{message}</span></div>`; `<PaneGroups machine={machine} current={null} onOpen={onOpen} />`; and `<p class="list-empty">No Panes</p>` when `machine` exists and all four groups are empty.
- CSS: `.list-header` sticky top 0, padding `calc(env(safe-area-inset-top) + 12px) 16px 12px`, `--surface-0` with a bottom `--line` border, title 17px semibold; `.conn-dot` 8px circle, `--green` when `data-ok="true"` else `--amber`. `.group-head` margin 20px 16px 8px, 12px, letter-spacing .06em, uppercase, `--fg-2`; the first group's head (Needs you) in `--amber`; `.group-count` margin-left 8px, `--fg-3`. `.pane-cards` list-style none, margin 0, padding 0 12px, flex column, gap 8px. `.pane-card` width 100%, flex row, gap 12px, align center, padding 12px, min-height 64px, text-align left, `--surface-1`, `1px solid var(--line)`, `--r-lg`, `:active` → `--surface-2`; `.pane-card-blocked` border `color-mix(in srgb, var(--amber) 55%, transparent)` and background `color-mix(in srgb, var(--amber) 8%, var(--surface-1))`; `.pane-card[aria-current="true"]` box-shadow `inset 3px 0 0 var(--accent)`; `.pane-card-dim` opacity .55. `.pane-card-text` flex 1, min-width 0; `.pane-card-title` 15px, ellipsis; `.pane-card-sub` 12px `--fg-3`, ellipsis. `.pane-card-hint` 13px `--fg-2`, padding 6px 12px 0. `.agent-mark` 28×28, `--r-md`, centred, 14px bold, colour `#fff` (`--fg` on `.agent-other`), mono for `.agent-other`. `.sessions-stopped`, `.session-failed`, `.list-empty` 13px, padding 12px 16px, `--fg-3` (`--err-fg` for failed). Page bottom padding `env(safe-area-inset-bottom)`.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --dir web exec vitest run src/list`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/list web/src/styles.css
git commit -m "feat(web-ui): Pane list by status with cards"
```

---

### Task 5: Attention and the app shell

**Files:**
- Create: `web/src/attention.ts`, `web/src/attention.test.tsx`
- Modify: `web/src/App.tsx` (call `useAttention`; restyle Not paired and the reconnect bar)
- Modify: `web/src/styles.css` (section "Shell")

**Interfaces:**
- Consumes: `VIBRATE_MS` from `web/src/config.ts`; `webKey` from `web/src/types.ts`; `useWeb` from `web/src/store.ts`.
- Produces: `blockedPanes(machines: MachineView[]): string[]`; `useAttention(): void`.

- [ ] **Step 1: Write the failing test** `web/src/attention.test.tsx`

```tsx
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockedPanes, useAttention } from "./attention";
import { useWeb } from "./store";

const pane = (id: string, status: string, agent = "claude") => ({ pane_id: id, terminal_id: "t" + id, title: "t" + id, cwd: null, agent, status });
const machine = (panes: unknown[]) => ({
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] }] }],
});
const status = (id: string, s: string, previous: string) =>
  act(() => useWeb.getState().apply({ type: "pane_status", ev: { pane: { machine_id: "local", session: "s", pane_id: id }, status: s, previous, title: "t" + id } } as never));
function Probe() {
  useAttention();
  return null;
}

let vibrate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
  document.title = "Herdly";
  useWeb.setState({ machines: [], chats: {}, open: null });
});
afterEach(() => {
  delete (navigator as { vibrate?: unknown }).vibrate;
});

describe("attention", () => {
  it("lists every blocked Pane whatever its agent", () => {
    expect(blockedPanes([machine([pane("1", "blocked"), pane("2", "working"), pane("3", "blocked", "codex")])] as never)).toEqual(["s/1", "s/3"]);
  });

  it("counts blocked Panes in the tab title", () => {
    useWeb.setState({ machines: [machine([pane("1", "blocked"), pane("2", "idle")])] as never });
    render(<Probe />);
    expect(document.title).toBe("(1) Herdly");
    status("2", "blocked", "idle");
    expect(document.title).toBe("(2) Herdly");
    status("1", "working", "blocked");
    status("2", "idle", "blocked");
    expect(document.title).toBe("Herdly");
  });

  it("vibrates when a known Pane turns blocked, never for the first view", () => {
    render(<Probe />);
    act(() => useWeb.setState({ machines: [machine([pane("1", "blocked"), pane("2", "working")])] as never }));
    expect(vibrate).not.toHaveBeenCalled();
    status("2", "blocked", "working");
    expect(vibrate).toHaveBeenCalledWith(200);
    status("2", "blocked", "blocked");
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("does nothing when vibration is missing", () => {
    delete (navigator as { vibrate?: unknown }).vibrate;
    useWeb.setState({ machines: [machine([pane("1", "idle")])] as never });
    render(<Probe />);
    expect(() => status("1", "blocked", "idle")).not.toThrow();
    expect(document.title).toBe("(1) Herdly");
  });
});
```

- [ ] **Step 2: Add stubs and see it fail**

`blockedPanes` returns `[]`; `useAttention` does nothing.
Run: `pnpm --dir web exec vitest run src/attention.test.tsx`
Expected: FAIL on `toEqual(["s/1", "s/3"])` (got `[]`) and on `expect(document.title).toBe("(1) Herdly")` (got `"Herdly"`).

- [ ] **Step 3: Implement `blockedPanes` and `useAttention` in `web/src/attention.ts`**

`useAttention` reads `useWeb((s) => s.machines)` and, in an effect on it: sets `document.title` to `` `(${n}) Herdly` `` when `n = blockedPanes(machines).length > 0`, else `"Herdly"`; then walks every Pane, and for each key whose previous status is in a `useRef<Map<string, AgentStatus>>` and is not `blocked` while the new one is `blocked`, calls `navigator.vibrate?.(VIBRATE_MS)` inside try/catch (once per effect run at most); finally stores every Pane's status in the ref.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --dir web exec vitest run src/attention.test.tsx`
Expected: PASS

- [ ] **Step 5: Wire it into the shell and restyle**

In `web/src/App.tsx`: call `useAttention()` at the top of `App` (before the early return for unpaired, so hook order is stable). `NotPaired` becomes `<main class="notpaired"><div class="notpaired-card"><h1>Not paired</h1><p>Open a pairing link from herdly-web pair on the devbox.</p></div></main>` (same text). The reconnect bar becomes `<div role="status" class="banner banner-warn reconnect">Disconnected, reconnecting…</div>`. CSS: `.notpaired` full height, centred; `.notpaired-card` `--surface-1`, `--r-lg`, padding 24px, max-width 340px, `--line` border, h1 20px; `.reconnect` sticky top 0, z-index 20, padding-top `calc(env(safe-area-inset-top) + 6px)`, 13px.

- [ ] **Step 6: Run the shell tests**

Run: `pnpm --dir web exec vitest run src/App.test.tsx src/attention.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/src/attention.ts web/src/attention.test.tsx web/src/App.tsx web/src/styles.css
git commit -m "feat(web-ui): blocked count in the tab title, vibration, restyled shell"
```

---

### Task 6: Chat header, ⋯ menu, need-you chip and Pane sheet

**Files:**
- Create: `web/src/chat/ChatHeader.tsx`, `web/src/chat/ChatHeader.test.tsx`
- Create: `web/src/chat/PaneSheet.tsx`
- Modify: `web/src/chat/ChatScreen.tsx` (header replaced; `onSwitch` prop; `StopBar` removed from `BottomBar`)
- Modify: `web/src/App.tsx` (`switchTo`, `key={openKey}`)
- Modify: `web/src/App.test.tsx` (one new test)
- Modify: `web/src/chat/ChatScreen.test.tsx` (the blocked test)
- Delete: `web/src/chat/StopBar.tsx`, `web/src/chat/StopBar.test.tsx`
- Modify: `web/src/styles.css` (section "Chat header")

**Interfaces:**
- Consumes: `findRow`, `groupByStatus`, `rowPane` from `web/src/list/order.ts`; `PaneGroups({ machine, current, onOpen })` from `web/src/list/PaneGroups.tsx`; `Sheet({ title, onClose, children })`, `BackIcon`, `MoreIcon` from `web/src/ui/`; `canChat`, `CTRL_C_CONFIRM_MS` from `web/src/config.ts`; `paneKeys(p: WebPane, keys: string[]): Promise<void>` from `web/src/api.ts`.
- Produces:
  - `ChatHeader({ pane, onBack, onSwitch }: { pane: WebPane; onBack(): void; onSwitch?(p: WebPane): void }): JSX.Element`.
  - `PaneSheet({ current, onClose, onSwitch }: { current: WebPane; onClose(): void; onSwitch(p: WebPane): void }): JSX.Element`.
  - `ChatScreen` gains the optional prop `onSwitch?(p: WebPane): void`.

- [ ] **Step 1: Write the failing tests**

`web/src/chat/ChatHeader.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useWeb } from "../store";
import { ChatHeader } from "./ChatHeader";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), paneKeys: vi.fn() }));

const pane = { session: "s", pane_id: "p1" };
const p = (id: string, title: string, status: string, agent = "claude") => ({ pane_id: id, terminal_id: "t" + id, title, cwd: null, agent, status });
const ws = (id: string, panes: unknown[]) => ({ workspace_id: id, label: id, number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] });
const machine = (p2status = "blocked") => ({
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [
    ws("w", [p("p1", "fix login", "working")]),
    ws("api", [p("p3", "codex task", "blocked", "codex"), p("p2", "review", p2status)]),
  ] }],
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.paneKeys).mockReset().mockResolvedValue(undefined as never);
  useWeb.setState({ conn: "open", machines: [machine()] as never, chats: {}, open: null });
});

describe("ChatHeader", () => {
  it("shows the Pane's title, place and status, and goes back", () => {
    const onBack = vi.fn();
    render(<ChatHeader pane={pane} onBack={onBack} />);
    expect(screen.getByText("fix login")).toBeInTheDocument();
    expect(screen.getByText("s › w")).toBeInTheDocument();
    expect(document.querySelector("header [data-status]")).toHaveAttribute("data-status", "working");
    fireEvent.click(screen.getByLabelText("Back"));
    expect(onBack).toHaveBeenCalled();
  });

  it("counts only other blocked chat Panes in the chip and jumps to the first", () => {
    const onSwitch = vi.fn();
    render(<ChatHeader pane={pane} onBack={() => {}} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByLabelText("1 need you"));
    expect(onSwitch).toHaveBeenCalledWith({ session: "s", pane_id: "p2" });
  });

  it("hides the chip when no other chat Pane is blocked", () => {
    useWeb.setState({ machines: [machine("idle")] as never });
    render(<ChatHeader pane={pane} onBack={() => {}} onSwitch={() => {}} />);
    expect(screen.queryByLabelText(/need you/)).toBeNull();
  });

  it("sends Esc from the menu at once and closes it", async () => {
    render(<ChatHeader pane={pane} onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText("More"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send Esc" }));
    await waitFor(() => expect(api.paneKeys).toHaveBeenCalledWith(pane, ["esc"]));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("asks twice before Ctrl+C, and forgets the first tap after 3 s", async () => {
    vi.useFakeTimers();
    try {
      render(<ChatHeader pane={pane} onBack={() => {}} />);
      fireEvent.click(screen.getByLabelText("More"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Send Ctrl+C" }));
      expect(api.paneKeys).not.toHaveBeenCalled();
      expect(screen.getByRole("menuitem", { name: "Tap again to send Ctrl+C" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(3000));
      fireEvent.click(screen.getByRole("menuitem", { name: "Send Ctrl+C" }));
      expect(api.paneKeys).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Tap again to send Ctrl+C" })));
      expect(api.paneKeys).toHaveBeenCalledWith(pane, ["ctrl+c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows why a key failed, in the menu", async () => {
    vi.mocked(api.paneKeys).mockRejectedValueOnce(new Error("pane gone"));
    render(<ChatHeader pane={pane} onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText("More"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send Esc" }));
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("alert")).toHaveTextContent("pane gone"));
  });

  it("closes the menu on a tap outside it", () => {
    render(<ChatHeader pane={pane} onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText("More"));
    fireEvent.click(document.querySelector("[data-backdrop]")!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the Pane sheet from the title; another Pane switches, the current one only closes", () => {
    const onSwitch = vi.fn();
    render(<ChatHeader pane={pane} onBack={() => {}} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /fix login/ }));
    const sheet = screen.getByRole("dialog", { name: "Panes" });
    expect(within(sheet).getByText("fix login").closest("[data-pane]")).toHaveAttribute("aria-current", "true");
    fireEvent.click(within(sheet).getByText("fix login"));
    expect(onSwitch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /fix login/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Panes" })).getByText("review"));
    expect(onSwitch).toHaveBeenCalledWith({ session: "s", pane_id: "p2" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

Add to `web/src/App.test.tsx` (inside the `describe`, with `within` added to the testing-library import):

```tsx
  it("switches Panes from the sheet: unsubscribes and clears the old, subscribes the new", () => {
    const a = { session: "s", pane_id: "p1" };
    const b = { session: "s", pane_id: "p2" };
    const pv = (id: string, title: string) => ({ pane_id: id, terminal_id: "t" + id, title, cwd: null, agent: "claude", status: "idle" });
    const m = { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
      sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes: [pv("p1", "alpha"), pv("p2", "beta")] }] }] }] };
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    useWeb.setState({ machines: [m] as never, open: a });
    act(() => useWeb.getState().apply({ type: "chat_opened", pane: a, located: { agent: "claude", path: "/t", ambiguous: false, candidates: [], pending: false } }));
    render(<App socket={socket as never} />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Panes" })).getByText("beta"));
    expect(socket.unsubscribe).toHaveBeenCalledWith(a);
    expect(socket.subscribe).toHaveBeenLastCalledWith(b);
    expect(useWeb.getState().open).toEqual(b);
    expect(useWeb.getState().chats["s/p1"]).toBeUndefined();
    expect(screen.getByRole("button", { name: /beta/ })).toBeInTheDocument();
  });
```

In `web/src/chat/ChatScreen.test.tsx`, rename the test `"replaces the Composer with the prompt card while blocked and keeps Esc and Ctrl+C"` to `"replaces the Composer with the prompt card while blocked; Esc and Ctrl+C are in the menu"`, and replace its two lines `expect(screen.getByText("Esc")).toBeInTheDocument();` and `expect(screen.getByText("Ctrl+C")).toBeInTheDocument();` with:

```tsx
    fireEvent.click(screen.getByLabelText("More"));
    expect(screen.getByRole("menuitem", { name: "Send Esc" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Send Ctrl+C" })).toBeInTheDocument();
```

- [ ] **Step 2: Add stubs and see the tests fail**

Add `ChatHeader` rendering only `<header><button aria-label="Back" onClick={onBack} /></header>` and `PaneSheet` rendering `null`; do not wire them yet.
Run: `pnpm --dir web exec vitest run src/chat/ChatHeader.test.tsx src/App.test.tsx src/chat/ChatScreen.test.tsx`
Expected: FAIL on `getByText("fix login")` in ChatHeader, on `getByRole("button", { name: /alpha/ })` in App, and on `getByLabelText("More")` in ChatScreen.

- [ ] **Step 3: Implement `ChatHeader` and `PaneSheet`**

- `ChatHeader` reads `const machines = useWeb((s) => s.machines)` and derives with `useMemo`: `row = findRow(sessions, pane)` and `groupByStatus(sessions)`, where `sessions = machines.flatMap((m) => m.sessions)`. It renders `<header class="chat-header">` with:
  - `<button class="icon-btn" aria-label="Back" onClick={onBack}><BackIcon /></button>`;
  - `<button class="chat-title" aria-haspopup="dialog" onClick={open sheet}>`: `<span class="chat-title-main">{row?.pane.title ?? pane.pane_id}</span>`, `<span class="chat-title-sub">{row ? `${row.session} › ${row.workspace}` : pane.session}</span>`, and `<span class="status" data-status={row?.status ?? "unknown"} />` (dot only; CSS hides its text with `font-size: 0` on `.chat-title .status`);
  - the chip, when `others = groups.needs.filter((r) => canChat(r.pane) && webKey(rowPane(r)) !== webKey(pane))` is non-empty and `onSwitch` is set: `<button class="need-chip" aria-label={`${others.length} need you`} onClick={() => onSwitch(rowPane(others[0]))}>● {others.length}</button>`;
  - `<button class="icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen}><MoreIcon /></button>`;
  - when the menu is open: `<div class="menu-backdrop" data-backdrop onClick={close} />` and `<div class="menu" role="menu">` with `<button role="menuitem">Send Esc</button>`, `<button role="menuitem">{armed ? "Tap again to send Ctrl+C" : "Send Ctrl+C"}</button>`, and `{error && <div role="alert" class="menu-error">{error}</div>}`.
  - Esc: `paneKeys(pane, ["esc"])`; on success close the menu, on failure keep it open with the error message (`e instanceof Error ? e.message : String(e)`).
  - Ctrl+C: the first tap sets `armed` and a `CTRL_C_CONFIRM_MS` timer that clears it; a tap while armed clears the timer and sends `["ctrl+c"]`, then behaves as Esc. Clear the timer on unmount and on menu close.
  - When the sheet is open: `<PaneSheet current={pane} onClose={close sheet} onSwitch={(p) => onSwitch?.(p)} />`.
- `PaneSheet`: `<Sheet title="Panes" onClose={onClose}><PaneGroups machine={machine} current={webKey(current)} onOpen={(p) => { onClose(); if (webKey(p) !== webKey(current)) onSwitch(p); }} /></Sheet>`, where `machine = useWeb((s) => s.machines[0])`.
- CSS: `.chat-header` flex row, gap 4px, align center, padding `calc(env(safe-area-inset-top) + 4px) 4px 4px`, `--surface-0`, bottom `--line` border. `.chat-title` flex 1, min-width 0, text-align left, padding 4px 8px, `--r-md`, grid with the title and the dot on the first row, the sub-line under it; `.chat-title-main` 15px semibold ellipsis; `.chat-title-sub` 12px `--fg-3` ellipsis. `.need-chip` min-height 32px inside a 44px tap area, padding 0 10px, round, `--amber` text, background `color-mix(in srgb, var(--amber) 16%, transparent)`, 13px semibold. `.menu-backdrop` fixed inset 0, z-index 25, transparent. `.menu` absolute, top 100%, right 8px, z-index 26, min-width 220px, `--surface-2`, `--line-2` border, `--r-md`, `--shadow-pop`, padding 4px; `[role="menuitem"]` block, full width, min-height 44px, padding 0 12px, text-align left, `--r-sm`, `:active` → `--active`; the armed Ctrl+C item in `--err-fg`. `.menu-error` 13px `--err-fg`, padding 6px 12px. `.chat-header` is `position: relative` so the menu anchors to it.

- [ ] **Step 4: Wire them in**

- `ChatScreen.tsx`: add `onSwitch?(p: WebPane): void` to its props; replace today's `<header>…</header>` with `<ChatHeader pane={pane} onBack={onBack} onSwitch={onSwitch} />`; remove `<StopBar pane={pane} />` from `BottomBar` and its import; delete `StopBar.tsx` and `StopBar.test.tsx`; delete the `BADGE` constant.
- `App.tsx`: `const switchTo = (next: WebPane) => { if (open) { socket?.unsubscribe(open); clearChat(webKey(open)); } openChat(next); };` and render `<ChatScreen key={openKey} pane={open} onBack={() => back(open)} onRetry={() => socket?.subscribe(open)} onSwitch={switchTo} />`.

- [ ] **Step 5: Run them and see them pass**

Run: `pnpm --dir web exec vitest run src/chat src/App.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A web/src
git commit -m "feat(web-ui): Chat header with Esc/Ctrl+C menu, need-you chip and Pane sheet"
```

---

### Task 7: Composer with Send/Stop and drafts per Pane

**Files:**
- Create: `web/src/chat/Composer.tsx`, `web/src/chat/Composer.test.tsx`
- Create: `web/src/chat/drafts.ts`, `web/src/chat/drafts.test.ts`
- Modify: `web/src/chat/ChatScreen.tsx` (`BottomBar` keeps living here; the old `Composer` function moves out)
- Modify: `web/src/chat/ChatScreen.test.tsx`
- Modify: `web/src/App.test.tsx` (one new test)
- Modify: `web/src/styles.css` (section "Composer")

**Interfaces:**
- Consumes: `paneKeys` from `web/src/api.ts`; `DRAFT_PREFIX`, `COMPOSER_MAX_ROWS` from `web/src/config.ts`; `SendIcon`, `StopIcon` from `web/src/ui/icons.tsx`.
- Produces:
  - `interface Draft { text: string; error: string | null }` exported from `Composer.tsx`.
  - `Composer({ pane, working, draft, setDraft, onSend }: { pane: WebPane; working: boolean; draft: Draft; setDraft(d: Draft): void; onSend(): void }): JSX.Element`.
  - `loadDraft(key: string): string`, `saveDraft(key: string, text: string): void` in `drafts.ts`; the storage key is `DRAFT_PREFIX + key`.

- [ ] **Step 1: Write the failing tests**

`web/src/chat/drafts.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDraft, saveDraft } from "./drafts";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("drafts", () => {
  it("keeps a draft per Pane", () => {
    saveDraft("s/p1", "half a thought");
    saveDraft("s/p2", "other");
    expect(loadDraft("s/p1")).toBe("half a thought");
    expect(localStorage.getItem("herdly-web:draft:s/p1")).toBe("half a thought");
    expect(loadDraft("s/p3")).toBe("");
  });

  it("removes a blank draft", () => {
    saveDraft("s/p1", "x");
    saveDraft("s/p1", "  \n");
    expect(localStorage.getItem("herdly-web:draft:s/p1")).toBeNull();
  });

  it("never throws when storage does", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => saveDraft("s/p1", "x")).not.toThrow();
    expect(() => saveDraft("s/p1", "")).not.toThrow();
    expect(loadDraft("s/p1")).toBe("");
  });
});
```

`web/src/chat/Composer.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { Composer, type Draft } from "./Composer";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), paneKeys: vi.fn() }));

const pane = { session: "s", pane_id: "p1" };
const onSend = vi.fn();
function Harness({ working, text = "", error = null }: { working: boolean; text?: string; error?: string | null }) {
  const [draft, setDraft] = useState<Draft>({ text, error });
  return <Composer pane={pane} working={working} draft={draft} setDraft={setDraft} onSend={onSend} />;
}

beforeEach(() => {
  onSend.mockReset();
  vi.mocked(api.paneKeys).mockReset().mockResolvedValue(undefined as never);
});

describe("Composer", () => {
  it("is Stop while working with a blank field, and Stop sends Esc", async () => {
    render(<Harness working />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.paneKeys).toHaveBeenCalledWith(pane, ["esc"]));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("turns into Send once something is typed, even while working", () => {
    render(<Harness working />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "also check lint" } });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("is a disabled Send when not working and the field is blank", () => {
    render(<Harness working={false} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows why Stop failed", async () => {
    vi.mocked(api.paneKeys).mockRejectedValueOnce(new Error("pane gone"));
    render(<Harness working />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("pane gone"));
  });

  it("shows the draft's send error", () => {
    render(<Harness working={false} text="hello" error="pane gone" />);
    expect(screen.getByRole("alert")).toHaveTextContent("pane gone");
  });
});
```

In `web/src/chat/ChatScreen.test.tsx`:
- `beforeEach` gains `localStorage.clear();` as its first line.
- Every `fireEvent.click(screen.getByText("Send"))` becomes `fireEvent.click(screen.getByRole("button", { name: "Send" }))` (four places), and `expect(screen.queryByText("Send")).toBeNull();` becomes `expect(screen.queryByRole("button", { name: "Send" })).toBeNull();`.
- Add these tests inside the `describe`:

```tsx
  it("keeps a Pane's draft across leaving and coming back", () => {
    open([]);
    const { unmount } = render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "half a thought" } });
    unmount();
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("half a thought");
  });

  it("clears the stored draft on send, and stores a failed send's text even after leaving", async () => {
    let reject!: (e: unknown) => void;
    vi.mocked(api.panePrompt).mockImplementation(() => new Promise((_, rj) => (reject = rj)));
    open([]);
    const { unmount } = render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(localStorage.getItem("herdly-web:draft:s/p1")).toBeNull();
    unmount();
    await act(async () => reject(new api.ApiError(502, "herdr_error", "pane gone")));
    expect(localStorage.getItem("herdly-web:draft:s/p1")).toBe("hello");
  });
```

Add to `web/src/App.test.tsx` (it reuses the two-Pane machine; lift `pv` and `m` from the Task 6 switch test to module level as `twoPanes` and use it in both):

```tsx
  it("gives each Pane its own Chat screen: a draft typed in one is not in the next", () => {
    localStorage.clear();
    const a = { session: "s", pane_id: "p1" };
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    useWeb.setState({ machines: [twoPanes] as never, open: a });
    render(<App socket={socket as never} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "draft A" } });
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Panes" })).getByText("beta"));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /beta/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Panes" })).getByText("alpha"));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("draft A");
  });
```

- [ ] **Step 2: Add stubs and see the tests fail**

Add `drafts.ts` with `loadDraft` returning `""` and `saveDraft` doing nothing; add `Composer.tsx` exporting `Draft` and a `Composer` that renders today's textarea and a text `Send` button (move today's `Composer` body there unchanged, taking the new props).
Run: `pnpm --dir web exec vitest run src/chat/drafts.test.ts src/chat/Composer.test.tsx src/chat/ChatScreen.test.tsx src/App.test.tsx`
Expected: FAIL on `expect(loadDraft("s/p1")).toBe("half a thought")` (got `""`), on `getByRole("button", { name: "Stop" })`, on the draft value `"half a thought"` after remount (got `""`), and on `"draft A"` after switching back (got `""`).

- [ ] **Step 3: Implement**

- `drafts.ts`: `loadDraft` returns `localStorage.getItem(DRAFT_PREFIX + key) ?? ""`; `saveDraft` removes the item when `text.trim() === ""`, else sets it; each call wrapped in try/catch (a throw means nothing is kept, and `loadDraft` returns `""`).
- `Composer.tsx`: `<div class="composer">`, then `{draft.error && <div role="alert" class="composer-error">{draft.error}</div>}` and `{stopError && <div role="alert" class="composer-error">{stopError}</div>}`, then a row: `<textarea aria-label="Message" rows={1} placeholder="Message" …>` and one `.send-btn` round button. `stop = working && draft.text.trim() === ""`. When `stop`: `aria-label="Stop"`, `<StopIcon />`, on click `paneKeys(pane, ["esc"])` and set `stopError` on failure (cleared on the next press). Else: `aria-label="Send"`, `<SendIcon />`, `disabled={draft.text.trim() === ""}`, `onClick={onSend}`. Auto-grow in a `useLayoutEffect` on `draft.text`: set the textarea's `style.height = "auto"`, then `style.height = Math.min(el.scrollHeight, rowHeight * COMPOSER_MAX_ROWS) + "px"`, where `rowHeight` is `parseFloat(getComputedStyle(el).lineHeight)` or 22 when that is not a number. Enter inserts a newline (no key handler).
- `ChatScreen.tsx` `BottomBar`:
  - takes the Pane's status (it already has `view`);
  - `const key = webKey(pane)`; `const [draft, setDraftState] = useState<Draft>(() => ({ text: loadDraft(key), error: null }))`;
  - `const setDraft = (d: Draft) => { setDraftState(d); saveDraft(key, d.text); }`;
  - in `send`: after clearing, `saveDraft(key, "")`; on failure `const cur = loadDraft(key); const restored = cur ? `${t}\n${cur}` : t; saveDraft(key, restored); setDraftState({ text: restored, error: errorText(e) });`;
  - renders `<Composer pane={pane} working={view?.status === "working"} draft={draft} setDraft={setDraft} onSend={send} />` when not blocked.
- CSS: footer `.chat-footer` padding `8px 12px calc(env(safe-area-inset-bottom) + 8px)`, `--surface-0`, top `--line` border. `.composer` flex column, gap 6px. The row: flex, gap 8px, align flex-end. The textarea: flex 1, resize none, 15px, line-height 22px, padding 10px 14px, `--surface-1`, `1px solid var(--line-2)`, radius 22px, `:focus` border `--accent` and no outline, overflow-y auto. `.send-btn` 44×44 round, `--accent` background, `--accent-fg` icon; `[aria-label="Stop"]` in `--err` with `--fg` icon; `:disabled` → `--surface-2` and `--fg-3`. `.composer-error` 13px `--err-fg`.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm --dir web exec vitest run src/chat src/App.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A web/src
git commit -m "feat(web-ui): auto-growing Composer with Send/Stop and a draft per Pane"
```

---

### Task 8: Work blocks in the Transcript

**Files:**
- Create: `web/src/chat/WorkBlock.tsx`
- Create: `web/src/chat/Transcript.test.tsx`
- Modify: `web/src/chat/ItemView.tsx` (rewrite)
- Modify: `web/src/chat/ChatScreen.tsx` (rows from `buildRows`)
- Modify: `web/src/importGuard.test.ts:7` (`"chat/workBlocks"` joins `ALLOWED`)
- Modify: `web/src/styles.css` (section "Transcript: work")

**Interfaces:**
- Consumes: from `@desktop/chat/workBlocks`: `buildRows(items: ChatItem[], offset?: number): { rows: ChatRow[]; results: Map<string, ToolResult> }`, `groupCalls(items: ChatItem[], live: boolean): WorkSegment[]` (`WorkSegment = { kind: "item"; item: ChatItem } | { kind: "calls"; calls: ToolCall[] }`), `workSummary(items: ChatItem[], results: Map<string, ToolResult>): string`, `formatWorkDuration(start: string | null, end: string | null): string | null`, types `ChatRow` (`{ kind: "item"; key; at; item } | { kind: "work"; key; at; block: WorkBlock; last: boolean }`), `WorkBlock` (`{ id: string; items: ChatItem[]; start: string | null; end: string | null }`), `ToolCall`, `ToolResult`; `checklist`, `checklistSummary` from `@desktop/chat/checklist`; `ChevronIcon` from `web/src/ui/icons.tsx`.
- Produces:
  - `ItemView({ item, result }: { item: ChatItem; result?: ToolResult }): JSX.Element` (memoised).
  - `WorkBlock({ block, results, open, live, onToggle }: { block: WorkBlockData; results: Map<string, ToolResult>; open: boolean; live: boolean; onToggle(id: string, open: boolean): void }): JSX.Element` (memoised), with `type WorkBlock as WorkBlockData` imported from `@desktop/chat/workBlocks`.

- [ ] **Step 1: Write the failing test** `web/src/chat/Transcript.test.tsx`

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWeb } from "../store";
import { ChatScreen } from "./ChatScreen";
import { Markdown } from "./Markdown";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), chatPage: vi.fn(), panePrompt: vi.fn(), paneRead: vi.fn(() => new Promise(() => {})) }));
vi.mock("./Markdown", async (orig) => {
  const real = await orig<typeof import("./Markdown")>();
  return { Markdown: vi.fn(real.Markdown) };
});

const pane = { session: "s", pane_id: "p1" };
const located = { agent: "claude", path: "/t/a.jsonl", ambiguous: false, candidates: [], pending: false };
const machine = (status: string) => ({ id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes: [{ pane_id: "p1", terminal_id: "t1", title: "fix login", cwd: null, agent: "claude", status }] }] }] }] });
const at = (s: number) => `2026-10-21T10:00:0${s}Z`;
const turn = [
  { kind: "user", text: "fix it", ts: at(0) },
  { kind: "assistant_text", markdown: "Looking", ts: at(1) },
  { kind: "tool_call", id: "c1", name: "Bash", input_summary: "pnpm test", input: {}, ts: at(2) },
  { kind: "tool_result", call_id: "c1", output: "3 passed", is_error: false, ts: at(5) },
  { kind: "tool_call", id: "c2", name: "Edit", input_summary: "src/a.ts", input: {}, ts: at(6) },
  { kind: "tool_result", call_id: "c2", output: "ok", is_error: false, ts: at(7) },
  { kind: "assistant_text", markdown: "All green", ts: at(8) },
];
function open(status: string, items: unknown[] = turn) {
  useWeb.setState({ conn: "open", machines: [machine(status)] as never, chats: {} });
  act(() => {
    useWeb.getState().apply({ type: "chat_opened", pane, located });
    useWeb.getState().apply({ type: "chat", pane, event: { type: "reset", items, total: items.length } as never });
  });
  render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
}
const append = (items: unknown[]) => act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "append", items } as never }));
const head = () => screen.getByRole("button", { name: /^Worked/ });

beforeEach(() => {
  localStorage.clear();
  vi.mocked(Markdown).mockClear();
});

describe("Transcript work blocks", () => {
  it("folds a finished turn's work under one header and keeps the answer open", () => {
    open("idle");
    expect(head()).toHaveAccessibleName("Worked for 7s · 1 edit · 1 command");
    expect(head()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Looking")).toBeNull();
    expect(screen.queryByText("pnpm test")).toBeNull();
    expect(screen.getByText("All green")).toBeInTheDocument();
    expect(screen.getByText("fix it")).toBeInTheDocument();
  });

  it("opens to the narration and a folded run of calls, and a call shows its result", () => {
    open("idle");
    fireEvent.click(head());
    expect(head()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Looking")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 edit · 1 command" }));
    fireEvent.click(screen.getByRole("button", { name: /Bash/ }));
    expect(screen.getByText("3 passed")).toBeInTheDocument();
    expect(screen.queryByText("ok")).toBeNull();
  });

  it("shows the newest block open as Working… while the Agent works", () => {
    open("working");
    const live = screen.getByRole("button", { name: /^Working…/ });
    expect(live).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Bash/ })).toBeInTheDocument();
  });

  it("keeps a block open across an Append", () => {
    open("idle");
    fireEvent.click(head());
    append([{ kind: "system", text: "later", ts: at(9) }]);
    expect(screen.getByText("later")).toBeInTheDocument();
    expect(screen.getByText("Looking")).toBeInTheDocument();
  });

  it("does not parse narration already shown again when a call joins the live block", () => {
    open("working");
    expect(screen.getByText("Looking")).toBeInTheDocument();
    vi.mocked(Markdown).mockClear();
    append([{ kind: "tool_call", id: "c3", name: "Read", input_summary: "b.ts", input: {}, ts: at(9) }]);
    expect(screen.getByRole("button", { name: /Read/ })).toBeInTheDocument();
    expect(vi.mocked(Markdown).mock.calls.map(([props]) => props.text)).not.toContain("Looking");
  });

  it("shows thinking and a result whose call is not loaded as their own rows", () => {
    open("idle", [
      { kind: "user", text: "go", ts: at(0) },
      { kind: "thinking", text: "pondering", ts: at(1) },
      { kind: "tool_result", call_id: "gone", output: "orphan out", is_error: true, ts: at(2) },
      { kind: "assistant_text", markdown: "done", ts: at(3) },
    ]);
    fireEvent.click(head());
    fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("pondering")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Error" }));
    expect(screen.getByText("orphan out")).toBeInTheDocument();
  });
});
```

In `web/src/importGuard.test.ts:7` add `"chat/workBlocks"` to `ALLOWED`.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --dir web exec vitest run src/chat/Transcript.test.tsx`
Expected: FAIL on `screen.getByRole("button", { name: /^Worked/ })` (no such button: today every item renders flat).

- [ ] **Step 3: Implement `ItemView` and `WorkBlock`, and render rows in `ChatScreen`**

- Every collapsible is `<button type="button" class="… toggle" aria-expanded={open}>` with a `ChevronIcon` (class `chev`, rotated 90° when open) and the body rendered only when open. No `<details>`.
- `ItemView` (memo), by `item.kind`:
  - `user`: `<div class="bubble-user">{text}{images → <span class="chip">image</span>}</div>`;
  - `assistant_text`: `<div class="answer"><Markdown text={markdown} /></div>`;
  - `thinking`: toggle labelled `Thinking`; body `<pre class="mono-block">{text}</pre>`;
  - `tool_call`: toggle `.call-head` whose label is `<span class="call-name">{name}</span> <span class="call-summary">{input_summary}{rows && ` (${checklistSummary(rows)})`}</span>`; body: the checklist when `checklist(input)` is non-null (`<ul class="checklist">`, each `<li data-status={status}>` with mark `○` pending, `◐` in_progress, `●` completed, then the label), then, when `result` is set, `<pre class="call-result" data-error={result.is_error}>{result.output}</pre>` plus image chips;
  - `tool_result` (a lone result): toggle labelled `Error` when `is_error`, else `Result`; body `<pre class="call-result">`;
  - `system`: `<div class="item-system">`; `shell_command`: `<pre class="mono-block">$ {command}</pre>`; `shell_output`: `<pre class="mono-block">{stdout}{stderr}</pre>`.
- `WorkBlock` (memo): the header toggle `.work-head` calls `onToggle(block.id, open)`; its text is one string in one `<span>`: `summary ? `${title} · ${summary}` : title` with `summary = workSummary(block.items, results)` (one string, so the accessible name is exactly `Worked for 7s · 1 edit · 1 command`), where `title` is `"Working…"` when `live`, else `` `Worked for ${d}` `` when `d = formatWorkDuration(block.start, block.end)` is non-null, else `"Worked"`. Open, it renders `groupCalls(block.items, live)`: an `item` segment → `<ItemView item={seg.item} result={seg.item.kind === "tool_call" ? results.get(seg.item.id) : undefined} />` (narration `assistant_text` wrapped in `.narration`); a `calls` segment → a `CallGroup` toggle labelled `workSummary(calls, results)` (its own open state, closed at first) listing each call's `ItemView` with its result. Keys: a calls segment `g:${calls[0].id}`, a single call `c:${id}`, any other item `i:${block.items.indexOf(item)}`.
- `ChatScreen`: `const live = status === "working" || status === "blocked"`; `const { rows, results } = useMemo(() => buildRows(items, before), [items, before])`; `const [openBlocks, setOpenBlocks] = useState<ReadonlyMap<string, boolean>>(() => new Map())`; `const onToggle = useCallback((id: string, wasOpen: boolean) => setOpenBlocks((m) => new Map(m).set(id, !wasOpen)), [])`. In `[data-transcript]`, render `rows.map((row) => row.kind === "item" ? <ItemView key={row.key} item={row.item} /> : <WorkBlock key={row.key} block={row.block} results={results} live={live && row.last} open={openBlocks.get(row.block.id) ?? (live && row.last)} onToggle={onToggle} />)` followed by the pending bubbles as today. `status` must be computed before this (move `const status = …` up).
- CSS: `.work` margin 6px 12px; `.work-head` min-height 36px within a 44px tap area, 13px, `--fg-2`, flex, gap 6px; `.chev` 14px, transition transform `var(--t-fast)`, `[aria-expanded="true"] .chev { transform: rotate(90deg) }`; `.work-body` margin-left 7px, padding-left 12px, left border `1px solid var(--line-2)`, flex column, gap 4px; `.call-head` 13px, mono, flex, gap 8px, min-width 0; `.call-name` `--accent`; `.call-summary` `--fg-2`, ellipsis; `.call-result` and `.mono-block` mono 12px, `--surface-code`, `--r-sm`, padding 8px 10px, `white-space: pre-wrap`, `overflow-wrap: anywhere`, max-height 40vh, overflow auto; `.call-result[data-error="true"]` colour `--err-fg`; `.checklist` list-style none, padding-left 4px, 13px; `.item-system` 13px `--fg-3`, margin 6px 16px.

- [ ] **Step 4: Run it and see it pass, with the existing Transcript tests**

Run: `pnpm --dir web exec vitest run src/chat src/importGuard.test.ts`
Expected: PASS (including the paging and Markdown spy tests already in `ChatScreen.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add -A web/src
git commit -m "feat(web-ui): fold each turn's work into a block in the Transcript"
```

---

### Task 9: Markdown code blocks, Copy and Transcript styling

**Files:**
- Modify: `web/src/chat/Markdown.tsx`
- Modify: `web/src/chat/Markdown.test.tsx`
- Modify: `web/src/chat/ItemView.tsx` (Copy on answers)
- Modify: `web/src/chat/Transcript.test.tsx` (one new test)
- Modify: `web/src/chat/ChatScreen.tsx` (pending bubble text)
- Modify: `web/src/styles.css` (section "Transcript: messages and Markdown")

**Interfaces:**
- Consumes: `CopyButton({ text, className })` from `web/src/ui/CopyButton.tsx`; `copyText` from `web/src/ui/copy.ts`.
- Produces: `CodeBlock` (internal to `Markdown.tsx`, mapped to `pre`).

- [ ] **Step 1: Write the failing tests**

Replace `web/src/chat/Markdown.test.tsx` with:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../ui/copy";
import { Markdown } from "./Markdown";

vi.mock("../ui/copy", () => ({ copyText: vi.fn(() => true) }));
beforeEach(() => vi.mocked(copyText).mockClear());

describe("Markdown", () => {
  it("shows HTML as text and opens links safely", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> see [docs](https://example.com)'} />);
    expect(container.querySelector("img")).toBeNull();
    const a = screen.getByText("docs");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("labels a code block with its language and copies its text", () => {
    render(<Markdown text={"```ts\nconst a = 1;\n```"} />);
    expect(screen.getByText("ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenCalledWith(expect.stringMatching(/^const a = 1;\n?$/));
  });

  it("labels a code block without a language as text", () => {
    render(<Markdown text={"```\nplain words\n```"} />);
    expect(screen.getByText("text")).toBeInTheDocument();
  });

  it("puts a table in a scrolling wrapper", () => {
    const { container } = render(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(container.querySelector(".table-wrap > table")).not.toBeNull();
  });
});
```

Add to `web/src/chat/Transcript.test.tsx` (with `vi.mock("../ui/copy", () => ({ copyText: vi.fn(() => true) }))` and `import { copyText } from "../ui/copy";` at the top):

```tsx
  it("copies an answer's Markdown source", () => {
    open("idle", [{ kind: "user", text: "go", ts: at(0) }, { kind: "assistant_text", markdown: "**All** green", ts: at(1) }]);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenCalledWith("**All** green");
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --dir web exec vitest run src/chat/Markdown.test.tsx src/chat/Transcript.test.tsx`
Expected: FAIL on `getByText("ts")`, on `getByText("text")`, on `.table-wrap > table` (got `null`), and on `getByRole("button", { name: "Copy" })` in the Transcript test.

- [ ] **Step 3: Implement**

- `Markdown.tsx`: `components.pre` → `CodeBlock({ node, children })`: the language is the `language-*` entry of the first child element's `properties.className` in the hast `node` (else `"text"`); renders `<div class="code-block"><div class="code-head"><span class="code-lang">{lang}</span><CopyButton text={() => ref.current?.textContent ?? ""} /></div><pre ref={ref}>{children}</pre></div>`. `components.table` → `<div class="table-wrap"><table>…</table></div>`. Keep the link override and no `rehype-raw`.
- `ItemView.tsx` `assistant_text`: after `<Markdown>`, `<div class="answer-actions"><CopyButton text={item.markdown} /></div>`.
- `ChatScreen.tsx` `PendingBubble`: the bubble gets class `bubble-user bubble-pending` (keep `data-pending`); under the text, `not seen yet` once stale, else `sending…`, in `<div class="bubble-note">`.
- CSS: `[data-transcript]` padding 8px 0 16px, `overscroll-behavior: contain`. `.bubble-user` margin 10px 12px 10px auto, max-width 85%, width fit-content, padding 10px 14px, `--accent-soft`, radius `--r-lg` with the bottom-right `--r-sm`, `white-space: pre-wrap`, `overflow-wrap: anywhere`; `.bubble-pending` opacity .55; `.bubble-note` 12px `--fg-3`. `.answer` margin 8px 16px, 15px; Markdown inside: paragraphs margin .5em 0, headings 17px/16px/15px semibold, lists padding-left 1.3em, `blockquote` left border `3px solid var(--line-3)` and `--fg-2`, `a` `--link`, inline `code` (not in `pre`) `--code-inline` on `--active`, padding 1px 5px, `--r-sm`, .9em; `hr` `--line-2`. `.code-block` margin 8px 0, `--surface-code`, `1px solid var(--line)`, `--r-md`, overflow hidden; `.code-head` flex, justify space-between, align center, padding 2px 4px 2px 12px, `--code-head`, 12px mono `--fg-3`; `.code-block pre` margin 0, padding 10px 12px, overflow-x auto, 12.5px, line-height 1.55. `.table-wrap` overflow-x auto; tables collapse, cells padding 6px 10px with `--line-2` borders, header `--surface-2`. `.answer-actions` margin-top 2px, flex, justify flex-start.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm --dir web exec vitest run src/chat`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A web/src
git commit -m "feat(web-ui): code blocks with language and Copy, styled messages and Markdown"
```

---

### Task 10: Scroll-to-bottom button

**Files:**
- Modify: `web/src/chat/ChatScreen.tsx`
- Create: `web/src/chat/ScrollDown.test.tsx`
- Modify: `web/src/styles.css` (section "Scroll to bottom")

**Interfaces:**
- Consumes: `ArrowDownIcon` from `web/src/ui/icons.tsx`.
- Produces: nothing new for other tasks.

- [ ] **Step 1: Write the failing test** `web/src/chat/ScrollDown.test.tsx`

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWeb } from "../store";
import { ChatScreen } from "./ChatScreen";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), chatPage: vi.fn(), panePrompt: vi.fn() }));

const pane = { session: "s", pane_id: "p1" };
const located = { agent: "claude", path: "/t/a.jsonl", ambiguous: false, candidates: [], pending: false };
const machine = { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes: [{ pane_id: "p1", terminal_id: "t1", title: "fix login", cwd: null, agent: "claude", status: "idle" }] }] }] }] };
const sys = (text: string) => ({ kind: "system", text });

function setup() {
  useWeb.setState({ conn: "open", machines: [machine] as never, chats: {} });
  act(() => {
    useWeb.getState().apply({ type: "chat_opened", pane, located });
    useWeb.getState().apply({ type: "chat", pane, event: { type: "reset", items: [sys("a"), sys("b")], total: 2 } as never });
  });
  const { container } = render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
  const el = container.querySelector("[data-transcript]") as HTMLElement;
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });
  return el;
}
const append = (items: unknown[]) => act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "append", items } as never }));
const reset = (items: unknown[], total: number) => act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "reset", items, total } as never }));

beforeEach(() => localStorage.clear());

describe("scroll to bottom", () => {
  it("is hidden at the bottom", () => {
    const el = setup();
    el.scrollTop = 500;
    fireEvent.scroll(el);
    expect(screen.queryByLabelText("Scroll to bottom")).toBeNull();
  });

  it("shows after scrolling up, counts new items, and scrolls down when tapped", () => {
    const el = setup();
    el.scrollTop = 100;
    fireEvent.scroll(el);
    const btn = screen.getByLabelText("Scroll to bottom");
    expect(btn).not.toHaveTextContent("new");
    append([sys("c"), sys("d")]);
    expect(screen.getByLabelText("Scroll to bottom")).toHaveTextContent("2 new");
    fireEvent.click(screen.getByLabelText("Scroll to bottom"));
    expect(el.scrollTop).toBe(1000);
    expect(screen.queryByLabelText("Scroll to bottom")).toBeNull();
  });

  it("restarts the count at a Reset", () => {
    const el = setup();
    el.scrollTop = 100;
    fireEvent.scroll(el);
    append([sys("c")]);
    reset([sys("x")], 1);
    expect(screen.getByLabelText("Scroll to bottom")).not.toHaveTextContent("new");
    append([sys("y")]);
    expect(screen.getByLabelText("Scroll to bottom")).toHaveTextContent("1 new");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --dir web exec vitest run src/chat/ScrollDown.test.tsx`
Expected: FAIL on `screen.getByLabelText("Scroll to bottom")` (no such element).

- [ ] **Step 3: Implement in `ChatScreen.tsx`**

- State `const [baseline, setBaseline] = useState<number | null>(null)`: `null` while stuck to the bottom, else `chat.total` when the user left it.
- In `onScroll`, after computing `stick.current`: when not stuck and `baseline === null`, `setBaseline(total)`; when stuck and `baseline !== null`, `setBaseline(null)`. (Keep the paging logic after it as it is.)
- In the existing items layout effect, when `prev.length > 0` and the previous last item is not in the new items (`at < 0`: a Reset replaced them), set the baseline to the new `total` if it is not `null`.
- Render, inside the Chat column and after the transcript, when `baseline !== null`: `<button class="scroll-down" aria-label="Scroll to bottom" onClick={toBottom}><ArrowDownIcon />{n > 0 && <span>{n} new</span>}</button>` with `n = Math.max(0, total - baseline)`.
- `toBottom`: `el.scrollTop = el.scrollHeight` (not `scrollTo`), `stick.current = true`, `setBaseline(null)`.
- CSS: the Chat column is `position: relative`; `.scroll-down` absolute, right 16px, bottom = the footer height plus 12px (put the button in a zero-height positioned wrapper just above the footer so it floats over the transcript's bottom), min-width 44px, height 44px, round (pill when it has a count), `--surface-2`, `--line-2` border, `--shadow-soft`, 13px, gap 6px, `--accent` count text.

- [ ] **Step 4: Run it and see it pass, with the paging tests**

Run: `pnpm --dir web exec vitest run src/chat`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/chat/ChatScreen.tsx web/src/chat/ScrollDown.test.tsx web/src/styles.css
git commit -m "feat(web-ui): scroll-to-bottom button with a new-item count"
```

---

### Task 11: Prompt card and the Chat layout

**Files:**
- Modify: `web/src/prompt/PromptCard.tsx`
- Modify: `web/src/prompt/PromptCard.test.tsx`
- Modify: `web/src/chat/ChatScreen.tsx` (`BlockedPrompt`, remaining inline styles, error and ambiguity banners)
- Modify: `web/src/chat/ChatScreen.test.tsx` (one new test)
- Modify: `web/src/styles.css` (sections "Prompt card", "Chat layout")

**Interfaces:**
- Consumes: `usePrompt(pane, view)` from `web/src/prompt/usePrompt.ts` (unchanged); `.banner` classes.
- Produces: nothing new for other tasks.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/prompt/PromptCard.test.tsx` (with `within` added to the import):

```tsx
  it("numbers single-choice options and offers a typed answer", () => {
    render(<PromptCard prompt={prompt} busy={false} error={null} onAnswer={() => {}} />);
    expect(within(screen.getByText("Yes").closest("button")!).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByText("No").closest("button")!).getByText("2")).toBeInTheDocument();
    expect(screen.getByText("and tell Claude why")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Or type your own answer")).toBe(screen.getByLabelText("Answer"));
  });
```

Add to `web/src/chat/ChatScreen.test.tsx`:

```tsx
  it("says it is reading the prompt until the screen has been read", () => {
    vi.mocked(api.paneRead).mockImplementationOnce(() => new Promise(() => {}));
    open([]);
    const blocked = structuredClone(machine);
    blocked.sessions[0].workspaces[0].tabs[0].panes[0].status = "blocked";
    act(() => useWeb.setState({ machines: [blocked] as never }));
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    expect(screen.getByText("Reading the prompt…")).toBeInTheDocument();
    expect(document.querySelector("[data-prompt]")).toBeNull();
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --dir web exec vitest run src/prompt/PromptCard.test.tsx src/chat/ChatScreen.test.tsx`
Expected: FAIL on `getByText("1")` inside the Yes button and on `getByText("Reading the prompt…")`.

- [ ] **Step 3: Implement**

- `PromptCard` (keep `data-prompt`, props and behaviour): `<div data-prompt class="prompt-card">`; head `<div class="prompt-head"><span class="prompt-dot" /><strong>{title}</strong></div>`; `<div class="prompt-question">{question}</div>`; body in `<pre class="prompt-body">`. Single-choice options: `<button class="prompt-option">` holding `<span class="prompt-num">{i + 1}</span>` and `<span class="prompt-option-text"><span>{label}</span>{description && <span class="prompt-desc">{description}</span>}</span>`. Multi-select rows: `<label class="prompt-option">` wrapping the checkbox and the option text only (no number), then `<button class="btn prompt-submit">Submit</button>`. Custom answer: `<div class="prompt-custom"><input aria-label="Answer" placeholder="Or type your own answer" …/><button class="btn">Answer</button></div>`. Error `role="alert"` with class `prompt-error`.
- `BlockedPrompt` in `ChatScreen.tsx`: when `prompt` is null, render `<div class="prompt-card prompt-waiting">Reading the prompt…</div>`.
- `ChatScreen` layout: the root is `<div class="chat">`; the ambiguity note `<div class="banner banner-warn">Several transcripts match; showing the newest</div>`; the error `<div role="alert" class="banner banner-err"><span>{message}</span><button class="btn">Retry</button></div>`; the transcript `<div ref={box} data-transcript class="transcript" onScroll={onScroll}>`; the footer `<footer class="chat-footer">`. Remove every remaining inline style object in `ChatScreen.tsx`, `ItemView.tsx` and `PromptCard.tsx` (`grep -n "style=" web/src` lists only the Composer textarea's height afterwards, which is set in an effect, not as a JSX prop).
- CSS: `.chat` flex column, height `100dvh`, max-width 720px, margin 0 auto. `.transcript` flex 1, overflow-y auto. `.prompt-card` flex column, gap 8px, max-height 60dvh, overflow-y auto, padding 12px, `--r-lg`, border `1px solid color-mix(in srgb, var(--amber) 55%, transparent)`, background `color-mix(in srgb, var(--amber) 6%, var(--surface-1))`; `.prompt-waiting` 14px `--amber`; `.prompt-head` flex, gap 8px, align center, 14px; `.prompt-dot` 8px circle `--amber`; `.prompt-question` 15px; `.prompt-body` mono 12px, `--surface-code`, `--r-sm`, padding 8px, `white-space: pre-wrap`, margin 0; `.prompt-option` flex, gap 10px, align flex-start, text-align left, min-height 52px, padding 10px 12px, `--surface-1`, `1px solid var(--line-2)`, `--r-md`, `:active` → `--surface-2`; `.prompt-num` 22×22, `--r-sm`, `--surface-3`, centred, 12px mono; `.prompt-desc` block, 13px `--fg-2`; `.prompt-custom` flex, gap 8px; its input flex 1, min-height 44px, padding 0 12px, `--surface-0`, `--line-2` border, `--r-md`, `:focus` border `--accent`; `.prompt-error` 13px `--err-fg`.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm --dir web exec vitest run src/prompt src/chat`
Expected: PASS
Run: `grep -rn "style={" web/src --include=*.tsx`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add -A web/src
git commit -m "feat(web-ui): numbered prompt card, reading state and the Chat layout"
```

---

### Task 12: Live verification

**Files:**
- None in the repository (screenshots go to the session's scratchpad directory).

**Interfaces:**
- Consumes: the whole UI; the `herdly-web` command on the PATH (`~/.local/bin/herdly-web`).

- [ ] **Step 1: Run the full suite and a production build**

Run: `pnpm --dir web test`
Expected: all tests pass.
Run: `pnpm --dir web typecheck`
Expected: exit 0.
Run: `pnpm --dir web build`
Expected: exit 0.
Run: `grep -c 'data:font' web/dist/assets/*.css`
Expected: `0`.

- [ ] **Step 2: Start a second, isolated instance on loopback**

This leaves the user's running `herdly-web` service and its Paired devices untouched: a fresh state directory, its own port, the worktree's bundle.

```bash
STATE=$(mktemp -d)
herdly-web pair --state "$STATE" --bind 127.0.0.1:7381
```

Expected: a pairing link starting `http://127.0.0.1:7381/pair` and `expires in 10 minutes`. Keep the link.

Run in the background: `herdly-web serve --state "$STATE" --bind 127.0.0.1:7381 --static "$PWD/web/dist"`
Expected: it stays up (no "address in use" or bind error in its output). If it cannot start next to the service, stop here and report the error: this side-by-side run was unverified in the spec.

- [ ] **Step 3: Screenshot the screens at phone size**

With the Playwright browser tools: open the pairing link, resize the viewport to 412×915, then capture, saving into the scratchpad:
- the Pane list;
- a Chat of a Claude Pane, with one work block opened and one call opened;
- the ⋯ menu open;
- the Pane sheet open;
- the prompt card, if any Pane is blocked (do not answer it).

Do not send messages, keys or answers to any Pane. Check on each screenshot: dark background, no browser-default buttons, no horizontal page scroll, the header and footer inside the screen.

- [ ] **Step 4: Stop the instance and clean up**

Stop the background `herdly-web serve`, then `rm -rf "$STATE"`.
Run: `ss -ltn | grep -c 7381`
Expected: `0`.

- [ ] **Step 5: Report**

List the screenshot paths and anything that looked wrong. Note for the user: keyboard overlap, vibration and Copy on the phone's plain-HTTP origin are checked on the phone after landing (`127.0.0.1` is a secure context, so Copy there proves nothing about the phone).
