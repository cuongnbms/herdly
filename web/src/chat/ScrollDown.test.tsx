import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWeb } from "../store";
import { ChatScreen } from "./ChatScreen";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), chatPage: vi.fn(), panePrompt: vi.fn() }));

const pane = { session: "s", pane_id: "p1" };
const located = { agent: "claude", path: "/t/a.jsonl", ambiguous: false, candidates: [], pending: false };
const machine = { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes: [{ pane_id: "p1", terminal_id: "t1", title: "fix login", cwd: null, agent: "claude", status: "idle" }] }] }] }] };
const sys = (text: string) => ({ kind: "system", text });

function setup() {
  useWeb.setState({ conn: "open", machines: [machine] as never, chats: {} });
  act(() => {
    useWeb.getState().apply({ type: "chat_opened", pane, located });
    useWeb.getState().apply({ type: "chat", pane, event: { type: "reset", items: [sys("a"), sys("b")], total: 2 } as never });
  });
  const { container } = render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
  const el = container.querySelector("[data-transcript]") as HTMLElement;
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });
  return el;
}
const append = (items: unknown[]) => act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "append", items } as never }));
const reset = (items: unknown[], total: number) => act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "reset", items, total } as never }));

beforeEach(() => localStorage.clear());

describe("scroll to bottom", () => {
  it("is hidden at the bottom", () => {
    const el = setup();
    el.scrollTop = 500;
    fireEvent.scroll(el);
    expect(screen.queryByLabelText("Scroll to bottom")).toBeNull();
  });

  it("shows after scrolling up, counts new items, and scrolls down when tapped", () => {
    const el = setup();
    el.scrollTop = 100;
    fireEvent.scroll(el);
    const btn = screen.getByLabelText("Scroll to bottom");
    expect(btn).not.toHaveTextContent("new");
    append([sys("c"), sys("d")]);
    expect(screen.getByLabelText("Scroll to bottom")).toHaveTextContent("2 new");
    fireEvent.click(screen.getByLabelText("Scroll to bottom"));
    expect(el.scrollTop).toBe(1000);
    expect(screen.queryByLabelText("Scroll to bottom")).toBeNull();
  });

  it("restarts the count at a Reset", () => {
    const el = setup();
    el.scrollTop = 100;
    fireEvent.scroll(el);
    append([sys("c")]);
    reset([sys("x")], 1);
    expect(screen.getByLabelText("Scroll to bottom")).not.toHaveTextContent("new");
    append([sys("y")]);
    expect(screen.getByLabelText("Scroll to bottom")).toHaveTextContent("1 new");
  });
});
