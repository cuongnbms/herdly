import { canChat } from "../config";
import type { WebPane } from "../types";

/** How a Pane is shown: the Chat transcript, or its live terminal. */
export type Lens = "chat" | "terminal";

/** Web-only namespace, so an old asset that does not know Lens keys ignores them. */
const LENS_PREFIX = "herdly-web:lens:v1:";

const storageKey = (pane: WebPane) => LENS_PREFIX + JSON.stringify([pane.session, pane.pane_id]);

/**
 * The Lens a Pane opens in: a remembered Terminal always wins, and a remembered Chat only
 * counts while the Pane's Agent has a Chat lens at all.
 */
export function chooseLens(agent: string | null, saved: unknown): Lens {
  if (saved === "terminal") return "terminal";
  return canChat({ agent }) ? "chat" : "terminal";
}

/** The Lens this Session+Pane was last shown in, or null when nothing valid is stored. */
export function loadLens(pane: WebPane): Lens | null {
  try {
    const saved = localStorage.getItem(storageKey(pane));
    return saved === "chat" || saved === "terminal" ? saved : null;
  } catch {
    return null;
  }
}

/** Remembers the Lens for this Session+Pane. Storage failures keep nothing. */
export function saveLens(pane: WebPane, lens: Lens): void {
  try {
    localStorage.setItem(storageKey(pane), lens);
  } catch {
    // Storage is full or blocked: the choice simply is not remembered.
  }
}
