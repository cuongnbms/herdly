import { describe, expect, it } from "vitest";
import { findRow, groupByStatus, orderSessions, rowPane } from "./order";

const p = (id: string, status: string, agent: string | null = "claude") => ({ pane_id: id, terminal_id: "t" + id, title: id, cwd: null, agent, status });
const session = (name: string, running: boolean, workspaces: unknown[], error: unknown = null) => ({ name, running, status: "idle", error, workspaces });
const ws = (label: string, panes: unknown[], id = label) => ({ workspace_id: id, label, number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] });
const ids = (rows: { pane: { pane_id: string } }[]) => rows.map((r) => r.pane.pane_id);

describe("order", () => {
  it("puts running sessions first and keeps herdr's order otherwise", () => {
    const ss = [session("a", false, []), session("b", true, []), session("c", true, [])] as never[];
    expect(orderSessions(ss).map((s: { name: string }) => s.name)).toEqual(["b", "c", "a"]);
  });

  it("groups Panes by status across Sessions, running Sessions first, then herdr's order", () => {
    const ss = [
      session("old", false, []),
      session("b", true, [ws("api", [p("1", "working"), p("2", "blocked")]), ws("web", [p("3", "done"), p("4", "idle", null)])]),
      session("a", true, [ws("docs", [p("5", "unknown"), p("6", "blocked")])]),
    ];
    const g = groupByStatus(ss as never);
    expect(ids(g.needs)).toEqual(["2", "6"]);
    expect(ids(g.working)).toEqual(["1"]);
    expect(ids(g.done)).toEqual(["3"]);
    expect(ids(g.idle)).toEqual(["4", "5"]);
    expect(g.stopped).toEqual(["old"]);
    expect(g.failed).toEqual([]);
    expect(g.needs[0]).toMatchObject({ session: "b", workspace: "api", workspace_id: "api", status: "blocked" });
    expect(rowPane(g.needs[1])).toEqual({ session: "a", pane_id: "6" });
  });

  it("files a Pane under its shown status", () => {
    const s = session("s", true, [ws("w", [p("1", "done"), p("2", "done")])]);
    const g = groupByStatus([s] as never, (key, st) => (key === "s/1" ? "idle" : st));
    expect(ids(g.done)).toEqual(["2"]);
    expect(ids(g.idle)).toEqual(["1"]);
    expect(g.idle[0].status).toBe("idle");
    expect(g.idle[0].pane.status).toBe("done");
  });

  it("lists a running Session that failed to load, and keeps two Workspaces with one label apart", () => {
    const ss = [
      session("x", true, [], { code: "herdr_error", message: "socket gone" }),
      session("s", true, [ws("herdly", [p("1", "idle")], "w1"), ws("herdly", [p("2", "idle")], "w2")]),
    ];
    const g = groupByStatus(ss as never);
    expect(g.failed).toEqual([{ name: "x", message: "socket gone" }]);
    expect(g.stopped).toEqual([]);
    expect(g.idle.map((r) => r.workspace_id)).toEqual(["w1", "w2"]);
  });

  it("finds a Pane's row by Session and pane id", () => {
    const ss = [session("a", true, [ws("api", [p("1", "working")])]), session("b", true, [ws("web", [p("1", "idle")])])];
    expect(findRow(ss as never, { session: "b", pane_id: "1" })).toMatchObject({ session: "b", workspace: "web", status: "idle" });
    expect(findRow(ss as never, { session: "c", pane_id: "1" })).toBeNull();
  });
});
