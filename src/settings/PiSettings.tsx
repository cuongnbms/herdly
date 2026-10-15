import { useCallback, useEffect, useMemo, useState } from "react";
import { piModelsList } from "../lib/ipc";
import type { MachineView, PiModel } from "../lib/types";
import { useApp } from "../store/app";
import { EnabledModels } from "./EnabledModels";
import type { PiSettingsFile } from "./pi";
import { errorText, loadSettings, type Loaded } from "./piFiles";

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
  // One flag per block; Task 8 adds the aliases block's.
  const [enabledDirty, setEnabledDirty] = useState(false);
  const dirty = enabledDirty;

  const options = useMemo(
    () => order.map((id) => machines[id]).filter((m): m is MachineView => !!m && m.state === "connected" && !!m.pi_agent_dir),
    [machines, order],
  );
  const fallback = options.find((m) => m.id === selectedMachine) ?? options.find((m) => m.id === "local") ?? options[0];
  const machine = options.find((m) => m.id === picked) ?? fallback;
  const machineId = machine?.id;
  const dir = machine?.pi_agent_dir ?? null;
  const hasPi = !!machine?.has_pi;

  // Edits belong to the Machine they were made on.
  useEffect(() => {
    setEnabledDirty(false);
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

  const [models, setModels] = useState<{ machineId: string; models: PiModel[] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!machineId || !hasPi) return;
    let stale = false;
    setModels(null);
    piModelsList(machineId).then(
      (m) => !stale && setModels({ machineId, models: m, error: null }),
      (e) => !stale && setModels({ machineId, models: null, error: errorText(e) }),
    );
    return () => {
      stale = true;
    };
  }, [machineId, hasPi, modelsNonce]);

  const onSaved = useCallback(
    (s: PiSettingsFile) =>
      setData((d) => (d && d.settings.kind === "ok" ? { ...d, settings: { ...d.settings, value: s } } : d)),
    [],
  );
  const retryModels = useCallback(() => setModelsNonce((n) => n + 1), []);

  if (!machine || !machineId || !dir) return <p className="note">No connected machine</p>;

  const mine = data?.machineId === machineId ? data : null;
  const cat = models?.machineId === machineId ? models : null;

  return (
    <>
      <div className="pi-head">
        <select
          aria-label="Machine"
          value={machineId}
          disabled={dirty}
          onChange={(e) => {
            setPicked(e.target.value);
            setData(null);
          }}
        >
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {dirty && (
          <span className="pi-dirty" title="Unsaved changes">
            ●
          </span>
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
      )}
    </>
  );
}
