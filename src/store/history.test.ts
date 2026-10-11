import { beforeEach, describe, expect, it } from "vitest";
import { activeItem, useApp } from "./app";
import { goBack, goForward, useHistory } from "./history";
import { itemKey } from "./openItems";
import type { MachineView, PaneRef } from "../lib/types";

const machine: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle",
  sessions: [
    { name: "default", running: true, status: "idle", error: null, workspaces: [
      { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [
        { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes: [
          { pane_id: "w1:p1", terminal_id: "term_a", title: "a", cwd: "/x", agent: "claude", status: "idle" },
          { pane_id: "w1:p2", terminal_id: "term_b", title: "b", cwd: "/x", agent: "pi", status: "idle" },
        ] },
      ] },
    ] },
    { name: "other", running: true, status: "idle", error: null, workspaces: [
      { workspace_id: "w9", label: "api", number: 1, status: "idle", tabs: [
        { tab_id: "w9:t1", label: "1", number: 1, status: "idle", panes: [
          { pane_id: "w9:p1", terminal_id: "term_c", title: "c", cwd: "/y", agent: "claude", status: "idle" },
        ] },
      ] },
    ] },
  ],
};

const p1: PaneRef = { machine_id: "local", session: "default", pane_id: "w1:p1" };
const p2: PaneRef = { machine_id: "local", session: "default", pane_id: "w1:p2" };
const p3: PaneRef = { machine_id: "local", session: "other", pane_id: "w9:p1" };
const ws = { machine_id: "local", session: "default", workspace_id: "w1" };

const shown = () => {
  const item = activeItem(useApp.getState());
  return item ? itemKey(item) : null;
};
const agent = (ref: PaneRef) => itemKey({ kind: "agent", ref });

describe("navigation history", () => {
  beforeEach(() => {
    useApp.setState({ machines: {}, order: [], selected: null, viewed: null, tabs: {}, lastPane: {} });
    useApp.getState().upsertMachine(machine);
    useHistory.setState({ back: [], forward: [] });
  });

  it("goes back and forward through the panes shown", () => {
    const { select } = useApp.getState();
    select(p1);
    select(p2);
    select(p3);
    goBack();
    expect(shown()).toBe(agent(p2));
    goBack();
    expect(shown()).toBe(agent(p1));
    goForward();
    expect(shown()).toBe(agent(p2));
    goForward();
    expect(shown()).toBe(agent(p3));
    goForward();
    expect(shown()).toBe(agent(p3));
  });

  it("returns to a file, reopening its tab once closed", () => {
    useApp.getState().select(p1);
    useApp.getState().openFile(ws, "/x", "README.md", { pin: false });
    const file = shown();
    useApp.getState().select(p2);
    useApp.getState().closeItems(file!, "one");
    goBack();
    expect(shown()).toBe(file);
    goBack();
    expect(shown()).toBe(agent(p1));
  });

  it("drops what lies ahead once the user goes somewhere new", () => {
    const { select } = useApp.getState();
    select(p1);
    select(p2);
    goBack();
    select(p3);
    goForward();
    expect(shown()).toBe(agent(p3));
    expect(useHistory.getState().forward).toEqual([]);
  });

  it("skips panes that are gone", () => {
    const { select } = useApp.getState();
    select(p1);
    select(p2);
    select(p3);
    const gone = structuredClone(machine);
    gone.sessions[0].workspaces[0].tabs[0].panes.pop();
    useApp.getState().upsertMachine(gone);
    goBack();
    expect(shown()).toBe(agent(p1));
  });

  it("keeps the last 50 places", () => {
    for (let i = 0; i < 60; i++) useApp.getState().select(i % 2 ? p1 : p2);
    expect(useHistory.getState().back).toHaveLength(50);
  });
});
