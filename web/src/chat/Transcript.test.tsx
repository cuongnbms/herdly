import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWeb } from "../store";
import { ChatScreen } from "./ChatScreen";
import { copyText } from "../ui/copy";
import { Markdown } from "./Markdown";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), chatPage: vi.fn(), panePrompt: vi.fn(), paneRead: vi.fn(() => new Promise(() => {})) }));
vi.mock("../ui/copy", () => ({ copyText: vi.fn(() => true) }));
vi.mock("./Markdown", async (orig) => {
  const real = await orig<typeof import("./Markdown")>();
  return { Markdown: vi.fn(real.Markdown) };
});

const pane = { session: "s", pane_id: "p1" };
const located = { agent: "claude", path: "/t/a.jsonl", ambiguous: false, candidates: [], pending: false };
const machine = (status: string) => ({ id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes: [{ pane_id: "p1", terminal_id: "t1", title: "fix login", cwd: null, agent: "claude", status }] }] }] }] });
const at = (s: number) => `2026-10-21T10:00:0${s}Z`;
const turn = [
  { kind: "user", text: "fix it", ts: at(0) },
  { kind: "assistant_text", markdown: "Looking", ts: at(1) },
  { kind: "tool_call", id: "c1", name: "Bash", input_summary: "pnpm test", input: {}, ts: at(2) },
  { kind: "tool_result", call_id: "c1", output: "3 passed", is_error: false, ts: at(5) },
  { kind: "tool_call", id: "c2", name: "Edit", input_summary: "src/a.ts", input: {}, ts: at(6) },
  { kind: "tool_result", call_id: "c2", output: "ok", is_error: false, ts: at(7) },
  { kind: "assistant_text", markdown: "All green", ts: at(8) },
];
function open(status: string, items: unknown[] = turn) {
  useWeb.setState({ conn: "open", machines: [machine(status)] as never, chats: {} });
  act(() => {
    useWeb.getState().apply({ type: "chat_opened", pane, located });
    useWeb.getState().apply({ type: "chat", pane, event: { type: "reset", items, total: items.length } as never });
  });
  render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
}
const append = (items: unknown[]) => act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "append", items } as never }));
const head = () => screen.getByRole("button", { name: /^Worked/ });

beforeEach(() => {
  localStorage.clear();
  vi.mocked(Markdown).mockClear();
});

describe("Transcript work blocks", () => {
  it("copies an answer's Markdown source", () => {
    open("idle", [{ kind: "user", text: "go", ts: at(0) }, { kind: "assistant_text", markdown: "**All** green", ts: at(1) }]);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenCalledWith("**All** green");
  });

  it("folds a finished turn's work under one header and keeps the answer open", () => {
    open("idle");
    expect(head()).toHaveAccessibleName("Worked for 7s · 1 edit · 1 command");
    expect(head()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Looking")).toBeNull();
    expect(screen.queryByText("pnpm test")).toBeNull();
    expect(screen.getByText("All green")).toBeInTheDocument();
    expect(screen.getByText("fix it")).toBeInTheDocument();
  });

  it("opens to the narration and a folded run of calls, and a call shows its result", () => {
    open("idle");
    fireEvent.click(head());
    expect(head()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Looking")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 edit · 1 command" }));
    fireEvent.click(screen.getByRole("button", { name: /Bash/ }));
    expect(screen.getByText("3 passed")).toBeInTheDocument();
    expect(screen.queryByText("ok")).toBeNull();
  });

  it("shows the newest block open as Working… while the Agent works", () => {
    open("working");
    const live = screen.getByRole("button", { name: /^Working…/ });
    expect(live).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Bash/ })).toBeInTheDocument();
  });

  it("keeps a block open across an Append", () => {
    open("idle");
    fireEvent.click(head());
    append([{ kind: "system", text: "later", ts: at(9) }]);
    expect(screen.getByText("later")).toBeInTheDocument();
    expect(screen.getByText("Looking")).toBeInTheDocument();
  });

  it("does not parse narration already shown again when a call joins the live block", () => {
    open("working");
    expect(screen.getByText("Looking")).toBeInTheDocument();
    vi.mocked(Markdown).mockClear();
    append([{ kind: "tool_call", id: "c3", name: "Read", input_summary: "b.ts", input: {}, ts: at(9) }]);
    expect(screen.getByRole("button", { name: /Read/ })).toBeInTheDocument();
    expect(vi.mocked(Markdown).mock.calls.map(([props]) => props.text)).not.toContain("Looking");
  });

  it("shows thinking and a result whose call is not loaded as their own rows", () => {
    open("idle", [
      { kind: "user", text: "go", ts: at(0) },
      { kind: "thinking", text: "pondering", ts: at(1) },
      { kind: "tool_result", call_id: "gone", output: "orphan out", is_error: true, ts: at(2) },
      { kind: "assistant_text", markdown: "done", ts: at(3) },
    ]);
    fireEvent.click(head());
    fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("pondering")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Error" }));
    expect(screen.getByText("orphan out")).toBeInTheDocument();
  });
});
