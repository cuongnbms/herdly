import { useState } from "react";
import { useWeb } from "../store";
import { webKey, type WebPane } from "../types";
import { groupSession, orderSessions, type PaneRow } from "./order";
import { markSeen, shownStatus } from "./seen";

const CHAT_AGENTS = ["claude", "pi"];

const BADGE: Record<string, string> = { blocked: "#c0392b", working: "#2e7d32", done: "#1565c0", idle: "#757575", unknown: "#757575" };

const rowStyle = { display: "flex", gap: 8, alignItems: "center", width: "100%", minHeight: 48, padding: "8px 12px", textAlign: "left", font: "inherit", background: "none", border: 0, borderBottom: "1px solid #8884" } as const;

export function PaneList({ onOpen }: { onOpen(p: WebPane): void }) {
  const machine = useWeb((s) => s.machines[0]);
  const [, bump] = useState(0);
  const [unsupported, setUnsupported] = useState<string | null>(null);

  const row = (session: string, { pane }: PaneRow) => {
    const web = { session, pane_id: pane.pane_id };
    const key = webKey(web);
    const shown = shownStatus(key, pane.status);
    const tap = () => {
      if (!pane.agent || !CHAT_AGENTS.includes(pane.agent)) {
        setUnsupported(key);
        return;
      }
      if (pane.status === "done") {
        markSeen(key);
        bump((n) => n + 1);
      }
      onOpen(web);
    };
    return (
      <li key={key} style={{ listStyle: "none" }}>
        <button type="button" data-pane={key} onClick={tap} style={rowStyle}>
          <strong>{pane.agent ?? "shell"}</strong>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pane.title}</span>
          <span data-status={shown} style={{ background: BADGE[shown] ?? BADGE.unknown, color: "#fff", borderRadius: 10, padding: "2px 8px", fontSize: 12 }}>{shown}</span>
        </button>
        {unsupported === key && <div style={{ padding: "0 12px 8px", fontSize: 13 }}>Chat lens supports Claude Code and pi only</div>}
      </li>
    );
  };

  return (
    <main style={{ maxWidth: 640, margin: "0 auto" }}>
      {machine?.error && <div role="alert" style={{ padding: 12, background: "#c0392b", color: "#fff" }}>{machine.error.message}</div>}
      {orderSessions(machine?.sessions ?? []).map((s) => {
        const g = groupSession(s);
        return (
          <section key={s.name}>
            <h2 style={{ margin: "16px 12px 4px" }}>{s.running ? s.name : `${s.name} (stopped)`}</h2>
            {g.waiting.length > 0 && (
              <>
                <h3 style={{ margin: "8px 12px 0" }}>Waiting</h3>
                <ul style={{ margin: 0, padding: 0 }}>{g.waiting.map((r) => row(s.name, r))}</ul>
              </>
            )}
            {g.workspaces.map((w) => (
              <div key={w.label}>
                <h3 style={{ margin: "8px 12px 0" }}>{w.label}</h3>
                <ul style={{ margin: 0, padding: 0 }}>{w.panes.map((r) => row(s.name, r))}</ul>
              </div>
            ))}
          </section>
        );
      })}
    </main>
  );
}
