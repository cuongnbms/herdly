import { useEffect, useRef } from "react";

// Each pane's unsent Composer text, kept outside the Composer: it unmounts on a pane switch,
// a lens switch, and while the agent is blocked.
const draftKey = (paneKey: string) => `herdly:draft:${paneKey}`;

/** How long typing must pause before the draft is written. */
export const DRAFT_WRITE_MS = 300;

export function readDraft(paneKey: string): string {
  try {
    return localStorage.getItem(draftKey(paneKey)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(paneKey: string, text: string) {
  try {
    if (text) localStorage.setItem(draftKey(paneKey), text);
    else localStorage.removeItem(draftKey(paneKey));
  } catch {
    /* storage unavailable: the draft lives only while the Composer does */
  }
}

/**
 * Keep `text` as the draft of `paneKey`, written once typing pauses rather than per keystroke.
 * A pending write is flushed on unmount, when `paneKey` changes and when the page is hidden, so
 * no draft is lost; an emptied draft (just sent) is forgotten at once.
 */
export function useDraft(paneKey: string, text: string) {
  const pending = useRef<{ key: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useRef(() => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) writeDraft(p.key, p.text);
  }).current;

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [paneKey, flush]);

  useEffect(() => {
    pending.current = { key: paneKey, text };
    if (!text) return flush();
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, DRAFT_WRITE_MS);
  }, [paneKey, text, flush]);
}
