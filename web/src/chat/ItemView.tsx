import { checklist, checklistSummary } from "@desktop/chat/checklist";
import type { CSSProperties } from "react";
import type { ChatItem } from "../types";
import { Markdown } from "./Markdown";

const block: CSSProperties = { margin: "6px 12px", overflowWrap: "anywhere" };
const pre: CSSProperties = { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13 };
const MARK = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;

export const userBubble: CSSProperties = { margin: "6px 12px 6px 48px", padding: "8px 12px", borderRadius: 12, background: "#1565c022", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };

export function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div style={userBubble}>
          {item.text}
          {item.images?.map((_, i) => <div key={i}>[image]</div>)}
        </div>
      );
    case "assistant_text":
      return <div style={block}><Markdown text={item.markdown} /></div>;
    case "thinking":
      return (
        <details style={block}>
          <summary>Thinking</summary>
          <pre style={pre}>{item.text}</pre>
        </details>
      );
    case "tool_call": {
      const rows = checklist(item.input);
      return (
        <details style={block}>
          <summary>
            <strong>{item.name}</strong> {item.input_summary}{rows && ` (${checklistSummary(rows)})`}
          </summary>
          {rows && (
            <ul style={{ margin: 0, paddingLeft: 20, listStyle: "none" }}>
              {rows.map((r, i) => <li key={i} data-status={r.status}>{MARK[r.status]} {r.label}</li>)}
            </ul>
          )}
        </details>
      );
    }
    case "tool_result":
      return (
        <details style={block}>
          <summary>{item.is_error ? "Error" : "Result"}</summary>
          <pre style={pre}>{item.output}</pre>
          {item.images?.map((_, i) => <div key={i}>[image]</div>)}
        </details>
      );
    case "system":
      return <div style={{ ...block, opacity: 0.7, fontSize: 13 }}>{item.text}</div>;
    case "shell_command":
      return <pre style={{ ...pre, ...block }}>$ {item.command}</pre>;
    case "shell_output":
      return <pre style={{ ...pre, ...block }}>{item.stdout}{item.stderr}</pre>;
  }
}
