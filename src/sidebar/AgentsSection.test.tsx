import { fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineView, PaneView } from "../lib/types";
import { loadListHeight, useRecentAgents } from "../settings/recentAgents";
import { useApp } from "../store/app";
import { AgentsSection } from "./AgentsSection";

const pane = (id: string, title: string, status: PaneView["status"], agent: string | null = "claude"): PaneView => ({
  pane_id: id, terminal_id: "t" + id, title, cwd: "/x", agent, status,
});

const machine = (panes: PaneView[]): MachineView => ({
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "herdr-app", number: 1, status: "idle", tabs: [
      { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes } ] } ] }],
});

const titles = () => within(screen.getByRole("region", { name: "Recent agents" })).getAllByRole("button", { name: /^(?!Recent agents)/ })
  .map((b) => b.querySelector(".agents-title")?.textContent);

describe("AgentsSection", () => {
  beforeEach(() =>
    useApp.setState({
      machines: { local: machine([
        pane("a", "Rewrite", "working"), pane("b", "Docs", "done"), pane("c", "Deploy", "idle"),
        pane("d", "Fix login", "blocked"), pane("e", "zsh", "working", null), pane("f", "Seen", "done"),
      ]) },
      order: ["local"], selected: null, viewed: null, expanded: {}, doneSeen: { "local/default/f": true }, statusSince: {},
    }),
  );

  afterEach(() => vi.useRealTimers());

  it("lists Blocked, then unseen Done, then Working agents, leaving out idle panes and shells", () => {
    render(<AgentsSection />);
    expect(titles()).toEqual(["Fix login", "Docs", "Rewrite"]);
    expect(screen.getAllByText("default › herdr-app")).toHaveLength(3);
  });

  it("opens the pane on click", () => {
    render(<AgentsSection />);
    fireEvent.click(screen.getByText("Fix login"));
    expect(useApp.getState().selected).toEqual({ machine_id: "local", session: "default", pane_id: "d" });
  });

  it("collapses", () => {
    render(<AgentsSection />);
    fireEvent.click(screen.getByRole("button", { name: /^Recent agents/ }));
    expect(screen.queryByText("Fix login")).toBeNull();
  });

  it("stays visible with a 0 count when no agent is blocked, done or working", () => {
    useApp.setState({ machines: { local: machine([pane("c", "Deploy", "idle")]) } });
    render(<AgentsSection />);
    const region = screen.getByRole("region", { name: "Recent agents" });
    expect(within(region).getByRole("button", { name: /^Recent agents/ }).textContent).toContain("0");
    expect(screen.queryByText("Deploy")).toBeNull();
  });

  it("keeps an agent that went idle for the set minutes, then drops it", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    useRecentAgents.setState({ idleMinutes: 3 });
    useApp.setState({ statusSince: { "local/default/c": 1_000_000 - 60_000 } });
    render(<AgentsSection />);
    expect(titles()).toEqual(["Fix login", "Docs", "Rewrite", "Deploy"]);
    act(() => vi.advanceTimersByTime(120_000));
    expect(titles()).toEqual(["Fix login", "Docs", "Rewrite"]);
  });

  it("leaves idle agents out when the setting is 0", () => {
    useRecentAgents.setState({ idleMinutes: 0 });
    useApp.setState({ statusSince: { "local/default/c": Date.now() } });
    render(<AgentsSection />);
    expect(titles()).toEqual(["Fix login", "Docs", "Rewrite"]);
  });

  describe("height", () => {
    beforeEach(() => {
      localStorage.clear();
      useRecentAgents.setState({ listHeight: null });
    });
    const handle = () => screen.getByRole("separator", { name: "Resize Recent agents" });
    const list = () => screen.getByRole("region", { name: "Recent agents" }).querySelector("ul")!;

    it("fits its rows until dragged, then keeps the dragged height", () => {
      const { unmount } = render(<AgentsSection />);
      expect(list().style.height).toBe("");
      unmount();
      useRecentAgents.setState({ listHeight: 120 });
      render(<AgentsSection />);
      // Up is taller: the handle sits on the section's top edge.
      fireEvent.pointerDown(handle(), { button: 0, clientY: 300, pointerId: 1 });
      fireEvent.pointerMove(handle(), { clientY: 220, pointerId: 1 });
      fireEvent.pointerUp(handle(), { clientY: 220, pointerId: 1 });
      fireEvent.pointerMove(handle(), { clientY: 500, pointerId: 1 });
      expect(useRecentAgents.getState().listHeight).toBe(200);
      expect(list().style.height).toBe("200px");
      expect(loadListHeight()).toBe(200);
    });

    it("keeps its room with no agents, and double-click fits the rows again", () => {
      useRecentAgents.setState({ listHeight: 160 });
      useApp.setState({ machines: { local: machine([]) } });
      render(<AgentsSection />);
      expect(list().style.height).toBe("160px");
      fireEvent.doubleClick(handle());
      expect(useRecentAgents.getState().listHeight).toBeNull();
      expect(screen.getByRole("region", { name: "Recent agents" }).querySelector("ul")).toBeNull();
    });

    it("steps with the arrow keys within its limits", () => {
      useRecentAgents.setState({ listHeight: 48 });
      render(<AgentsSection />);
      fireEvent.keyDown(handle(), { key: "ArrowUp" });
      expect(useRecentAgents.getState().listHeight).toBe(64);
      fireEvent.keyDown(handle(), { key: "ArrowDown" });
      fireEvent.keyDown(handle(), { key: "ArrowDown" });
      expect(useRecentAgents.getState().listHeight).toBe(40);
    });

    it("hides the handle while collapsed", () => {
      render(<AgentsSection />);
      fireEvent.click(screen.getByRole("button", { name: /^Recent agents/ }));
      expect(screen.queryByRole("separator")).toBeNull();
    });
  });
});
