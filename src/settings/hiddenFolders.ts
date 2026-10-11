import { create } from "zustand";

/** Shared with store.ts, theme.ts and notify.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdly:settings";

/** Folders the Files tree leaves out until its eye button is on; the backend's `SKIP_DIRS`. */
export const DEFAULT_HIDDEN_FOLDERS = [".git", "node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build", ".next", ".worktrees"];

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

/**
 * Trimmed folder names, each once; blanks, `.`, `..` and names with a `/` are dropped.
 * Anything but a list falls back to the defaults.
 */
export function normalizeFolders(v: unknown): string[] {
  if (!Array.isArray(v)) return [...DEFAULT_HIDDEN_FOLDERS];
  const names = v
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim())
    .filter((n) => n && n !== "." && n !== ".." && !n.includes("/"));
  return [...new Set(names)];
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function loadHiddenFolders(): string[] {
  return normalizeFolders(readRaw().hiddenFolders);
}

interface HiddenFoldersStore {
  folders: string[];
  setFolders: (folders: string[]) => void;
  reset: () => void;
}

export const useHiddenFolders = create<HiddenFoldersStore>((setState) => ({
  folders: loadHiddenFolders(),
  setFolders: (next) => {
    const folders = normalizeFolders(next);
    save({ hiddenFolders: folders });
    // The same list keeps its identity, so the Files tree does not relist for nothing.
    setState((s) => (sameList(s.folders, folders) ? s : { folders }));
  },
  reset: () => {
    save({ hiddenFolders: DEFAULT_HIDDEN_FOLDERS });
    setState({ folders: [...DEFAULT_HIDDEN_FOLDERS] });
  },
}));
