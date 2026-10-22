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
  it("handles Android Back from a Pane like the in-app Back button", () => {
    const pane = { session: "s", pane_id: "p1" };
    useWeb.setState({ machines: [twoPanes] as never, open: pane });
    useWeb.getState().apply({ type: "chat_opened", pane, located: { agent: "claude", path: "/t", ambiguous: false, candidates: [], pending: false } });
    render(<App />);
    expect(screen.getByLabelText("Back")).toBeInTheDocument();
    expect(useWeb.getState().chats["s/p1"]).toBeDefined();

    const back = new Event("herdly:android-back", { cancelable: true });
    act(() => { window.dispatchEvent(back); });

    expect(screen.getByRole("heading", { name: "Herdly" })).toBeInTheDocument();
    expect(useWeb.getState().open).toBeNull();
    expect(useWeb.getState().chats["s/p1"]).toBeUndefined();
    expect(back.defaultPrevented).toBe(true);
  });

  it("leaves Android Back unhandled at the root, when unpaired, and after unmount", () => {
    const view = render(<App />);
    const rootBack = new Event("herdly:android-back", { cancelable: true });
    act(() => { window.dispatchEvent(rootBack); });
    expect(rootBack.defaultPrevented).toBe(false);
    expect(screen.getByRole("heading", { name: "Herdly" })).toBeInTheDocument();

    act(() => useWeb.setState({ conn: "unpaired", open: { session: "s", pane_id: "p1" } }));
    const unpairedBack = new Event("herdly:android-back", { cancelable: true });
    act(() => { window.dispatchEvent(unpairedBack); });
    expect(unpairedBack.defaultPrevented).toBe(false);
    expect(screen.getByRole("heading", { name: "Not paired" })).toBeInTheDocument();

    act(() => useWeb.setState({ conn: "open", machines: [twoPanes] as never }));
    expect(screen.getByLabelText("Back")).toBeInTheDocument();
    view.unmount();
    const afterUnmount = new Event("herdly:android-back", { cancelable: true });
    window.dispatchEvent(afterUnmount);
    expect(afterUnmount.defaultPrevented).toBe(false);
    expect(useWeb.getState().open).toEqual({ session: "s", pane_id: "p1" });
  });

  it("returns from Terminal on Android Back and handles a newly opened Pane", () => {
    localStorage.clear();
    useWeb.setState({ machines: [twoPanes] as never, open: { session: "s", pane_id: "p1" } });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByTestId("terminal-host")).toBeInTheDocument();
    act(() => { window.dispatchEvent(new Event("herdly:android-back", { cancelable: true })); });
    expect(screen.getByRole("heading", { name: "Herdly" })).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-host")).not.toBeInTheDocument();

    act(() => useWeb.getState().openChat({ session: "s", pane_id: "p2" }));
    expect(screen.getByLabelText("Back")).toBeInTheDocument();
    const nextBack = new Event("herdly:android-back", { cancelable: true });
    act(() => { window.dispatchEvent(nextBack); });
    expect(nextBack.defaultPrevented).toBe(true);
    expect(screen.getByRole("heading", { name: "Herdly" })).toBeInTheDocument();
    expect(useWeb.getState().open).toBeNull();
  });

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

  it("selects one Session, keeps its Workspaces collapsible, and opens a Pane", () => {
    const other = { ...twoPanes.sessions[0], name: "other", workspaces: [{ ...twoPanes.sessions[0].workspaces[0], label: "Other", tabs: [{ ...twoPanes.sessions[0].workspaces[0].tabs[0], panes: [pv("p3", "gamma")] }] }] };
    useWeb.setState({ machines: [{ ...twoPanes, sessions: [...twoPanes.sessions, other] }] as never });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    const session = drawer.getByRole("combobox", { name: "Session" });
    expect(session).toHaveTextContent("s");
    expect(drawer.queryByRole("group", { name: "Workspace Other" })).not.toBeInTheDocument();
    fireEvent.click(session);
    fireEvent.click(drawer.getByRole("option", { name: "other" }));
    expect(drawer.getByRole("group", { name: "Workspace Other" })).toBeInTheDocument();
    expect(drawer.getByRole("button", { name: /gamma/ })).toBeInTheDocument();
    expect(drawer.queryByRole("group", { name: "Workspace w" })).not.toBeInTheDocument();
    expect(useWeb.getState().open).toBeNull();
    fireEvent.click(session);
    fireEvent.click(drawer.getByRole("option", { name: "s" }));
    const workspace = drawer.getByRole("button", { name: "Workspace w" });
    expect(workspace).toHaveAttribute("aria-expanded", "true");
    expect(within(drawer.getByRole("group", { name: "Workspace w" })).getByRole("button", { name: /beta/ })).toBeInTheDocument();
    fireEvent.click(workspace);
    expect(drawer.queryByRole("button", { name: /beta/ })).not.toBeInTheDocument();
    fireEvent.click(workspace);
    fireEvent.click(drawer.getByRole("button", { name: /beta/ }));
    expect(screen.queryByRole("dialog", { name: "Sessions and Workspaces" })).not.toBeInTheDocument();
    expect(useWeb.getState().open).toEqual({ session: "s", pane_id: "p2" });
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
  });

  it("starts with only the current Workspace expanded and remembers toggles after reopening", () => {
    const session = twoPanes.sessions[0];
    const workspace = session.workspaces[0];
    const other = { ...workspace, workspace_id: "w2", label: "Other", tabs: [{ ...workspace.tabs[0], panes: [pv("p3", "gamma")] }] };
    useWeb.setState({ machines: [{ ...twoPanes, sessions: [{ ...session, workspaces: [workspace, other] }] }] as never, open: { session: "s", pane_id: "p3" } });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    let drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    expect(drawer.getByRole("button", { name: "Workspace w" })).toHaveAttribute("aria-expanded", "false");
    expect(drawer.getByRole("button", { name: "Workspace Other" })).toHaveAttribute("aria-expanded", "true");
    expect(drawer.getByRole("button", { name: /gamma/ })).toHaveAttribute("aria-current", "true");
    expect(within(drawer.getByRole("group", { name: "Workspace w" })).getByText("2 panes")).toBeInTheDocument();
    fireEvent.click(drawer.getByRole("button", { name: "Workspace w" }));
    expect(drawer.getByRole("button", { name: /alpha/ })).toBeInTheDocument();
    fireEvent.click(drawer.getByRole("button", { name: "Workspace Other" }));
    fireEvent.click(drawer.getByRole("button", { name: "Close sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    expect(drawer.getByRole("button", { name: "Workspace w" })).toHaveAttribute("aria-expanded", "true");
    expect(drawer.getByRole("button", { name: /alpha/ })).toBeInTheDocument();
    expect(drawer.getByRole("button", { name: "Workspace Other" })).toHaveAttribute("aria-expanded", "false");
    expect(drawer.queryByRole("button", { name: /gamma/ })).not.toBeInTheDocument();
  });

  it("starts at the current Session, remembers a different selection, and recovers if it disappears", () => {
    const other = { ...twoPanes.sessions[0], name: "other", workspaces: [{ ...twoPanes.sessions[0].workspaces[0], label: "Other", tabs: [{ ...twoPanes.sessions[0].workspaces[0].tabs[0], panes: [pv("p3", "gamma")] }] }] };
    const current = { session: "other", pane_id: "p3" };
    useWeb.setState({ machines: [{ ...twoPanes, sessions: [...twoPanes.sessions, other] }] as never, open: current });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    let drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    expect(drawer.getByRole("combobox", { name: "Session" })).toHaveTextContent("other");
    expect(drawer.getByRole("button", { name: /gamma/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(drawer.getByRole("button", { name: "Workspace Other" }));
    fireEvent.click(drawer.getByRole("combobox", { name: "Session" }));
    fireEvent.click(drawer.getByRole("option", { name: "s" }));
    // Same workspace_id in another Session must not inherit the collapsed state.
    expect(drawer.getByRole("button", { name: "Workspace w" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(drawer.getByRole("button", { name: "Close sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    expect(drawer.getByRole("combobox", { name: "Session" })).toHaveTextContent("s");
    expect(useWeb.getState().open).toEqual(current);
    act(() => useWeb.setState({ machines: [{ ...twoPanes, sessions: [other] }] as never }));
    expect(drawer.getByRole("combobox", { name: "Session" })).toHaveTextContent("other");
    expect(drawer.getByRole("button", { name: "Workspace Other" })).toHaveAttribute("aria-expanded", "false");
    act(() => useWeb.setState({ machines: [] }));
    expect(drawer.getByText("No Sessions")).toBeInTheDocument();
    expect(drawer.queryByRole("combobox", { name: "Session" })).not.toBeInTheDocument();
  });

  it("navigates Sessions by keyboard and dismisses the dropdown before the sidebar", () => {
    const other = { ...twoPanes.sessions[0], name: "other" };
    useWeb.setState({ machines: [{ ...twoPanes, sessions: [...twoPanes.sessions, other] }] as never });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const selector = screen.getByRole("combobox", { name: "Session" });
    selector.focus();
    fireEvent.keyDown(selector, { key: "ArrowDown" });
    expect(screen.getByRole("listbox", { name: "Session" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "s" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(selector, { key: "End" });
    expect(selector).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "other" }).id);
    fireEvent.keyDown(selector, { key: "Enter" });
    expect(selector).toHaveTextContent("other");
    expect(selector).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(selector);
    fireEvent.keyDown(selector, { key: "Escape" });
    expect(selector).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("dialog", { name: "Sessions and Workspaces" })).toBeInTheDocument();
    fireEvent.click(selector);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("heading", { name: "Sessions and Workspaces" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(selector);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(selector, { key: "Tab" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(selector, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Sessions and Workspaces" })).not.toBeInTheDocument();
  });

  it("includes the Session selector in the focus trap when the Session has no Workspaces", () => {
    useWeb.setState({ machines: [{ ...twoPanes, sessions: [{ ...twoPanes.sessions[0], workspaces: [] }] }] as never });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    const selector = drawer.getByRole("combobox", { name: "Session" });
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(selector).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(drawer.getByRole("button", { name: "Close sidebar" })).toHaveFocus();
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

  it("exposes readable status and the full Pane title in the compact sidebar", () => {
    useWeb.setState({ machines: [twoPanes] as never });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    const drawer = within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
    const pane = within(drawer.getByRole("button", { name: /alpha/ }));
    expect(pane.getByText("idle")).toHaveAttribute("title", "Status: idle");
    expect(pane.getByText("alpha")).toHaveAttribute("title", "alpha");
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
    // Inactive Workspaces now start collapsed; their Panes remain reachable on expand.
    fireEvent.click(drawer.getByRole("button", { name: "Workspace Other" }));
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

  it.each([1000, 1008, 1009])("recovers terminal close %i manually through App without changing pairing", async (code) => {
    const wires: BrowserWire[] = [];
    class BrowserWire {
      binaryType = "blob";
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
      onclose: ((e: { code: number }) => void) | null = null;
      onerror: (() => void) | null = null;
      sent: (string | ArrayBufferView)[] = [];
      constructor(readonly url: string) { wires.push(this); }
      send(data: string | ArrayBufferView) { this.sent.push(data); }
      close() {}
    }
    vi.stubGlobal("WebSocket", BrowserWire);
    localStorage.clear();
    useWeb.setState({ conn: "open", authLost: false, machines: [shellMachine] as never, open: { session: "s", pane_id: "p2" } });
    try {
      const view = render(<App />);
      expect(wires[0].url).toBe(`ws://${location.host}/ws/terminal`);
      act(() => {
        wires[0].onopen!();
        wires[0].onmessage!({ data: JSON.stringify({ type: "attached" }) });
        wires[0].onmessage!({ data: new TextEncoder().encode("retained screen").buffer });
      });
      await act(async () => { await new Promise((done) => setTimeout(done, 40)); });
      const old = document.querySelector(".xterm");
      const rendered = old!.querySelector(".xterm-rows")!.textContent;
      expect(rendered).toContain("retained screen");
      act(() => wires[0].onclose!({ code }));
      expect(screen.getByRole("status")).toHaveTextContent(`Connection closed (code ${code}). Reattach to try again.`);
      expect(document.querySelector(".xterm")).toBe(old);
      expect(old!.querySelector(".xterm-rows")!.textContent).toBe(rendered);
      expect(screen.queryByText("Disconnected, reconnecting…")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Esc" })).toBeDisabled();
      expect(useWeb.getState().conn).toBe("open");
      expect(useWeb.getState().authLost).toBe(false);
      const reattach = screen.getByRole("button", { name: "Reattach" });
      reattach.focus();
      expect(reattach).toHaveFocus();
      fireEvent.click(reattach);
      expect(wires).toHaveLength(2);
      expect(document.querySelector(".xterm")).not.toBe(old);
      expect(old!.isConnected).toBe(false);
      expect(document.querySelector(".xterm-rows")!.textContent).not.toContain("retained screen");
      expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
      act(() => wires[1].onopen!());
      expect(JSON.parse(wires[1].sent[0] as string)).toMatchObject({ type: "open", pane: { session: "s", pane_id: "p2" }, takeover: false });
      act(() => wires[1].onmessage!({ data: JSON.stringify({ type: "attached" }) }));
      expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Esc" }));
      expect([...new Uint8Array((wires[1].sent[1] as ArrayBufferView).buffer)]).toEqual([27]);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      view.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
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
