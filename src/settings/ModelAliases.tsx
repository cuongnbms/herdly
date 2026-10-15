import { useEffect, useLayoutEffect, useState } from "react";
import type { FileVersion, PiModel } from "../lib/types";
import { aliasNameError, missingTargets, modelRef, renameAlias, withAliases, type Alias, type AliasFile } from "./pi";
import { errorText, saveAliases } from "./piFiles";
import { ProviderDimmed } from "./EnabledModels";
import { ReorderList } from "./ReorderList";

/** Drops key `i` and shifts the later keys down, as deleting row `i` does. */
function dropAt<T>(rec: Record<number, T>, i: number): Record<number, T> {
  const out: Record<number, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    const n = Number(k);
    if (n < i) out[n] = v;
    else if (n > i) out[n - 1] = v;
  }
  return out;
}

/** The Model aliases block: each alias's name and its fallback targets, in order. */
export function ModelAliases({
  machineId,
  dir,
  file,
  version,
  models,
  onDirty,
  onSaved,
  onReload,
}: {
  machineId: string;
  dir: string;
  file: AliasFile;
  version: FileVersion | null;
  models: PiModel[] | null;
  onDirty: (dirty: boolean) => void;
  onSaved: (file: AliasFile, version: FileVersion) => void;
  onReload: () => void;
}) {
  const [aliases, setAliases] = useState(file.aliases);
  const [seen, setSeen] = useState(file);
  const [names, setNames] = useState<Record<number, string>>({});
  const [adds, setAdds] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reminder, setReminder] = useState(false);

  // A new file from the parent (after a save or reload) replaces the edits without remounting.
  if (seen !== file) {
    setSeen(file);
    setAliases(file.aliases);
    setNames({});
    setAdds({});
  }

  const dirty = withAliases(file.raw, aliases) !== withAliases(file.raw, file.aliases);
  useLayoutEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const touched = () => {
    setReminder(false);
    setConflict(false);
    setSaveError(null);
  };
  const edit = (next: Alias[]) => {
    setAliases(next);
    touched();
  };
  const setTargets = (i: number, targets: string[]) => edit(aliases.map((a, j) => (j === i ? { ...a, targets } : a)));

  const nameError = (i: number) => aliasNameError(names[i] ?? aliases[i].name, aliases, i);
  const commitName = (i: number) => {
    const draft = names[i];
    if (draft === undefined) return;
    if (aliasNameError(draft, aliases, i) !== null) return;
    setNames((n) => {
      const { [i]: _gone, ...rest } = n;
      return rest;
    });
    if (draft !== aliases[i].name) edit(renameAlias(aliases, i, draft));
  };

  const addTarget = (i: number) => {
    const t = (adds[i] ?? "").trim();
    setAdds((a) => ({ ...a, [i]: "" }));
    if (!t || aliases[i].targets.includes(t)) return;
    setTargets(i, [...aliases[i].targets, t]);
  };

  const remove = (i: number) => {
    setNames((n) => dropAt(n, i));
    setAdds((a) => dropAt(a, i));
    edit(aliases.filter((_, j) => j !== i));
  };

  const invalid = aliases.some((a, i) => nameError(i) !== null || a.targets.length === 0);
  const disabled = !dirty || invalid || busy;

  const save = async (force: boolean) => {
    setBusy(true);
    setSaveError(null);
    try {
      const r = await saveAliases(machineId, dir, file.raw, aliases, version, force);
      if (r.kind === "saved") {
        setConflict(false);
        setReminder(true);
        onSaved(r.value, r.version);
      } else if (r.kind === "conflict") setConflict(true);
      else setSaveError(r.error);
    } catch (e) {
      setSaveError(`Cannot save: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const revert = () => {
    setAliases(file.aliases);
    setNames({});
    setAdds({});
    touched();
  };

  return (
    <section className="pi-block">
      <p className="setting-desc">An alias tries its targets in order and falls back to the next when one fails. Use it as alias/name.</p>
      <datalist id="pi-alias-models">
        {(models ?? []).map((m) => (
          <option key={modelRef(m)} value={modelRef(m)} />
        ))}
        {aliases.map((a, i) => (
          <option key={`alias-${i}`} value={`alias/${a.name}`} />
        ))}
      </datalist>
      {aliases.map((a, i) => {
        const err = nameError(i);
        return (
          <section key={i} className="pi-alias" aria-label={`Alias ${i + 1}`}>
            <div className="pi-alias-head">
              <input
                className="input"
                aria-label={`Alias ${i + 1} name`}
                value={names[i] ?? a.name}
                onChange={(e) => {
                  const v = e.target.value;
                  setNames((n) => ({ ...n, [i]: v }));
                  touched();
                }}
                onBlur={() => commitName(i)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  commitName(i);
                }}
              />
              <span className="pi-alias-ref">{`alias/${a.name}`}</span>
              <button className="btn btn-xs" aria-label={`Delete alias ${i + 1}`} onClick={() => remove(i)}>
                Delete
              </button>
            </div>
            {err && <p className="note pi-error">{err}</p>}
            <ReorderList
              label={`Alias ${i + 1} targets`}
              items={a.targets}
              onChange={(next) => setTargets(i, next)}
              numbered
              render={(target) => (
                <span className="reorder-text pi-id" title={target}>
                  <ProviderDimmed entry={target} />
                </span>
              )}
            />
            <input
              className="input"
              aria-label={`Add target to alias ${i + 1}`}
              placeholder="Add target…"
              list="pi-alias-models"
              value={adds[i] ?? ""}
              onChange={(e) => setAdds((m) => ({ ...m, [i]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                addTarget(i);
              }}
            />
            {a.targets.length === 0 && <p className="note pi-error">Add at least one target</p>}
            {missingTargets(a, aliases).map((t) => (
              <p key={t} className="note pi-error">{`${t} does not exist`}</p>
            ))}
          </section>
        );
      })}
      <div>
        <button
          className="btn btn-xs pi-new-alias"
          aria-label="New alias"
          onClick={() => edit([...aliases, { name: "", orig: null, form: "array", targets: [] }])}
        >
          + New alias
        </button>
      </div>
      {conflict && (
        <div className="files-banner files-banner-conflict" role="alert">
          Changed on disk
          <button
            className="btn btn-xs"
            disabled={busy}
            onClick={() => {
              setConflict(false);
              onReload();
            }}
          >
            Reload
          </button>
          <button className="btn btn-xs" disabled={busy} onClick={() => save(true)}>
            Overwrite
          </button>
        </div>
      )}
      <div className="settings-foot">
        {saveError ? (
          <p className="settings-foot-msg pi-error" role="alert">
            {saveError}
          </p>
        ) : (
          reminder && <p className="settings-foot-msg">New pi agents use this; running ones need /reload.</p>
        )}
        <button className="btn btn-xs" aria-label="Revert model aliases" disabled={!dirty || busy} onClick={revert}>
          Revert
        </button>
        <button className="btn btn-xs btn-primary" aria-label="Save model aliases" disabled={disabled} onClick={() => save(false)}>
          Save
        </button>
      </div>
    </section>
  );
}
