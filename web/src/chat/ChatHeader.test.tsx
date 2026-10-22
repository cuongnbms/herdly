import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useWeb } from "../store";
import { ChatHeader } from "./ChatHeader";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), paneKeys: vi.fn() }));

const pane = { session: "s", pane_id: "p1" };
const p = (id: string, title: string, status: string, agent = "claude") => ({ pane_id: id, terminal_id: "t" + id, title, cwd: null, agent, status });
const ws = (id: string, panes: unknown[]) => ({ workspace_id: id, label: id, number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes }] });
const machine = (p2status = "blocked") => ({
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [
    ws("w", [p("p1", "fix login", "working")]),
    ws("api", [p("p3", "codex task", "blocked", "codex"), p("p2", "review", p2status)]),
  ] }],
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.paneKeys).mockReset().mockResolvedValue(undefined as never);
  useWeb.setState({ conn: "open", machines: [machine()] as never, chats: {}, open: null });
});

describe("ChatHeader", () => {
  it("shows the Pane's title, place and status, and goes back", () => {
    const onBack = vi.fn();
    render(<ChatHeader pane={pane} onBack={onBack} />);
    expect(screen.getByText("fix login")).toBeInTheDocument();
    expect(screen.getByText("s › w")).toBeInTheDocument();
    expect(document.querySelector("header [data-status]")).toHaveAttribute("data-status", "working");
    fireEvent.click(screen.getByLabelText("Back"));
    expect(onBack).toHaveBeenCalled();
  });

  // The chip used to count only other blocked Panes with a Chat lens, which hid every blocked
  // shell and codex Pane from attention navigation. Terminal reachability is approved, so the
  // count covers every other blocked Pane and jumps to the first in herdr's order.
  it("counts every other blocked Pane, including one with no Chat lens, and jumps to the first", () => {
    const onSwitch = vi.fn();
    render(<ChatHeader pane={pane} onBack={() => {}} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByLabelText("2 need you"));
    expect(onSwitch).toHaveBeenCalledWith({ session: "s", pane_id: "p3" });
  });

  it("hides the chip when no other Pane is blocked", () => {
    useWeb.setState({ machines: [{ ...machine("idle"), sessions: [{ ...machine("idle").sessions[0], workspaces: [{ ...machine("idle").sessions[0].workspaces[0], tabs: [{ ...machine("idle").sessions[0].workspaces[0].tabs[0], panes: [p("p1", "fix login", "working")] }] }] }] }] as never });
    render(<ChatHeader pane={pane} onBack={() => {}} onSwitch={() => {}} />);
    expect(screen.queryByLabelText(/need you/)).toBeNull();
  });

  it("sends Esc from the menu at once and closes it", async () => {
    render(<ChatHeader pane={pane} onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText("More"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send Esc" }));
    await waitFor(() => expect(api.paneKeys).toHaveBeenCalledWith(pane, ["esc"]));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("asks twice before Ctrl+C, and forgets the first tap after 3 s", async () => {
    vi.useFakeTimers();
    try {
      render(<ChatHeader pane={pane} onBack={() => {}} />);
      fireEvent.click(screen.getByLabelText("More"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Send Ctrl+C" }));
      expect(api.paneKeys).not.toHaveBeenCalled();
      expect(screen.getByRole("menuitem", { name: "Tap again to send Ctrl+C" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(3000));
      fireEvent.click(screen.getByRole("menuitem", { name: "Send Ctrl+C" }));
      expect(api.paneKeys).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Tap again to send Ctrl+C" })));
      expect(api.paneKeys).toHaveBeenCalledWith(pane, ["ctrl+c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows why a key failed, in the menu", async () => {
    vi.mocked(api.paneKeys).mockRejectedValueOnce(new Error("pane gone"));
    render(<ChatHeader pane={pane} onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText("More"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send Esc" }));
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("alert")).toHaveTextContent("pane gone"));
  });

  it("closes the menu on a tap outside it", () => {
    render(<ChatHeader pane={pane} onBack={() => {}} />);
    fireEvent.click(screen.getByLabelText("More"));
    fireEvent.click(document.querySelector("[data-backdrop]")!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the Pane sheet from the title; another Pane switches, the current one only closes", () => {
    const onSwitch = vi.fn();
    render(<ChatHeader pane={pane} onBack={() => {}} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /fix login/ }));
    const sheet = screen.getByRole("dialog", { name: "Panes" });
    expect(within(sheet).getByText("fix login").closest("[data-pane]")).toHaveAttribute("aria-current", "true");
    fireEvent.click(within(sheet).getByText("fix login"));
    expect(onSwitch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /fix login/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Panes" })).getByText("review"));
    expect(onSwitch).toHaveBeenCalledWith({ session: "s", pane_id: "p2" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
