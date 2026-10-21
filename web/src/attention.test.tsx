import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockedPanes, useAttention } from "./attention";
import { useWeb } from "./store";

const pane = (id: string, status: string, agent = "claude") => ({ pane_id: id, terminal_id: "t" + id, title: "t" + id, cwd: null, agent, status });
const machine = (panes: unknown[]) => ({
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] }] }],
});
const status = (id: string, s: string, previous: string) =>
  act(() => useWeb.getState().apply({ type: "pane_status", ev: { pane: { machine_id: "local", session: "s", pane_id: id }, status: s, previous, title: "t" + id } } as never));
function Probe() {
  useAttention();
  return null;
}

let vibrate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
  document.title = "Herdly";
  useWeb.setState({ machines: [], chats: {}, open: null });
});
afterEach(() => {
  delete (navigator as { vibrate?: unknown }).vibrate;
});

describe("attention", () => {
  it("lists every blocked Pane whatever its agent", () => {
    expect(blockedPanes([machine([pane("1", "blocked"), pane("2", "working"), pane("3", "blocked", "codex")])] as never)).toEqual(["s/1", "s/3"]);
  });

  it("counts blocked Panes in the tab title", () => {
    useWeb.setState({ machines: [machine([pane("1", "blocked"), pane("2", "idle")])] as never });
    render(<Probe />);
    expect(document.title).toBe("(1) Herdly");
    status("2", "blocked", "idle");
    expect(document.title).toBe("(2) Herdly");
    status("1", "working", "blocked");
    status("2", "idle", "blocked");
    expect(document.title).toBe("Herdly");
  });

  it("vibrates when a known Pane turns blocked, never for the first view", () => {
    render(<Probe />);
    act(() => useWeb.setState({ machines: [machine([pane("1", "blocked"), pane("2", "working")])] as never }));
    expect(vibrate).not.toHaveBeenCalled();
    status("2", "blocked", "working");
    expect(vibrate).toHaveBeenCalledWith(200);
    status("2", "blocked", "blocked");
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("does nothing when vibration is missing", () => {
    delete (navigator as { vibrate?: unknown }).vibrate;
    useWeb.setState({ machines: [machine([pane("1", "idle")])] as never });
    render(<Probe />);
    expect(() => status("1", "blocked", "idle")).not.toThrow();
    expect(document.title).toBe("(1) Herdly");
  });
});
