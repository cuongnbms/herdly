/** Pure logic for the pi section of Settings: parse pi's settings.json and merge an edited enabledModels list back. No I/O. */

export const SETTINGS_FILE = "settings.json";
export const ALIAS_FILE = "model-alias.json";

const ALIAS_PACKAGE = "pi-model-fallback-alias";

export type Json = Record<string, unknown>;
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PiSettingsFile {
  /** The whole parsed object, so a save keeps every other key. */
  json: Json;
  enabled: string[];
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An empty file counts as `{}`; a missing enabledModels as no entries. */
export function parseSettings(text: string): Parsed<PiSettingsFile> {
  let json: unknown = {};
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: `${SETTINGS_FILE} is not valid JSON` };
    }
  }
  if (!isObject(json)) return { ok: false, error: `${SETTINGS_FILE} is not valid JSON` };
  const raw = json.enabledModels;
  if (raw === undefined) return { ok: true, value: { json, enabled: [] } };
  if (!Array.isArray(raw) || !raw.every((e) => typeof e === "string")) {
    return { ok: false, error: `enabledModels in ${SETTINGS_FILE} is not a list` };
  }
  return { ok: true, value: { json, enabled: raw as string[] } };
}

/** New file text with enabledModels replaced in place; an empty list drops the key. Input is not mutated. */
export function withEnabled(json: Json, list: string[]): string {
  const out: Json = {};
  let placed = false;
  for (const [k, v] of Object.entries(json)) {
    if (k === "enabledModels") {
      if (list.length > 0) out[k] = [...list];
      placed = true;
    } else {
      out[k] = v;
    }
  }
  if (!placed && list.length > 0) out.enabledModels = [...list];
  return JSON.stringify(out, null, 2) + "\n";
}

/** Order-sensitive: a reorder on disk is also a change. */
export function enabledConflict(loaded: string[], onDisk: string[]): boolean {
  return loaded.length !== onDisk.length || loaded.some((e, i) => e !== onDisk[i]);
}

/** True when `packages` lists the alias package, as a string or as an object's `source`. */
export function hasAliasPackage(json: Json): boolean {
  const pk = json.packages;
  if (!Array.isArray(pk)) return false;
  return pk.some((p) => {
    const src = typeof p === "string" ? p : isObject(p) && typeof p.source === "string" ? p.source : "";
    return src.includes(ALIAS_PACKAGE);
  });
}

export function modelRef(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`;
}

/** Exact provider/id match, case-insensitive; no globs. */
export function isCatalogEntry(entry: string, models: { provider: string; id: string }[]): boolean {
  const e = entry.toLowerCase();
  return models.some((m) => modelRef(m).toLowerCase() === e);
}
