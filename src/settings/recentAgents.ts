import { create } from "zustand";

/** Shared with store.ts, theme.ts, quickReplies.ts and notify.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdly:settings";

export const IDLE_MINUTES = { min: 0, max: 60 };
export const DEFAULT_IDLE_MINUTES = 3;
/** The Recent agents list's dragged height, in px; with none saved it fits its rows. */
export const LIST_HEIGHT = { min: 40, max: 1200 };

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

const clamp = (n: number) => Math.min(IDLE_MINUTES.max, Math.max(IDLE_MINUTES.min, Math.round(n)));

/** How long, in minutes, an agent that went idle stays in Recent agents; 0 leaves idle agents out. */
export function loadIdleMinutes(): number {
  const v = readRaw().recentIdleMinutes;
  return typeof v === "number" && Number.isFinite(v) ? clamp(v) : DEFAULT_IDLE_MINUTES;
}

export function loadListHeight(): number | null {
  const v = readRaw().recentAgentsHeight;
  return typeof v === "number" && Number.isFinite(v) ? clampHeight(v) : null;
}

const clampHeight = (n: number) => Math.round(Math.min(LIST_HEIGHT.max, Math.max(LIST_HEIGHT.min, n)));

interface RecentAgentsStore {
  idleMinutes: number;
  /** null: the list fits its rows. */
  listHeight: number | null;
  setIdleMinutes: (n: number) => void;
  setListHeight: (h: number | null) => void;
}

export const useRecentAgents = create<RecentAgentsStore>((setState) => ({
  idleMinutes: loadIdleMinutes(),
  listHeight: loadListHeight(),
  setListHeight: (h) => {
    const listHeight = h === null ? null : clampHeight(h);
    save({ recentAgentsHeight: listHeight });
    setState({ listHeight });
  },
  setIdleMinutes: (n) => {
    const idleMinutes = clamp(n);
    save({ recentIdleMinutes: idleMinutes });
    setState({ idleMinutes });
  },
}));
