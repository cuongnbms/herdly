import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "./app";
import { syncDockBadge } from "./dockBadge";
import type { MachineView, PaneView } from "../lib/types";

const pane = (id: string, status: PaneView["status"]): PaneView => ({
  pane_id: id, terminal_id: "t" + id, title: id, cwd: "/x", agent: "claude", status,
});
const machine = (panes: PaneView[]): MachineView => ({
  id: "devtuf", label: "devtuf", kind: "ssh", state: "connected", error: null, version: "0.9.3", status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "x", number: 1, status: "idle", tabs: [
      { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes } ] } ] }],
});

describe("syncDockBadge", () => {
  beforeEach(() => useApp.setState({ machines: {}, order: [], selected: null, dashboardOpen: false, doneSeen: {} }));

  it("counts blocked plus unseen done agents, and clears at zero", () => {
    const set = vi.fn(() => Promise.resolve());
    const stop = syncDockBadge(set);
    expect(set).toHaveBeenLastCalledWith(undefined);
    useApp.getState().upsertMachine(machine([pane("a", "blocked"), pane("b", "done"), pane("c", "working")]));
    expect(set).toHaveBeenLastCalledWith(2);
    // Looking at the done pane takes it off the badge.
    useApp.getState().select({ machine_id: "devtuf", session: "default", pane_id: "b" });
    expect(set).toHaveBeenLastCalledWith(1);
    useApp.getState().upsertMachine(machine([pane("a", "working")]));
    expect(set).toHaveBeenLastCalledWith(undefined);
    stop();
  });

  it("only updates the badge when the count changes", () => {
    const set = vi.fn(() => Promise.resolve());
    const stop = syncDockBadge(set);
    useApp.getState().upsertMachine(machine([pane("a", "blocked")]));
    useApp.getState().upsertMachine(machine([pane("a", "blocked"), pane("c", "working")]));
    expect(set).toHaveBeenCalledTimes(2);
    stop();
  });
});
