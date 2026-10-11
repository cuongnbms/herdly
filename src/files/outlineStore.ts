import { create } from "zustand";

/** Shared with the other settings writers: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdly:settings";

export const OUTLINE_MIN = 160;
export const OUTLINE_MAX = 480;
export const OUTLINE_DEFAULT = 220;

export const clampOutline = (w: number) => Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, Math.round(w)));

function readRaw(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const p = raw ? (JSON.parse(raw) as unknown) : null;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function save(patch: Record<string, unknown>): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readRaw(), ...patch }));
  } catch {
    /* ignore */
  }
}

interface OutlineStore {
  /** Whether rendered markdown shows its outline column. */
  shown: boolean;
  width: number;
  toggle: () => void;
  /** Sets the width; `persist` saves it (once, at the end of a drag). */
  setWidth: (w: number, persist?: boolean) => void;
}

export const useOutline = create<OutlineStore>((setState, get) => {
  const raw = readRaw();
  const w = Number(raw.filesOutlineWidth);
  return {
    shown: raw.filesOutline !== false,
    width: w ? clampOutline(w) : OUTLINE_DEFAULT,
    toggle: () => {
      const shown = !get().shown;
      save({ filesOutline: shown });
      setState({ shown });
    },
    setWidth: (w, persist = false) => {
      const width = clampOutline(w);
      if (persist) save({ filesOutlineWidth: width });
      setState({ width });
    },
  };
});
