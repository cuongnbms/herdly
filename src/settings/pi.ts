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

export interface Alias {
  name: string;
  targets: string[];
  form: "string" | "array" | "object";
  /** The key it was read under; null for a new alias. Renames change `name`, never `orig`. */
  orig: string | null;
}

export interface AliasFile {
  /** The whole parsed object, so a save keeps `$` keys and fields the app does not edit. */
  raw: Json;
  aliases: Alias[];
}

const ALIAS_SHAPE_ERROR = `${ALIAS_FILE} must be an object`;

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((e) => typeof e === "string");

/** An empty file counts as `{}`; keys starting with `$` are settings, not aliases. */
export function parseAliases(text: string): Parsed<AliasFile> {
  let raw: unknown = {};
  if (text.trim() !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: `${ALIAS_FILE} is not valid JSON` };
    }
  }
  if (!isObject(raw)) return { ok: false, error: ALIAS_SHAPE_ERROR };
  const aliases: Alias[] = [];
  for (const [name, v] of Object.entries(raw)) {
    if (name.startsWith("$")) continue;
    if (typeof v === "string") aliases.push({ name, orig: name, form: "string", targets: [v] });
    else if (isStringArray(v)) aliases.push({ name, orig: name, form: "array", targets: [...v] });
    else if (isObject(v) && isStringArray(v.targets)) aliases.push({ name, orig: name, form: "object", targets: [...v.targets] });
    else return { ok: false, error: ALIAS_SHAPE_ERROR };
  }
  return { ok: true, value: { raw, aliases } };
}

/** New file text: `$` keys and key positions kept, renamed keys written in place, deleted aliases dropped, new ones appended. */
export function withAliases(raw: Json, aliases: Alias[]): string {
  const out: Json = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("$")) {
      out[k] = v;
      continue;
    }
    const a = aliases.find((x) => x.orig === k);
    if (!a) continue;
    if (a.form === "object") out[a.name] = { ...(isObject(v) ? v : {}), targets: [...a.targets] };
    else if (a.form === "string" && a.targets.length === 1 && a.targets[0] === v) out[a.name] = v;
    else out[a.name] = [...a.targets];
  }
  for (const a of aliases) if (a.orig === null) out[a.name] = [...a.targets];
  return JSON.stringify(out, null, 2) + "\n";
}

/** Renames one alias and rewrites targets that are exactly `alias/<old name>`. */
export function renameAlias(aliases: Alias[], index: number, to: string): Alias[] {
  const from = `alias/${aliases[index].name}`;
  return aliases.map((a, i) => ({
    ...a,
    name: i === index ? to : a.name,
    targets: a.targets.map((t) => (t === from ? `alias/${to}` : t)),
  }));
}

export function aliasNameError(name: string, aliases: Alias[], index: number): string | null {
  if (name === "") return "Name is required";
  if (name.includes("/")) return "Name cannot contain /";
  if (name.startsWith("$")) return "Name cannot start with $";
  if (aliases.some((a, i) => i !== index && a.name === name)) return "Name already used";
  return null;
}

/** The `alias/x` targets with no alias named `x`. */
export function missingTargets(alias: Alias, aliases: Alias[]): string[] {
  return alias.targets.filter((t) => t.startsWith("alias/") && !aliases.some((a) => a.name === t.slice("alias/".length)));
}
