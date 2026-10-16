import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFilesBus } from "../files/bus";
import { filesKey } from "../files/store";
import { useApp } from "../store/app";
import { useGitRefresh } from "./refresh";
import { useGit } from "./store";

const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
const withStatus = (status: string) =>
  ({ local: { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, status: "idle", sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [{ tab_id: "t1", label: "t", panes: [{ pane_id: "p1", cwd: "/r", agent: "claude", status }] }] },
  ] }] } }) as never;

describe("useGitRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useFilesBus.setState(useFilesBus.getInitialState(), true);
    useGit.setState(useGit.getInitialState(), true);
    useApp.setState({ machines: withStatus("working") });
  });
  afterEach(() => vi.useRealTimers());

  const hook = () => renderHook(() => useGitRefresh(ws, "/r", "local|/r"));

  it("ticks once, 300 ms after a burst of watch batches for its root", () => {
    const { result } = hook();
    const t0 = result.current;
    act(() => {
      useFilesBus.getState().publish(filesKey(ws, "/r"), [{ path: "a", isDir: false, removed: false }]);
      useFilesBus.getState().publish(filesKey(ws, "/r"), [{ path: "b", isDir: false, removed: false }]);
      useFilesBus.getState().publish(filesKey(ws, "/elsewhere"), [{ path: "c", isDir: false, removed: false }]);
    });
    expect(result.current).toBe(t0);
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe(t0 + 1);
  });

  it("ticks when an Agent of the Workspace stops working, on window focus, and on ⟳", () => {
    const { result } = hook();
    const t0 = result.current;
    act(() => useApp.setState({ machines: withStatus("done") }));
    expect(result.current).toBe(t0 + 1);
    act(() => useApp.setState({ machines: withStatus("working") }));
    expect(result.current).toBe(t0 + 1);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(result.current).toBe(t0 + 2);
    act(() => useGit.getState().bump("local|/r"));
    expect(result.current).toBe(t0 + 3);
  });

  it("does not throw when the Workspace or Machine is missing", () => {
    useApp.setState({ machines: {} });
    expect(() => hook()).not.toThrow();
  });
});
