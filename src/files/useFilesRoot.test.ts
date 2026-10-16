import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store/app";
import { setFolder } from "../workspaces/folder";
import { useFilesRoot, useResolvedRoots } from "./useFilesRoot";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };
const machines = (cwd1: string, cwd2: string) =>
  ({ local: { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, status: "idle", sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [{ tab_id: "t1", label: "t", panes: [{ pane_id: "p1", cwd: cwd1 }, { pane_id: "p2", cwd: cwd2 }] }] },
  ] }] } }) as never;

describe("useFilesRoot", () => {
  beforeEach(() => {
    localStorage.clear();
    useResolvedRoots.setState(useResolvedRoots.getInitialState(), true);
    useApp.setState({ machines: machines("/r", "/r/sub"), selected: { machine_id: "local", session: "default", pane_id: "p1" }, tabs: {}, viewed: null });
  });

  it("gives a second caller the root the first one resolved, though the selection moved", () => {
    const first = renderHook(() => useFilesRoot(ref));
    expect(first.result.current).toEqual({ path: "/r", source: "pane" });
    act(() => useApp.setState({ selected: { machine_id: "local", session: "default", pane_id: "p2" } }));
    const second = renderHook(() => useFilesRoot(ref));
    expect(second.result.current).toEqual({ path: "/r", source: "pane" });
  });

  it("resolves again when the Workspace folder is set", () => {
    const { result } = renderHook(() => useFilesRoot(ref));
    act(() => setFolder(ref, "/elsewhere"));
    expect(result.current).toEqual({ path: "/elsewhere", source: "folder" });
  });

  it("resolves again for a remounted Workspace whose folder was set while it was away", () => {
    const first = renderHook(() => useFilesRoot(ref));
    expect(first.result.current).toEqual({ path: "/r", source: "pane" });
    first.unmount();
    act(() => setFolder(ref, "/elsewhere"));
    const second = renderHook(() => useFilesRoot(ref));
    expect(second.result.current).toEqual({ path: "/elsewhere", source: "folder" });
  });

  it("follows the root of an active diff item of this Workspace", () => {
    const { result } = renderHook(() => useFilesRoot(ref));
    act(() => useApp.getState().openDiff({ kind: "diff", ws: ref, root: "/other", repo: "/other", prefix: "", path: "a.txt", origPath: null, scope: { kind: "worktree" }, untracked: false }, { pin: false }));
    expect(result.current?.path).toBe("/other");
  });
});
