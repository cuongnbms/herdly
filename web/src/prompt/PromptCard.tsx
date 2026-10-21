import type { PromptAnswer, ScreenPrompt } from "@desktop/chat/prompt/screenPrompt";
import { useState } from "react";

const BTN = { minHeight: 44, textAlign: "left", font: "inherit" } as const;

export function PromptCard({ prompt, busy, error, onAnswer }: { prompt: ScreenPrompt; busy: boolean; error: string | null; onAnswer(a: PromptAnswer): void }) {
  const [picked, setPicked] = useState<number[]>([]);
  const [custom, setCustom] = useState("");
  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)));
  return (
    <div data-prompt style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "45dvh", overflowY: "auto" }}>
      <strong>{prompt.title}</strong>
      <div>{prompt.question}</div>
      {prompt.body && <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{prompt.body}</pre>}
      {prompt.options.map((o, i) =>
        prompt.multi_select ? (
          <label key={i} style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
            <input type="checkbox" checked={picked.includes(i)} disabled={busy} onChange={() => toggle(i)} />
            <span>
              <div>{o.label}</div>
              {o.description && <div style={{ fontSize: 12, opacity: 0.7 }}>{o.description}</div>}
            </span>
          </label>
        ) : (
          <button key={i} type="button" disabled={busy} onClick={() => onAnswer({ option_index: i })} style={BTN}>
            <div>{o.label}</div>
            {o.description && <div style={{ fontSize: 12, opacity: 0.7 }}>{o.description}</div>}
          </button>
        ),
      )}
      {prompt.multi_select && (
        <button type="button" disabled={busy} onClick={() => onAnswer({ option_indices: picked })} style={BTN}>Submit</button>
      )}
      {prompt.custom_option_index !== null && (
        <div style={{ display: "flex", gap: 8 }}>
          <input aria-label="Answer" value={custom} disabled={busy} onChange={(e) => setCustom(e.target.value)} style={{ flex: 1, font: "inherit", minHeight: 44 }} />
          <button type="button" disabled={busy || !custom.trim()} onClick={() => onAnswer({ custom_text: custom })} style={{ minHeight: 44 }}>Answer</button>
        </div>
      )}
      {error && <div role="alert" style={{ color: "#c0392b", fontSize: 13 }}>{error}</div>}
    </div>
  );
}
