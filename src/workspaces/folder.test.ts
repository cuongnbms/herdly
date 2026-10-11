import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { folderKey, folderName, getFolder, pruneFolders, setFolder, suggestFolder, useFolder } from "./folder";
import type { PaneView, SessionView, WorkspaceView } from "../lib/types";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };
const pane = (id: string, cwd: string | null): PaneView => ({ pane_id: id, terminal_id: "t" + id, title: id, cwd, agent: null, status: "idle" });
const ws = (id: string, ...cwds: (string | null)[][]): WorkspaceView => ({
  workspace_id: id, label: id, number: 1, status: "idle",
  tabs: cwds.map((cs, i) => ({ tab_id: `${id}:t${i}`, label: String(i), number: i + 1, status: "idle", panes: cs.map((c, j) => pane(`${id}:p${i}${j}`, c)) })),
});
const session = (over: Partial<SessionView>): SessionView => ({ name: "default", running: true, status: "idle", error: null, workspaces: [ws("w1", ["/a"])], ...over });

describe("workspace folder", () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("round-trips, trims, and removes on empty", () => {
    expect(getFolder(ref)).toBeNull();
    setFolder(ref, "  /Users/me/app  ");
    expect(getFolder(ref)).toBe("/Users/me/app");
    expect(localStorage.getItem("herdly:ws-folder:local/default/w1")).toBe("/Users/me/app");
    setFolder(ref, "   ");
    expect(getFolder(ref)).toBeNull();
  });

  it("encodes key parts", () => {
    expect(folderKey({ machine_id: "a/b", session: "s", workspace_id: "w1" })).toBe("herdly:ws-folder:a%2Fb/s/w1");
  });

  it("reads as no folder when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(getFolder(ref)).toBeNull();
  });

  it("suggests the first pane cwd in tab order, skipping panes without one", () => {
    expect(suggestFolder(ws("w1", [null, "/b"], ["/c"]))).toBe("/b");
    expect(suggestFolder(ws("w1", [null]))).toBe("");
    expect(suggestFolder(ws("w1"))).toBe("");
  });

  it("names a folder by its last segment", () => {
    expect(folderName("/Users/me/herdr-app")).toBe("herdr-app");
    expect(folderName("/a/b/")).toBe("b");
    expect(folderName("~")).toBe("~");
    expect(folderName("/")).toBe("/");
  });

  it("prunes folders of workspaces gone from a running session only", () => {
    setFolder(ref, "/a");
    setFolder({ ...ref, workspace_id: "w2" }, "/b");
    setFolder({ ...ref, session: "other", workspace_id: "w2" }, "/c");
    pruneFolders("local", session({ running: false, workspaces: [] }));
    pruneFolders("local", session({ error: { code: "io", message: "x" }, workspaces: [ws("w1", ["/a"])] }));
    pruneFolders("local", session({ workspaces: [] }));
    expect(getFolder({ ...ref, workspace_id: "w2" })).toBe("/b");
    pruneFolders("local", session({}));
    expect(getFolder(ref)).toBe("/a");
    expect(getFolder({ ...ref, workspace_id: "w2" })).toBeNull();
    expect(getFolder({ ...ref, session: "other", workspace_id: "w2" })).toBe("/c");
  });

  it("with a valid previous view prunes only workspaces that left since then", () => {
    setFolder(ref, "/a");
    setFolder({ ...ref, workspace_id: "w2" }, "/b");
    setFolder({ ...ref, workspace_id: "w5" }, "/new");
    const previous = session({ workspaces: [ws("w1", ["/a"]), ws("w2", ["/b"])] });
    pruneFolders("local", session({}), previous);
    expect(getFolder(ref)).toBe("/a");
    expect(getFolder({ ...ref, workspace_id: "w2" })).toBeNull();
    expect(getFolder({ ...ref, workspace_id: "w5" })).toBe("/new");
  });

  it("skips the storage scan when no workspace left since the previous view", () => {
    setFolder({ ...ref, workspace_id: "w5" }, "/new");
    const key = vi.spyOn(Storage.prototype, "key");
    pruneFolders("local", session({}), session({}));
    pruneFolders("local", session({ workspaces: [ws("w1", ["/a"]), ws("w2", ["/b"])] }), session({}));
    expect(key).not.toHaveBeenCalled();
    expect(getFolder({ ...ref, workspace_id: "w5" })).toBe("/new");
    pruneFolders("local", session({}));
    expect(key).toHaveBeenCalled();
    expect(getFolder({ ...ref, workspace_id: "w5" })).toBeNull();
  });

  it("does a full prune when the previous view is not a valid snapshot", () => {
    setFolder({ ...ref, workspace_id: "w5" }, "/new");
    pruneFolders("local", session({}), session({ running: false, workspaces: [] }));
    expect(getFolder({ ...ref, workspace_id: "w5" })).toBeNull();
  });

  it("re-renders subscribers on change", () => {
    const { result } = renderHook(() => useFolder(ref));
    expect(result.current).toBeNull();
    act(() => setFolder(ref, "/x"));
    expect(result.current).toBe("/x");
  });
});
