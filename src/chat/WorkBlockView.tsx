import { memo, useState } from "react";
import { ChevronIcon } from "../ui/icons";
import { ChatItemView } from "./ChatItemView";
import { SkillChips, turnSkills } from "./skills";
import { formatWorkDuration, groupCalls, workSummary, type ToolCall, type ToolResult, type WorkBlock } from "./workBlocks";

/**
 * One turn's work under one header ("Worked for 7s · 1 edit"). Controlled: the Chat lens keeps
 * open/closed, since a virtualized row unmounts when it scrolls away.
 */
export const WorkBlockView = memo(function WorkBlockView({
  block,
  results,
  open,
  onToggle,
  live,
}: {
  block: WorkBlock;
  results: Map<string, ToolResult>;
  open: boolean;
  /** Called with this block's id and its open state, so a stable callback keeps memo working. */
  onToggle: (id: string, open: boolean) => void;
  live: boolean;
}) {
  const duration = formatWorkDuration(block.start, block.end);
  const title = live ? "Working…" : duration ? `Worked for ${duration}` : "Worked";
  const summary = workSummary(block.items, results);
  return (
    <div className="chat-row chat-work">
      <button className="chat-work-head" aria-expanded={open} onClick={() => onToggle(block.id, open)}>
        <ChevronIcon className={"icon chev" + (open ? " open" : "")} />
        <span className="chat-work-title">{title}</span>
        {summary && (
          <>
            {" · "}
            <span className="chat-work-summary">{summary}</span>
          </>
        )}
      </button>
      <SkillChips chips={turnSkills(block.items, results)} />
      {open && (
        <div className="chat-work-rows">
          {groupCalls(block.items, live).map((seg, i) =>
            seg.kind === "calls" ? (
              <CallGroup key={i} calls={seg.calls} results={results} />
            ) : (
              <div key={i} className={seg.item.kind === "assistant_text" ? "chat-narration" : undefined}>
                <ChatItemView item={seg.item} result={seg.item.kind === "tool_call" ? results.get(seg.item.id) : undefined} />
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
});

/** A run of calls as one "3 commands · 1 file read" line; open, the calls' own rows. */
function CallGroup({ calls, results }: { calls: ToolCall[]; results: Map<string, ToolResult> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-calls">
      <button className="chat-calls-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronIcon className={"icon chev" + (open ? " open" : "")} />
        <span>{workSummary(calls, results)}</span>
      </button>
      {open && (
        <div className="chat-calls-rows">
          {calls.map((call) => (
            <ChatItemView key={call.id} item={call} result={results.get(call.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
