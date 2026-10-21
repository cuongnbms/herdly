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
    useWeb.setState({ open: pane });
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
});
