import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { PiModel } from "../lib/types";
import { ChevronIcon } from "../ui/icons";
import { isCatalogEntry, modelRef, type PiSettingsFile } from "./pi";
import { errorText, loadSettings, saveEnabled } from "./piFiles";
import { ReorderList } from "./ReorderList";

/** `provider/id` with the provider dimmed, so the ids line up by eye. */
export function ProviderDimmed({ entry }: { entry: string }) {
  const slash = entry.indexOf("/");
  if (slash <= 0) return entry;
  return (
    <>
      <span className="pi-prov">{entry.slice(0, slash + 1)}</span>
      {entry.slice(slash + 1)}
    </>
  );
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The Enabled models block: a catalog to check models from, and the Ctrl+P order to arrange. */
export function EnabledModels({
  machineId,
  dir,
  settings,
  models,
  modelsError,
  onRetryModels,
  onDirty,
  onSaved,
}: {
  machineId: string;
  dir: string;
  settings: PiSettingsFile;
  models: PiModel[] | null;
  modelsError: string | null;
  onRetryModels: () => void;
  onDirty: (dirty: boolean) => void;
  onSaved: (s: PiSettingsFile) => void;
}) {
  const [list, setList] = useState(settings.enabled);
  const [seen, setSeen] = useState(settings);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reminder, setReminder] = useState(false);

  // A new file from the parent (after a reload) replaces the edits without remounting.
  if (seen !== settings) {
    setSeen(settings);
    setList(settings.enabled);
  }

  const dirty = !sameList(list, settings.enabled);
  useLayoutEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const edit = (next: string[]) => {
    setList(next);
    setReminder(false);
    setConflict(false);
    setSaveError(null);
  };

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out: { provider: string; models: PiModel[] }[] = [];
    for (const m of models ?? []) {
      if (q && !modelRef(m).toLowerCase().includes(q)) continue;
      const g = out.find((x) => x.provider === m.provider);
      if (g) g.models.push(m);
      else out.push({ provider: m.provider, models: [m] });
    }
    return out;
  }, [models, filter]);

  const isChecked = (m: PiModel) => list.some((e) => isCatalogEntry(e, [m]));
  const toggle = (m: PiModel) => {
    const ref = modelRef(m).toLowerCase();
    edit(isChecked(m) ? list.filter((e) => e.toLowerCase() !== ref) : [...list, modelRef(m)]);
  };

  const addPattern = () => {
    const p = pattern.trim();
    setPattern("");
    if (!p || list.some((e) => e.toLowerCase() === p.toLowerCase())) return;
    edit([...list, p]);
  };

  const save = async (force: boolean) => {
    setBusy(true);
    setSaveError(null);
    try {
      const r = await saveEnabled(machineId, dir, settings.enabled, list, force);
      if (r.kind === "saved") {
        setConflict(false);
        setReminder(true);
        onSaved(r.value);
      } else if (r.kind === "conflict") setConflict(true);
      else setSaveError(r.error);
    } catch (e) {
      setSaveError(`Cannot save: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      const r = await loadSettings(machineId, dir);
      if (r.kind === "ok") {
        setConflict(false);
        setReminder(false);
        setSeen(r.value);
        setList(r.value.enabled);
        onSaved(r.value);
      } else setSaveError(r.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pi-block">
      <div className="pi-models">
        <div className="pi-panel">
          <header className="pi-panel-head">
            <h4>Models</h4>
            <p className="setting-desc">Check a model to add it to the order.</p>
          </header>
          <input
            className="input"
            aria-label="Filter models"
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="pi-panel-scroll">
            {modelsError !== null ? (
              <p className="note pi-error" role="alert">
                {`Cannot list models: ${modelsError}`}
                <button className="btn btn-xs" onClick={onRetryModels}>
                  Retry
                </button>
              </p>
            ) : models === null ? (
              <p className="note">Loading models…</p>
            ) : models.length === 0 ? (
              <p className="note">No models</p>
            ) : (
              groups.map((g) => {
                const open = !collapsed[g.provider];
                const total = (models ?? []).filter((m) => m.provider === g.provider);
                const checked = total.filter(isChecked).length;
                return (
                  <div key={g.provider} className="pi-group">
                    <button
                      className="pi-group-head"
                      aria-expanded={open}
                      onClick={() => setCollapsed((c) => ({ ...c, [g.provider]: open }))}
                    >
                      <ChevronIcon />
                      <span className="pi-group-name">{g.provider}</span>
                      <span className={checked > 0 ? "pi-count on" : "pi-count"}>{`${checked}/${total.length}`}</span>
                    </button>
                    {open &&
                      g.models.map((m) => (
                        <label key={modelRef(m)} className="pi-model" title={modelRef(m)}>
                          <input type="checkbox" aria-label={modelRef(m)} checked={isChecked(m)} onChange={() => toggle(m)} />
                          <span className="pi-id">{m.id}</span>
                        </label>
                      ))}
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div className="pi-panel">
          <header className="pi-panel-head">
            <h4>Ctrl+P order</h4>
            <p className="setting-desc">Ctrl+P cycles through these, top first.</p>
          </header>
          <div className="pi-panel-scroll">
            {list.length === 0 && <p className="note">Empty: Ctrl+P cycles through every model</p>}
            <ReorderList
              label="Ctrl+P order"
              items={list}
              onChange={edit}
              numbered
              render={(entry) => (
                <>
                  <span className="reorder-text pi-id" title={entry}>
                    <ProviderDimmed entry={entry} />
                  </span>
                  {!isCatalogEntry(entry, models ?? []) && <span className="pi-pattern">pattern</span>}
                </>
              )}
            />
          </div>
          <input
            className="input"
            aria-label="Add pattern"
            placeholder="Add pattern, e.g. anthropic/*"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              addPattern();
            }}
          />
        </div>
      </div>
      {conflict && (
        <div className="files-banner files-banner-conflict" role="alert">
          Changed on disk
          <button className="btn btn-xs" disabled={busy} onClick={reload}>
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
        <button className="btn btn-xs" aria-label="Revert enabled models" disabled={!dirty || busy} onClick={() => edit(settings.enabled)}>
          Revert
        </button>
        <button className="btn btn-xs btn-primary" aria-label="Save enabled models" disabled={!dirty || busy} onClick={() => save(false)}>
          Save
        </button>
      </div>
    </section>
  );
}
