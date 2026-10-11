import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ quotaFetch: vi.fn().mockResolvedValue({ kind: "notSignedIn" }) }));
import type { MachineView, PaneView } from "../lib/types";
import { useApp } from "../store/app";
import { AgentDashboard, DashboardEntry } from "./AgentDashboard";

const pane = (id: string, title: string, status: PaneView["status"], agent = "claude"): PaneView => ({
  pane_id: id, terminal_id: "t" + id, title, cwd: "/x", agent, status,
});

const machine = (id: string, label: string, panes: PaneView[]): MachineView => ({
  id, label, kind: id === "local" ? "local" : "ssh", state: "connected", error: null, version: "0.9.3", status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "herdr-app", number: 1, status: "idle", tabs: [
      { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes } ] } ] }],
});

const local = machine("local", "local", [pane("a", "Fix login", "blocked"), pane("b", "Rewrite parser", "working", "pi"), pane("c", "Docs", "done")]);
const box = machine("box", "devtuf", [pane("d", "Deploy", "idle")]);

const column = (name: RegExp) => screen.getByRole("region", { name });

describe("AgentDashboard", () => {
  beforeEach(() =>
    useApp.setState({ machines: { local, box }, order: ["local", "box"], selected: null, viewed: null, doneSeen: {}, dashboardOpen: true }),
  );

  it("keeps the Quota column when search hides every agent", () => {
    render(<AgentDashboard />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "zzz-no-match" } });
    expect(screen.getByRole("region", { name: "Quota" })).toBeTruthy();
    expect(within(column(/blocked/i)).getByText("None")).toBeTruthy();
  });

  it("keeps the Quota column when filters hide every agent", () => {
    render(<AgentDashboard />);
    fireEvent.click(screen.getByRole("button", { name: /filter/i }));
    // Only devtuf machines AND only pi agents: pi runs on local only, so nothing matches.
    fireEvent.click(screen.getByRole("checkbox", { name: /devtuf/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^pi/ }));
    expect(screen.getByText("0 of 4 shown")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Quota" })).toBeTruthy();
    expect(within(column(/blocked/i)).getByText("None")).toBeTruthy();
  });

  it("sorts agents into Blocked, Working, Done and Idle with counts", () => {
    render(<AgentDashboard />);
    expect(screen.getByText("4 total")).toBeTruthy();
    expect(within(column(/blocked/i)).getByText("Fix login")).toBeTruthy();
    expect(within(column(/working/i)).getByText("Rewrite parser")).toBeTruthy();
    expect(within(column(/done/i)).getByText("Docs")).toBeTruthy();
    expect(within(column(/idle/i)).getByText("Deploy")).toBeTruthy();
    expect(within(column(/idle/i)).getByText("devtuf")).toBeTruthy();
    expect(within(column(/working/i)).getByText("1")).toBeTruthy();
  });

  it("shows a seen Done agent as Idle", () => {
    useApp.setState({ doneSeen: { "local/default/c": true } });
    render(<AgentDashboard />);
    expect(within(column(/idle/i)).getByText("Docs")).toBeTruthy();
    expect(within(column(/done/i)).getByText("None")).toBeTruthy();
  });

  it("filters by search text", () => {
    render(<AgentDashboard />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "parser" } });
    expect(screen.getByText("Rewrite parser")).toBeTruthy();
    expect(screen.queryByText("Fix login")).toBeNull();
    expect(screen.getByText("1 of 4 shown")).toBeTruthy();
  });

  it("filters by machine from the Filter menu", () => {
    render(<AgentDashboard />);
    fireEvent.click(screen.getByRole("button", { name: /filter/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /devtuf/ }));
    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.queryByText("Fix login")).toBeNull();
  });

  it("opens an agent on click and closes", () => {
    render(<AgentDashboard />);
    fireEvent.click(screen.getByText("Docs"));
    expect(useApp.getState().selected).toEqual({ machine_id: "local", session: "default", pane_id: "c" });
    expect(useApp.getState().dashboardOpen).toBe(false);
    expect(useApp.getState().doneSeen).toEqual({ "local/default/c": true });
  });

  it("closes on Escape and on the close button", () => {
    render(<AgentDashboard />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useApp.getState().dashboardOpen).toBe(false);
    act(() => useApp.setState({ dashboardOpen: true }));
    fireEvent.click(screen.getByRole("button", { name: /close dashboard/i }));
    expect(useApp.getState().dashboardOpen).toBe(false);
  });

  it("Escape is taken by the dashboard, so a file behind it (listening since before) does not act on it", () => {
    const seen: boolean[] = [];
    const behind = (e: KeyboardEvent) => seen.push(e.defaultPrevented);
    window.addEventListener("keydown", behind);
    try {
      render(<AgentDashboard />);
      fireEvent.click(screen.getByRole("button", { name: /filter/i }));
      fireEvent.keyDown(document.body, { key: "Escape" });
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(seen).toEqual([true, true]);
      expect(useApp.getState().dashboardOpen).toBe(false);
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  it("Escape closes the Filter menu before the dashboard", () => {
    render(<AgentDashboard />);
    fireEvent.click(screen.getByRole("button", { name: /filter/i }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("checkbox", { name: /devtuf/ })).toBeNull();
    expect(useApp.getState().dashboardOpen).toBe(true);
  });

  it("focuses search on ⌘K", () => {
    render(<AgentDashboard />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/search/i));
  });
});

describe("DashboardEntry", () => {
  beforeEach(() =>
    useApp.setState({ machines: { local, box }, order: ["local", "box"], selected: null, viewed: null, doneSeen: {}, dashboardOpen: false }),
  );

  it("shows per-bucket counts, hiding empty ones, and toggles the dashboard", () => {
    render(<DashboardEntry />);
    const btn = screen.getByRole("button", { name: /agent dashboard/i });
    expect(within(btn).getByLabelText("1 blocked")).toBeTruthy();
    expect(within(btn).getByLabelText("1 working")).toBeTruthy();
    expect(within(btn).getByLabelText("1 done")).toBeTruthy();
    act(() => useApp.setState({ doneSeen: { "local/default/c": true } }));
    expect(within(btn).queryByLabelText(/done/)).toBeNull();
    fireEvent.click(btn);
    expect(useApp.getState().dashboardOpen).toBe(true);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("highlights the row for a blocked agent first, then for an unseen done one", () => {
    render(<DashboardEntry />);
    const btn = screen.getByRole("button", { name: /agent dashboard/i });
    expect(btn.classList.contains("has-blocked")).toBe(true);
    expect(btn.classList.contains("has-done")).toBe(false);
    const doneOnly = machine("local", "local", [pane("a", "Fix login", "idle"), pane("c", "Docs", "done")]);
    act(() => useApp.setState({ machines: { local: doneOnly, box } }));
    expect(btn.classList.contains("has-blocked")).toBe(false);
    expect(btn.classList.contains("has-done")).toBe(true);
    act(() => useApp.setState({ doneSeen: { "local/default/c": true } }));
    expect(btn.classList.contains("has-done")).toBe(false);
  });
});
