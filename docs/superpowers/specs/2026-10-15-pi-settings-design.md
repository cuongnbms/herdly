# pi settings: Enabled models and Model aliases

Date: 2026-10-15
Status: approved design

## Purpose

pi keeps two lists the user edits by hand today: the **Enabled models** that Ctrl+P cycles
through (`enabledModels` in `<agent dir>/settings.json`), and, when the
[`pi-model-fallback-alias`](https://github.com/unrelentingfox/pi-model-fallback-alias) package
is installed, the **Model aliases** in `<agent dir>/model-alias.json`. This adds a **pi**
section to Settings that edits both, for any connected Machine, local or remote.

## Scope

In:

- A **pi** section in the Settings dialog with a Machine picker.
- Enabled models: a catalog from `pi --list-models` with a checkbox per model, plus the ordered
  Ctrl+P list (drag to reorder, remove, add a free-text pattern).
- Model aliases (only when the alias package is installed): add, rename, delete aliases; add,
  remove and reorder each alias's targets.
- Save / Revert per block, a version check against the file on disk, a `/reload` reminder.

Out (non-goals):

- Any other pi setting (`defaultModel`, `theme`, `packages`, ...).
- Project-level `.pi/settings.json`; only the global `<agent dir>/settings.json`.
- Alias `timeouts` / `cooldown`, `$settings`, `$defaults`: preserved, never shown or edited.
- `PI_MODEL_ALIAS_MAP`: ignored; the file is always `<agent dir>/model-alias.json`.
- Expanding globs or fuzzy patterns the way pi does to pre-check catalog rows.
- Sending `/reload` to running pi Agents.
- Keeping unsaved edits across closing the dialog or leaving the section.

## Verified pi behaviour (pi-coding-agent 0.84)

- `enabledModels` unset or `[]` means no scope: Ctrl+P cycles through every model
  (`main.js`: `parsed.models ?? settingsManager.getEnabledModels()`, used only when non-empty).
- pi writes `enabledModels` itself: `/scoped-models`, and when a default model outside a
  non-empty scope is chosen (`agent-session.js` `_addPersistedDefaultToNonEmptyScope`). It also
  rewrites `settings.json` for unrelated keys (`defaultModel`, `lastChangelogVersion`, ...).
- `pi --list-models` has no machine-readable output. It prints a header line
  (`provider  model  context  max-out  thinking  images`) and one row per available model,
  sorted by provider then id, columns separated by runs of spaces. It lists models outside
  `enabledModels`, models from `models.json`, and `alias/*` models when the alias package is
  loaded. A broken `models.json` prints a warning on stderr; no models prints a message instead
  of a table.
- The alias package registers each top-level key `k` of `model-alias.json` (except `$settings`
  and `$defaults`) as model `alias/k`. A value is a model string, an ordered array of targets,
  or an object with `targets` (plus `timeouts`, `cooldown`). A target may be another `alias/*`.

## Backend

### Probe (`src-tauri/src/transport/mod.rs`)

`PROBE_SCRIPT` prints two more lines before `@@SESSIONS@@`:

- `AGENT_DIR=` `$PI_CODING_AGENT_DIR` if set, else `$HOME/.pi/agent`. It cannot be derived from
  `PI_DIR`, which `PI_CODING_AGENT_SESSION_DIR` can point anywhere.
- `PI=` the absolute path of `pi`, found the way `herdr` is: login shell `command -v pi`, then
  interactive shell, then `$HOME/.local/bin/pi`, `/opt/homebrew/bin/pi`, `/usr/local/bin/pi`;
  empty when not found. The pi lookup must not change how `H` (herdr) is resolved.

`MachineInfo` gains `agent_dir: String` and `pi: String` (empty = not found). `parse_probe`
fills them; a probe without the lines (older fixture) yields `agent_dir = "$HOME/.pi/agent"`
and `pi = ""`. Fixtures in `transport/mod.rs` tests and `machines.rs` tests are updated.

### `pi_models_list(machine_id) -> Vec<PiModel>`

New module `src-tauri/src/pi.rs`, command registered in `lib.rs`.

- `PiModel { provider: String, id: String }`.
- Runs `sh -c 'PATH="${1%/*}:$PATH" exec "$1" --list-models' sh <pi>` so a `#!/usr/bin/env node`
  pi finds the node installed beside it (mise, nvm, npm global) without a login shell.
- Errors: `not_found` when `info.pi` is empty; `io` with stderr (or `exit N`) on a non-zero
  exit; runs with the transport's normal exec and a 30 s timeout.
- `parse_list_models(stdout) -> Vec<PiModel>`: skip lines until the header line starting with
  `provider` followed by `model`; each later non-empty line split on whitespace, first token is
  the provider, second the id; lines with fewer than two tokens are skipped. No header (the
  "no models" message) yields an empty list.

### Reading and writing the files

No new file commands. The frontend uses `files_read` and `files_write` with
`root = info.agent_dir` and `rel = "settings.json"` or `"model-alias.json"`. `files_write`
already checks the `FileVersion` it is given (ADR 0007) and, with `expected = null`, writes
regardless and creates a missing file when its folder exists.

`MachineView` (`src-tauri/src/view.rs`, mirrored in `src/lib/types.ts`) gains
`pi_agent_dir: Option<String>` (None until probed) and `has_pi: bool`, filled in
`machines.rs` `view()` from `info`, so the UI shows the section's empty states without a
round trip.

## Frontend

### Pure logic: `src/settings/pi.ts`

All JSON handling is here, unit-tested, no React:

- `parseSettings(text)` → `{ json, enabled: string[] }` or a parse error. A non-array
  `enabledModels` is a parse error for this purpose (never overwrite what we don't understand).
- `withEnabled(json, list)` → new text: replaces `enabledModels` in place (same key position),
  appends it when absent, deletes the key when `list` is empty. Every other key and its order
  are kept. Output is `JSON.stringify(obj, null, 2)` plus a trailing newline.
- `hasAliasPackage(json)` → true when any string in `packages` (or `source` of an object
  entry) contains `pi-model-fallback-alias`.
- `parseAliases(text)` → ordered `Alias[]` (`{ name, targets, form: "string" | "array" | "object" }`)
  plus the untouched raw object; `$`-prefixed keys are kept aside, not listed.
- `withAliases(raw, aliases)` → new text: `$settings` / `$defaults` and other `$` keys keep their
  place; an object-form alias gets only its `targets` replaced; a string-form alias whose
  single target is unchanged stays a string, otherwise becomes an array; new aliases are
  arrays, appended in UI order; deleted aliases are removed.
- `renameAlias(aliases, index, to)`: renames and rewrites every `alias/<old name>` target to
  `alias/<to>` in all aliases. Applied when the name field is committed (blur or Enter) and
  the new name is valid, not per keystroke, so a half-typed name never captures another
  alias's references.
- `aliasNameError(name, others)`: empty, contains `/`, starts with `$`, or duplicate.
- `enabledConflict(loaded, current)`: true when `enabledModels` on disk differs from the list
  read when the block was opened (order-sensitive).

### Section UI: `src/settings/PiSettings.tsx`

Added to `SECTIONS` in `Settings.tsx` as `{ id: "pi", label: "pi" }`.

**Machine picker** at the top: connected Machines from `useApp` with a `pi_agent_dir`.
Default: the Machine of the selected Pane, else `local`. Disabled while either block has unsaved
changes. The section header shows `●` while there are unsaved changes.

**Empty states**: no connected Machine → "No connected machine". Machine without pi →
"pi not found on <machine>". Nothing else is shown in those cases.

**Enabled models block**, two columns (stacked when narrow):

- Catalog: `pi_models_list` grouped by provider, collapsible group headers with a
  `selected/total` count, a filter box matching `provider/id` case-insensitively. A row is
  checked when the ordered list contains exactly `provider/id` (case-insensitive). Checking
  appends to the end of the list; unchecking removes that entry.
- "Ctrl+P order": the `enabledModels` array verbatim. Each row has a grip (drag to reorder,
  reusing `dropZone`, `GripIcon` and the `moveReply` move logic from Quick replies) and ×.
  Entries that are not an exact catalog id render as a **pattern chip** (italic, "pattern"
  tag). A "Add pattern…" input appends on Enter (trimmed, ignored if empty or duplicate).
  Empty list shows "Empty: Ctrl+P cycles through every model".
- Save / Revert, enabled only when the list differs from what was loaded.

**Model aliases block**, only when `hasAliasPackage(settings)`:

- One card per alias: inline-editable name with a dim `alias/<name>` label and a delete
  button; numbered targets with grip and ×; an "Add target…" input with suggestions from the
  catalog (including `alias/*`) that also accepts free text; "+ New alias" at the end.
- Name errors show under the field. Deleting an alias that another alias targets shows a
  warning on the referencing card (dangling target), not a block. Save is disabled while any
  name is invalid or any alias has no targets.
- Rename cascades via `renameAlias` when the name field is committed.
- Save / Revert, independent of the Enabled models block.

### Data flow and saving

On Machine change (and on opening the section): read `settings.json` and `model-alias.json`
with `files_read`, keep each file's `FileVersion`, call `pi_models_list` in parallel.
A `not_found` from `files_read` on `settings.json` means an empty object with no version (first save creates it).
A missing `model-alias.json` likewise.

**Save (Enabled models)**: read `settings.json` again; if `enabledConflict(loaded, onDisk)`,
show the conflict bar; else write `withEnabled(fresh, list)` with the fresh `FileVersion`.
If that write fails with code `conflict` (pi wrote in between), retry the
read-merge-write once, then show the conflict bar. This keeps pi's own writes to other keys
from ever causing a conflict.

**Save (Model aliases)**: write `withAliases(raw, aliases)` with the version read at load
(whole-file check: only the user edits this file). Missing file → write with `expected = null`.

**Conflict bar** (same choice as Edit mode, ADR 0007): "Changed on disk" with **Reload**
(discard edits, read again) and **Overwrite** (write the edits merged onto the current file,
`expected = null` for aliases; for settings, merge onto a fresh read and write with its version).

After a successful save: the block's loaded state becomes what was written, and a line reads
"New pi agents use this; running ones need /reload."

## Errors

| Case | Shown |
|------|-------|
| `pi_models_list` fails | Error in the catalog column with Retry; the order list still works, every entry renders as a pattern chip |
| A file fails to parse | Error in that block; Save disabled; the file is never written |
| `files_read` fails (other than missing) | Error in that block with Retry |
| Write fails (permission, connection) | Error under Save; edits kept |
| Machine disconnects while open | Picker drops it; section falls back to the default Machine, edits discarded |

## Testing

No app launch. Rust:

- `parse_list_models`: header detection, extra stderr-ish lines before the header, empty
  output, the "no models" message, ids containing `/`.
- `parse_probe` with and without `AGENT_DIR` / `PI`.

TypeScript (`src/settings/pi.test.ts`): `withEnabled` keeps other keys and their order,
replaces in place, deletes on empty; `hasAliasPackage` for `npm:`, `git:` and path entries;
`parseAliases`/`withAliases` round-trip a file with `$settings`, `$defaults`, string, array and
object forms untouched when nothing changed; object form keeps `timeouts`/`cooldown`;
`renameAlias` cascade; `aliasNameError`; `enabledConflict`.

`src/settings/Settings.test.tsx` with `invoke` mocked: catalog check/uncheck updates the order
list; drag reorders; pattern chip rendering and adding; Save writes the merged text with the
fresh version; version mismatch twice shows the conflict bar and Reload re-reads; the alias
block is hidden without the package; rename cascades into another alias's targets.

Commands: `pnpm test`, `pnpm tsc --noEmit` (and lint if configured), `cargo test`.
