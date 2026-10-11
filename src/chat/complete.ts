import type { SlashCommand } from "../lib/types";

function subsequence(text: string, query: string): boolean {
  let index = 0;
  for (const character of text) if (character === query[index]) index += 1;
  return index === query.length;
}

function tier(name: string, query: string): number {
  const lower = name.toLowerCase();
  if (lower.startsWith(query) || lower.split(":").some((segment) => segment.startsWith(query))) return 0;
  if (lower.includes(query)) return 1;
  if (subsequence(lower, query)) return 2;
  return -1;
}

/** Prefix matches first, then substring, then subsequence; within a tier, most used first, then by name. */
export function rankCommands(commands: SlashCommand[], query: string, usage: Record<string, number>): SlashCommand[] {
  const q = query.toLowerCase();
  return commands
    .map((command) => ({ command, tier: tier(command.name, q) }))
    .filter((item) => item.tier >= 0)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (usage[b.command.name] ?? 0) - (usage[a.command.name] ?? 0) ||
        (a.command.name < b.command.name ? -1 : a.command.name > b.command.name ? 1 : 0),
    )
    .map((item) => item.command);
}

function score(path: string, query: string): number {
  if (!query) return 1;
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const at = lower.indexOf(query);
  if (at >= 0) return 300 - at + (name.includes(query) ? 30 : 0);
  if (subsequence(name, query)) return 200 - name.length;
  if (subsequence(lower, query)) return 100 - lower.length / 1000;
  return -1;
}

/** Ranks file paths against a query, file name matches first; ties by path. */
export function rankFiles(paths: string[], query: string, limit = 50): string[] {
  const normalized = query.trim().toLowerCase();
  return paths
    .map((path) => ({ path, score: score(path, normalized) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((item) => item.path);
}

/** Splits a `@../…` query into the folder to list and the name typed after it; null for other queries. */
export function splitParentQuery(query: string): { dir: string; prefix: string } | null {
  if (!query.startsWith("../")) return null;
  const slash = query.lastIndexOf("/");
  return { dir: query.slice(0, slash + 1), prefix: query.slice(slash + 1) };
}

const usageKey = (agent: string) => `herdly:slash-usage:${agent}`;

export function readUsage(agent: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(usageKey(agent)) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const usage: Record<string, number> = {};
    for (const [name, count] of Object.entries(parsed)) {
      if (typeof count === "number" && Number.isFinite(count)) usage[name] = count;
    }
    return usage;
  } catch {
    return {};
  }
}

/** Counts one pick of `name` for `agent` and returns the new map. */
export function recordUse(agent: string, name: string): Record<string, number> {
  const usage = readUsage(agent);
  usage[name] = (usage[name] ?? 0) + 1;
  try {
    localStorage.setItem(usageKey(agent), JSON.stringify(usage));
  } catch {
    // storage unavailable: the in-memory count still ranks this session
  }
  return usage;
}
