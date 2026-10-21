import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { useWeb } from "./store";

// Two Panes, alpha (p1) and beta (p2), on one machine.
const pv = (id: string, title: string) => ({ pane_id: id, terminal_id: "t" + id, title, cwd: null, agent: "claude", status: "idle" });
const twoPanes = { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes: [pv("p1", "alpha"), pv("p2", "beta")] }] }] }] };

beforeEach(() => {
  useWeb.setState({ conn: "open", lost: false, machines: [], chats: {}, open: null });
});

describe("App", () => {
  it("opens the sidebar from the list and closes it with Escape, restoring focus", () => {
    render(<App />);
    const menu = screen.getByRole("button", { name: "Open sidebar" });
    menu.focus();
    expect(screen.queryByRole("dialog", { name: "Sessions and Workspaces" })).not.toBeInTheDocument();
    fireEvent.click(menu);
    const drawer = screen.getByRole("dialog", { name: "Sessions and Workspaces" });
    expect(drawer).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Close sidebar" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Sessions and Workspaces" })).not.toBeInTheDocument();
    expect(menu).toHaveFocus();
  });

  it("shows collapsible Sessions and Workspaces, and opens a Pane from its Workspace", () => {
    useWeb.setState({ machines: [twoPanes] as never });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    const session = drawer.getByRole("button", { name: "Session s" });
    const workspace = drawer.getByRole("button", { name: "Workspace w" });
    expect(session).toHaveAttribute("aria-expanded", "true");
    expect(workspace).toHaveAttribute("aria-expanded", "true");
    expect(within(drawer.getByRole("group", { name: "Workspace w" })).getByRole("button", { name: /beta/ })).toBeInTheDocument();
    fireEvent.click(workspace);
    expect(drawer.queryByRole("button", { name: /beta/ })).not.toBeInTheDocument();
    fireEvent.click(workspace);
    fireEvent.click(session);
    expect(drawer.queryByRole("button", { name: "Workspace w" })).not.toBeInTheDocument();
    fireEvent.click(session);
    fireEvent.click(drawer.getByRole("button", { name: /beta/ }));
    expect(screen.queryByRole("dialog", { name: "Sessions and Workspaces" })).not.toBeInTheDocument();
    expect(useWeb.getState().open).toEqual({ session: "s", pane_id: "p2" });
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
  });

  it("opens the sidebar from Chat, marks the current Pane and switches without losing drafts", () => {
    localStorage.clear();
    const a = { session: "s", pane_id: "p1" };
    const b = { session: "s", pane_id: "p2" };
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    useWeb.setState({ machines: [twoPanes] as never, open: a });
    act(() => useWeb.getState().apply({ type: "chat_opened", pane: a, located: { agent: "claude", path: "/t", ambiguous: false, candidates: [], pending: false } }));
    render(<App socket={socket as never} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "sidebar draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    expect(drawer.getByRole("button", { name: /alpha/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(drawer.getByRole("button", { name: /beta/ }));
    expect(screen.queryByRole("dialog", { name: "Sessions and Workspaces" })).not.toBeInTheDocument();
    expect(socket.unsubscribe).toHaveBeenCalledWith(a);
    expect(socket.subscribe).toHaveBeenLastCalledWith(b);
    expect(useWeb.getState().chats["s/p1"]).toBeUndefined();
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Open sidebar" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sessions and Workspaces" })).getByRole("button", { name: /alpha/ }));
    expect(screen.getByLabelText("Message")).toHaveValue("sidebar draft");
  });

  it("traps keyboard focus and disables the background while the sidebar is open", () => {
    useWeb.setState({ machines: [twoPanes] as never });
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = screen.getByRole("dialog", { name: "Sessions and Workspaces" });
    const close = within(drawer).getByRole("button", { name: "Close sidebar" });
    const last = within(drawer).getByRole("button", { name: /beta/ });
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
    expect(container.querySelector(".app-content")).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(close);
    expect(container.querySelector(".app-content")).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("shows an empty state when there are no Sessions", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    expect(drawer.getByText("No Sessions")).toBeInTheDocument();
  });

  it("labels stopped Sessions and prevents opening their stale Panes", () => {
    useWeb.setState({ machines: [{ ...twoPanes, sessions: [{ ...twoPanes.sessions[0], running: false }] }] as never });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    expect(drawer.getByText("Stopped")).toBeInTheDocument();
    expect(drawer.getByRole("button", { name: /alpha/ })).toBeDisabled();
  });

  // Guards for behaviour already provided by the slices above.
  it("dismisses on the scrim and does not resubscribe or clear the current Pane", () => {
    const pane = { session: "s", pane_id: "p1" };
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    useWeb.setState({ machines: [twoPanes] as never, open: pane });
    act(() => useWeb.getState().apply({ type: "chat_opened", pane, located: { agent: "claude", path: "/t", ambiguous: false, candidates: [], pending: false } }));
    const { container } = render(<App socket={socket as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    expect(screen.getByRole("dialog", { name: "Sessions and Workspaces" })).toBeInTheDocument();
    fireEvent.click(container.querySelector("[data-sidebar-scrim]")!);
    expect(screen.queryByRole("dialog", { name: "Sessions and Workspaces" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sessions and Workspaces" })).getByRole("button", { name: /alpha/ }));
    expect(screen.queryByRole("dialog", { name: "Sessions and Workspaces" })).not.toBeInTheDocument();
    expect(socket.unsubscribe).not.toHaveBeenCalled();
    expect(socket.subscribe).toHaveBeenCalledTimes(1);
    expect(useWeb.getState().chats["s/p1"].located?.path).toBe("/t");
  });

  // Replaced assertion: a shell Pane used to be disabled here. Task 7 approves Terminal
  // reachability, so the shell Pane is selectable from the sidebar and only a stopped Session
  // is disabled.
  it("keeps Panes from multiple Tabs under the correct Workspace and keeps shell Panes reachable", () => {
    const session = twoPanes.sessions[0];
    const workspace = session.workspaces[0];
    const tab = workspace.tabs[0];
    useWeb.setState({ machines: [{ ...twoPanes, sessions: [{ ...session, workspaces: [
      { ...workspace, tabs: [tab, { ...tab, tab_id: "t2", panes: [pv("p3", "gamma")] }] },
      { ...workspace, workspace_id: "w2", label: "Other", tabs: [{ ...tab, tab_id: "t3", panes: [{ ...pv("p4", "shell"), agent: null }] }] },
    ] }] }] as never });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    const first = within(drawer.getByRole("group", { name: "Workspace w" }));
    expect(first.getByRole("button", { name: /alpha/ })).toBeInTheDocument();
    expect(first.getByRole("button", { name: /gamma/ })).toBeInTheDocument();
    const other = within(drawer.getByRole("group", { name: "Workspace Other" }));
    expect(other.getByRole("button", { name: /shell/ })).not.toBeDisabled();
    expect(first.queryByRole("button", { name: /shell/ })).not.toBeInTheDocument();
    expect(other.queryByRole("button", { name: /gamma/ })).not.toBeInTheDocument();
  });

  it("recovers keyboard focus when a live update removes the focused Pane", () => {
    useWeb.setState({ machines: [twoPanes] as never });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    drawer.getByRole("button", { name: /beta/ }).focus();
    expect(drawer.getByRole("button", { name: /beta/ })).toHaveFocus();
    act(() => useWeb.setState({ machines: [] }));
    expect(document.body).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(drawer.getByRole("button", { name: "Close sidebar" })).toHaveFocus();
  });

  it("shows the pairing hint only when unpaired", () => {
    const { unmount } = render(<App />);
    expect(screen.queryByText("Not paired")).not.toBeInTheDocument();
    unmount();
    useWeb.setState({ conn: "unpaired" });
    render(<App />);
    expect(screen.getByRole("heading", { name: "Not paired" })).toBeInTheDocument();
    expect(screen.getByText("Open a pairing link from herdly-web pair on the devbox.")).toBeInTheDocument();
  });

  it("shows the reconnecting bar only while down", () => {
    const { rerender } = render(<App />);
    expect(screen.queryByText("Disconnected, reconnecting…")).not.toBeInTheDocument();
    useWeb.setState({ conn: "down" });
    rerender(<App />);
    expect(screen.getByText("Disconnected, reconnecting…")).toBeInTheDocument();
  });

  it("keeps the bar through reconnect attempts and drops it on open, but not on the first connect", () => {
    useWeb.setState({ conn: "connecting", lost: false });
    render(<App />);
    expect(screen.queryByText("Disconnected, reconnecting…")).not.toBeInTheDocument();
    const { setConn } = useWeb.getState();
    act(() => { setConn("open"); setConn("down"); setConn("connecting"); });
    expect(screen.getByText("Disconnected, reconnecting…")).toBeInTheDocument();
    act(() => setConn("open"));
    expect(screen.queryByText("Disconnected, reconnecting…")).not.toBeInTheDocument();
  });

  it("subscribes when a Chat opens, and on back unsubscribes, clears it and returns to the list", () => {
    const pane = { session: "s", pane_id: "p1" };
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    // A claude Pane, so it opens in Chat and PaneScreen takes the subscription.
    useWeb.setState({ machines: [twoPanes] as never, open: pane });
    act(() => useWeb.getState().apply({ type: "chat_opened", pane, located: { agent: "claude", path: "/t", ambiguous: false, candidates: [], pending: false } }));
    render(<App socket={socket as never} />);
    expect(socket.subscribe).toHaveBeenCalledWith(pane);
    fireEvent.click(screen.getByLabelText("Back"));
    expect(socket.unsubscribe).toHaveBeenCalledWith(pane);
    expect(useWeb.getState().open).toBeNull();
    expect(useWeb.getState().chats["s/p1"]).toBeUndefined();
  });

  it("switches Panes from the sheet: unsubscribes and clears the old, subscribes the new", () => {
    const a = { session: "s", pane_id: "p1" };
    const b = { session: "s", pane_id: "p2" };
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    useWeb.setState({ machines: [twoPanes] as never, open: a });
    act(() => useWeb.getState().apply({ type: "chat_opened", pane: a, located: { agent: "claude", path: "/t", ambiguous: false, candidates: [], pending: false } }));
    render(<App socket={socket as never} />);
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Panes" })).getByText("beta"));
    expect(socket.unsubscribe).toHaveBeenCalledWith(a);
    expect(socket.subscribe).toHaveBeenLastCalledWith(b);
    expect(useWeb.getState().open).toEqual(b);
    expect(useWeb.getState().chats["s/p1"]).toBeUndefined();
    expect(screen.getByRole("button", { name: /beta/ })).toBeInTheDocument();
  });

  it("gives each Pane its own Chat screen: a draft typed in one is not in the next", () => {
    localStorage.clear();
    const a = { session: "s", pane_id: "p1" };
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    useWeb.setState({ machines: [twoPanes] as never, open: a });
    render(<App socket={socket as never} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "draft A" } });
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Panes" })).getByText("beta"));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /beta/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Panes" })).getByText("alpha"));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("draft A");
  });

  /** A machine whose second Pane is a shell, so it has no Chat lens. */
  const shellMachine = { ...twoPanes, sessions: [{ ...twoPanes.sessions[0], workspaces: [{ ...twoPanes.sessions[0].workspaces[0], tabs: [{ ...twoPanes.sessions[0].workspaces[0].tabs[0], panes: [pv("p1", "alpha"), { ...pv("p2", "beta"), agent: null }] }] }] }] };

  it("opens a shell Pane from the list into Terminal, without subscribing Chat", () => {
    useWeb.setState({ machines: [shellMachine] as never });
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    render(<App socket={socket as never} />);
    fireEvent.click(screen.getByText("beta"));
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Chat" })).toBeDisabled();
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(socket.subscribe).not.toHaveBeenCalled();
  });

  it("opens a shell Pane from the sidebar into Terminal", () => {
    useWeb.setState({ machines: [shellMachine] as never });
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    render(<App socket={socket as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    fireEvent.click(drawer.getByRole("button", { name: /beta/ }));
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Chat" })).toBeDisabled();
    expect(socket.subscribe).not.toHaveBeenCalled();
  });

  it("can switch to a shell Pane from the Pane sheet, and reach a blocked shell from the needs chip", () => {
    // beta is a blocked shell Pane: only the Terminal lens can show it.
    const blockedShell = { ...shellMachine, sessions: [{ ...shellMachine.sessions[0], workspaces: [{ ...shellMachine.sessions[0].workspaces[0], tabs: [{ ...shellMachine.sessions[0].workspaces[0].tabs[0], panes: [pv("p1", "alpha"), { ...pv("p2", "beta"), agent: null, status: "blocked" }] }] }] }] };
    useWeb.setState({ machines: [blockedShell] as never, open: { session: "s", pane_id: "p1" } });
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    render(<App socket={socket as never} />);
    // The needs chip used to filter by Chat capability, which hid every shell Pane.
    fireEvent.click(screen.getByRole("button", { name: /1 need you/ }));
    expect(useWeb.getState().open).toEqual({ session: "s", pane_id: "p2" });
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    // And the Pane sheet reaches it too.
    fireEvent.click(screen.getByRole("button", { name: /alpha|beta/ }));
    const sheet = within(screen.getByRole("dialog", { name: "Panes" }));
    fireEvent.click(sheet.getByText("alpha"));
    expect(useWeb.getState().open).toEqual({ session: "s", pane_id: "p1" });
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
    // No Chat subscribe for the shell Pane, only for the claude one it came back to.
    expect(socket.subscribe.mock.calls.map((c) => c[0].pane_id)).toEqual(["p1", "p1"]);
  });

  it("unsubscribes Chat when Terminal is chosen and subscribes again on return, keeping the draft", () => {
    localStorage.clear();
    const a = { session: "s", pane_id: "p1" };
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    useWeb.setState({ machines: [twoPanes] as never, open: a });
    act(() => useWeb.getState().apply({ type: "chat_opened", pane: a, located: { agent: "claude", path: "/t", ambiguous: false, candidates: [], pending: false } }));
    render(<App socket={socket as never} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "half a thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(socket.unsubscribe).toHaveBeenCalledWith(a);
    expect(screen.queryByLabelText("Message")).toBeNull();
    // The Chat state is kept, not cleared: only the live feed stops.
    expect(useWeb.getState().chats["s/p1"].located?.path).toBe("/t");
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(socket.subscribe).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Message")).toHaveValue("half a thought");
  });

  it("remembers the chosen Lens across a remount, per Pane", () => {
    localStorage.clear();
    const a = { session: "s", pane_id: "p1" };
    const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
    useWeb.setState({ machines: [twoPanes] as never, open: a });
    const first = render(<App socket={socket as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    act(() => first.unmount());
    useWeb.setState({ open: a });
    render(<App socket={socket as never} />);
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    // Another Pane has its own preference and still opens on Chat.
    act(() => useWeb.getState().openChat({ session: "s", pane_id: "p2" }));
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
  });

  it("goes back from Terminal to the list and keeps one header at a time", () => {
    localStorage.clear();
    const a = { session: "s", pane_id: "p1" };
    useWeb.setState({ machines: [twoPanes] as never, open: a });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(document.querySelectorAll("header.chat-header")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Back"));
    expect(useWeb.getState().open).toBeNull();
    expect(screen.getByRole("heading", { name: "Herdly" })).toBeInTheDocument();
  });

  it("closes the Terminal and shows the Pane as unavailable when its Session stops", () => {
    localStorage.clear();
    const a = { session: "s", pane_id: "p1" };
    useWeb.setState({ machines: [twoPanes] as never, open: a });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByTestId("terminal-host")).toBeInTheDocument();
    act(() => useWeb.setState({ machines: [{ ...twoPanes, sessions: [{ ...twoPanes.sessions[0], running: false }] }] as never }));
    expect(screen.getByRole("alert")).toHaveTextContent("This Session is stopped");
    // The attempt is gone: nothing is left that could keep writing to the old terminal.
    expect(document.querySelectorAll(".xterm")).toHaveLength(0);
  });

  it("shows a Pane that disappeared as unavailable instead of attaching to it", () => {
    localStorage.clear();
    const a = { session: "s", pane_id: "p1" };
    useWeb.setState({ machines: [twoPanes] as never, open: a });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    act(() => useWeb.setState({ machines: [{ ...twoPanes, sessions: [{ ...twoPanes.sessions[0], workspaces: [] }] }] as never }));
    expect(screen.getByRole("alert")).toHaveTextContent("This Pane is no longer here");
    expect(document.querySelectorAll(".xterm")).toHaveLength(0);
  });
});
