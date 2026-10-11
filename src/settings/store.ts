import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { create } from "zustand";
import { fontFace, systemFonts } from "../lib/ipc";

/** Shared with notify.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdly:settings";

export interface FontSettings {
  terminalFontSize: number;
  terminalFontFamily: string;
  chatFontSize: number;
}

export const DEFAULTS: FontSettings = {
  terminalFontSize: 13,
  terminalFontFamily: "JetBrains Mono",
  chatFontSize: 13.5,
};

export const TERM_SIZE = { min: 10, max: 20 };
export const CHAT_SIZE = { min: 11, max: 18 };

/** Ships with the app (src/fonts), so it is always offered. */
export const BUNDLED_FONT = "JetBrains Mono";

/** The picker's list: the bundled font, then the installed monospace families. */
export function fontFamilies(installed: string[]): string[] {
  return [BUNDLED_FONT, ...installed.filter((f) => f !== BUNDLED_FONT)];
}

let families: Promise<string[]> | null = null;

/** Installed monospace families from the backend, fetched once. */
export function loadFontFamilies(): Promise<string[]> {
  families ??= systemFonts()
    .then(fontFamilies)
    .catch(() => fontFamilies(["Menlo", "Monaco"]));
  return families;
}

/** Case-insensitive substring match; names starting with the query come first. */
export function filterFonts(all: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  const hits = all.filter((f) => f.toLowerCase().includes(q));
  const starts = hits.filter((f) => f.toLowerCase().startsWith(q));
  return [...starts, ...hits.filter((f) => !starts.includes(f))];
}

const clamp = (n: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, n));

function readRaw(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const p = raw ? (JSON.parse(raw) as unknown) : null;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalize(p: Partial<Record<keyof FontSettings, unknown>>, base: FontSettings): FontSettings {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const family = typeof p.terminalFontFamily === "string" && p.terminalFontFamily.trim() ? p.terminalFontFamily.trim() : undefined;
  return {
    terminalFontSize: clamp(num(p.terminalFontSize) ?? base.terminalFontSize, TERM_SIZE),
    terminalFontFamily: family ?? base.terminalFontFamily,
    chatFontSize: clamp(num(p.chatFontSize) ?? base.chatFontSize, CHAT_SIZE),
  };
}

export function loadFonts(): FontSettings {
  return normalize(readRaw(), DEFAULTS);
}

function save(f: FontSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readRaw(), ...f }));
  } catch {
    /* ignore */
  }
}

interface SettingsStore extends FontSettings {
  set: (patch: Partial<FontSettings>) => void;
  reset: () => void;
}

const pick = (s: FontSettings): FontSettings => ({
  terminalFontSize: s.terminalFontSize,
  terminalFontFamily: s.terminalFontFamily,
  chatFontSize: s.chatFontSize,
});

export const useSettings = create<SettingsStore>((setState, get) => ({
  ...loadFonts(),
  set: (patch) => {
    const next = normalize(patch, pick(get()));
    save(next);
    setState(next);
  },
  reset: () => {
    save(DEFAULTS);
    setState({ ...DEFAULTS });
  },
}));

export function termFontFamily(family: string): string {
  return `"${family}", Menlo, monospace`;
}

/** The faces xterm draws with, by CoreText style name. */
const TERM_FACES: { style: string; descriptors: FontFaceDescriptors }[] = [
  { style: "Regular", descriptors: {} },
  { style: "Bold", descriptors: { weight: "700" } },
  { style: "Italic", descriptors: { style: "italic" } },
  { style: "Bold Italic", descriptors: { weight: "700", style: "italic" } },
];

const termFonts = new Map<string, Promise<void>>();

/**
 * Registers an installed `family` as a web font, from its own files. WebKit hides installed
 * (non-system) fonts from canvases outside the document, and xterm's WebGL atlas draws glyphs
 * on such a canvas, so they would come out in the fallback font. Once per family; never rejects.
 */
export function ensureTermFont(family: string): Promise<void> {
  if (family === BUNDLED_FONT || typeof FontFace === "undefined") return Promise.resolve();
  let p = termFonts.get(family);
  if (!p) {
    p = Promise.all(
      TERM_FACES.map(({ style, descriptors }) =>
        fontFace(family, style)
          .then((bytes) => {
            const face = new FontFace(family, bytes, descriptors);
            document.fonts.add(face);
            return face.load();
          })
          .catch((e: unknown) => {
            // not_found: a system font or a missing face; WebKit already handles those natively.
            if ((e as { code?: string } | null)?.code !== "not_found") console.warn("font face", family, style, e);
          }),
      ),
    ).then(() => {});
    termFonts.set(family, p);
  }
  return p;
}

export function applyChatFont(px: number): void {
  document.documentElement.style.setProperty("--chat-font", `${px}px`);
}

const VI_SAMPLE = "aăâđêôơư ạảấầẩẫậắằẳẵặ";

/**
 * Applies the terminal font settings to `term` now and on every change, refitting so the
 * new cell size reaches the PTY through the terminal's own onResize. Returns an unsubscribe.
 * `offset` shifts the size (the blocked panel runs one px smaller).
 */
export function watchTermFont(term: Terminal, fit: FitAddon, offset = 0): () => void {
  const apply = (s: FontSettings) => {
    term.options.fontFamily = termFontFamily(s.terminalFontFamily);
    term.options.fontSize = s.terminalFontSize + offset;
    // Subsets (e.g. Vietnamese) load lazily; once they are in, redraw glyphs cached from the fallback.
    void ensureTermFont(s.terminalFontFamily)
      .then(() => document.fonts?.load(`${s.terminalFontSize + offset}px "${s.terminalFontFamily}"`, VI_SAMPLE))
      .then(() => {
        if (term.options.fontFamily !== termFontFamily(s.terminalFontFamily)) return;
        term.clearTextureAtlas?.();
        term.refresh?.(0, term.rows - 1);
      })
      .catch(() => {});
  };
  apply(useSettings.getState());
  return useSettings.subscribe((s, prev) => {
    if (s.terminalFontSize === prev.terminalFontSize && s.terminalFontFamily === prev.terminalFontFamily) return;
    apply(s);
    try {
      fit.fit();
    } catch {
      /* not measurable (hidden) */
    }
  });
}
