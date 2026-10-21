import { webKey, type AgentStatus, type PaneView, type SessionView, type WebPane } from "../types";

export interface PaneRow { session: string; workspace: string; workspace_id: string; pane: PaneView; status: AgentStatus }

export interface StatusGroups {
  needs: PaneRow[];
  working: PaneRow[];
  done: PaneRow[];
  idle: PaneRow[];
  stopped: string[];
  failed: { name: string; message: string }[];
}

/** Running Sessions first, otherwise herdr's order (Array.sort is stable). */
export function orderSessions(ss: SessionView[]): SessionView[] {
  return [...ss].sort((a, b) => Number(b.running) - Number(a.running));
}

export function groupByStatus(sessions: SessionView[], shown: (key: string, s: AgentStatus) => AgentStatus = (_k, s) => s): StatusGroups {
  const g: StatusGroups = { needs: [], working: [], done: [], idle: [], stopped: [], failed: [] };
  for (const s of orderSessions(sessions)) {
    if (!s.running) {
      g.stopped.push(s.name);
      continue;
    }
    if (s.error && s.workspaces.length === 0) {
      g.failed.push({ name: s.name, message: s.error.message });
      continue;
    }
    for (const w of s.workspaces) {
      for (const t of w.tabs) {
        for (const pane of t.panes) {
          const status = shown(webKey({ session: s.name, pane_id: pane.pane_id }), pane.status);
          const row: PaneRow = { session: s.name, workspace: w.label, workspace_id: w.workspace_id, pane, status };
          const list = status === "blocked" ? g.needs : status === "working" ? g.working : status === "done" ? g.done : g.idle;
          list.push(row);
        }
      }
    }
  }
  return g;
}

export function findRow(sessions: SessionView[], pane: WebPane): PaneRow | null {
  const s = sessions.find((x) => x.name === pane.session);
  if (!s) return null;
  for (const w of s.workspaces) {
    for (const t of w.tabs) {
      for (const p of t.panes) {
        if (p.pane_id === pane.pane_id) return { session: s.name, workspace: w.label, workspace_id: w.workspace_id, pane: p, status: p.status };
      }
    }
  }
  return null;
}

export function rowPane(r: PaneRow): WebPane {
  return { session: r.session, pane_id: r.pane.pane_id };
}
