import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { piModelsList } from "../lib/ipc";
import type { FileVersion, MachineView, PiModel } from "../lib/types";
import { useApp } from "../store/app";
import { SelectMenu } from "./Dropdown";
import { EnabledModels } from "./EnabledModels";
import { ModelAliases } from "./ModelAliases";
import { hasAliasPackage, type AliasFile, type PiSettingsFile } from "./pi";
import { errorText, loadAliases, loadSettings, type Loaded } from "./piFiles";

interface Data {
  machineId: string;
  settings: Loaded<PiSettingsFile>;
}

/** Settings › pi: edits one connected Machine's pi files. */
export function PiSettings() {
  const machines = useApp((s) => s.machines);
  const order = useApp((s) => s.order);
  const selectedMachine = useApp((s) => s.selected?.machine_id);
  const [picked, setPicked] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [nonce, setNonce] = useState(0);
  const [modelsNonce, setModelsNonce] = useState(0);
  // One flag per block.
  const [enabledDirty, setEnabledDirty] = useState(false);
  const [aliasDirty, setAliasDirty] = useState(false);
  const dirty = enabledDirty || aliasDirty;
  const [aliasNonce, setAliasNonce] = useState(0);
  const [view, setView] = useState<"enabled" | "aliases">("enabled");

  const options = useMemo(
    () => order.map((id) => machines[id]).filter((m): m is MachineView => !!m && m.state === "connected" && !!m.pi_agent_dir),
    [machines, order],
  );
  const fallback = options.find((m) => m.id === selectedMachine) ?? options.find((m) => m.id === "local") ?? options[0];
  const machine = options.find((m) => m.id === picked) ?? fallback;
  const machineId = machine?.id;
  // Once shown, a Machine stays put: only its leaving the options moves the section.
  useEffect(() => {
    if (machine && picked !== machine.id) setPicked(machine.id);
  }, [machine, picked]);
  const dir = machine?.pi_agent_dir ?? null;
  const hasPi = !!machine?.has_pi;

  // Edits belong to the Machine they were made on.
  useEffect(() => {
    setEnabledDirty(false);
    setAliasDirty(false);
  }, [machineId]);

  useEffect(() => {
    if (!machineId || !dir || !hasPi) return;
    if (nonce > 0) setData(null);
    let stale = false;
    loadSettings(machineId, dir).then((settings) => {
      if (!stale) setData({ machineId, settings });
    });
    return () => {
      stale = true;
    };
  }, [machineId, dir, hasPi, nonce]);

  const [aliasData, setAliasData] = useState<{ machineId: string; loaded: Loaded<AliasFile> } | null>(null);
  useEffect(() => {
    if (!machineId || !dir || !hasPi) return;
    let stale = false;
    loadAliases(machineId, dir).then((loaded) => {
      if (!stale) setAliasData({ machineId, loaded });
    });
    return () => {
      stale = true;
    };
  }, [machineId, dir, hasPi, aliasNonce]);

  const [models, setModels] = useState<{ machineId: string; models: PiModel[] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!machineId || !hasPi) return;
    let stale = false;
    // A refresh keeps the catalog shown; a new Machine or a retry after an error starts over.
    setModels((m) => (m && m.machineId === machineId && m.models !== null ? m : null));
    piModelsList(machineId).then(
      (m) => !stale && setModels({ machineId, models: m, error: null }),
      (e) => !stale && setModels({ machineId, models: null, error: errorText(e) }),
    );
    return () => {
      stale = true;
    };
  }, [machineId, hasPi, modelsNonce]);

  // A save finishing after the Machine changed must not land on the new one.
  const onSaved = useCallback(
    (s: PiSettingsFile) =>
      setData((d) => (d && d.machineId === machineId && d.settings.kind === "ok" ? { ...d, settings: { ...d.settings, value: s } } : d)),
    [machineId],
  );
  // The next save must use the version the last save returned; new or renamed aliases join the catalog.
  const onAliasesSaved = useCallback(
    (file: AliasFile, version: FileVersion) => {
      setAliasData((d) => (d && d.machineId === machineId && d.loaded.kind === "ok" ? { ...d, loaded: { kind: "ok", value: file, version } } : d));
      setModelsNonce((n) => n + 1);
    },
    [machineId],
  );
  const reloadAliases = useCallback(() => setAliasNonce((n) => n + 1), []);
  const retryModels = useCallback(() => setModelsNonce((n) => n + 1), []);

  if (!machine || !machineId || !dir) return <p className="note">No connected machine</p>;

  const mine = data?.machineId === machineId ? data : null;
  const aliases = aliasData?.machineId === machineId ? aliasData.loaded : null;
  const cat = models?.machineId === machineId ? models : null;

  const withAliases = !!mine && mine.settings.kind === "ok" && hasAliasPackage(mine.settings.value.json);
  const shown = withAliases ? view : "enabled";
  const views = [
    { id: "enabled", label: "Enabled models", dirty: enabledDirty },
    { id: "aliases", label: "Model aliases", dirty: aliasDirty },
  ] as const;

  return (
    <div className="pi-root">
      <div className="pi-head">
        <div className="pi-machine">
          <span>Machine</span>
          <SelectMenu
            label="Machine"
            value={machineId}
            disabled={dirty}
            options={options.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(id) => {
              setPicked(id);
              setData(null);
            }}
          />
        </div>
        {dirty && (
          <span className="pi-dirty" title="Unsaved changes">
            ●
          </span>
        )}
        {withAliases && (
          <div className="seg seg-n pi-views" role="group" aria-label="pi files" style={{ "--n": 2, "--i": shown === "enabled" ? 0 : 1 } as CSSProperties}>
            <span className="seg-thumb" />
            {views.map((v) => (
              <button key={v.id} aria-pressed={shown === v.id} onClick={() => setView(v.id)}>
                {v.label}
                {v.dirty && <span className="pi-view-dirty" aria-hidden="true" />}
              </button>
            ))}
          </div>
        )}
      </div>
      {!hasPi ? (
        <p className="note">{`pi not found on ${machine.label}`}</p>
      ) : !mine ? (
        <p className="note">Loading…</p>
      ) : mine.settings.kind === "error" ? (
        <p className="note pi-error" role="alert">
          {mine.settings.error}
          <button className="btn btn-xs" onClick={() => setNonce((n) => n + 1)}>
            Retry
          </button>
        </p>
      ) : (
        <>
          {/* Both stay mounted, so switching views keeps unsaved edits. */}
          <div className="pi-view" hidden={shown !== "enabled"}>
            <EnabledModels
              key={machineId}
              machineId={machineId}
              dir={dir}
              settings={mine.settings.value}
              models={cat?.models ?? null}
              modelsError={cat?.error ?? null}
              onRetryModels={retryModels}
              onDirty={setEnabledDirty}
              onSaved={onSaved}
            />
          </div>
          {withAliases && (
            <div className="pi-view" hidden={shown !== "aliases"}>
              {!aliases ? (
                <p className="note">Loading…</p>
              ) : aliases.kind === "error" ? (
                <p className="note pi-error" role="alert">
                  {aliases.error}
                  <button className="btn btn-xs" onClick={reloadAliases}>
                    Retry
                  </button>
                </p>
              ) : (
                <ModelAliases
                  key={machineId}
                  machineId={machineId}
                  dir={dir}
                  file={aliases.value}
                  version={aliases.version}
                  models={cat?.models ?? null}
                  onDirty={setAliasDirty}
                  onSaved={onAliasesSaved}
                  onReload={reloadAliases}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
