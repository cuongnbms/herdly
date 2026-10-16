# Git view

Date: 2026-10-16
Status: approved design

## Purpose

Agents change files and make commits in a Workspace; the user wants to see what changed without
leaving the app or opening a terminal: the uncommitted changes of the repository, the recent
commits and what each one changed, as unified diffs. The model is VS Code's Source Control view,
read-only.

The **Git view** replaces the agents column's **Split** view. Clicking a file in it opens a
**Diff item** in the main area, the way clicking a file in the Files panel opens a file Open
item. Nothing in this feature runs a git command that changes the repository:
[ADR 0010](../../adr/0010-git-view-is-read-only.md).

## Scope

In:

- The view switch becomes **Agents | Files | Git**; Split and everything only it had (both
  halves at once, the resize drag, collapsing the Files panel) are removed.
- The Git view of the repository holding the Files panel's root: branch, upstream, ahead and
  behind, Merge Changes, Staged Changes, Changes, and the branch's commits (50 at a time) each
  expandable to the files it changed.
- A Diff item per (file, scope): working tree against the index, index against HEAD, or one
  commit against its first parent. Hunks with 3 lines of context, two line-number columns,
  syntax highlighting.
- Local and ssh Machines alike, through the Machine's `Transport`.

Out (non-goals):

- Stage, unstage, discard, commit, checkout, stash, push, pull, fetch: any git command that
  writes (ADR 0010).
- Side-by-side diffs; showing the whole file; expanding the context between hunks.
- A commit's whole diff on one page (one Diff item per file).
- Other branches, the commit graph, tags, blame, file history, search in the log.
- Several repositories at once (nested repositories and `.worktrees/*` under the root are not
  listed); submodule contents.
- Polling.

## Sidebar view switch

`src/files/panelStore.ts`:

- `SidebarView = "agents" | "files" | "git"`. The default (no stored choice) is `"files"`. A stored
  `"split"` fails `isView` and falls back to the default, in `herdly:sidebar-view` and in each
  Session's entry of `herdly:sidebar-views`.
- Removed: `height`, `collapsed`, `setHeight`, `setCollapsed`, `filesHidden`, `shownView`.
- `focusTree` and `focusGoto` (⌘P) set the view to `"files"` from any other view, unpersisted as
  today.

`src/agents/AgentList.tsx`: the third `VIEWS` entry is `{ view: "git", label: "Git", Icon:
GitBranchIcon }`. The agent list is hidden whenever the view is not `"agents"`.

`src/files/FilesPanel.tsx`: the separator, `CollapseButton`, `toggleFromHead` and the 50% basis go.
The panel is either the whole column (`view === "files"`) or `hidden`; it stays mounted in the
other views, because its Files watch is what reloads the open file and feeds the Git view.

## Git view (sidebar)

Rendered in the agents column when `view === "git"`, as a sibling of the (hidden) Files panel.

**Which repository.** The Git view follows the same Workspace as the Files panel
(`shownWorkspace`, honouring the pinned Workspace) and the same root. The root resolution now in
`WorkspacePanel` (resolved once, again when the Workspace folder is set, overridden by the active
file item's root) moves into a hook `useFilesRoot(ref)` that both panels call. The repository is
`git rev-parse --show-toplevel` of that root. With no Workspace: "Select an agent to see its
changes". Root not in a repository: "Not a git repository" and the root path. Machine offline:
the last result stays, greyed, with "Offline".

**Header.** Repository folder name · branch (short sha when detached) · `↑ahead ↓behind` against
the upstream (hidden without one) · ⟳ Refresh.

**Sections**, each with a chevron to collapse it (collapsed state kept per section for the
running app) and a count:

1. **Merge Changes**: unmerged entries; shown only when there are some.
2. **Staged Changes**: entries whose index column is not `.`.
3. **Changes**: entries whose working-tree column is not `.`, then untracked files. A file staged
   and then edited again is in both 2 and 3.
4. **Commits**: the 50 newest commits reachable from HEAD, then **Load more** while git returned a
   full page.

A section with no entries shows nothing under its header (Staged Changes and Changes headers are
always shown; Merge Changes is not).

**File row.** File name, then its folder (relative to the repository root) dimmed, then the status
letter at the right in its colour: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied,
`T` type changed, `U` untracked, `!` conflicted. A rename shows `old → new` in the folder slot and
in the tooltip. The tooltip is the full path.

**Commit row.** Chevron, short sha (monospace), subject, then author and relative time dimmed.
The tooltip is the full sha, author, absolute date and the whole message. Expanding it fetches
the commit's files once (cached by sha) and lists them as file rows, indented.

**Clicks.**

- Click a file row: opens its Diff item as the preview (replacing the current preview, as a file
  click in the tree does). Double-click: opens it pinned.
- Context menu on a file row: **Open file** (opens the file Open item; only when the path is
  under the Files panel's root and the file is not deleted in that scope), **Copy path**
  (absolute).
- Context menu on a commit row: **Copy sha**, **Copy message**.
- The row of the active Diff item is highlighted.

**Refresh.** The Files watch excludes `.git`, so staging and committing never reach it. The Git
view reads the status again (and the first page of the log, if the HEAD sha changed) when:

- the view is shown, or its repository changes;
- a Files watch batch arrives for the Files panel's root (debounced 300 ms); changes outside the
  root but inside the repository arrive only through the other triggers;
- an Agent in the shown Workspace leaves `working` (it may have staged or committed);
- the window regains focus;
- the user clicks ⟳ (also resets the log to its first page).

Reads are serialized per repository; a read that finishes after a newer one started is dropped
(`latestOnly`).

## Diff item

`src/store/openItems.ts`:

```ts
type DiffScope = { kind: "worktree" } | { kind: "staged" } | { kind: "commit"; sha: string; short: string };
type OpenItem =
  | { kind: "agent"; ref: PaneRef }
  | { kind: "file"; ws: WorkspaceRef; root: string; rel: string }
  | { kind: "diff"; ws: WorkspaceRef; root: string; repo: string; prefix: string; path: string; origPath: string | null; scope: DiffScope; untracked: boolean };
```

`root` is the Files panel root the item was opened from (its Files watch refreshes the item) and
`prefix` is that root's path inside the repository (`git rev-parse --show-prefix`), so "Open
file" maps `path` to the root without comparing absolute paths that git may have resolved
through symlinks.

`itemKey` of a Diff item: `"diff:" + wsKey(ws) + "|" + repo + "|" + scopeKey + "|" + path`, where
`scopeKey` is `worktree`, `staged` or the full sha. So the staged and the working-tree diff of one
file are two Open items.

Every site that branches on `kind === "file"` handles `"diff"`: `App.tsx` (the `online` flag, and
rendering `DiffViewer` for an active Diff item), `OpenStrip.tsx` (label, icon), `store/app.ts`
(new `openDiff(item, { pin })`; the active-item branch that keeps the viewed Session), `root.ts`
(`panelWorkspace` returns a Diff item's `ws`, so the Files panel and the Git view follow it),
`openItems.ts` (`itemKey`; `inRoot` stays file-only: closing a root's files does not close
diffs).

**Tab label** (Open strip): `name (Working Tree)`, `name (Index)`, `name @ <short sha>`, with a
diff icon; the tooltip is the repository-relative path and the scope in words.

## Diff viewer

`src/git/DiffViewer.tsx`, the main area for an active Diff item.

**Header.** Path (`old → new` for a rename), `+added −removed` from `--numstat`, **Open file**
(same rule as the context menu). For a commit scope, a second line: short sha, subject, author,
relative time.

**Body.** For each hunk, a header row `@@ -a,b +c,d @@ <section heading>`, then its lines:
old line number, new line number, a `+`/`−`/space marker, and the text. Added lines have the
add background, deleted lines the delete background, both as theme tokens in light and dark.
`\ No newline at end of file` shows as a dim note under the line it belongs to. Rows are
virtualized with `@tanstack/react-virtual` as in `TextView`. Text is selectable; copying a
selection copies the text without line numbers or markers.

**Highlighting** (`src/git/diffLines.ts`). Per hunk, the old side (context and deleted lines in
order) and the new side (context and added lines in order) are joined into two texts, each run
through `highlightLines(text, path)` once, and the segments are mapped back to the rows, so a
block comment or template string spanning lines inside one hunk is coloured right. Above
`HIGHLIGHT_LIMIT` total or for an unknown extension: plain text.

**Special cases**, each a one-line notice in place of (or above) the body:

| Case | Shows |
|------|-------|
| Binary | "Binary file changed" |
| Untracked | the whole file as added lines (read with `--no-index`) |
| Deleted | the whole old file as deleted lines |
| Rename or copy, no content change | "Renamed, no content changes" |
| Mode change only | "Mode changed 100644 → 100755" (also shown above hunks when content changed too) |
| Truncated | the hunks read, then "Diff truncated at 2 MB" |
| Conflicted | git's combined diff (`@@@`), two markers per line, not highlighted |
| No difference any more | "No changes" (the item stays open) |
| Error | git's message, with Retry |

**Refresh.** Worktree and staged Diff items read again on the same triggers as the Git view
(a Files watch batch for the Files panel's root, which may cover only part of the repository;
an Agent leaving `working`; window focus; ⟳ in the Git view). A commit Diff item never changes and is read once. Keeps the scroll position across
re-reads when the hunks above it did not change; otherwise starts at the top. Offline: the last
read stays, with an offline banner as in the File viewer.

## Backend

`src-tauri/src/git.rs` becomes the module `src-tauri/src/git/`:

- `status.rs`: today's `git_status` and `parse_porcelain_v2`, which gains the renamed entry's
  original path; the Chat status line still lists at most `MAX_CHANGES`.
- `repo.rs`: `git_repo`.
- `log.rs`: `git_log`, `git_commit_files`.
- `diff.rs`: `git_diff` and the unified-diff parser.

Every command runs `sh -c '<script>' sh <args…>` through the Machine's `Transport` (`exec`), with
paths and shas passed as positional arguments, never spliced into the script. Every git call
carries `--no-optional-locks -c core.quotepath=off -c color.ui=never --no-pager`. A sha argument
must match `^[0-9a-f]{4,64}$` before anything runs.

### Commands

**`git_repo(machine_id, dir) -> Option<GitRepo>`**

`cd "$dir" && git rev-parse --show-toplevel`, then `git status --porcelain=v2 --branch -z
--untracked-files=all` in the top level. `None` outside a repository.

```rust
struct GitRepo { root: String, prefix: String, head: Option<String> /* full sha; None before the first commit */,
  branch: Option<String>, upstream: Option<String>, ahead: u32, behind: u32, entries: Vec<GitEntry>,
  total: u32 }
struct GitEntry { path: String, orig_path: Option<String>, index: char, worktree: char,
  /* '?' both for untracked */ unmerged: bool }
```

At most `MAX_GIT_ENTRIES` (5000) entries, in `git status` order, plus `total: u32`; past the
limit the Changes section ends with "… N more files" (a large folder that is not ignored).

**`git_log(machine_id, root, skip, limit) -> Vec<GitCommit>`**

`git log --skip=<skip> -n <limit> --format=%H%x00%h%x00%an%x00%at%x00%P%x00%s%x00%b%x1e`.
Empty before the first commit (exit 128 with "does not have any commits" is not an error).

```rust
struct GitCommit { sha: String, short: String, author: String, time: i64, parents: u32,
  subject: String, body: String }
```

**`git_commit_files(machine_id, root, sha) -> Vec<GitCommitFile>`**

`git diff-tree -r -z -M --no-commit-id --name-status <sha>^ <sha>` (first parent; a merge's
default diff-tree output is empty), or `git diff-tree -r -z -M --root --no-commit-id
--name-status <sha>` for a root commit.

```rust
struct GitCommitFile { status: char, path: String, orig_path: Option<String> }
```

**`git_diff(machine_id, root, path, orig_path, scope, untracked) -> FileDiff`**

| Scope | Command |
|-------|---------|
| worktree | `git diff -M -- <path>` |
| worktree, untracked | `git diff --no-index -- /dev/null <path>` (exit 1 means "differs", not failure) |
| staged | `git diff --cached -M -- [<orig>] <path>` |
| commit | `git diff -M <sha>^ <sha> -- [<orig>] <path>` (`git diff-tree -p --root` form for a root commit) |

The patch is piped through `head -c $((MAX_TEXT_BYTES + 1))` on the Machine; more than
`MAX_TEXT_BYTES` read means truncated, and the partial last line is dropped. `--numstat` with the
same arguments gives `added`/`removed` (`-` for binary).

```rust
struct FileDiff { binary: bool, old_mode: Option<String>, new_mode: Option<String>,
  rename: Option<String> /* old path */, added: u32, removed: u32, hunks: Vec<Hunk>, truncated: bool }
struct Hunk { header: String, old_start: u32, new_start: u32, lines: Vec<DiffLine> }
struct DiffLine { kind: LineKind /* Context | Add | Del | Combined */, old_no: Option<u32>,
  new_no: Option<u32>, text: String, no_newline: bool }
```

### Errors

git missing, a vanished sha or path, a repository gone: an `AppError` carrying git's stderr. The
UI shows it in place (Git view body or Diff viewer) with Retry; it never toasts.

## Frontend layout

New folder `src/git/`:

- `GitPanel.tsx`: the Git view (header, sections, refresh wiring).
- `ChangeList.tsx`: Merge Changes, Staged Changes, Changes.
- `CommitList.tsx`: commits, their files, Load more.
- `DiffViewer.tsx`, `diffLines.ts`.
- `store.ts`: per `machine|repo`: status, log pages, commit files by sha, collapsed sections.
- `refresh.ts`: the refresh triggers as one hook.

`src/lib/ipc.ts` and `src/lib/types.ts` gain the four commands and their types.

## Testing

Rust, against real repositories in a `tempdir` (as `git.rs` does today):

- status: modified, added, deleted, renamed (with original path), untracked, staged then modified,
  the entry limit and `total`,
  conflicted, detached HEAD, no commits yet, a Vietnamese file name, a root that is a subfolder.
- log: paging with `skip`, a merge's parent count, the empty repository.
- commit files: an ordinary commit, a merge (first parent), the root commit, a rename.
- diff: every row of the scope table; binary; mode change only; rename without content change;
  missing newline at the end; the 2 MB cut (truncated flag, no partial line); combined diff of a
  conflict; a path with spaces and Vietnamese characters; a bad sha refused before running.
- the unified-diff parser on fixed patch texts, including `@@` lines inside content.

Vitest:

- panel store: a stored `"split"` (global and per Session) reads as `"files"`; ⌘P from the agents
  and git views switches to files.
- view switch shows three buttons; the agent list is hidden in files and git.
- `ChangeList`: the three sections, a file in both Staged and Changes, status letters, rename row.
- opening: click opens the preview, double-click pins, staged and working-tree of one file are two
  items; tab labels.
- `diffLines`: a block comment spanning lines inside a hunk is highlighted on every row; plain
  text over the limit.
- `DiffViewer`: each special case's notice; line numbers of context, add and delete rows.
- refresh: a watch batch, an Agent leaving `working` and window focus each read again; a stale
  read is dropped.

Finally, the app run against this repository to check the view and the diffs by eye.
