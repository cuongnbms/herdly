import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every command answers [], except those whose real answer is not a list.
const { answer } = vi.hoisted(() => ({
  answer: (cmd: string): unknown => (cmd === "files_list_all" ? { paths: [], capped: false, refused: false } : []),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn((cmd: string) => Promise.resolve(answer(cmd))), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: vi.fn().mockResolvedValue(() => {}), destroy: vi.fn(), setTheme: vi.fn(), setBadgeCount: vi.fn().mockResolvedValue(undefined) }),
}));
// xterm needs a real window; the Terminal lens is stood in for by its loading overlay.
vi.mock("./terminal/TerminalLens", async () => {
  const { StartingOverlay } = await import("./terminal/StartingOverlay");
  return { TerminalLens: ({ pane }: { pane: import("./lib/types").PaneRef }) => <StartingOverlay pane={pane} /> };
});

import App from "./App";
import { activeItem, chosenLens, useApp, viewedItems } from "./store/app";
import { paneKey } from "./lib/types";
import { itemKey } from "./store/openItems";
import { useHistory } from "./store/history";
import { useFilesPanel } from "./files/panelStore";
import { useLensSettings } from "./settings/lens";
import { initialSlots, useQuota } from "./quota/store";
import { useResolvedRoots } from "./files/useFilesRoot";

describe("App shell", () => {
  // A Workspace's resolved root outlives a render: one stored by an earlier test would open the
  // Files panel on a Workspace that has no root of its own.
  beforeEach(() => useResolvedRoots.setState(useResolvedRoots.getInitialState(), true));

  it("renders the sidebar and the empty main area", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Machines" })).toBeTruthy();
    expect(screen.getByText("Select a pane")).toBeTruthy();
  });

  it("offers to start the default session when local has none running", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as any).mockResolvedValueOnce([{ id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "unknown",
      sessions: [{ name: "default", running: false, status: "unknown", error: null, workspaces: [] }] }]);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Start default session" })).toBeTruthy();
  });

  it("shows a toast when starting the default session fails", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as any).mockResolvedValueOnce([{ id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "unknown",
      sessions: [{ name: "default", running: false, status: "unknown", error: null, workspaces: [] }] }]);
    render(<App />);
    const start = await screen.findByRole("button", { name: "Start default session" });
    (invoke as any).mockImplementation((cmd: string) => (cmd === "session_start" ? Promise.reject({ code: "timeout", message: "did not start" }) : Promise.resolve(answer(cmd))));
    fireEvent.click(start);
    expect(await screen.findByText("Could not start the default session: did not start")).toBeTruthy();
    (invoke as any).mockImplementation((cmd: string) => Promise.resolve(answer(cmd)));
  });

  it("explains when herdr is missing", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as any).mockResolvedValueOnce([{ id: "local", label: "local", kind: "local", state: "error", error: { code: "herdr_not_found", message: "herdr not found" }, version: null, status: "unknown", sessions: [] }]);
    render(<App />);
    expect(await screen.findByText("herdr is not installed on this Mac")).toBeTruthy();
  });

  it("opens the Agent Dashboard over the main area from the sidebar, keeping the main area mounted", () => {
    useApp.setState({ machines: {}, order: [], selected: null, dashboardOpen: false });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /agent dashboard/i }));
    expect(screen.getByRole("dialog", { name: "Agent Dashboard" })).toBeTruthy();
    expect(screen.getByText("Select a pane")).toBeTruthy();
    // ⌘K searches the dashboard instead of opening the palette.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Agent Dashboard" })).toBeNull();
  });

  it("toggles the Agent Dashboard with ⌘D", () => {
    useApp.setState({ machines: {}, order: [], selected: null, dashboardOpen: false });
    // The mocked invoke answers an earlier test's quota fetch with [], which is no outcome.
    useQuota.setState({ slots: initialSlots() });
    render(<App />);
    fireEvent.keyDown(window, { key: "d", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Agent Dashboard" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "d", metaKey: true });
    expect(screen.queryByRole("dialog", { name: "Agent Dashboard" })).toBeNull();
  });

  it("has no Workspace Files entry in the sidebar", () => {
    render(<App />);
    expect(screen.queryByText("Workspace Files")).toBeNull();
  });

  describe("open files", () => {
    const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
    const p1 = { machine_id: "local", session: "default", pane_id: "p1" };
    beforeEach(async () => {
      localStorage.clear();
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as any).mockImplementation((cmd: string) =>
        Promise.resolve(cmd === "files_list_all" ? { paths: [], capped: false, refused: false } : cmd === "files_read" ? { kind: "text", text: "x", truncated: false, size: 1, mtime: 1 } : cmd === "files_watch" ? 1 : []),
      );
      useApp.setState({
        machines: { local: { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, status: "idle", sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
          { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [{ tab_id: "t1", label: "t", panes: [{ pane_id: "p1", cwd: "/r", agent: "claude", title: "a", status: "idle", terminal_id: "x" }] }] },
        ] }] } } as never,
        order: ["local"],
        selected: null,
        tabs: {}, viewed: null,
        dashboardOpen: false,
        paletteOpen: false,
      });
      useFilesPanel.setState(useFilesPanel.getInitialState(), true);
      useApp.getState().select(p1);
    });

    afterEach(async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as any).mockImplementation((cmd: string) => Promise.resolve(answer(cmd)));
      useApp.setState({ machines: {}, order: [], selected: null, tabs: {}, viewed: null });
    });

    it("shows the active file item in the main area and the lens again when it closes", async () => {
      render(<App />);
      act(() => useApp.getState().openFile(ws, "/r", "a.txt", { pin: false }));
      expect(await screen.findByLabelText("Copy path")).toBeTruthy();
      fireEvent.keyDown(window, { key: "w", metaKey: true });
      await waitFor(() => expect(screen.queryByLabelText("Copy path")).toBeNull());
      expect(useApp.getState().selected?.pane_id).toBe("p1");
      expect(viewedItems(useApp.getState()).active).toBeNull();
      // The selected agent with no active item: its lens, not a blank main area.
      await waitFor(() => expect(document.querySelector(".main .chat-lens, .main .term-lens")).toBeTruthy());
      expect(document.querySelector(".main .header")).toBeTruthy();
    });

    it("keeps the strip above the empty state when no pane is selected", async () => {
      render(<App />);
      act(() => useApp.getState().select(null));
      expect(screen.getByText("Select a pane")).toBeTruthy();
      act(() => useApp.getState().openFile(ws, "/r", "a.txt", { pin: false }));
      expect(await screen.findByLabelText("Copy path")).toBeTruthy();
      expect(document.querySelector(".main")!.textContent).toContain("a.txt");
      act(() => useApp.getState().closeItems(viewedItems(useApp.getState()).active!, "one"));
      expect(await screen.findByText("Select a pane")).toBeTruthy();
    });

    it("⌘E flips the selected agent between the Chat and Terminal lenses", () => {
      render(<App />);
      const lens = () => chosenLens(useApp.getState(), paneKey(p1)) ?? "chat";
      expect(lens()).toBe("chat");
      fireEvent.keyDown(window, { key: "e", metaKey: true });
      expect(lens()).toBe("terminal");
      fireEvent.keyDown(window, { key: "e", metaKey: true });
      expect(lens()).toBe("chat");
      expect(useFilesPanel.getState().focusTick).toBe(0);
    });

    it("⌘P focuses Go to file, but not while the palette is open", () => {
      render(<App />);
      fireEvent.keyDown(window, { key: "p", metaKey: true });
      expect(useFilesPanel.getState().gotoTick).toBe(1);
      act(() => useApp.getState().setPaletteOpen(true));
      fireEvent.keyDown(window, { key: "p", metaKey: true });
      expect(useFilesPanel.getState().gotoTick).toBe(1);
    });

    it("⌘⇧] moves to the next open item", () => {
      render(<App />);
      act(() => {
        useApp.getState().pinItem(itemKey({ kind: "agent", ref: useApp.getState().selected! }));
        useApp.getState().openFile(ws, "/r", "a.txt", { pin: true });
      });
      fireEvent.keyDown(window, { key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
      expect(activeItem(useApp.getState())?.kind).toBe("agent");
      fireEvent.keyDown(window, { key: "[", code: "BracketLeft", metaKey: true, shiftKey: true });
      expect(activeItem(useApp.getState())?.kind).toBe("file");
    });

    it("⌘[ and ⌘] go back and forward through what was shown", () => {
      useHistory.setState({ back: [], forward: [] });
      render(<App />);
      act(() => useApp.getState().openFile(ws, "/r", "a.txt", { pin: true }));
      fireEvent.keyDown(window, { key: "[", code: "BracketLeft", metaKey: true });
      expect(activeItem(useApp.getState())?.kind).toBe("agent");
      fireEvent.keyDown(window, { key: "]", code: "BracketRight", metaKey: true });
      expect(activeItem(useApp.getState())?.kind).toBe("file");
    });

    it("leaves ⌘[ to a focused editor that handled it", () => {
      useHistory.setState({ back: [], forward: [] });
      render(<App />);
      act(() => useApp.getState().openFile(ws, "/r", "a.txt", { pin: true }));
      const ev = new KeyboardEvent("keydown", { key: "[", code: "BracketLeft", metaKey: true, bubbles: true, cancelable: true });
      ev.preventDefault();
      window.dispatchEvent(ev);
      expect(activeItem(useApp.getState())?.kind).toBe("file");
    });
  });

  it("shows the loading overlay, not the empty state, while a new pane's agent starts before herdr reports the pane", () => {
    const pane = { machine_id: "local", session: "default", pane_id: "w1:p7" };
    useApp.setState({ machines: {}, order: [], selected: pane, dashboardOpen: false, starting: { "local/default/w1:p7": { agent: "claude", phase: "shell" } } });
    render(<App />);
    expect(screen.getByText("Waiting for the shell…")).toBeTruthy();
    expect(screen.queryByText("Select a pane")).toBeNull();
    useApp.setState({ selected: null, starting: {} });
  });

  it("keeps the loading overlay up while a new agent starts, even when new agents open on Chat", async () => {
    useLensSettings.setState({ newAgentLens: "chat" });
    const pane = { machine_id: "local", session: "default", pane_id: "w1:p7" };
    useApp.setState({
      machines: { local: { id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle",
        sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
          { workspace_id: "w1", label: "x", number: 1, status: "idle", tabs: [
            { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes: [
              { pane_id: "w1:p7", terminal_id: "t7", title: "sh", cwd: null, agent: null, status: "unknown" } ] } ] } ] }] } },
      order: ["local"], selected: pane, dashboardOpen: false, lens: {}, lensOverride: {},
      starting: { "local/default/w1:p7": { agent: "claude", phase: "agent" } },
    });
    render(<App />);
    expect(await screen.findByText("Starting claude…")).toBeTruthy();
    useApp.setState({ machines: {}, order: [], selected: null, starting: {} });
    useLensSettings.setState({ newAgentLens: "terminal" });
  });

  it("keeps file drops from navigating the webview, leaving sidebar drags alone", () => {
    render(<App />);
    expect(fireEvent.dragOver(document, { dataTransfer: { types: ["Files"] } })).toBe(false);
    expect(fireEvent.drop(document, { dataTransfer: { types: ["Files"] } })).toBe(false);
    expect(fireEvent.dragOver(document, { dataTransfer: { types: ["application/x-herdr-node"] } })).toBe(true);
    expect(fireEvent.drop(document, { dataTransfer: { types: ["application/x-herdr-node"] } })).toBe(true);
  });
});
