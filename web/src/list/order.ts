import type { PaneView, SessionView } from "../types";

export interface PaneRow { pane: PaneView; workspace: string }

/** Running Sessions first, otherwise herdr's order (Array.sort is stable). */
export function orderSessions(ss: SessionView[]): SessionView[] {
  return [...ss].sort((a, b) => Number(b.running) - Number(a.running));
}

export function groupSession(s: SessionView): { waiting: PaneRow[]; workspaces: { label: string; panes: PaneRow[] }[] } {
  const waiting: PaneRow[] = [];
  const workspaces: { label: string; panes: PaneRow[] }[] = [];
  for (const w of s.workspaces) {
    const panes: PaneRow[] = [];
    for (const t of w.tabs) {
      for (const pane of t.panes) {
        (pane.status === "blocked" ? waiting : panes).push({ pane, workspace: w.label });
      }
    }
    if (panes.length > 0) workspaces.push({ label: w.label, panes });
  }
  return { waiting, workspaces };
}
