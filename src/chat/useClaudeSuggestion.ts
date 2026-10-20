import { useEffect, useState } from "react";
import { herdrCall } from "../lib/ipc";
import type { AgentStatus, PaneRef } from "../lib/types";
import { parseClaudeSuggestion } from "./prompt/claudeSuggestion";

/** How often the screen is re-read while Claude waits: its suggestion shows up a moment after a turn ends. */
export const SUGGESTION_POLL_MS = 2000;

interface ReadResult {
  text?: string;
  read?: { text?: string };
}

/**
 * The prompt Claude Code suggests next, grey in its own input box. Read from the pane's screen
 * with colors (only dim text tells it apart), and only while Claude waits for a prompt; `reading`
 * pauses the reads (the Composer has text of its own) and keeps the last suggestion.
 */
export function useClaudeSuggestion(pane: PaneRef, agent: string | null, status: AgentStatus | undefined, reading: boolean) {
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const waiting = agent === "claude" && (status === "idle" || status === "done");

  useEffect(() => {
    if (!waiting) setSuggestion(null);
  }, [waiting]);

  useEffect(() => {
    if (!waiting || !reading) return;
    let live = true;
    let inFlight = false;
    const read = () => {
      // No reads while the window is in the background; the next tick after it returns reads.
      // Nor while the last one is still out: a stalled link would pile them up.
      if (document.hidden || inFlight) return;
      inFlight = true;
      return herdrCall(pane.machine_id, pane.session, "pane.read", {
        pane_id: pane.pane_id,
        source: "visible",
        format: "ansi",
        strip_ansi: false,
      }).then(
        (r) => {
          const text = (r as ReadResult | undefined)?.text ?? (r as ReadResult | undefined)?.read?.text ?? "";
          if (live) setSuggestion(parseClaudeSuggestion(text));
        },
        // Only a nicety: a failed read leaves no suggestion.
        () => live && setSuggestion(null),
      ).finally(() => (inFlight = false));
    };
    void read();
    const timer = setInterval(read, SUGGESTION_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [waiting, reading, pane.machine_id, pane.session, pane.pane_id]);

  return { suggestion, clear: () => setSuggestion(null) };
}
