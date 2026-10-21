import type { PaneView, SessionView } from "../types";

export interface PaneRow { pane: PaneView; workspace: string }

/** Running Sessions first, otherwise herdr's order (Array.sort is stable). */
export function orderSessions(ss: SessionView[]): SessionView[] {
  return [...ss].sort((a, b) => Number(b.running) - Number(a.running));
}

export function groupSession(s: SessionView): { waiting: PaneRow[]; workspaces: { workspace_id: string; label: string; panes: PaneRow[] }[] } {
  const waiting: PaneRow[] = [];
  const workspaces: { workspace_id: string; label: string; panes: PaneRow[] }[] = [];
  for (const w of s.workspaces) {
    const panes: PaneRow[] = [];
    for (const t of w.tabs) {
      for (const pane of t.panes) {
        (pane.status === "blocked" ? waiting : panes).push({ pane, workspace: w.label });
      }
    }
    if (panes.length > 0) workspaces.push({ workspace_id: w.workspace_id, label: w.label, panes });
  }
  return { waiting, workspaces };
}
