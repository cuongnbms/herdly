/** Shared with settings/*.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdly:settings";

export const OUTLINE_MIN = 200;
export const OUTLINE_MAX = 420;
export const OUTLINE_DEFAULT = 260;

export function clampOutlineWidth(px: number): number {
  return Math.round(Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, px)));
}

function readRaw(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const p = raw ? (JSON.parse(raw) as unknown) : null;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The outline rail's width, the same in every pane. */
export function loadOutlineWidth(): number {
  const w = readRaw().outlineWidth;
  return typeof w === "number" && Number.isFinite(w) ? clampOutlineWidth(w) : OUTLINE_DEFAULT;
}

export function saveOutlineWidth(px: number): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readRaw(), outlineWidth: clampOutlineWidth(px) }));
  } catch {
    /* ignore */
  }
}
