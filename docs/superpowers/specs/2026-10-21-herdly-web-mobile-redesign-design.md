# Herdly Web: mobile redesign

Date: 2026-10-21
Status: approved design (sections approved in chat; autopilot from the spec on, see Rulings)

## Purpose

The user, on the phone: "Giao diện trên mobi xấu quá, Redesign lại cho đẹp", then "thiết kế lại
cả UX luôn". Herdly Web's UI (`web/`, built by
[2026-10-21-herdly-web-mobile-design.md](2026-10-21-herdly-web-mobile-design.md)) is browser
defaults plus inline styles: there is no stylesheet besides `web/src/chat/highlight.css`, and
every colour is a literal (`web/src/list/PaneList.tsx:8-10`, `web/src/chat/ChatScreen.tsx:12`).

This redesign restyles every screen after the desktop app and reworks how the phone is used:
a status-first Pane list, folded work in the Transcript, a contextual Send/Stop button, a Pane
switcher, and a few client-side conveniences.

## Decisions (stated by the user)

- **Look like the desktop app**: dark only, the desktop's tokens, status colours and
  JetBrains Mono for code. Rejected: a light/dark pair, a mobile-only style.
- **Pane list by status**: Needs you, Working, Done, Idle. Rejected: the Session › Workspace
  tree, and a toggle between the two.
- **Transcript folds work into blocks like the desktop** ("Worked for 7s · 3 edits").
  Rejected: one line per tool call.
- **Bottom bar**: an auto-growing field with one round button that is **Stop** (Esc) while the
  Agent works and the field is empty, **Send** otherwise; Ctrl+C lives in a ⋯ menu with a
  confirm step. Rejected: Esc and Ctrl+C chips always shown.
- **Switching Panes**: tapping the Chat title opens a bottom sheet of Panes by status; a
  "● N need you" chip in the header jumps to another blocked Pane. Rejected: swiping between
  Panes; the chip alone.
- **Client-side conveniences**: Copy buttons, a blocked count in the tab title with a
  vibration, a scroll-to-bottom button with a new-item count, a draft kept per Pane.
- **No server change.** No edit under `src/` or `src-tauri/`.
- **Styling approach**: one plain stylesheet `web/src/styles.css` holding tokens copied from
  the desktop and class rules; components use `className`. Rejected: importing the desktop's
  `src/styles.css` (1855 lines of desktop classes that would change under the phone), and
  Tailwind (a new dependency and an idiom the repo does not use).
- Unsupported Panes (shell, other agents) stay in the list, dimmed, under Idle when idle;
  `unknown` and seen-`done` Panes show under Idle; stopped Sessions show as one line
  "Stopped: carex, probe".
- One spec and one plan, no epic.

## Facts this design rests on

- A stopped Session carries no Workspaces: `MachineView` builds it with
  `workspaces: Vec::new()` (`src-tauri/core/src/machines.rs:273-281`).
- `src/chat/workBlocks.ts` imports only `../lib/types` and `./checklist`
  (`src/chat/workBlocks.ts:7-8`), so the import guard (`web/src/importGuard.test.ts`) accepts it
  once `chat/workBlocks` is added to `ALLOWED` (`web/src/importGuard.test.ts:7`). It exports
  `buildRows`, `groupCalls`, `workSummary`, `formatWorkDuration` and the `ChatRow`,
  `WorkBlock`, `ToolCall`, `ToolResult` types. This extends the list of reused modules that
  the earlier spec gave as exact.
- `src/chat/toolIcon.ts` and `src/ui/icons.tsx` import `react`, so they are not reused; the few
  icons needed are written in `web/`.
- The desktop marks a work block live when the Pane is `working` or `blocked` and the block is
  the newest (`src/chat/ChatLens.tsx:278`, `:561`).
- Herdly Web is plain HTTP (ADR 0011), not a secure context, so `navigator.clipboard` is
  unavailable; copying uses a hidden textarea and `document.execCommand("copy")`.
  **Unverified** on the phone.
- `navigator.vibrate` is ignored by Chrome until the page has had a user activation.
  **Unverified**; accepted: the first blocked transition after a fresh load may not vibrate.
- `web/index.html:5` has `viewport-fit=cover` but no `interactive-widget`; without
  `interactive-widget=resizes-content` the Android keyboard overlays a bottom-pinned Composer.

## Visual system

`web/src/styles.css`, imported once from `web/src/main.tsx`:

- **Tokens** (`:root`), copied from `src/styles.css:1-80` and trimmed to what `web/` uses:
  `--surface-0..3`, `--surface-code`, `--hover`, `--active`, `--fg`, `--fg-2`, `--fg-3`,
  `--line`, `--line-2`, `--line-3`, `--accent`, `--accent-fg`, `--accent-soft`, `--ring`,
  `--amber`, `--blue`, `--green`, `--grey`, `--err`, `--err-fg`, `--link`, `--code-head`,
  `--code-inline`, `--hl-*`, `--r-sm`, `--r-md`, `--r-lg`, `--shadow-*`, `--ease`, `--t-fast`,
  `--t`, `--mono`. A comment names the source lines so a later sync knows where to look.
- **Status colours**: blocked `--amber`, working `--blue`, done `--green`, idle and unknown
  `--grey`, as on the desktop dashboard (`docs/screenshots/dashboard.png`).
- **Type**: body is the system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
  sans-serif`) at 15px, line-height 1.5; code is `var(--mono)`. JetBrains Mono woff2 files and
  `fonts.css` are copied from `src/fonts/` into `web/src/fonts/` (the Vietnamese and latin-ext
  subsets cover Vietnamese text).
- **Base**: `html, body, #root` take `background: var(--surface-0)`, `color: var(--fg)`,
  `color-scheme: dark`; `-webkit-tap-highlight-color: transparent`; buttons reset to the
  surface style, at least 44×44 px, with `:active` and `:focus-visible` (`--ring`) states.
- **Viewport**: `web/index.html` meta becomes
  `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`,
  plus `<meta name="theme-color" content="#1a1b1f">`. Headers pad by
  `env(safe-area-inset-top)`, the bottom bar by `env(safe-area-inset-bottom)`.
- `web/src/chat/highlight.css` maps `.hljs-*` classes to `--hl-*`; its light rules go.

Class names follow the desktop's flat style (`.pane-card`, `.chat-work-head`, …); no CSS
modules.

## Components

### Shell (`web/src/App.tsx`)

- Not paired: a centred card with the same heading and text as today.
- Reconnect bar: a slim amber strip at the top, same text and same show/hide rule as today.
- `switchTo(next)`: unsubscribe and clear the open Pane exactly as Back does, then
  `openChat(next)`; the existing subscribe effect subscribes the new one. `ChatScreen` gets an
  `onSwitch(p: WebPane)` prop wired to it.
- Calls `useAttention()` (below).

### Pane list (`web/src/list/`)

- `order.ts`: `groupSession` is replaced by
  `groupByStatus(sessions: SessionView[], shown: (key: string, s: AgentStatus) => AgentStatus)
  → { needs: PaneRow[]; working: PaneRow[]; done: PaneRow[]; idle: PaneRow[]; stopped: string[] }`
  where `PaneRow = { session: string; workspace: string; workspace_id: string; pane: PaneView;
  status: AgentStatus }` (`status` is the shown status). Order inside each group: running
  Sessions first, then herdr's order of Workspaces, Tabs and Panes. `orderSessions` stays.
  `PaneList` passes `shownStatus` from `seen.ts`.
- `PaneCard.tsx`: one `<button data-pane={key}>` with an agent mark, the title (one line,
  ellipsis), a sub-line `session › workspace`, and a status dot with its label in a
  `<span data-status={status}>`. Blocked cards get an amber border and tint; the card of the
  open Pane (in the sheet) gets `aria-current="true"` and an accent edge. Panes whose agent is
  not `claude` or `pi` are dimmed; tapping one shows "Chat lens supports Claude Code and pi
  only" under it, as today.
- Agent mark: a 28 px rounded square: Claude `✳` on `#d97757`, pi `π` on `--accent`, anything
  else `>_` on `--surface-3`.
- `PaneGroups.tsx`: renders the four groups, each with an uppercase heading and a count
  ("NEEDS YOU 2", heading text "Needs you"); empty groups are not shown; then the "Stopped: …"
  line when `stopped` is non-empty. Props: `machine`, `current: string | null`, `onOpen`.
  Owns the unsupported-hint state and the seen-mark bump that `PaneList` owns today.
- `PaneList.tsx`: header "Herdly" with a connection dot (`--green` when the machine is
  `connected`, `--amber` otherwise) and the machine label; the machine error banner as today
  (state in bold, message after); `PaneGroups`; an empty state "No Panes" when every group is
  empty.

### Chat header (`web/src/chat/ChatHeader.tsx`)

- `‹` Back (`aria-label="Back"`).
- A title button: the Pane title (ellipsis) over `session › workspace`, with the status dot
  (`data-status`). Tapping it opens the Pane sheet.
- **Need-you chip**, shown when another Pane is blocked: "● N" with `aria-label="N need you"`
  (N = blocked Panes other than this one). Tapping it calls `onSwitch` with the first of them
  in `groupByStatus` order.
- **⋯ menu** (`aria-label="More"`): a small popover with **Send Esc** and **Send Ctrl+C**.
  Ctrl+C asks twice: the first tap turns the item into "Tap again to send Ctrl+C" for 3 s; the
  second sends. Both call `paneKeys` with `["esc"]` / `["ctrl+c"]`; a failure shows its message
  in the menu with `role="alert"`. Tapping outside closes the menu.
- The "Several transcripts match; showing the newest" note and the error banner with Retry sit
  under the header, restyled, same text and behaviour.

### Pane sheet (`web/src/chat/PaneSheet.tsx`, `web/src/ui/Sheet.tsx`)

- `Sheet`: a scrim plus a panel sliding up from the bottom (max 80dvh, scrolls), with a grab
  handle and a title; closes on scrim tap, on Escape, or through `onClose`. `role="dialog"`,
  `aria-modal="true"`, `aria-label` from its title.
- `PaneSheet`: `Sheet` titled "Panes" holding `PaneGroups` with `current` = the open Pane.
  Tapping another chat-capable Pane closes the sheet and calls `onSwitch`; tapping the current
  one just closes it.

### Transcript (`web/src/chat/ChatScreen.tsx`, `WorkBlock.tsx`, `ItemView.tsx`, `Markdown.tsx`)

- Rows come from `buildRows(items, before)` (memoised on `items` and `before`); each row's
  `key` is the row's `key` from `buildRows`, so keys survive prepends.
- `item` rows render with `ItemView`; `work` rows with `WorkBlock`.
- **`WorkBlock`**: a header button (`aria-expanded`) with a chevron, the title ("Working…"
  when live, else "Worked for <duration>", else "Worked") and `workSummary` after " · ".
  Open, it lists `groupCalls(block.items, live)`: narration as Markdown, thinking as a
  collapsible "Thinking" row, single calls as call rows, runs as a collapsible
  "3 commands · 1 file read" line. Live = Pane status `working` or `blocked` and `row.last`.
- **Open state** lives in `ChatScreen` as a `Map<blockId, boolean>`; a block not in the map is
  open when it is live and closed otherwise. `WorkBlock` is memoised and takes a stable
  `onToggle(id, open)`.
- **Call row**: a `<details>` whose summary is the tool name (mono, accent) and
  `input_summary` (mono, `--fg-2`, ellipsis), plus the checklist count when `checklist(input)`
  is non-null. Open, it shows the checklist (marks ○ ◐ ●) and the call's result from
  `results` (mono, `pre-wrap`, max-height 40vh scrolling, `--err-fg` when `is_error`). A
  result without its call keeps the "Result"/"Error" row as today.
- **User item**: a right-aligned bubble (`--accent-soft`, `--r-lg`, max-width 85%); images
  as an "image" chip as today.
- **Assistant text**: full width; Markdown styles for headings, lists, quotes, links
  (`--link`), inline code (`--code-inline` on `--active`), tables in a horizontally scrolling
  wrapper.
- **Code blocks**: `Markdown` maps `pre` to a `CodeBlock`: a header with the language (from
  the `language-*` class, else "text") and a **Copy** button, then the code on
  `--surface-code`, scrolling horizontally. Copy reads the code element's `textContent`.
- **Copy** (`web/src/ui/copy.ts`): `copyText(text): boolean` puts the text in an off-screen
  read-only textarea, selects it, runs `document.execCommand("copy")`, removes it, and returns
  whether it worked. The button shows "Copied" for 1.5 s on success, "Copy failed" otherwise.
  The same button sits at the end of every `assistant_text` item.
- **System**, **shell command** and **shell output** items: muted small text, mono for the
  shell ones, as today but on the tokens.
- **Pending bubble**: the user bubble at 55% opacity with "sending…" under it, then "not seen
  yet" once stale (`data-pending` kept).
- **Scroll-to-bottom**: when not stuck to the bottom, a round ↓ button floats above the bottom
  bar (`aria-label="Scroll to bottom"`); it shows "N new" when items arrived since the user left
  the bottom (counted from `chat.total` at the moment of leaving). Tapping scrolls to the
  bottom and sticks again. The `stick`, `anchorHeight` and `asked` logic is otherwise kept as
  it is. Toggling a block does not move the scroll position.

### Bottom bar (`web/src/chat/Composer.tsx`, `web/src/chat/drafts.ts`)

- Not blocked: the `Composer`. Blocked: the prompt area (below). `StopBar` and its test are
  removed; Esc and Ctrl+C move to the header menu.
- **Composer**: a textarea (`aria-label="Message"`), one row high, growing with its content up
  to 6 rows, then scrolling; Enter inserts a newline. The round button on its right:
  - **Stop** (`aria-label="Stop"`, square icon) when the Pane is `working` and the field is
    blank: sends `["esc"]`; a failure shows under the field with `role="alert"`;
  - **Send** (`aria-label="Send"`, arrow icon) otherwise, disabled while the field is blank.
  Send behaves as today: clear, add the pending bubble, POST, and on failure put the text back
  and show the error.
- **Drafts** (`drafts.ts`): `loadDraft(key)`, `saveDraft(key, text)` (blank removes),
  under `herdly-web:draft:<session>/<pane_id>`; every storage call in try/catch. `BottomBar`
  starts from `loadDraft(key)` and saves on every change; a sent message clears it; a failed
  send restores it as today. The draft and its error stay in `BottomBar`, so a prompt that hides
  the Composer keeps them, as today.

### Prompt area (`web/src/prompt/PromptCard.tsx`, `BlockedPrompt` in `ChatScreen.tsx`)

- While blocked and no prompt is read yet: a slim amber card "Reading the prompt…".
- **PromptCard** (`data-prompt` kept): amber border and tint, a header with an amber dot and
  the title, the question, the body in mono when present. Each option is a row button with a
  number badge (1, 2, …), the label and the description under it in `--fg-2`. Multi-select
  rows are labels wrapping a checkbox (accessible name = option label, as today) and end with
  **Submit**. The custom answer is a field ("Or type your own answer", `aria-label="Answer"`)
  with an **Answer** button. Busy disables everything; the error shows with `role="alert"`.
  The card scrolls inside max 60dvh.

### Attention (`web/src/attention.ts`)

- `blockedPanes(machines): string[]`: the `webKey`s of every blocked Pane.
- `useAttention()`, called once from `App`:
  - sets `document.title` to `(N) Herdly` when N > 0 blocked Panes, else `Herdly`;
  - keeps the previous status per Pane key in a ref; when a Pane known before turns `blocked`
    from another status, calls `navigator.vibrate?.(200)` in a try/catch. The first machines
    frame only fills the ref.

### Other screens

Error banners (machine error, `chat_error`, send errors) use `--err` tints and keep their text
and `role="alert"`. "Not paired" keeps its heading and text.

## Data flow

Unchanged: one socket, the zustand store, the same frames and REST calls. New client state:
the open-block map and sheet/menu open flags (component state), drafts (localStorage), the
attention ref. No new frame, route or store field.

## Error handling

- Storage unavailable: drafts are not kept; nothing throws.
- Copy fails: the button says "Copy failed".
- Vibration unsupported or refused: nothing happens.
- Key, prompt and send failures surface as today, in the place the control now lives.

## Testing

All in `web/`, with vitest and testing-library: `pnpm test`, `pnpm typecheck`, `pnpm build`.

Kept as they are: `data-pane`, `data-status`, `data-transcript`, `data-pending`,
`data-prompt`, `aria-label="Back"`, `aria-label="Message"`, `aria-label="Answer"`,
`role="alert"`, and every visible text the tests read except those listed next.

Tests changed on purpose:

- `PaneList.test.tsx`: the "Waiting" heading becomes "Needs you"; the test for two Workspaces
  sharing a label checks both cards show `default › herdly` and no duplicate-key warning,
  instead of two headings.
- `order.test.ts`: `groupSession` tests become `groupByStatus` tests.
- `StopBar.test.tsx` is deleted; its two cases move to `ChatHeader.test.tsx` (menu) and
  `Composer.test.tsx` (Stop).
- `ChatScreen.test.tsx`: `getByText("Send")` becomes `getByRole("button", { name: "Send" })`;
  the blocked test finds Esc and Ctrl+C through the ⋯ menu instead of on the bar.
- `importGuard.test.ts`: `chat/workBlocks` joins `ALLOWED`.

New tests:

- `groupByStatus`: grouping, shown status (seen done → Idle), unknown → Idle, order, stopped
  names, two Workspaces with one label.
- `PaneCard`/`PaneGroups`: dimmed unsupported Pane and its hint, `aria-current` on the current
  Pane, empty groups hidden.
- `ChatHeader`: Esc sends at once; Ctrl+C needs a second tap; a key failure shows in the menu;
  the chip counts other blocked Panes and switches to the first one.
- `PaneSheet`: opens from the title, switching calls `onSwitch` and closes, the current Pane
  only closes.
- `App`: `onSwitch` unsubscribes and clears the old Pane and subscribes the new one.
- Transcript: a turn with calls renders one collapsed "Worked" header with the summary; tapping
  it shows the calls; a call shows its result inside; the live block is open; open state
  survives an Append; item keys survive a page prepend (existing paging tests still pass).
- `CodeBlock`: language label; Copy calls `copyText` with the code text and shows "Copied".
- `copyText`: uses `execCommand("copy")` and returns its result; false when it throws.
- `Composer`: Stop when working and blank, Send otherwise; Stop sends `["esc"]`; Send disabled
  while blank.
- `drafts`: round trip, blank removes, storage throwing; `ChatScreen` restores a Pane's draft
  after unmount and remount.
- Scroll-to-bottom: hidden at the bottom; shown with "N new" after scrolling up and an Append;
  tapping it scrolls down and hides it.
- `useAttention`: title count; vibrate only on a transition to blocked, not on the first frame.

**Visual check** (by the implementer, before finishing): build into the worktree, then run a
second instance that leaves the real service and its Paired devices alone:

```sh
(cd web && pnpm build)
STATE=$(mktemp -d)
herdly-web pair  --state "$STATE" --bind 127.0.0.1:7381            # prints the pairing link
herdly-web serve --state "$STATE" --bind 127.0.0.1:7381 --static "$PWD/web/dist"
```

Open the link with Playwright at 412×915 (GPU flags from the user's CLAUDE.md, one browser at a
time) and screenshot the list, a Chat with a folded work block opened, the ⋯ menu, the Pane
sheet and, if a Pane is blocked, the prompt card. Stop the instance and delete `$STATE`
afterwards. Whether a second `herdly-web` instance runs side by side with the service is
**unverified**. Keyboard overlap, vibration and Copy are checked by the user on the phone after
landing.

## Non-goals

- Light theme, swipe navigation, notifications while the app is closed (Web Push).
- Anything that needs the server: new routes or frames, images in the Transcript, starting
  Agents.
- Desktop changes; sharing a stylesheet with the desktop.
- Virtualising the Transcript.

## Rulings

Made under autopilot; the user has not reviewed them.

### Flagged

none

### Other

- Ruling: UI text stays English — matches today's UI and the desktop — cost if wrong: a
  translation pass over the strings.
- Ruling: order inside each status group follows herdr (running Sessions, then Workspace, Tab,
  Pane) — stable positions while statuses change — cost if wrong: a sort change in
  `groupByStatus`.
- Ruling: the need-you chip jumps to the first other blocked Pane in that order — predictable
  — cost if wrong: a different pick in `ChatHeader`.
- Ruling: Enter inserts a newline; only the button sends — phone keyboards make Enter-to-send
  easy to hit by accident — cost if wrong: a key handler.
- Ruling: vibrate only on a transition to blocked while the app is open, never on load — a load
  is not news — cost if wrong: one condition in `useAttention`.
- Ruling: work-block open state lasts only while the Chat is shown; a block is open by default
  only while live — on a phone the last turn's calls would otherwise fill the screen; the
  desktop opens the newest block (`src/chat/ChatLens.tsx:559`) — cost if wrong: the default in
  one expression.
- Ruling: agent marks are a glyph on a colour (✳ Claude, π pi, >_ other), no brand logos — no
  assets to license — cost if wrong: swap the mark component.
- Ruling: Ctrl+C confirms by a second tap within 3 s rather than a dialog — one less overlay
  on a small screen — cost if wrong: replace with a dialog.
- Ruling: Copy also sits on every assistant answer, not only code blocks — answers are what
  gets pasted elsewhere — cost if wrong: remove one button.
- Ruling: Stop shows only while `working` with a blank field; while `blocked` Esc is in the ⋯
  menu — while blocked, the prompt card replaces the Composer — cost if wrong: show Stop on the
  prompt card too.
