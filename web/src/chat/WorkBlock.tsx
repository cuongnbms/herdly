import { formatWorkDuration, groupCalls, workSummary, type ToolResult, type WorkBlock as WorkBlockData } from "@desktop/chat/workBlocks";
import { memo, useState } from "react";
import type { ChatItem } from "../types";
import { ChevronIcon } from "../ui/icons";
import { ItemView } from "./ItemView";

type Call = Extract<ChatItem, { kind: "tool_call" }>;

function CallGroup({ calls, results }: { calls: Call[]; results: Map<string, ToolResult> }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="work-head toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronIcon className="chev" />
        <span>{workSummary(calls, results)}</span>
      </button>
      {open && (
        <div className="work-body">
          {calls.map((c) => <ItemView key={`c:${c.id}`} item={c} result={results.get(c.id)} />)}
        </div>
      )}
    </div>
  );
}

/** One turn's work under a header; memoised so a stable block skips re-rendering on Append. */
export const WorkBlock = memo(function WorkBlock({ block, results, open, live, onToggle }: { block: WorkBlockData; results: Map<string, ToolResult>; open: boolean; live: boolean; onToggle(id: string, open: boolean): void }) {
  const summary = workSummary(block.items, results);
  const d = formatWorkDuration(block.start, block.end);
  const title = live ? "Working…" : d ? `Worked for ${d}` : "Worked";
  return (
    <div className="work">
      <button type="button" className="work-head toggle" aria-expanded={open} onClick={() => onToggle(block.id, open)}>
        <ChevronIcon className="chev" />
        <span>{summary ? `${title} · ${summary}` : title}</span>
      </button>
      {open && (
        <div className="work-body">
          {groupCalls(block.items, live).map((seg) => {
            if (seg.kind === "calls") return <CallGroup key={`g:${seg.calls[0].id}`} calls={seg.calls} results={results} />;
            const it = seg.item;
            if (it.kind === "tool_call") return <ItemView key={`c:${it.id}`} item={it} result={results.get(it.id)} />;
            const view = <ItemView item={it} />;
            const key = `i:${block.items.indexOf(it)}`;
            return it.kind === "assistant_text" ? <div key={key} className="narration">{view}</div> : <div key={key}>{view}</div>;
          })}
        </div>
      )}
    </div>
  );
});
