import { readPrompt, type PromptAnswer, type ScreenPrompt } from "@desktop/chat/prompt/screenPrompt";
import { sendAnswer, type PromptIo } from "@desktop/chat/prompt/sendAnswer";
import { useCallback, useEffect, useRef, useState } from "react";
import { paneKeys, paneRead, paneText } from "../api";
import { PROMPT_POLL_MS } from "../config";
import type { PaneView, WebPane } from "../types";

/** The prompt card's state: polled from the screen while the Pane is blocked, gone otherwise. */
export function usePrompt(pane: WebPane, view: PaneView): { prompt: ScreenPrompt | null; answer(a: PromptAnswer): Promise<void>; busy: boolean; error: string | null } {
  const [prompt, setPrompt] = useState<ScreenPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = view.status === "blocked";
  const { agent, title } = view;
  const { session, pane_id } = pane;
  const live = useRef(false);
  const shown = useRef<ScreenPrompt | null>(null);
  shown.current = prompt;

  useEffect(() => {
    live.current = blocked;
    if (!blocked) {
      setPrompt(null);
      setError(null);
      return;
    }
    // `current` is false once this run is replaced or the Pane stops being blocked: a read that lands later is ignored.
    let current = true;
    let inFlight = false;
    const read = () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      paneRead({ session, pane_id }).then(
        (text) => {
          inFlight = false;
          if (!current) return;
          const next = readPrompt(agent, text);
          setPrompt((cur) => (cur?.id === next.id ? cur : next));
        },
        () => {
          inFlight = false;
        },
      );
    };
    read();
    const timer = setInterval(read, PROMPT_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [blocked, title, agent, session, pane_id]);

  const answer = useCallback(
    async (a: PromptAnswer) => {
      const card = shown.current;
      if (!card) return;
      const io: PromptIo = {
        read: () => paneRead({ session, pane_id }),
        keys: (k) => paneKeys({ session, pane_id }, k),
        text: (t) => paneText({ session, pane_id }, t),
      };
      setBusy(true);
      setError(null);
      try {
        const out = await sendAnswer(io, agent, card, a);
        if (!out.sent && live.current) setPrompt(out.fresh);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [agent, session, pane_id],
  );

  return { prompt, answer, busy, error };
}
