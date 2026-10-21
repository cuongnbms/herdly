import { describe, expect, it } from "vitest";
import { groupSession, orderSessions } from "./order";

const p = (id: string, status: string, agent: string | null = "claude") => ({ pane_id: id, terminal_id: "t" + id, title: id, cwd: null, agent, status });
const session = (name: string, running: boolean, workspaces: unknown[]) => ({ name, running, status: "idle", error: null, workspaces });
const ws = (label: string, panes: unknown[]) => ({ workspace_id: label, label, number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] });

describe("order", () => {
  it("puts running sessions first and keeps herdr's order otherwise", () => {
    const ss = [session("a", false, []), session("b", true, []), session("c", true, [])] as never[];
    expect(orderSessions(ss).map((s: { name: string }) => s.name)).toEqual(["b", "c", "a"]);
  });

  it("lifts blocked panes of every workspace into waiting", () => {
    const s = session("s", true, [ws("api", [p("1", "working"), p("2", "blocked")]), ws("web", [p("3", "blocked")]), ws("docs", [p("4", "blocked")])]);
    const g = groupSession(s as never);
    expect(g.waiting.map((r) => [r.pane.pane_id, r.workspace])).toEqual([["2", "api"], ["3", "web"], ["4", "docs"]]);
    expect(g.workspaces.map((w) => [w.label, w.panes.map((r) => r.pane.pane_id)])).toEqual([["api", ["1"]]]);
  });
});
