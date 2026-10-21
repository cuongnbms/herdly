import { useLayoutEffect, useRef, useState } from "react";
import { paneKeys } from "../api";
import { COMPOSER_MAX_ROWS } from "../config";
import type { WebPane } from "../types";
import { SendIcon, StopIcon } from "../ui/icons";

export interface Draft { text: string; error: string | null }

const FALLBACK_ROW_PX = 22;
const VERTICAL_PADDING_PX = 20;

/** The text field and one round button: Stop while the Agent works and the field is blank, else Send. */
export function Composer({ pane, working, draft, setDraft, onSend }: { pane: WebPane; working: boolean; draft: Draft; setDraft(d: Draft): void; onSend(): void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const blank = draft.text.trim() === "";
  const stop = working && blank;

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight);
    const rowHeight = Number.isNaN(line) ? FALLBACK_ROW_PX : line;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, rowHeight * COMPOSER_MAX_ROWS + VERTICAL_PADDING_PX) + "px";
  }, [draft.text]);

  const onStop = async () => {
    setStopError(null);
    try {
      await paneKeys(pane, ["esc"]);
    } catch (e) {
      setStopError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="composer">
      {draft.error && <div role="alert" className="composer-error">{draft.error}</div>}
      {stopError && <div role="alert" className="composer-error">{stopError}</div>}
      <div className="composer-row">
        <textarea ref={field} aria-label="Message" rows={1} placeholder="Message" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
        {stop ? (
          <button type="button" className="send-btn" aria-label="Stop" onClick={() => void onStop()}><StopIcon /></button>
        ) : (
          <button type="button" className="send-btn" aria-label="Send" disabled={blank} onClick={onSend}><SendIcon /></button>
        )}
      </div>
    </div>
  );
}
