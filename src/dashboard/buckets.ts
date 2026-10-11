import { paneKey } from "../lib/types";
import type { AgentStatus, MachineView, PaneRef, PaneView, SessionView, WorkspaceView } from "../lib/types";

/** The Agent Dashboard columns, in display order. */
export type Bucket = "blocked" | "working" | "done" | "idle";

export const BUCKETS: { id: Bucket; label: string }[] = [
  { id: "blocked", label: "Blocked" },
  { id: "working", label: "Working" },
  { id: "done", label: "Done" },
  { id: "idle", label: "Idle" },
];

export interface DashCard {
  key: string;
  ref: PaneRef;
  machine: MachineView;
  session: SessionView;
  workspace: WorkspaceView;
  pane: PaneView;
  bucket: Bucket;
}

/** A pane's column: Done only until the user has seen it, then Idle. */
export function bucketOf(status: AgentStatus, seen: boolean): Bucket {
  if (status === "blocked") return "blocked";
  if (status === "working") return "working";
  if (status === "done" && !seen) return "done";
  return "idle";
}

/** Every agent pane (shells are left out) of a running session on a connected machine, in sidebar order, except Done and Idle:
 *  newest status change first (`since`), then panes with no known time in sidebar order. */
export function dashboardCards(
  machines: Record<string, MachineView>,
  order: string[],
  doneSeen: Record<string, true>,
  since: Record<string, number> = {},
): DashCard[] {
  const cards: DashCard[] = [];
  for (const id of order) {
    const machine = machines[id];
    if (!machine || machine.state !== "connected") continue;
    for (const session of machine.sessions) {
      if (!session.running) continue;
      for (const workspace of session.workspaces)
        for (const tab of workspace.tabs)
          for (const pane of tab.panes) {
            if (!pane.agent) continue;
            const ref = { machine_id: machine.id, session: session.name, pane_id: pane.pane_id };
            const key = paneKey(ref);
            cards.push({ key, ref, machine, session, workspace, pane, bucket: bucketOf(pane.status, !!doneSeen[key]) });
          }
    }
  }
  const newest = (a: DashCard, b: DashCard) => (since[b.key] ?? 0) - (since[a.key] ?? 0);
  const sorted = { done: cards.filter((c) => c.bucket === "done").sort(newest), idle: cards.filter((c) => c.bucket === "idle").sort(newest) };
  const next = { done: 0, idle: 0 };
  return cards.map((c) => (c.bucket === "done" || c.bucket === "idle" ? sorted[c.bucket][next[c.bucket]++] : c));
}

export function bucketCounts(cards: DashCard[]): Record<Bucket, number> {
  const counts: Record<Bucket, number> = { blocked: 0, working: 0, done: 0, idle: 0 };
  for (const c of cards) counts[c.bucket]++;
  return counts;
}

/** Case-insensitive substring match over the pane title, agent, workspace, session and machine. */
export function matchesQuery(card: DashCard, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [card.pane.title, card.pane.agent ?? "", card.workspace.label, card.session.name, card.machine.label]
    .some((f) => f.toLowerCase().includes(q));
}

const SIDEBAR_ORDER: Bucket[] = ["blocked", "done", "working"];

/** The sidebar's Agents list: Blocked, then Done, then Working cards, each in dashboard order. */
export function sidebarAgents(cards: DashCard[]): DashCard[] {
  return SIDEBAR_ORDER.flatMap((b) => cards.filter((c) => c.bucket === b));
}
