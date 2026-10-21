import { checklist, checklistSummary } from "@desktop/chat/checklist";
import type { ToolResult } from "@desktop/chat/workBlocks";
import { memo, useState, type ReactNode } from "react";
import type { ChatItem } from "../types";
import { CopyButton } from "../ui/CopyButton";
import { ChevronIcon } from "../ui/icons";
import { Markdown } from "./Markdown";

const MARK = { pending: "○", in_progress: "◐", completed: "●" } as const;

/** A collapsible row: the body is rendered only while open. */
function Collapsible({ head, headClass, children }: { head: ReactNode; headClass: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className={`${headClass} toggle`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronIcon className="chev" />
        {head}
      </button>
      {open && <div className="work-body">{children}</div>}
    </div>
  );
}

function Images({ images }: { images: unknown[] | undefined }) {
  return <>{images?.map((_, i) => <span key={i} className="chip">image</span>)}</>;
}

/** Memoised: the chat store keeps each item's object across Append and paging, so a shown item never re-parses. */
export const ItemView = memo(function ItemView({ item, result }: { item: ChatItem; result?: ToolResult }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="bubble-user">
          {item.text}
          <Images images={item.images} />
        </div>
      );
    case "assistant_text":
      return (
        <div className="answer">
          <Markdown text={item.markdown} />
          <div className="answer-actions"><CopyButton text={item.markdown} /></div>
        </div>
      );
    case "thinking":
      return (
        <Collapsible headClass="work-head" head={<span>Thinking</span>}>
          <pre className="mono-block">{item.text}</pre>
        </Collapsible>
      );
    case "tool_call": {
      const rows = checklist(item.input);
      return (
        <Collapsible
          headClass="call-head"
          head={<><span className="call-name">{item.name}</span> <span className="call-summary">{item.input_summary}{rows && ` (${checklistSummary(rows)})`}</span></>}
        >
          {rows && (
            <ul className="checklist">
              {rows.map((r, i) => <li key={i} data-status={r.status}>{MARK[r.status]} {r.label}</li>)}
            </ul>
          )}
          {result && (
            <>
              <pre className="call-result" data-error={result.is_error}>{result.output}</pre>
              <Images images={result.images} />
            </>
          )}
        </Collapsible>
      );
    }
    case "tool_result":
      return (
        <Collapsible headClass="work-head" head={<span>{item.is_error ? "Error" : "Result"}</span>}>
          <pre className="call-result" data-error={item.is_error}>{item.output}</pre>
          <Images images={item.images} />
        </Collapsible>
      );
    case "system":
      return <div className="item-system">{item.text}</div>;
    case "shell_command":
      return <pre className="mono-block">$ {item.command}</pre>;
    case "shell_output":
      return <pre className="mono-block">{item.stdout}{item.stderr}</pre>;
  }
});
