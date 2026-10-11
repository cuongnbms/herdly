import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn() }));
import { herdrCall } from "../lib/ipc";
import type { MachineView, PaneView } from "../lib/types";
import { loadNewTabAgent, useNewTab } from "../settings/newTab";
import { useApp } from "../store/app";
import { setFolder } from "../workspaces/folder";
import { openNewTabHere } from "./newTabShortcut";

const machine: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "api", number: 1, status: "idle", tabs: [
      { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes: [
        { pane_id: "w1:p1", terminal_id: "t1", title: "claude", cwd: "/srv/api/sub", agent: "claude", status: "idle" },
      ] },
    ] },
  ] }],
};
const withPane = (pane: PaneView): MachineView => {
  const ws = machine.sessions[0].workspaces[0];
  return { ...machine, sessions: [{ ...machine.sessions[0], workspaces: [{ ...ws, tabs: [...ws.tabs,
    { tab_id: "w1:t9", label: "claude", number: 9, status: "idle", panes: [pane] }] }] }] };
};
const ref = { machine_id: "local", session: "default", workspace_id: "w1" };

describe("openNewTabHere", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useApp.setState({ machines: {}, order: [], selected: null, lensOverride: {} });
    useApp.getState().upsertMachine(machine);
    useNewTab.setState({ agent: "claude" });
    vi.mocked(herdrCall).mockImplementation((_m, _s, method) => {
      if (method === "tab.create") return Promise.resolve({ root_pane: { pane_id: "w1:p9" } });
      // herdr reports the started agent in the next snapshot.
      useApp.getState().upsertMachine(withPane({ pane_id: "w1:p9", terminal_id: "t9", title: "claude", cwd: "/srv/api", agent: "claude", status: "idle" }));
      return Promise.resolve(undefined);
    });
  });

  it("does nothing without a selected pane", async () => {
    expect(await openNewTabHere()).toBe(false);
    expect(herdrCall).not.toHaveBeenCalled();
  });

  it("opens claude by default in the workspace's folder and selects it", async () => {
    setFolder(ref, "/srv/api");
    useApp.getState().select({ machine_id: "local", session: "default", pane_id: "w1:p1" });
    expect(await openNewTabHere()).toBe(true);
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "tab.create", { workspace_id: "w1", cwd: "/srv/api", label: "claude", focus: false });
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "agent.start", { name: "claude", kind: "claude", pane_id: "w1:p9" });
    expect(useApp.getState().selected?.pane_id).toBe("w1:p9");
  });

  it("falls back to the pane's cwd and honours the chosen agent", async () => {
    useNewTab.getState().setAgent("shell");
    useApp.getState().select({ machine_id: "local", session: "default", pane_id: "w1:p1" });
    await openNewTabHere();
    expect(herdrCall).toHaveBeenCalledTimes(1);
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "tab.create", { workspace_id: "w1", cwd: "/srv/api/sub", label: "shell", focus: false });
  });
});

describe("new tab setting", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to claude, persists a choice and ignores junk", () => {
    expect(loadNewTabAgent()).toBe("claude");
    useNewTab.getState().setAgent("pi");
    expect(loadNewTabAgent()).toBe("pi");
    localStorage.setItem("herdly:settings", JSON.stringify({ newTabAgent: "vim" }));
    expect(loadNewTabAgent()).toBe("claude");
  });
});
