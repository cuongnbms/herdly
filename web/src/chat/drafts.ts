import { DRAFT_PREFIX } from "../config";

/** The unsent text of a Pane's Composer; "" when none is kept or storage is unavailable. */
export function loadDraft(key: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

/** Keeps `text` for the Pane; a blank text removes the draft. Storage failures keep nothing. */
export function saveDraft(key: string, text: string): void {
  try {
    if (text.trim() === "") localStorage.removeItem(DRAFT_PREFIX + key);
    else localStorage.setItem(DRAFT_PREFIX + key, text);
  } catch {
    // Storage is full or blocked: the draft is simply not kept.
  }
}
