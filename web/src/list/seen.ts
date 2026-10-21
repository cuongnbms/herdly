import { SEEN_KEY } from "../config";
import type { AgentStatus } from "../types";

function read(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function write(m: Record<string, string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(m));
  } catch {
    /* storage unavailable: nothing is remembered */
  }
}

export function markSeen(key: string): void {
  write({ ...read(), [key]: "done" });
}

export function clearSeen(key: string): void {
  const m = read();
  if (!(key in m)) return;
  delete m[key];
  write(m);
}

/** A seen `done` Pane shows as `idle` until its status changes. */
export function shownStatus(key: string, status: AgentStatus): AgentStatus {
  return status === "done" && read()[key] === "done" ? "idle" : status;
}
