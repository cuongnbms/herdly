# pi settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **pi** section in Settings that edits pi's Enabled models and (when the alias package is installed) Model aliases on any connected Machine.

**Architecture:** The Machine probe learns pi's Agent dir and binary; one new Tauri command lists pi's models. All JSON reading, merging and writing happens in TypeScript over the existing `files_read` / `files_write` commands (version-checked writes, ADR 0007). The UI is a new Settings section split into a pure logic module, an I/O module, a reusable drag-to-reorder list, and two blocks.

**Tech Stack:** Rust (Tauri 2, tokio, serde), React 18 + TypeScript, zustand, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-10-15-pi-settings-design.md`

## Global Constraints

- Work on branch `pi-settings` in the main checkout (not a worktree). Package manager: `pnpm`.
- Never launch the app to verify; tests only (`pnpm test`, `pnpm typecheck`, `cd src-tauri && cargo test`).
- `cargo fmt` reformats unrelated files: after running it, `git checkout --` every `src-tauri` file you did not edit in that task.
- File names are constants in `src/settings/pi.ts`: `SETTINGS_FILE = "settings.json"`, `ALIAS_FILE = "model-alias.json"`.
- JSON written by the app is always `JSON.stringify(obj, null, 2) + "\n"`; key order of the source object is preserved.
- A catalog model matches an entry when `entry.toLowerCase() === \`${provider}/${id}\`.toLowerCase()`; nothing else (no glob/fuzzy expansion).
- The alias package is detected by the substring `pi-model-fallback-alias`.
- Errors thrown by `invoke` are `{ code, message }`; turn any caught error into text with `errorText(e)` from `src/settings/piFiles.ts` (`message ?? String(e)`), and test codes with `(e as { code?: string } | null)?.code`.
- `MachineView` gains snake_case fields `pi_agent_dir` and `has_pi`; in `src/lib/types.ts` they are **optional** (`pi_agent_dir?: string | null; has_pi?: boolean`) so existing test fixtures stay valid.
- UI copy is English and exact (tests assert it):
  - Machine picker `<select aria-label="Machine">`, options show `MachineView.label`; unsaved marker `<span className="pi-dirty" title="Unsaved changes">●</span>` beside the picker.
  - Empty states: `No connected machine`; `pi not found on ${label}`.
  - Errors (each in `<p className="note pi-error" role="alert">`): `Cannot list models: ${msg}`, `Cannot read ${file}: ${msg}`, `${file} is not valid JSON`, `enabledModels in settings.json is not a list`, `model-alias.json must be an object`, `Cannot save: ${msg}`; read/list errors carry a `Retry` button.
  - Conflict bar: `<div className="files-banner files-banner-conflict" role="alert">` with `Changed on disk` and buttons `Reload`, `Overwrite`.
  - After a save: `<p className="note">New pi agents use this; running ones need /reload.</p>`.
  - Save/Revert buttons show `Save` / `Revert` with aria-labels `Save enabled models` / `Revert enabled models` and `Save model aliases` / `Revert model aliases`.
- Drag-to-reorder rows use the grip `title="Drag to reorder"`; remove buttons use `aria-label={\`Remove ${item}\`}`.

## Review Focus

- A `settings.json` written by pi while the dialog is open (other keys) must not raise a conflict and must not be lost — Task 5 test `merges onto pi's newer write`.
- `enabledModels` present but not an array (e.g. a string) must never be overwritten — Task 3 test `rejects a non-array enabledModels` and Task 7 test `never saves a file it cannot parse`.
- Alias object form keeps `timeouts`/`cooldown`, and `$settings` / `$defaults` keep their position — Task 4 round-trip tests.
- A half-typed alias name must not rewrite other aliases' targets — Task 8 test `renames on commit only`.
- A Machine without pi or without a probe (older herdr probe output) must show the empty state, not crash — Task 1 `probe_without_pi_lines_defaults`, Task 7 `shows pi not found`.

---

### Task 1: Probe reports pi's Agent dir and binary

**Files:**
- Modify: `src-tauri/src/transport/mod.rs` (`MachineInfo` ~L15, `PROBE_SCRIPT` ~L266, `parse_probe` ~L317, tests ~L520-570)
- Modify: `src-tauri/src/view.rs:18-28` (`MachineView`)
- Modify: `src-tauri/src/machines.rs:282` (`view()`)
- Modify (test fixtures only, add the two fields): `src-tauri/src/attach.rs:917`, `src-tauri/src/transcript/locate.rs:319`, `src-tauri/src/transcript/locate.rs:368`
- Modify: `src/lib/types.ts:61-71` (`MachineView`)

**Interfaces:**
- Produces: `MachineInfo { home, herdr, pi_dir, agent_dir: String, pi: String, version, protocol }` (`pi` empty = not found); `MachineView.pi_agent_dir: Option<String>` (None while `info` is None), `MachineView.has_pi: bool` (`info.pi` non-empty); TS `MachineView.pi_agent_dir?: string | null`, `MachineView.has_pi?: boolean`.

- [ ] **Step 1: Write the failing tests** in the `tests` module of `src-tauri/src/transport/mod.rs`. Replace `info()` and `parses_probe_output`, add three tests:

```rust
    fn info() -> MachineInfo {
        MachineInfo {
            home: "/home/u".into(),
            herdr: "/home/u/.local/bin/herdr".into(),
            pi_dir: "/home/u/.pi/agent/sessions".into(),
            agent_dir: "/home/u/.pi/agent".into(),
            pi: "/home/u/.local/bin/pi".into(),
            version: "0.9.3".into(),
            protocol: 22,
        }
    }

    #[test]
    fn parses_probe_output() {
        let out = "HOME=/home/u\nHERDR=/home/u/.local/bin/herdr\nPI_DIR=/home/u/.pi/agent/sessions\nAGENT_DIR=/home/u/.pi/agent\nPI=/home/u/.local/bin/pi\nVERSION=0.9.3\nPROTOCOL=22\n";
        assert_eq!(parse_probe(out).unwrap(), info());
    }
    #[test]
    fn probe_without_pi_lines_defaults() {
        let i = parse_probe("HOME=/home/u\nHERDR=/h/herdr\nPI_DIR=/x\nVERSION=0.9.3\nPROTOCOL=22\n").unwrap();
        assert_eq!(i.agent_dir, "/home/u/.pi/agent");
        assert_eq!(i.pi, "");
    }
    #[test]
    fn probe_keeps_custom_agent_dir() {
        let i = parse_probe("HOME=/home/u\nHERDR=/h/herdr\nAGENT_DIR=/opt/pi agent\nPI=\nVERSION=0.9.3\nPROTOCOL=22\n").unwrap();
        assert_eq!(i.agent_dir, "/opt/pi agent");
        assert_eq!(i.pi, "");
    }
    #[test]
    fn probe_script_finds_agent_dir_and_pi() {
        let d = tempfile::tempdir().unwrap();
        let bin = d.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let pi = bin.join("pi");
        std::fs::write(&pi, "#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&pi, std::fs::Permissions::from_mode(0o755)).unwrap();
        let out = std::process::Command::new("sh")
            .args(["-c", PROBE_SCRIPT, "sh", "/usr/bin/true"])
            .env_clear()
            .env("HOME", d.path())
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("SHELL", "/bin/sh")
            .env("PI_CODING_AGENT_DIR", "/opt/pi-agent")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("AGENT_DIR=/opt/pi-agent\n"), "{stdout}");
        assert!(stdout.contains(&format!("PI={}\n", pi.display())), "{stdout}");
    }
```

Also add `agent_dir` and `pi` to the three test fixtures in `attach.rs` and `locate.rs` (`agent_dir: "/h/.pi/agent".into(), pi: String::new()`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib transport::tests`
Expected: compile error `struct MachineInfo has no field named agent_dir`.

- [ ] **Step 3: Implement**

- `MachineInfo`: add `pub agent_dir: String` and `pub pi: String` after `pi_dir`.
- `PROBE_SCRIPT`: right after the `PI_DIR` `if … fi` block, before `[ -n "$H" ] || exit 0`, insert exactly:

```sh
echo "AGENT_DIR=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
P=$(command -v pi 2>/dev/null)
case "$P" in /*) ;; *) P=$("${SHELL:-sh}" -lc 'command -v pi' 2>/dev/null | tail -n 1) ;; esac
case "$P" in /*) ;; *) P=$("${SHELL:-sh}" -ic 'command -v pi' 2>/dev/null </dev/null | tail -n 1) ;; esac
case "$P" in /*) ;; *) P="" ;; esac
for c in "$HOME/.local/bin/pi" /opt/homebrew/bin/pi /usr/local/bin/pi; do
  [ -n "$P" ] && break; [ -x "$c" ] && P="$c"
done
echo "PI=$P"
```

- `parse_probe`: `agent_dir` = `field("AGENT_DIR")`, or `format!("{home}/.pi/agent")` when empty; `pi` = `field("PI")`.
- `view.rs` `MachineView`: add `pub pi_agent_dir: Option<String>` and `pub has_pi: bool` after `version`.
- `machines.rs` `view()`: `pi_agent_dir: self.info.as_ref().map(|i| i.agent_dir.clone())`, `has_pi: self.info.as_ref().is_some_and(|i| !i.pi.is_empty())`.
- `src/lib/types.ts` `MachineView`: add after `version`:

```ts
  /** pi's Agent dir on this Machine; null until probed. */
  pi_agent_dir?: string | null;
  /** The probe found a `pi` binary. */
  has_pi?: boolean;
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd src-tauri && cargo test --lib` then `pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transport/mod.rs src-tauri/src/view.rs src-tauri/src/machines.rs src-tauri/src/attach.rs src-tauri/src/transcript/locate.rs src/lib/types.ts
git commit -m "feat(pi): the machine probe finds pi's agent dir and binary"
```

### Task 2: `pi_models_list` command

**Files:**
- Create: `src-tauri/src/pi.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod pi;` in the module list, `commands::pi_models_list` in `generate_handler!` next to `commands::quota_fetch`)
- Modify: `src-tauri/src/commands.rs` (new command after `quota_fetch`, ~L760)
- Modify: `src/lib/types.ts` (add `PiModel`), `src/lib/ipc.ts` (add `piModelsList`)

**Interfaces:**
- Consumes: `MachineInfo.pi` (Task 1); `crate::transport::exec`; `crate::files::paths::{script_argv, io_error}`.
- Produces:
  - Rust: `#[derive(Clone, Debug, PartialEq, Serialize)] pub struct PiModel { pub provider: String, pub id: String }`; `pub fn parse_list_models(stdout: &str) -> Vec<PiModel>`; `pub fn list_models_argv(pi: &str) -> Vec<String>`; `pub async fn list_models(t: &dyn Transport, pi: &str) -> AppResult<Vec<PiModel>>`; command `pi_models_list(machine_id: String) -> Result<Vec<PiModel>, AppError>`.
  - TS: `export interface PiModel { provider: string; id: string }` in `types.ts`; `export const piModelsList = (machineId: string) => invoke<PiModel[]>("pi_models_list", { machineId });` in `ipc.ts`.

- [ ] **Step 1: Write the failing tests** at the bottom of `src-tauri/src/pi.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    fn m(provider: &str, id: &str) -> PiModel {
        PiModel { provider: provider.into(), id: id.into() }
    }
    const TABLE: &str = "provider      model                  context  max-out  thinking  images\n\
9router       ag/gemini-3.8-flash    1M       128K     yes       yes   \n\
alias         high-model             1M       262.1K   yes       yes   \n\
\n";

    #[test]
    fn parses_list_models_table() {
        assert_eq!(
            parse_list_models(TABLE),
            vec![m("9router", "ag/gemini-3.8-flash"), m("alias", "high-model")]
        );
    }
    #[test]
    fn skips_lines_before_the_header() {
        let out = format!("Warning: errors loading models.json:\nbad thing\n{TABLE}");
        assert_eq!(parse_list_models(&out).len(), 2);
    }
    #[test]
    fn no_header_is_empty() {
        assert_eq!(parse_list_models(""), vec![]);
        assert_eq!(parse_list_models("No models available. Run pi login\n"), vec![]);
    }
    #[test]
    fn argv_puts_pi_folder_first_on_path() {
        let argv = list_models_argv("/opt/node/bin/pi");
        assert_eq!(&argv[..2], &["sh", "-c"]);
        assert_eq!(argv.last().unwrap(), "/opt/node/bin/pi");
        assert!(argv[2].contains(r#"PATH="${1%/*}:$PATH" exec "$1" --list-models"#));
    }
    #[tokio::test]
    async fn runs_pi_and_reports_failures() {
        let d = tempfile::tempdir().unwrap();
        let ok = d.path().join("pi");
        std::fs::write(&ok, format!("#!/bin/sh\n[ \"$1\" = --list-models ] || exit 2\ncat <<'EOF'\n{TABLE}EOF\n")).unwrap();
        let bad = d.path().join("pi-bad");
        std::fs::write(&bad, "#!/bin/sh\necho 'models.json broken' >&2\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        for p in [&ok, &bad] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let got = list_models(&LocalTransport, ok.to_str().unwrap()).await.unwrap();
        assert_eq!(got.len(), 2);
        let e = list_models(&LocalTransport, bad.to_str().unwrap()).await.unwrap_err();
        assert_eq!(e.code, "io");
        assert_eq!(e.message, "models.json broken");
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib pi::tests`
Expected: compile error (`parse_list_models` not found) after adding `pub mod pi;` to `lib.rs`.

- [ ] **Step 3: Implement**

- `pi.rs`: `const LIST_MODELS_SCRIPT: &str = r#"PATH="${1%/*}:$PATH" exec "$1" --list-models"#;` `list_models_argv(pi)` = `script_argv(LIST_MODELS_SCRIPT, &[pi])`. `parse_list_models`: skip lines until one whose first two whitespace tokens are `provider` and `model`; each later line with ≥ 2 tokens yields `PiModel { provider: tok0, id: tok1 }`. `list_models`: `exec(t, &list_models_argv(pi))`; status ≠ 0 → `Err(io_error(status, &stderr))`; else `Ok(parse_list_models(&stdout))`.
- `commands.rs`:

```rust
/// The models pi can use on the Machine (`pi --list-models`).
#[tauri::command]
pub async fn pi_models_list(mgr: Mgr<'_>, machine_id: String) -> Result<Vec<crate::pi::PiModel>, AppError>
```

  Body: `let info = mgr.info(&machine_id)?;` if `info.pi.is_empty()` → `Err(AppError::new("not_found", "pi was not found on this machine"))`; else `crate::pi::list_models(&*mgr.transport(&machine_id)?, &info.pi).await`.
- `types.ts` / `ipc.ts`: as in Interfaces (`PiModel` added to the `import type` list in `ipc.ts`).

- [ ] **Step 4: Run to verify they pass**

Run: `cd src-tauri && cargo test --lib pi::tests && cargo build` then `pnpm typecheck`
Expected: PASS, build OK.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pi.rs src-tauri/src/lib.rs src-tauri/src/commands.rs src/lib/types.ts src/lib/ipc.ts
git commit -m "feat(pi): list a machine's pi models"
```

### Task 3: Enabled models logic (`pi.ts`, settings half)

**Files:**
- Create: `src/settings/pi.ts`
- Test: `src/settings/pi.test.ts`

**Interfaces:**
- Produces (all exported from `src/settings/pi.ts`):
  - `SETTINGS_FILE`, `ALIAS_FILE` (string constants)
  - `type Json = Record<string, unknown>`
  - `type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }`
  - `interface PiSettingsFile { json: Json; enabled: string[] }`
  - `parseSettings(text: string): Parsed<PiSettingsFile>` — `""` parses as `{}`; errors use the exact Global Constraints copy.
  - `withEnabled(json: Json, list: string[]): string`
  - `enabledConflict(loaded: string[], onDisk: string[]): boolean`
  - `hasAliasPackage(json: Json): boolean`
  - `modelRef(m: { provider: string; id: string }): string` → `"provider/id"`
  - `isCatalogEntry(entry: string, models: { provider: string; id: string }[]): boolean`

- [ ] **Step 1: Write the failing tests** in `src/settings/pi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { enabledConflict, hasAliasPackage, isCatalogEntry, parseSettings, withEnabled } from "./pi";

const text = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

describe("parseSettings", () => {
  it("reads enabledModels and keeps the whole object", () => {
    const r = parseSettings(text({ theme: "slop", enabledModels: ["xai/grok-4.6", "anthropic/*"] }));
    expect(r).toEqual({ ok: true, value: { json: { theme: "slop", enabledModels: ["xai/grok-4.6", "anthropic/*"] }, enabled: ["xai/grok-4.6", "anthropic/*"] } });
  });
  it("treats a missing key and an empty file as no entries", () => {
    expect(parseSettings(text({ theme: "x" }))).toMatchObject({ ok: true, value: { enabled: [] } });
    expect(parseSettings("")).toEqual({ ok: true, value: { json: {}, enabled: [] } });
  });
  it("rejects broken JSON and non-objects", () => {
    expect(parseSettings("{ nope")).toEqual({ ok: false, error: "settings.json is not valid JSON" });
    expect(parseSettings("[1]")).toEqual({ ok: false, error: "settings.json is not valid JSON" });
  });
  it("rejects a non-array enabledModels", () => {
    expect(parseSettings(text({ enabledModels: "xai/*" }))).toEqual({ ok: false, error: "enabledModels in settings.json is not a list" });
    expect(parseSettings(text({ enabledModels: ["a", 1] }))).toEqual({ ok: false, error: "enabledModels in settings.json is not a list" });
  });
});

describe("withEnabled", () => {
  const json = { theme: "slop", enabledModels: ["a/b"], packages: ["npm:x"] };
  it("replaces the list in place, keeping other keys and their order", () => {
    const out = withEnabled(json, ["c/d", "a/b"]);
    expect(out).toBe(text({ theme: "slop", enabledModels: ["c/d", "a/b"], packages: ["npm:x"] }));
    expect(Object.keys(JSON.parse(out))).toEqual(["theme", "enabledModels", "packages"]);
  });
  it("appends the key when absent", () => {
    expect(Object.keys(JSON.parse(withEnabled({ theme: "x" }, ["a/b"])))).toEqual(["theme", "enabledModels"]);
  });
  it("deletes the key for an empty list", () => {
    expect(withEnabled(json, [])).toBe(text({ theme: "slop", packages: ["npm:x"] }));
  });
  it("does not change its input", () => {
    withEnabled(json, []);
    expect(json.enabledModels).toEqual(["a/b"]);
  });
});

describe("enabledConflict", () => {
  it("is order-sensitive and exact", () => {
    expect(enabledConflict(["a", "b"], ["a", "b"])).toBe(false);
    expect(enabledConflict(["a", "b"], ["b", "a"])).toBe(true);
    expect(enabledConflict(["a"], [])).toBe(true);
  });
});

describe("hasAliasPackage", () => {
  it("finds npm, git and path sources, and object entries", () => {
    expect(hasAliasPackage({ packages: ["npm:pi-model-fallback-alias"] })).toBe(true);
    expect(hasAliasPackage({ packages: ["git:github.com/cuongnbms/pi-model-fallback-alias"] })).toBe(true);
    expect(hasAliasPackage({ packages: ["../src/pi-model-fallback-alias"] })).toBe(true);
    expect(hasAliasPackage({ packages: [{ source: "npm:pi-model-fallback-alias@1.2.0" }] })).toBe(true);
  });
  it("is false without it", () => {
    expect(hasAliasPackage({ packages: ["npm:pi-web-access"] })).toBe(false);
    expect(hasAliasPackage({})).toBe(false);
    expect(hasAliasPackage({ packages: "npm:pi-model-fallback-alias" })).toBe(false);
  });
});

describe("isCatalogEntry", () => {
  const models = [{ provider: "xai", id: "grok-4.6" }];
  it("matches provider/id case-insensitively and nothing else", () => {
    expect(isCatalogEntry("XAI/Grok-4.6", models)).toBe(true);
    expect(isCatalogEntry("xai/*", models)).toBe(false);
    expect(isCatalogEntry("grok", models)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/settings/pi.test.ts`
Expected: FAIL, cannot resolve `./pi`.

- [ ] **Step 3: Implement** the functions listed in Interfaces in `src/settings/pi.ts`. `withEnabled` builds a new object by iterating the input's keys (replace at `enabledModels`, skip it for `[]`, append it if absent and non-empty); never mutates its input.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run src/settings/pi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/pi.ts src/settings/pi.test.ts
git commit -m "feat(pi): read and merge enabledModels without touching other settings"
```

### Task 4: Model alias logic (`pi.ts`, alias half)

**Files:**
- Modify: `src/settings/pi.ts`
- Test: `src/settings/pi.test.ts`

**Interfaces:**
- Consumes: `Json`, `Parsed<T>` (Task 3).
- Produces (exported from `src/settings/pi.ts`):
  - `interface Alias { name: string; targets: string[]; form: "string" | "array" | "object"; orig: string | null }` — `orig` is the key it was read under (null for a new alias); renames change `name`, never `orig`.
  - `interface AliasFile { raw: Json; aliases: Alias[] }`
  - `parseAliases(text: string): Parsed<AliasFile>` — `""` parses as `{}`; keys starting with `$` are not listed; an alias whose value is not a string, string array, or object with a string-array `targets` is a parse error `model-alias.json must be an object`; broken JSON → `model-alias.json is not valid JSON`; a non-object root → `model-alias.json must be an object`.
  - `withAliases(raw: Json, aliases: Alias[]): string`
  - `renameAlias(aliases: Alias[], index: number, to: string): Alias[]`
  - `aliasNameError(name: string, aliases: Alias[], index: number): string | null` — `Name is required` | `Name cannot contain /` | `Name cannot start with $` | `Name already used` | null.
  - `missingTargets(alias: Alias, aliases: Alias[]): string[]` — the `alias/x` targets with no alias named `x`.

- [ ] **Step 1: Write the failing tests** (append to `src/settings/pi.test.ts`, extend the import with `aliasNameError, missingTargets, parseAliases, renameAlias, withAliases, type Alias`):

```ts
const ALIASES = {
  $settings: { statusRefreshMs: 2000 },
  mid: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"],
  $defaults: { cooldown: { baseMs: 1 } },
  high: { targets: ["openai-codex/gpt-5.6-sol"], timeouts: { stallMs: 5 } },
  top: "alias/mid",
};
const parsed = () => {
  const r = parseAliases(text(ALIASES));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("parseAliases", () => {
  it("lists aliases in file order with their form, skipping $ keys", () => {
    expect(parsed().aliases).toEqual([
      { name: "mid", orig: "mid", form: "array", targets: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"] },
      { name: "high", orig: "high", form: "object", targets: ["openai-codex/gpt-5.6-sol"] },
      { name: "top", orig: "top", form: "string", targets: ["alias/mid"] },
    ]);
  });
  it("reads an empty file as no aliases and rejects bad shapes", () => {
    expect(parseAliases("")).toEqual({ ok: true, value: { raw: {}, aliases: [] } });
    expect(parseAliases("{")).toEqual({ ok: false, error: "model-alias.json is not valid JSON" });
    expect(parseAliases("[]")).toEqual({ ok: false, error: "model-alias.json must be an object" });
    expect(parseAliases(text({ a: 3 }))).toEqual({ ok: false, error: "model-alias.json must be an object" });
  });
});

describe("withAliases", () => {
  it("writes an unchanged file back identically", () => {
    const { raw, aliases } = parsed();
    expect(withAliases(raw, aliases)).toBe(text(ALIASES));
  });
  it("keeps object fields, $ keys and positions; renamed keys stay in place", () => {
    const { raw, aliases } = parsed();
    const next: Alias[] = [
      { ...aliases[0], name: "middle" },
      { ...aliases[1], targets: ["a/b", "alias/middle"] },
      aliases[2],
    ];
    expect(JSON.parse(withAliases(raw, next))).toEqual({
      $settings: { statusRefreshMs: 2000 },
      middle: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"],
      $defaults: { cooldown: { baseMs: 1 } },
      high: { targets: ["a/b", "alias/middle"], timeouts: { stallMs: 5 } },
      top: "alias/mid",
    });
    expect(Object.keys(JSON.parse(withAliases(raw, next)))).toEqual(["$settings", "middle", "$defaults", "high", "top"]);
  });
  it("turns a changed string form into an array, drops deleted aliases, appends new ones", () => {
    const { raw, aliases } = parsed();
    const next: Alias[] = [
      aliases[1],
      { ...aliases[2], targets: ["alias/high"] },
      { name: "fast", orig: null, form: "array", targets: ["x/y"] },
    ];
    expect(JSON.parse(withAliases(raw, next))).toEqual({
      $settings: { statusRefreshMs: 2000 },
      $defaults: { cooldown: { baseMs: 1 } },
      high: { targets: ["openai-codex/gpt-5.6-sol"], timeouts: { stallMs: 5 } },
      top: ["alias/high"],
      fast: ["x/y"],
    });
  });
});

describe("renameAlias", () => {
  it("renames and rewrites references in every alias", () => {
    const next = renameAlias(parsed().aliases, 0, "middle");
    expect(next[0]).toMatchObject({ name: "middle", orig: "mid" });
    expect(next[2].targets).toEqual(["alias/middle"]);
  });
  it("leaves aliases with similar names alone", () => {
    const list: Alias[] = [
      { name: "a", orig: "a", form: "array", targets: ["x/y"] },
      { name: "b", orig: "b", form: "array", targets: ["alias/a", "alias/ab"] },
    ];
    expect(renameAlias(list, 0, "z")[1].targets).toEqual(["alias/z", "alias/ab"]);
  });
});

describe("aliasNameError", () => {
  const list = parsed().aliases;
  it("checks emptiness, slash, $ prefix and duplicates (not itself)", () => {
    expect(aliasNameError("", list, 0)).toBe("Name is required");
    expect(aliasNameError("a/b", list, 0)).toBe("Name cannot contain /");
    expect(aliasNameError("$x", list, 0)).toBe("Name cannot start with $");
    expect(aliasNameError("high", list, 0)).toBe("Name already used");
    expect(aliasNameError("mid", list, 0)).toBeNull();
  });
});

describe("missingTargets", () => {
  it("names alias targets that point nowhere", () => {
    const list = parsed().aliases.filter((a) => a.name !== "mid");
    expect(missingTargets(list[1], list)).toEqual(["alias/mid"]);
    expect(missingTargets(list[0], list)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/settings/pi.test.ts`
Expected: FAIL, `parseAliases` is not exported.

- [ ] **Step 3: Implement** in `src/settings/pi.ts`. `withAliases`: iterate `raw`'s keys; a `$` key is copied; an alias key is written under the current `name` of the alias whose `orig` is that key (skipped if none). Value: `object` form → `{ ...raw[orig], targets }`; `string` form with `targets.length === 1 && targets[0] === raw[orig]` → the string; otherwise the array. Then append aliases with `orig === null` as arrays, in list order. `renameAlias` rewrites only targets exactly equal to `alias/<old name>`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run src/settings/pi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/pi.ts src/settings/pi.test.ts
git commit -m "feat(pi): read and write model aliases, keeping fields the app does not edit"
```

### Task 5: Loading and saving the files (`piFiles.ts`)

**Files:**
- Create: `src/settings/piFiles.ts`
- Test: `src/settings/piFiles.test.ts`

**Interfaces:**
- Consumes: `filesRead`, `filesWrite`, `piModelsList` from `src/lib/ipc.ts`; `FileVersion`, `FileContent`, `PiModel` from `src/lib/types.ts`; Task 3/4 exports.
- Produces (exported from `src/settings/piFiles.ts`):
  - `errorText(e: unknown): string`
  - `type Loaded<T> = { kind: "ok"; value: T; version: FileVersion | null } | { kind: "error"; error: string }` — `version` is null when the file does not exist.
  - `loadSettings(machineId: string, dir: string): Promise<Loaded<PiSettingsFile>>`
  - `loadAliases(machineId: string, dir: string): Promise<Loaded<AliasFile>>`
  - `type SaveOutcome<T> = { kind: "saved"; value: T; version: FileVersion } | { kind: "conflict" } | { kind: "error"; error: string }`
  - `saveEnabled(machineId: string, dir: string, loaded: string[], list: string[], force: boolean): Promise<SaveOutcome<PiSettingsFile>>`
  - `saveAliases(machineId: string, dir: string, raw: Json, aliases: Alias[], version: FileVersion | null, force: boolean): Promise<SaveOutcome<AliasFile>>`

Rules: a read rejecting with code `not_found` → `{ kind: "ok", value: <parse of "">, version: null }`; any other rejection → `Cannot read ${file}: ${errorText(e)}`; content with `editable === false` or `cksum === null` → `Cannot read ${file}: not a text file`; a parse failure → its `error` text. `saveEnabled`: read the file fresh (a read error or parse error → `{ kind: "error" }` with that text); unless `force`, `enabledConflict(loaded, fresh.enabled)` → `{ kind: "conflict" }`; write `withEnabled(fresh.json, list)` with the fresh version (null when missing); a `conflict` rejection retries the whole read-merge-write once, a second one → `{ kind: "conflict" }`; other rejections → `Cannot save: ${msg}`. `saveAliases`: write `withAliases(raw, aliases)` with `force ? null : version`; `conflict` → `{ kind: "conflict" }`; others → `Cannot save: ${msg}`. Saved `value` is the parse of the text written.

- [ ] **Step 1: Write the failing tests** in `src/settings/piFiles.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "../lib/types";

const ipc = vi.hoisted(() => ({ filesRead: vi.fn(), filesWrite: vi.fn(), piModelsList: vi.fn() }));
vi.mock("../lib/ipc", () => ipc);
import { loadAliases, loadSettings, saveAliases, saveEnabled } from "./piFiles";

const text = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const content = (t: string, over: Partial<FileContent> = {}): FileContent =>
  ({ kind: "text", text: t, truncated: false, size: t.length, mtime: 1, cksum: 42, editable: true, ...over });
const DIR = "/home/u/.pi/agent";
let disk: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  disk = { "settings.json": text({ theme: "slop", enabledModels: ["a/b"] }) };
  ipc.filesRead.mockImplementation(async (_m: string, _d: string, rel: string) => {
    if (!(rel in disk)) throw { code: "not_found", message: "no such file" };
    return content(disk[rel]);
  });
  ipc.filesWrite.mockImplementation(async (_m: string, _d: string, rel: string, t: string) => {
    disk[rel] = t;
    return { size: t.length, mtime: 2, cksum: 7 };
  });
});

describe("loadSettings", () => {
  it("returns the parsed file and its version", async () => {
    expect(await loadSettings("local", DIR)).toEqual({
      kind: "ok", value: { json: { theme: "slop", enabledModels: ["a/b"] }, enabled: ["a/b"] }, version: { size: disk["settings.json"].length, mtime: 1, cksum: 42 },
    });
    expect(ipc.filesRead).toHaveBeenCalledWith("local", DIR, "settings.json");
  });
  it("treats a missing file as empty with no version", async () => {
    delete disk["settings.json"];
    expect(await loadSettings("local", DIR)).toEqual({ kind: "ok", value: { json: {}, enabled: [] }, version: null });
  });
  it("reports read and parse errors", async () => {
    ipc.filesRead.mockRejectedValueOnce({ code: "io", message: "boom" });
    expect(await loadSettings("local", DIR)).toEqual({ kind: "error", error: "Cannot read settings.json: boom" });
    disk["settings.json"] = "{";
    expect(await loadSettings("local", DIR)).toEqual({ kind: "error", error: "settings.json is not valid JSON" });
    ipc.filesRead.mockResolvedValueOnce(content("x", { editable: false, cksum: null }));
    expect(await loadSettings("local", DIR)).toEqual({ kind: "error", error: "Cannot read settings.json: not a text file" });
  });
});

describe("saveEnabled", () => {
  it("merges onto pi's newer write", async () => {
    disk["settings.json"] = text({ theme: "slop", enabledModels: ["a/b"], defaultModel: "x/y" });
    const r = await saveEnabled("local", DIR, ["a/b"], ["c/d", "a/b"], false);
    expect(r.kind).toBe("saved");
    expect(JSON.parse(disk["settings.json"])).toEqual({ theme: "slop", enabledModels: ["c/d", "a/b"], defaultModel: "x/y" });
    expect(ipc.filesWrite).toHaveBeenCalledWith("local", DIR, "settings.json", expect.any(String), { size: expect.any(Number), mtime: 1, cksum: 42 });
  });
  it("reports a conflict when enabledModels changed on disk, unless forced", async () => {
    disk["settings.json"] = text({ enabledModels: ["z/z"] });
    expect(await saveEnabled("local", DIR, ["a/b"], ["c/d"], false)).toEqual({ kind: "conflict" });
    expect(ipc.filesWrite).not.toHaveBeenCalled();
    expect((await saveEnabled("local", DIR, ["a/b"], ["c/d"], true)).kind).toBe("saved");
    expect(JSON.parse(disk["settings.json"]).enabledModels).toEqual(["c/d"]);
  });
  it("retries once when the write races, then gives up", async () => {
    ipc.filesWrite.mockRejectedValueOnce({ code: "conflict", message: "changed" });
    expect((await saveEnabled("local", DIR, ["a/b"], ["c/d"], false)).kind).toBe("saved");
    expect(ipc.filesWrite).toHaveBeenCalledTimes(2);
    ipc.filesWrite.mockReset();
    ipc.filesWrite.mockRejectedValue({ code: "conflict", message: "changed" });
    disk["settings.json"] = text({ enabledModels: ["c/d"] });
    expect(await saveEnabled("local", DIR, ["c/d"], ["e/f"], false)).toEqual({ kind: "conflict" });
    expect(ipc.filesWrite).toHaveBeenCalledTimes(2);
  });
  it("creates a missing settings.json", async () => {
    delete disk["settings.json"];
    expect((await saveEnabled("local", DIR, [], ["a/b"], false)).kind).toBe("saved");
    expect(ipc.filesWrite).toHaveBeenCalledWith("local", DIR, "settings.json", text({ enabledModels: ["a/b"] }), null);
  });
  it("never writes over a file it cannot parse", async () => {
    disk["settings.json"] = text({ enabledModels: "a/*" });
    expect(await saveEnabled("local", DIR, [], ["a/b"], true)).toEqual({ kind: "error", error: "enabledModels in settings.json is not a list" });
    expect(ipc.filesWrite).not.toHaveBeenCalled();
  });
  it("reports other write errors", async () => {
    ipc.filesWrite.mockRejectedValueOnce({ code: "io", message: "Permission denied" });
    expect(await saveEnabled("local", DIR, ["a/b"], [], false)).toEqual({ kind: "error", error: "Cannot save: Permission denied" });
  });
});

describe("aliases", () => {
  it("loads a missing file as empty and creates it on save", async () => {
    const r = await loadAliases("local", DIR);
    expect(r).toEqual({ kind: "ok", value: { raw: {}, aliases: [] }, version: null });
    const s = await saveAliases("local", DIR, {}, [{ name: "fast", orig: null, form: "array", targets: ["x/y"] }], null, false);
    expect(s).toMatchObject({ kind: "saved", value: { aliases: [{ name: "fast", orig: "fast", form: "array", targets: ["x/y"] }] } });
    expect(ipc.filesWrite).toHaveBeenCalledWith("local", DIR, "model-alias.json", text({ fast: ["x/y"] }), null);
  });
  it("checks the whole file's version and reports conflicts", async () => {
    const v = { size: 1, mtime: 1, cksum: 1 };
    ipc.filesWrite.mockRejectedValueOnce({ code: "conflict", message: "changed" });
    expect(await saveAliases("local", DIR, {}, [], v, false)).toEqual({ kind: "conflict" });
    expect(ipc.filesWrite).toHaveBeenLastCalledWith("local", DIR, "model-alias.json", "{}\n", v);
    await saveAliases("local", DIR, {}, [], v, true);
    expect(ipc.filesWrite).toHaveBeenLastCalledWith("local", DIR, "model-alias.json", "{}\n", null);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/settings/piFiles.test.ts`
Expected: FAIL, cannot resolve `./piFiles`.

- [ ] **Step 3: Implement** `src/settings/piFiles.ts` per Interfaces and Rules. Version from a read: `{ size, mtime, cksum }` of the `FileContent`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run src/settings/piFiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/piFiles.ts src/settings/piFiles.test.ts
git commit -m "feat(pi): load and save pi's files with version checks"
```

### Task 6: `ReorderList` component

**Files:**
- Create: `src/settings/ReorderList.tsx`
- Test: `src/settings/ReorderList.test.tsx`
- Modify: `src/styles.css:586-603` (make every `.quick-reply-row` rule also apply to `.reorder-row`, e.g. `.quick-reply-row, .reorder-row { … }`)

**Interfaces:**
- Consumes: `moveReply` from `src/settings/quickReplies.ts`; `dropZone` from `src/sidebar/dnd.ts`; `GripIcon`, `CloseIcon` from `src/ui/icons`.
- Produces: `export function ReorderList({ label, items, onChange, render }: { label: string; items: string[]; onChange: (next: string[]) => void; render?: (item: string, i: number) => ReactNode }): JSX.Element` — renders `<div role="list" aria-label={label}>` with one `<div role="listitem" className="reorder-row">` per item: grip (`title="Drag to reorder"`, draggable, drag type `application/x-herdr-reorder`), then `render?.(item, i) ?? <span className="reorder-text">{item}</span>`, then a remove button `aria-label={\`Remove ${item}\`}`. Rows show `dragging`, `drop-before` / `drop-after` classes during a drag like Quick replies (side from `dropZone(rect, clientY, "session")`). ⌥↑ / ⌥↓ while focus is inside a row moves it by one. Items are keyed by index.

- [ ] **Step 1: Write the failing tests** in `src/settings/ReorderList.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReorderList } from "./ReorderList";

const dt = () => {
  const data: Record<string, string> = {};
  return { data, types: [] as string[], effectAllowed: "", dropEffect: "",
    setData(t: string, v: string) { data[t] = v; this.types.push(t); }, getData: (t: string) => data[t] ?? "", setDragImage() {} };
};

function setup(items = ["a", "b", "c"]) {
  const onChange = vi.fn();
  render(<ReorderList label="Order" items={items} onChange={onChange} />);
  const rows = () => within(screen.getByRole("list", { name: "Order" })).getAllByRole("listitem");
  return { onChange, rows };
}

describe("ReorderList", () => {
  it("shows the items in order", () => {
    const { rows } = setup();
    expect(rows().map((r) => r.querySelector(".reorder-text")!.textContent)).toEqual(["a", "b", "c"]);
  });
  it("moves an item by dragging its grip onto another row", () => {
    const { onChange, rows } = setup();
    const dataTransfer = dt();
    const grip = screen.getAllByTitle("Drag to reorder")[0];
    fireEvent.dragStart(grip, { dataTransfer });
    fireEvent.dragOver(rows()[2], { dataTransfer });
    expect(rows()[2].className).toContain("drop-after");
    fireEvent.drop(rows()[2], { dataTransfer });
    // jsdom rects are empty, so every drop lands after the target.
    expect(onChange).toHaveBeenCalledWith(["b", "c", "a"]);
  });
  it("removes an item", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove b" }));
    expect(onChange).toHaveBeenCalledWith(["a", "c"]);
  });
  it("moves with Option-Up / Option-Down", () => {
    const { onChange } = setup();
    fireEvent.keyDown(screen.getByRole("button", { name: "Remove b" }), { key: "ArrowUp", altKey: true });
    expect(onChange).toHaveBeenLastCalledWith(["b", "a", "c"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "Remove c" }), { key: "ArrowDown", altKey: true });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it("renders custom content", () => {
    render(<ReorderList label="T" items={["x"]} onChange={() => {}} render={(it, i) => <em>{`${i + 1}. ${it}`}</em>} />);
    expect(screen.getByText("1. x").tagName).toBe("EM");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/settings/ReorderList.test.tsx`
Expected: FAIL, cannot resolve `./ReorderList`.

- [ ] **Step 3: Implement** `ReorderList` as specified (the drag handling mirrors `ChatSettings` in `src/settings/Settings.tsx:174-320`, which stays unchanged) and the CSS selector change.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run src/settings/ReorderList.test.tsx src/settings/Settings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/ReorderList.tsx src/settings/ReorderList.test.tsx src/styles.css
git commit -m "feat(settings): a reusable drag-to-reorder list"
```

### Task 7: pi section with the Enabled models block

**Files:**
- Create: `src/settings/PiSettings.tsx` (section shell: Machine picker, loading, empty states, dirty marker)
- Create: `src/settings/EnabledModels.tsx` (the block)
- Test: `src/settings/PiSettings.test.tsx`
- Modify: `src/settings/Settings.tsx:362-368` (add `{ id: "pi", label: "pi", Body: PiSettings }` after `files`)
- Modify: `src/styles.css` (append `pi-*` rules: two-column `.pi-models` grid collapsing to one column under 640px dialog width, `.pi-pattern` italic tag, `.pi-dirty`, `.pi-error`)

**Interfaces:**
- Consumes: `useApp` (`machines`, `order`, `selected`) from `src/store/app.ts`; `piModelsList` (Task 2); `loadSettings`, `saveEnabled`, `errorText`, `Loaded` (Task 5); `isCatalogEntry`, `modelRef`, `hasAliasPackage`, `PiSettingsFile` (Task 3); `ReorderList` (Task 6).
- Produces:
  - `export function PiSettings(): JSX.Element` (no props).
  - `export function EnabledModels(props: { machineId: string; dir: string; settings: PiSettingsFile; models: PiModel[] | null; modelsError: string | null; onRetryModels: () => void; onDirty: (dirty: boolean) => void; onSaved: (s: PiSettingsFile) => void }): JSX.Element` — `models === null` with no error means loading.
  - `PiSettings` holds per Machine: the `Loaded<PiSettingsFile>`, the catalog, and a `dirty` flag per block; Task 8 adds the alias block into the same shell, rendered under Enabled models when `hasAliasPackage(settings.json)`.

Behaviour:
- Machine options: `order.map(id => machines[id])` filtered to `state === "connected" && pi_agent_dir`. Default: `selected?.machine_id` if it is an option, else `"local"` if an option, else the first. If the chosen Machine leaves the options, fall back to the default and drop edits.
- Machine without `has_pi`: only `pi not found on ${label}`. No options: only `No connected machine`.
- On Machine change: `loadSettings` and `piModelsList` in parallel; `Cannot list models: …` + `Retry` in the catalog column; settings load errors as `<p role="alert">` + `Retry` in place of both blocks.
- Catalog column: `<input aria-label="Filter models" placeholder="Filter">`; providers in catalog order, each a `<button aria-expanded>` header reading `${provider} ${checked}/${total}` (expanded by default) followed by `<label><input type="checkbox" aria-label={modelRef(m)} …/>{m.id}</label>` rows; the filter matches `modelRef(m)` case-insensitively and hides empty groups.
- Order column: heading `Ctrl+P order`, `ReorderList label="Ctrl+P order"`; each entry renders `<span className="reorder-text">{entry}</span>` plus `<span className="pi-pattern">pattern</span>` when `!isCatalogEntry(entry, models ?? [])`; `Empty: Ctrl+P cycles through every model` when empty; `<input aria-label="Add pattern" placeholder="Add pattern…">` appends on Enter (trimmed; ignored if empty or already present case-insensitively) and clears.
- Checking a catalog row appends `modelRef(m)`; unchecking removes every entry matching it.
- Save / Revert enabled when the list differs from `settings.enabled`. Save → `saveEnabled(…, false)`: `saved` → `onSaved`, show the reminder; `conflict` → conflict bar (Reload → reload the file into the block, dropping edits; Overwrite → `saveEnabled(…, true)`); `error` → its text under Save. The reminder hides on the next edit.
- The `●` marker shows while any block is dirty; the Machine `<select>` is `disabled` then.

- [ ] **Step 1: Write the failing tests** in `src/settings/PiSettings.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent, MachineView } from "../lib/types";

const ipc = vi.hoisted(() => ({ piModelsList: vi.fn(), filesRead: vi.fn(), filesWrite: vi.fn() }));
vi.mock("../lib/ipc", () => ipc);
import { useApp } from "../store/app";
import { PiSettings } from "./PiSettings";

export const text = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const machine = (id: string, label: string, extra: Partial<MachineView> = {}): MachineView => ({
  id, label, kind: id === "local" ? "local" : "ssh", state: "connected", error: null, version: "0.9.3", status: "idle", sessions: [],
  pi_agent_dir: `/home/${id}/.pi/agent`, has_pi: true, ...extra,
});
const content = (t: string): FileContent => ({ kind: "text", text: t, truncated: false, size: t.length, mtime: 1, cksum: 42, editable: true });
let disk: Record<string, Record<string, string>>;

beforeEach(() => {
  vi.clearAllMocks();
  disk = {
    "/home/local/.pi/agent": { "settings.json": text({ theme: "slop", enabledModels: ["xai/grok-4.6", "anthropic/*"], packages: ["npm:pi-web-access"] }) },
    "/home/box/.pi/agent": { "settings.json": text({ enabledModels: ["box/model"] }) },
  };
  ipc.piModelsList.mockResolvedValue([{ provider: "openai-codex", id: "gpt-6.1-sol" }, { provider: "xai", id: "grok-4.6" }]);
  ipc.filesRead.mockImplementation(async (_m: string, dir: string, rel: string) => {
    const t = disk[dir]?.[rel];
    if (t === undefined) throw { code: "not_found", message: "no such file" };
    return content(t);
  });
  ipc.filesWrite.mockImplementation(async (_m: string, dir: string, rel: string, t: string) => {
    disk[dir][rel] = t;
    return { size: t.length, mtime: 2, cksum: 43 };
  });
  useApp.setState({ machines: { local: machine("local", "This Mac") }, order: ["local"], selected: null });
});

const order = () => within(screen.getByRole("list", { name: "Ctrl+P order" })).getAllByRole("listitem");
const entries = () => order().map((r) => r.querySelector(".reorder-text")!.textContent);
const settingsOnDisk = () => JSON.parse(disk["/home/local/.pi/agent"]["settings.json"]);
async function ready() {
  render(<PiSettings />);
  await screen.findByRole("checkbox", { name: "openai-codex/gpt-6.1-sol" });
}

describe("pi settings: Enabled models", () => {
  it("shows the Ctrl+P order with patterns marked, and checks matching models", async () => {
    await ready();
    expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*"]);
    expect(within(order()[0]).queryByText("pattern")).toBeNull();
    expect(within(order()[1]).getByText("pattern")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "xai/grok-4.6" }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "openai-codex/gpt-6.1-sol" }).checked).toBe(false);
  });

  it("appends a checked model and removes an unchecked one", async () => {
    await ready();
    fireEvent.click(screen.getByRole("checkbox", { name: "openai-codex/gpt-6.1-sol" }));
    expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*", "openai-codex/gpt-6.1-sol"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "xai/grok-4.6" }));
    expect(entries()).toEqual(["anthropic/*", "openai-codex/gpt-6.1-sol"]);
  });

  it("filters the catalog", async () => {
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter models" }), { target: { value: "GROK" } });
    expect(screen.queryByRole("checkbox", { name: "openai-codex/gpt-6.1-sol" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "xai/grok-4.6" })).toBeTruthy();
  });

  it("adds a pattern on Enter", async () => {
    await ready();
    const input = screen.getByRole("textbox", { name: "Add pattern" });
    fireEvent.change(input, { target: { value: "  *sonnet*  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*", "*sonnet*"]);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("saves the merged file, then reminds about /reload", async () => {
    await ready();
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save enabled models" });
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "openai-codex/gpt-6.1-sol" }));
    expect(screen.getByTitle("Unsaved changes")).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Machine" }).disabled).toBe(true);
    fireEvent.click(save);
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect(settingsOnDisk()).toEqual({ theme: "slop", enabledModels: ["xai/grok-4.6", "anthropic/*", "openai-codex/gpt-6.1-sol"], packages: ["npm:pi-web-access"] });
    expect(save.disabled).toBe(true);
    expect(screen.queryByTitle("Unsaved changes")).toBeNull();
  });

  it("empties the list by deleting the key", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Remove xai/grok-4.6" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove anthropic/*" }));
    expect(screen.getByText("Empty: Ctrl+P cycles through every model")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save enabled models" }));
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect("enabledModels" in settingsOnDisk()).toBe(false);
  });

  it("shows the conflict bar when enabledModels changed on disk; Reload and Overwrite", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Remove anthropic/*" }));
    disk["/home/local/.pi/agent"]["settings.json"] = text({ enabledModels: ["z/z"] });
    fireEvent.click(screen.getByRole("button", { name: "Save enabled models" }));
    const bar = await screen.findByRole("alert");
    expect(bar.textContent).toContain("Changed on disk");
    fireEvent.click(within(bar).getByRole("button", { name: "Overwrite" }));
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect(settingsOnDisk().enabledModels).toEqual(["xai/grok-4.6"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove xai/grok-4.6" }));
    disk["/home/local/.pi/agent"]["settings.json"] = text({ enabledModels: ["q/q"] });
    fireEvent.click(screen.getByRole("button", { name: "Save enabled models" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(entries()).toEqual(["q/q"]));
  });

  it("lists models from the Machine picked, defaulting to the selected pane's", async () => {
    useApp.setState({
      machines: { local: machine("local", "This Mac"), box: machine("box", "devtuf") },
      order: ["local", "box"],
      selected: { machine_id: "box", session: "default", pane_id: "p" },
    });
    render(<PiSettings />);
    await waitFor(() => expect(entries()).toEqual(["box/model"]));
    expect(ipc.piModelsList).toHaveBeenCalledWith("box");
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "local" } });
    await waitFor(() => expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*"]));
  });

  it("shows pi not found, and no connected machine", async () => {
    useApp.setState({ machines: { local: machine("local", "This Mac", { has_pi: false }) } });
    const { unmount } = render(<PiSettings />);
    expect(screen.getByText("pi not found on This Mac")).toBeTruthy();
    unmount();
    useApp.setState({ machines: { local: machine("local", "This Mac", { state: "disconnected" }) } });
    render(<PiSettings />);
    expect(screen.getByText("No connected machine")).toBeTruthy();
  });

  it("keeps the order list usable when listing models fails", async () => {
    ipc.piModelsList.mockRejectedValueOnce({ code: "io", message: "models.json broken" });
    render(<PiSettings />);
    expect((await screen.findByText("Cannot list models: models.json broken")).getAttribute("role")).toBe("alert");
    expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*"]);
    expect(within(order()[0]).getByText("pattern")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("checkbox", { name: "xai/grok-4.6" });
  });

  it("never saves a file it cannot parse", async () => {
    disk["/home/local/.pi/agent"]["settings.json"] = text({ enabledModels: "anthropic/*" });
    render(<PiSettings />);
    expect(await screen.findByText("enabledModels in settings.json is not a list")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save enabled models" })).toBeNull();
    expect(ipc.filesWrite).not.toHaveBeenCalled();
  });
});
```

Add one test to `src/settings/Settings.test.tsx` (`describe("Settings dialog")`):

```tsx
  it("has a pi section", () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("tab", { name: "pi" })).toBeTruthy();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/settings/PiSettings.test.tsx src/settings/Settings.test.tsx`
Expected: FAIL, cannot resolve `./PiSettings`.

- [ ] **Step 3: Implement** `PiSettings.tsx`, `EnabledModels.tsx`, the `SECTIONS` entry and the CSS, per Interfaces and Behaviour.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run src/settings && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/PiSettings.tsx src/settings/EnabledModels.tsx src/settings/PiSettings.test.tsx src/settings/Settings.tsx src/settings/Settings.test.tsx src/styles.css
git commit -m "feat(pi): Settings › pi edits a machine's Enabled models"
```

### Task 8: Model aliases block

**Files:**
- Create: `src/settings/ModelAliases.tsx`
- Modify: `src/settings/PiSettings.tsx` (load `model-alias.json` with `loadAliases` alongside settings; render `ModelAliases` under Enabled models when `hasAliasPackage(settings.json)`; its dirty flag joins the `●` / picker lock)
- Test: `src/settings/ModelAliases.test.tsx`
- Modify: `src/styles.css` (append `.pi-alias` card rules)

**Interfaces:**
- Consumes: `loadAliases`, `saveAliases`, `Loaded`, `errorText` (Task 5); `Alias`, `AliasFile`, `renameAlias`, `aliasNameError`, `missingTargets`, `modelRef` (Tasks 3-4); `ReorderList` (Task 6); `PiModel`.
- Produces: `export function ModelAliases(props: { machineId: string; dir: string; file: AliasFile; version: FileVersion | null; models: PiModel[] | null; onDirty: (dirty: boolean) => void; onSaved: (file: AliasFile, version: FileVersion) => void; onReload: () => void }): JSX.Element`.

Behaviour:
- Heading `Model aliases`. One `<section className="pi-alias" aria-label={\`Alias ${i + 1}\`}>` per alias:
  - `<input aria-label={\`Alias ${i + 1} name\`}>` holding a local draft of the name; on blur or Enter, if `aliasNameError(draft, aliases, i)` is null, apply `renameAlias(aliases, i, draft)`; the error (computed from the draft) shows under the field as `<p className="note pi-error">`. A dim `alias/${name}` label follows the field.
  - `<button aria-label={\`Delete alias ${i + 1}\`}>`.
  - `ReorderList label={\`Alias ${i + 1} targets\`}` rendering `${n}. ${target}` in `.reorder-text`.
  - `<input aria-label={\`Add target to alias ${i + 1}\`} list="pi-alias-models">` appends on Enter (trimmed, non-empty, not already in this alias) and clears. One shared `<datalist id="pi-alias-models">` holds `modelRef(m)` for every catalog model plus `alias/${name}` for every alias.
  - `Add at least one target` when the alias has none; `${t} does not exist` for each of `missingTargets(alias, aliases)`.
- `<button aria-label="New alias">+ New alias</button>` appends `{ name: "", orig: null, form: "array", targets: [] }`.
- Save (`Save model aliases`) is disabled when nothing changed, any name draft has an error, or any alias has no targets. Save → `saveAliases(…, version, false)`: `saved` → `onSaved`, reminder line; `conflict` → conflict bar (Reload → `onReload`; Overwrite → `saveAliases(…, version, true)`); `error` → its text.

- [ ] **Step 1: Write the failing tests** in `src/settings/ModelAliases.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent, MachineView } from "../lib/types";

const ipc = vi.hoisted(() => ({ piModelsList: vi.fn(), filesRead: vi.fn(), filesWrite: vi.fn() }));
vi.mock("../lib/ipc", () => ipc);
import { useApp } from "../store/app";
import { PiSettings } from "./PiSettings";

const text = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const DIR = "/home/local/.pi/agent";
const local: MachineView = {
  id: "local", label: "This Mac", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle", sessions: [],
  pi_agent_dir: DIR, has_pi: true,
};
const ALIASES = {
  $settings: { statusRefreshMs: 2000 },
  mid: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"],
  high: { targets: ["openai-codex/gpt-5.6-sol"], timeouts: { stallMs: 5 } },
  top: "alias/mid",
};
let disk: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  disk = {
    "settings.json": text({ packages: ["git:github.com/cuongnbms/pi-model-fallback-alias"] }),
    "model-alias.json": text(ALIASES),
  };
  ipc.piModelsList.mockResolvedValue([{ provider: "xai", id: "grok-4.6" }]);
  ipc.filesRead.mockImplementation(async (_m: string, _d: string, rel: string) => {
    if (!(rel in disk)) throw { code: "not_found", message: "no such file" };
    const t = disk[rel];
    return { kind: "text", text: t, truncated: false, size: t.length, mtime: 1, cksum: 42, editable: true } satisfies FileContent;
  });
  ipc.filesWrite.mockImplementation(async (_m: string, _d: string, rel: string, t: string) => {
    disk[rel] = t;
    return { size: t.length, mtime: 2, cksum: 43 };
  });
  useApp.setState({ machines: { local }, order: ["local"], selected: null });
});

const card = (n: number) => screen.getByRole("region", { name: `Alias ${n}` });
const targets = (n: number) =>
  within(screen.getByRole("list", { name: `Alias ${n} targets` })).getAllByRole("listitem").map((r) => r.querySelector(".reorder-text")!.textContent);
const nameBox = (n: number) => screen.getByRole<HTMLInputElement>("textbox", { name: `Alias ${n} name` });
const aliasesOnDisk = () => JSON.parse(disk["model-alias.json"]);
async function ready() {
  render(<PiSettings />);
  await screen.findByRole("textbox", { name: "Alias 1 name" });
}

describe("pi settings: Model aliases", () => {
  it("is hidden without the alias package", async () => {
    disk["settings.json"] = text({ packages: ["npm:pi-web-access"] });
    render(<PiSettings />);
    await screen.findByRole("list", { name: "Ctrl+P order" });
    expect(screen.queryByText("Model aliases")).toBeNull();
  });

  it("lists aliases and their numbered targets", async () => {
    await ready();
    expect([1, 2, 3].map((n) => nameBox(n).value)).toEqual(["mid", "high", "top"]);
    expect(targets(1)).toEqual(["1. opencode-go/deepseek-v4.1-flash", "2. openai-codex/gpt-5.6-luna"]);
    expect(targets(3)).toEqual(["1. alias/mid"]);
  });

  it("renames on commit only, cascading into other aliases, and saves", async () => {
    await ready();
    fireEvent.change(nameBox(1), { target: { value: "hig" } });
    expect(targets(3)).toEqual(["1. alias/mid"]);
    fireEvent.change(nameBox(1), { target: { value: "high" } });
    expect(within(card(1)).getByText("Name already used")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save model aliases" }).disabled).toBe(true);
    fireEvent.blur(nameBox(1));
    expect(targets(3)).toEqual(["1. alias/mid"]);
    fireEvent.change(nameBox(1), { target: { value: "middle" } });
    fireEvent.keyDown(nameBox(1), { key: "Enter" });
    expect(targets(3)).toEqual(["1. alias/middle"]);
    fireEvent.click(screen.getByRole("button", { name: "Save model aliases" }));
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect(aliasesOnDisk()).toEqual({
      $settings: { statusRefreshMs: 2000 },
      middle: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"],
      high: { targets: ["openai-codex/gpt-5.6-sol"], timeouts: { stallMs: 5 } },
      top: ["alias/middle"],
    });
    expect(ipc.filesWrite).toHaveBeenCalledWith("local", DIR, "model-alias.json", expect.any(String), { size: expect.any(Number), mtime: 1, cksum: 42 });
  });

  it("warns about a deleted alias that another one targets", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Delete alias 1" }));
    expect(within(card(2)).getByText("alias/mid does not exist")).toBeTruthy();
  });

  it("adds an alias with a target", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New alias" }));
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save model aliases" });
    expect(within(card(4)).getByText("Add at least one target")).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(nameBox(4), { target: { value: "fast" } });
    fireEvent.blur(nameBox(4));
    const add = screen.getByRole("textbox", { name: "Add target to alias 4" });
    fireEvent.change(add, { target: { value: "xai/grok-4.6" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(targets(4)).toEqual(["1. xai/grok-4.6"]);
    fireEvent.click(save);
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect(aliasesOnDisk().fast).toEqual(["xai/grok-4.6"]);
  });

  it("creates model-alias.json when missing", async () => {
    delete disk["model-alias.json"];
    render(<PiSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "New alias" }));
    fireEvent.change(nameBox(1), { target: { value: "fast" } });
    fireEvent.blur(nameBox(1));
    const add = screen.getByRole("textbox", { name: "Add target to alias 1" });
    fireEvent.change(add, { target: { value: "xai/grok-4.6" } });
    fireEvent.keyDown(add, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Save model aliases" }));
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect(ipc.filesWrite).toHaveBeenCalledWith("local", DIR, "model-alias.json", text({ fast: ["xai/grok-4.6"] }), null);
  });

  it("shows the conflict bar when the file changed; Reload reads it again", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Delete alias 3" }));
    ipc.filesWrite.mockRejectedValueOnce({ code: "conflict", message: "changed" });
    disk["model-alias.json"] = text({ other: ["a/b"] });
    fireEvent.click(screen.getByRole("button", { name: "Save model aliases" }));
    const bar = await screen.findByRole("alert");
    expect(bar.textContent).toContain("Changed on disk");
    fireEvent.click(within(bar).getByRole("button", { name: "Reload" }));
    await screen.findByDisplayValue("other");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/settings/ModelAliases.test.tsx`
Expected: FAIL (no `Alias 1 name` textbox).

- [ ] **Step 3: Implement** `ModelAliases.tsx`, its wiring in `PiSettings.tsx`, and the CSS, per Interfaces and Behaviour.

- [ ] **Step 4: Run the whole suite and checks**

Run: `pnpm test && pnpm typecheck && (cd src-tauri && cargo test)`
Expected: all pass. Then `cd src-tauri && cargo fmt && git status --short` and `git checkout --` any `src-tauri` file this branch did not edit.

- [ ] **Step 5: Commit**

```bash
git add src/settings/ModelAliases.tsx src/settings/ModelAliases.test.tsx src/settings/PiSettings.tsx src/styles.css
git commit -m "feat(pi): Settings › pi edits model aliases when the alias package is installed"
```
