import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { MachineView, PaneView } from "../lib/types";
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

const titles = () => within(screen.getByRole("region", { name: "Working agents" })).getAllByRole("button", { name: /^(?!Working agents)/ })
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
    fireEvent.click(screen.getByRole("button", { name: /^Working agents/ }));
    expect(screen.queryByText("Fix login")).toBeNull();
  });

  it("is hidden when no agent is blocked, done or working", () => {
    useApp.setState({ machines: { local: machine([pane("c", "Deploy", "idle")]) } });
    render(<AgentsSection />);
    expect(screen.queryByRole("region", { name: "Working agents" })).toBeNull();
  });
});
