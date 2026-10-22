import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWeb } from "../store";
import { PaneList } from "./PaneList";

const p = (id: string, status: string, agent: string | null) => ({ pane_id: id, terminal_id: "t", title: "title " + id, cwd: null, agent, status });
const ws = (panes: unknown[], id = "w") => ({ workspace_id: id, label: "herdly", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] });
const machine = (panes: unknown[], error: unknown = null, more: unknown[] = []) => ({
  id: "local", label: "local", kind: "local", state: "connected", error, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [ws(panes)] }, ...more],
});
const card = (title: string) => screen.getByText(title).closest("[data-pane]")!;
const shown = (title: string) => card(title).querySelector("[data-status]")!.getAttribute("data-status");

beforeEach(() => {
  localStorage.clear();
  useWeb.setState({ conn: "open", machines: [machine([p("1", "done", "claude"), p("2", "blocked", "claude"), p("3", "idle", null)])] as never, chats: {} });
});

describe("PaneList", () => {
  it("shows Needs you first with its count and opens a chat-capable pane, marking a done one seen", () => {
    const onOpen = vi.fn();
    render(<PaneList onOpen={onOpen} />);
    const heads = [...document.querySelectorAll("h2")].map((h) => h.firstElementChild?.textContent);
    expect(heads).toEqual(["Needs you", "Done", "Idle"]);
    expect(screen.getByText("Needs you").nextElementSibling?.textContent).toBe("1");
    expect(shown("title 1")).toBe("done");
    fireEvent.click(card("title 1"));
    expect(onOpen).toHaveBeenCalledWith({ session: "default", pane_id: "1" });
    expect(shown("title 1")).toBe("idle");
  });

  it("opens a shell Pane into its Terminal lens, with no Chat hint", () => {
    const onOpen = vi.fn();
    render(<PaneList onOpen={onOpen} />);
    fireEvent.click(screen.getByText("title 3"));
    expect(onOpen).toHaveBeenCalledWith({ session: "default", pane_id: "3" });
    expect(screen.queryByText("Chat lens supports Claude Code and pi only")).toBeNull();
  });

  it("updates a badge from a pane_status frame and clears the seen mark", () => {
    render(<PaneList onOpen={() => {}} />);
    fireEvent.click(screen.getByText("title 1"));
    const status = (s: string, previous: string) => act(() => useWeb.getState().apply({ type: "pane_status", ev: { pane: { machine_id: "local", session: "default", pane_id: "1" }, status: s, previous, title: "title 1" } } as never));
    status("working", "done");
    expect(shown("title 1")).toBe("working");
    status("done", "working");
    expect(shown("title 1")).toBe("done");
  });

  it("shows the machine's error as a banner", () => {
    useWeb.setState({ machines: [{ ...machine([], { code: "herdr_not_found", message: "herdr not found" }), state: "error" }] as never });
    render(<PaneList onOpen={() => {}} />);
    expect(screen.getByText("herdr not found")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it("names each card's Session and Workspace, so two Workspaces sharing a label stay apart", () => {
    const m = machine([p("1", "idle", "claude")]);
    (m.sessions[0] as { workspaces: unknown[] }).workspaces = [ws([p("1", "idle", "claude")], "w1"), ws([p("2", "idle", "claude")], "w2")];
    useWeb.setState({ machines: [m] as never });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<PaneList onOpen={() => {}} />);
      expect(screen.getAllByText("default › herdly")).toHaveLength(2);
      expect(screen.getByText("title 1")).toBeInTheDocument();
      expect(screen.getByText("title 2")).toBeInTheDocument();
      expect(errors.mock.calls.map((c) => String(c[0])).filter((t) => t.includes("same key"))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("lists stopped Sessions and Sessions that failed to load", () => {
    const more = [
      { name: "carex", running: false, status: "unknown", error: null, workspaces: [] },
      { name: "probe", running: false, status: "unknown", error: null, workspaces: [] },
      { name: "tasipay", running: true, status: "unknown", error: { code: "herdr_error", message: "socket gone" }, workspaces: [] },
    ];
    useWeb.setState({ machines: [machine([p("1", "idle", "claude")], null, more)] as never });
    render(<PaneList onOpen={() => {}} />);
    expect(screen.getByText("Stopped: carex, probe")).toBeInTheDocument();
    expect(screen.getByText("tasipay: socket gone")).toBeInTheDocument();
  });

  it("says No Panes only once a machine view has arrived", () => {
    useWeb.setState({ machines: [] });
    const { rerender } = render(<PaneList onOpen={() => {}} />);
    expect(screen.queryByText("No Panes")).toBeNull();
    useWeb.setState({ machines: [machine([])] as never });
    rerender(<PaneList onOpen={() => {}} />);
    expect(screen.getByText("No Panes")).toBeInTheDocument();
  });
});
