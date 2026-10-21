import type { PromptAnswer, ScreenPrompt } from "@desktop/chat/prompt/screenPrompt";
import { useState } from "react";

export function PromptCard({ prompt, busy, error, onAnswer }: { prompt: ScreenPrompt; busy: boolean; error: string | null; onAnswer(a: PromptAnswer): void }) {
  const [picked, setPicked] = useState<number[]>([]);
  const [custom, setCustom] = useState("");
  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)));
  return (
    <div data-prompt className="prompt-card">
      <div className="prompt-head">
        <span className="prompt-dot" />
        <strong>{prompt.title}</strong>
      </div>
      <div className="prompt-question">{prompt.question}</div>
      {prompt.body && <pre className="prompt-body">{prompt.body}</pre>}
      {prompt.options.map((o, i) =>
        prompt.multi_select ? (
          <label key={i} className="prompt-option">
            <input type="checkbox" checked={picked.includes(i)} disabled={busy} onChange={() => toggle(i)} />
            <span className="prompt-option-text">
              <span>{o.label}</span>
              {o.description && <span className="prompt-desc">{o.description}</span>}
            </span>
          </label>
        ) : (
          <button key={i} type="button" className="prompt-option" disabled={busy} onClick={() => onAnswer({ option_index: i })}>
            <span className="prompt-num">{i + 1}</span>
            <span className="prompt-option-text">
              <span>{o.label}</span>
              {o.description && <span className="prompt-desc">{o.description}</span>}
            </span>
          </button>
        ),
      )}
      {prompt.multi_select && (
        <button type="button" className="btn prompt-submit" disabled={busy} onClick={() => onAnswer({ option_indices: picked })}>Submit</button>
      )}
      {prompt.custom_option_index !== null && (
        <div className="prompt-custom">
          <input aria-label="Answer" placeholder="Or type your own answer" value={custom} disabled={busy} onChange={(e) => setCustom(e.target.value)} />
          <button type="button" className="btn" disabled={busy || !custom.trim()} onClick={() => onAnswer({ custom_text: custom })}>Answer</button>
        </div>
      )}
      {error && <div role="alert" className="prompt-error">{error}</div>}
    </div>
  );
}
