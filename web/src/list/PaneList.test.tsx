import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWeb } from "../store";
import { PaneList } from "./PaneList";

const p = (id: string, status: string, agent: string | null) => ({ pane_id: id, terminal_id: "t", title: "title " + id, cwd: null, agent, status });
const machine = (panes: unknown[], error: unknown = null) => ({
  id: "local", label: "local", kind: "local", state: "connected", error, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "herdly", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] }] }],
});

beforeEach(() => {
  localStorage.clear();
  useWeb.setState({ conn: "open", machines: [machine([p("1", "done", "claude"), p("2", "blocked", "claude"), p("3", "idle", null)])] as never, chats: {} });
});

describe("PaneList", () => {
  it("shows waiting first and opens a chat-capable pane, marking a done one seen", () => {
    const onOpen = vi.fn();
    render(<PaneList onOpen={onOpen} />);
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    const done = screen.getByText("title 1").closest("[data-pane]")!;
    expect(done.querySelector("[data-status]")!.getAttribute("data-status")).toBe("done");
    fireEvent.click(done);
    expect(onOpen).toHaveBeenCalledWith({ session: "default", pane_id: "1" });
    expect(screen.getByText("title 1").closest("[data-pane]")!.querySelector("[data-status]")!.getAttribute("data-status")).toBe("idle");
  });

  it("explains panes without a chat lens", () => {
    const onOpen = vi.fn();
    render(<PaneList onOpen={onOpen} />);
    fireEvent.click(screen.getByText("title 3"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText("Chat lens supports Claude Code and pi only")).toBeInTheDocument();
  });

  it("updates a badge from a pane_status frame and clears the seen mark", () => {
    render(<PaneList onOpen={() => {}} />);
    fireEvent.click(screen.getByText("title 1"));
    const status = (s: string, previous: string) => act(() => useWeb.getState().apply({ type: "pane_status", ev: { pane: { machine_id: "local", session: "default", pane_id: "1" }, status: s, previous, title: "title 1" } } as never));
    status("working", "done");
    expect(screen.getByText("title 1").closest("[data-pane]")!.querySelector("[data-status]")!.getAttribute("data-status")).toBe("working");
    status("done", "working");
    expect(screen.getByText("title 1").closest("[data-pane]")!.querySelector("[data-status]")!.getAttribute("data-status")).toBe("done");
  });

  it("shows the machine's error as a banner", () => {
    useWeb.setState({ machines: [{ ...machine([], { code: "herdr_not_found", message: "herdr not found" }), state: "error" }] as never });
    render(<PaneList onOpen={() => {}} />);
    expect(screen.getByText("herdr not found")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
  });
});
