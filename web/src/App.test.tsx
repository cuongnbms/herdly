import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { useWeb } from "./store";

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
});
