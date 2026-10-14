import { beforeEach, describe, expect, it } from "vitest";
import { panelAnchor, resolveRoot, shownWorkspace, workspaceOfSelection } from "./root";
import { setFolder } from "../workspaces/folder";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };
const ws = { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [{ panes: [{ cwd: "/p/first" }] }] } as never;

describe("resolveRoot", () => {
  beforeEach(() => localStorage.clear());
  it("prefers the workspace folder", () => {
    setFolder(ref, "~/app");
    expect(resolveRoot(ref, ws, "/p/sel")).toEqual({ path: "~/app", source: "folder" });
  });
  it("falls back to the selected pane cwd, then the first pane cwd", () => {
    expect(resolveRoot(ref, ws, "/p/sel")).toEqual({ path: "/p/sel", source: "pane" });
    expect(resolveRoot(ref, ws, null)).toEqual({ path: "/p/first", source: "pane" });
  });
  it("is null with nothing to go on", () => {
    expect(resolveRoot(ref, undefined, null)).toBeNull();
  });
});

describe("workspaceOfSelection", () => {
  const machines = {
    local: {
      id: "local",
      sessions: [{ name: "default", workspaces: [{ workspace_id: "w1", tabs: [{ panes: [{ pane_id: "p1", cwd: "/a" }] }] }] }],
    },
  } as never;
  it("is the workspace holding the selected pane", () => {
    expect(workspaceOfSelection({ machines, selected: { machine_id: "local", session: "default", pane_id: "p1" } as never })).toEqual(ref);
  });
  it("is null without a selection or when the pane is gone", () => {
    expect(workspaceOfSelection({ machines, selected: null })).toBeNull();
    expect(workspaceOfSelection({ machines, selected: { machine_id: "local", session: "default", pane_id: "gone" } as never })).toBeNull();
  });
});

describe("shownWorkspace", () => {
  const w1 = { machine_id: "local", session: "default", workspace_id: "w1" };
  const w2 = { machine_id: "local", session: "default", workspace_id: "w2" };
  const state = (selected: string, workspaces = ["w1", "w2"]) =>
    ({
      machines: {
        local: {
          id: "local",
          sessions: [{ name: "default", workspaces: workspaces.map((id) => ({ workspace_id: id, tabs: [{ panes: [{ pane_id: `p-${id}`, cwd: "/a" }] }] })) }],
        },
      },
      selected: { machine_id: "local", session: "default", pane_id: selected },
      tabs: {},
      viewed: null,
    }) as never;

  it("is the followed workspace with nothing picked", () => {
    expect(shownWorkspace(state("p-w1"), null)).toEqual(w1);
  });
  it("is the picked workspace while the anchor it was picked on holds", () => {
    const s = state("p-w1");
    expect(shownWorkspace(s, { ws: w2, anchor: panelAnchor(s) })).toEqual(w2);
  });
  it("follows again once the selection moves", () => {
    const picked = { ws: w2, anchor: panelAnchor(state("p-w1")) };
    expect(panelAnchor(state("p-w2"))).not.toBe(picked.anchor);
    expect(shownWorkspace(state("p-w2"), picked)).toEqual(w2);
    expect(shownWorkspace(state("p-w1"), { ws: w2, anchor: "other" })).toEqual(w1);
  });
  it("follows when the picked workspace is gone", () => {
    const s = state("p-w1", ["w1"]);
    expect(shownWorkspace(s, { ws: w2, anchor: panelAnchor(s) })).toEqual(w1);
  });
});
