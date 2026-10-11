import type { Terminal } from "@xterm/xterm";
import { create } from "zustand";
import { setWindowTheme } from "../lib/ipc";
import { TERM_THEME, TERM_THEME_LIGHT } from "../terminal/theme";

/** Shared with store.ts and notify.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdly:settings";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_PREFS: { id: ThemePref; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export const DEFAULT_THEME: ThemePref = "dark";

const isPref = (v: unknown): v is ThemePref => v === "system" || v === "light" || v === "dark";

function readRaw(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const p = raw ? (JSON.parse(raw) as unknown) : null;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadThemePref(): ThemePref {
  const t = readRaw().theme;
  return isPref(t) ? t : DEFAULT_THEME;
}

function save(theme: ThemePref): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readRaw(), theme }));
  } catch {
    /* ignore */
  }
}

const darkQuery = () => (typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null);

export function resolveTheme(pref: ThemePref, systemDark = darkQuery()?.matches ?? true): Theme {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

interface ThemeStore {
  pref: ThemePref;
  /** What is on screen: `pref`, with "system" resolved. */
  theme: Theme;
  setPref: (pref: ThemePref) => void;
}

export const useTheme = create<ThemeStore>((setState) => {
  const pref = loadThemePref();
  return {
    pref,
    theme: resolveTheme(pref),
    setPref: (next) => {
      if (!isPref(next)) return;
      save(next);
      setState({ pref: next, theme: resolveTheme(next) });
    },
  };
});

// "system" tracks the OS appearance live.
darkQuery()?.addEventListener?.("change", (e) => {
  const { pref } = useTheme.getState();
  if (pref === "system") useTheme.setState({ theme: resolveTheme(pref, e.matches) });
});

/** Puts `theme` on <html data-theme> for styles.css and matches the native window to `pref`. */
export function applyTheme(theme: Theme, pref: ThemePref): void {
  document.documentElement.dataset.theme = theme;
  try {
    // A forced window theme would also force prefers-color-scheme, so "system" hands it back.
    void setWindowTheme(pref === "system" ? null : theme).catch(() => {});
  } catch {
    /* not running in Tauri */
  }
}

export const termTheme = (theme: Theme) => (theme === "light" ? TERM_THEME_LIGHT : TERM_THEME);

/** Keeps `term`'s colors on the current theme. Returns an unsubscribe. */
export function watchTermTheme(term: Terminal): () => void {
  term.options.theme = termTheme(useTheme.getState().theme);
  return useTheme.subscribe((s, prev) => {
    if (s.theme !== prev.theme) term.options.theme = termTheme(s.theme);
  });
}
