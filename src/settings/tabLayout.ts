import { create } from "zustand";

/** Shared with store.ts, theme.ts, lens.ts, newTab.ts, quickReplies.ts and notify.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdly:settings";

/** How an Open strip tab shows its Workspace: before the title, or on a second line under it. */
export type TabLayout = "one-line" | "two-lines";

export const TAB_LAYOUTS: { id: TabLayout; label: string }[] = [
  { id: "one-line", label: "One line" },
  { id: "two-lines", label: "Two lines" },
];

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

export function loadTabLayout(): TabLayout {
  const v = readRaw().tabLayout;
  return TAB_LAYOUTS.some((l) => l.id === v) ? (v as TabLayout) : "one-line";
}

interface TabLayoutStore {
  layout: TabLayout;
  setLayout: (layout: TabLayout) => void;
}

export const useTabLayout = create<TabLayoutStore>((setState) => ({
  layout: loadTabLayout(),
  setLayout: (layout) => {
    save({ tabLayout: layout });
    setState({ layout });
  },
}));
