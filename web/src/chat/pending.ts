import { PENDING_STALE_MS } from "../config";
import type { ChatItem } from "../types";

export interface Pending { id: number; text: string; sentAt: number }

/** Each `user` item removes the first pending with the same trimmed text. */
export function settle(pending: Pending[], items: ChatItem[]): Pending[] {
  let rest = pending;
  for (const it of items) {
    if (it.kind !== "user") continue;
    const i = rest.findIndex((p) => p.text.trim() === it.text.trim());
    if (i >= 0) rest = rest.filter((_, j) => j !== i);
  }
  return rest;
}

export function isStale(p: Pending, now: number): boolean {
  return now - p.sentAt >= PENDING_STALE_MS;
}
