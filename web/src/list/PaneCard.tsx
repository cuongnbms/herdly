import { canChat } from "../config";
import { webKey } from "../types";
import { rowPane, type PaneRow } from "./order";

export function AgentMark({ agent }: { agent: string | null }) {
  if (agent === "claude") return <span className="agent-mark agent-claude" aria-hidden="true">✳</span>;
  if (agent === "pi") return <span className="agent-mark agent-pi" aria-hidden="true">π</span>;
  return <span className="agent-mark agent-other" aria-hidden="true">&gt;_</span>;
}

export function PaneCard({ row, current, hint, onTap }: { row: PaneRow; current: boolean; hint: boolean; onTap(): void }) {
  const key = webKey(rowPane(row));
  const classes = ["pane-card", row.status === "blocked" && "pane-card-blocked", !canChat(row.pane) && "pane-card-dim"].filter(Boolean).join(" ");
  return (
    <li>
      <button type="button" className={classes} data-pane={key} aria-current={current ? "true" : undefined} onClick={onTap}>
        <AgentMark agent={row.pane.agent} />
        <span className="pane-card-text">
          <span className="pane-card-title">{row.pane.title}</span>
          <span className="pane-card-sub">{`${row.session} › ${row.workspace}`}</span>
        </span>
        <span className="status" data-status={row.status}>{row.status}</span>
      </button>
      {hint && <div className="pane-card-hint">Chat lens supports Claude Code and pi only</div>}
    </li>
  );
}
