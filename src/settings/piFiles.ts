/** Loads and saves pi's settings.json and model-alias.json through the files IPC, with version-checked writes. No React. */
import { filesRead, filesWrite } from "../lib/ipc";
import type { FileVersion } from "../lib/types";
import {
  ALIAS_FILE,
  SETTINGS_FILE,
  enabledConflict,
  parseAliases,
  parseSettings,
  withAliases,
  withEnabled,
  type Alias,
  type AliasFile,
  type Json,
  type Parsed,
  type PiSettingsFile,
} from "./pi";

export function errorText(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? String(e);
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

export type Loaded<T> = { kind: "ok"; value: T; version: FileVersion | null } | { kind: "error"; error: string };

export type SaveOutcome<T> =
  | { kind: "saved"; value: T; version: FileVersion }
  | { kind: "conflict" }
  | { kind: "error"; error: string };

async function loadFile<T>(machineId: string, dir: string, file: string, parse: (t: string) => Parsed<T>): Promise<Loaded<T>> {
  let version: FileVersion | null;
  let body: string;
  try {
    const c = await filesRead(machineId, dir, file);
    if (!c.editable || c.cksum === null || c.text === null) {
      return { kind: "error", error: `Cannot read ${file}: not a text file` };
    }
    version = { size: c.size, mtime: c.mtime, cksum: c.cksum };
    body = c.text;
  } catch (e) {
    if (codeOf(e) !== "not_found") return { kind: "error", error: `Cannot read ${file}: ${errorText(e)}` };
    version = null;
    body = "";
  }
  const p = parse(body);
  return p.ok ? { kind: "ok", value: p.value, version } : { kind: "error", error: p.error };
}

export const loadSettings = (machineId: string, dir: string) => loadFile(machineId, dir, SETTINGS_FILE, parseSettings);
export const loadAliases = (machineId: string, dir: string) => loadFile(machineId, dir, ALIAS_FILE, parseAliases);

export async function saveEnabled(
  machineId: string,
  dir: string,
  loaded: string[],
  list: string[],
  force: boolean,
): Promise<SaveOutcome<PiSettingsFile>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = await loadSettings(machineId, dir);
    if (fresh.kind === "error") return fresh;
    if (!force && enabledConflict(loaded, fresh.value.enabled)) return { kind: "conflict" };
    const body = withEnabled(fresh.value.json, list);
    try {
      const version = await filesWrite(machineId, dir, SETTINGS_FILE, body, fresh.version);
      const parsed = parseSettings(body);
      if (!parsed.ok) return { kind: "error", error: parsed.error };
      return { kind: "saved", value: parsed.value, version };
    } catch (e) {
      if (codeOf(e) !== "conflict") return { kind: "error", error: `Cannot save: ${errorText(e)}` };
    }
  }
  return { kind: "conflict" };
}

export async function saveAliases(
  machineId: string,
  dir: string,
  raw: Json,
  aliases: Alias[],
  version: FileVersion | null,
  force: boolean,
): Promise<SaveOutcome<AliasFile>> {
  const body = withAliases(raw, aliases);
  try {
    const written = await filesWrite(machineId, dir, ALIAS_FILE, body, force ? null : version);
    const parsed = parseAliases(body);
    if (!parsed.ok) return { kind: "error", error: parsed.error };
    return { kind: "saved", value: parsed.value, version: written };
  } catch (e) {
    if (codeOf(e) === "conflict") return { kind: "conflict" };
    return { kind: "error", error: `Cannot save: ${errorText(e)}` };
  }
}
