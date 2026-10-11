import { create } from "zustand";

/** Shared with store.ts, theme.ts, lens.ts, newTab.ts, quickReplies.ts, tabLayout.ts and notify.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdly:settings";

/** The two left columns the user can drag wider or narrower: Machines and Agents. */
export type Column = "sidebar" | "agents";

export const COLUMNS: Record<Column, { key: string; def: number; min: number; max: number }> = {
  sidebar: { key: "sidebarWidth", def: 248, min: 180, max: 420 },
  agents: { key: "agentsWidth", def: 288, min: 220, max: 520 },
};

export type Widths = Record<Column, number>;

const clamp = (column: Column, n: number) => {
  const c = COLUMNS[column];
  return Math.round(Math.min(c.max, Math.max(c.min, n)));
};

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

function read(raw: Record<string, unknown>, column: Column): number {
  const v = raw[COLUMNS[column].key];
  return typeof v === "number" && Number.isFinite(v) ? clamp(column, v) : COLUMNS[column].def;
}

export function loadWidths(): Widths {
  const raw = readRaw();
  return { sidebar: read(raw, "sidebar"), agents: read(raw, "agents") };
}

interface SidebarWidthsStore extends Widths {
  setWidth: (column: Column, width: number) => void;
}

export const useSidebarWidths = create<SidebarWidthsStore>((setState) => ({
  ...loadWidths(),
  setWidth: (column, width) => {
    const w = clamp(column, width);
    save({ [COLUMNS[column].key]: w });
    setState({ [column]: w } as Partial<Widths>);
  },
}));
