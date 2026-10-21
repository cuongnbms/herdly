import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useWeb } from "../store";
import { ChatScreen } from "./ChatScreen";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), chatPage: vi.fn(), panePrompt: vi.fn() }));

const pane = { session: "s", pane_id: "p1" };
const located = { agent: "claude", path: "/t/a.jsonl", ambiguous: false, candidates: [], pending: false };
const machine = { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "s", running: true, status: "idle", error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status: "idle", tabs: [{ tab_id: "t", label: "t", number: 1, status: "idle", panes: [{ pane_id: "p1", terminal_id: "t1", title: "fix login", cwd: null, agent: "claude", status: "working" }] }] }] }] };

function open(items: unknown[], total = items.length) {
  useWeb.setState({ conn: "open", machines: [machine] as never, chats: {} });
  act(() => {
    useWeb.getState().apply({ type: "chat_opened", pane, located });
    useWeb.getState().apply({ type: "chat", pane, event: { type: "reset", items, total } as never });
  });
}

beforeEach(() => {
  vi.mocked(api.panePrompt).mockReset();
});

describe("ChatScreen", () => {
  it("renders the transcript and appends live", () => {
    open([{ kind: "user", text: "fix the login" }, { kind: "assistant_text", markdown: "**done**" }]);
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    expect(screen.getByText("fix login")).toBeInTheDocument();
    expect(screen.getByText("done").tagName).toBe("STRONG");
    act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "append", items: [{ kind: "system", text: "compacted" }] } }));
    expect(screen.getByText("compacted")).toBeInTheDocument();
  });

  it("pages older items in at the top", async () => {
    vi.mocked(api.chatPage).mockResolvedValue([{ kind: "system", text: "older" }] as never);
    open([{ kind: "system", text: "newest" }], 501);
    const { container } = render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    fireEvent.scroll(container.querySelector("[data-transcript]")!, { target: { scrollTop: 0 } });
    await waitFor(() => expect(screen.getByText("older")).toBeInTheDocument());
    expect(api.chatPage).toHaveBeenCalledWith(pane, 500, 200);
  });

  it("pages again after a Reset brings the same offset back", async () => {
    vi.mocked(api.chatPage).mockReset().mockResolvedValue([{ kind: "system", text: "older" }] as never);
    open([{ kind: "system", text: "newest" }], 501);
    const { container } = render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    const top = () => fireEvent.scroll(container.querySelector("[data-transcript]")!, { target: { scrollTop: 0 } });
    top();
    await waitFor(() => expect(screen.getByText("older")).toBeInTheDocument());
    act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "reset", items: [{ kind: "system", text: "newest" }], total: 501 } as never }));
    expect(screen.queryByText("older")).not.toBeInTheDocument();
    top();
    await waitFor(() => expect(api.chatPage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.chatPage).mock.calls[1]).toEqual([pane, 500, 200]);
  });

  it("a page dropped as stale after a Reset does not block the next page", async () => {
    let resolve!: (v: never) => void;
    vi.mocked(api.chatPage).mockReset().mockImplementationOnce(() => new Promise((r) => (resolve = r as never))).mockResolvedValue([{ kind: "system", text: "older" }] as never);
    open([{ kind: "system", text: "newest" }], 501);
    const { container } = render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    const top = () => fireEvent.scroll(container.querySelector("[data-transcript]")!, { target: { scrollTop: 0 } });
    top();
    const reset = (items: unknown[]) => act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "reset", items, total: 501 } as never }));
    reset([{ kind: "system", text: "a" }, { kind: "system", text: "b" }]);
    await act(async () => resolve([{ kind: "system", text: "late" }] as never));
    expect(screen.queryByText("late")).not.toBeInTheDocument();
    reset([{ kind: "system", text: "newest" }]);
    top();
    await waitFor(() => expect(screen.getByText("older")).toBeInTheDocument());
    expect(api.chatPage).toHaveBeenCalledTimes(2);
  });

  it("sends a message, shows it pending, and settles it on the append", async () => {
    vi.mocked(api.panePrompt).mockResolvedValue(undefined as never);
    open([]);
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "run the tests" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(api.panePrompt).toHaveBeenCalledWith(pane, "run the tests"));
    expect(screen.getByText("run the tests").closest("[data-pending]")).not.toBeNull();
    act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "append", items: [{ kind: "user", text: "run the tests" }] } }));
    expect(screen.getByText("run the tests").closest("[data-pending]")).toBeNull();
  });

  it("keeps the text and shows the error when sending fails", async () => {
    vi.mocked(api.panePrompt).mockRejectedValue(new api.ApiError(502, "herdr_error", "pane gone"));
    open([]);
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(screen.getByText("pane gone")).toBeInTheDocument());
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("hello");
  });

  it("shows the ambiguity note, and Retry for both error shapes", () => {
    const onRetry = vi.fn();
    open([]);
    act(() => useWeb.getState().apply({ type: "chat_opened", pane, located: { ...located, ambiguous: true, candidates: ["/a", "/b"] } }));
    const { rerender } = render(<ChatScreen pane={pane} onBack={() => {}} onRetry={onRetry} />);
    expect(screen.getByText("Several transcripts match; showing the newest")).toBeInTheDocument();
    act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "error", error: { code: "io", message: "tail ended" } } }));
    rerender(<ChatScreen pane={pane} onBack={() => {}} onRetry={onRetry} />);
    fireEvent.click(screen.getByText("Retry"));
    act(() => useWeb.getState().apply({ type: "chat_error", pane, error: { code: "not_found", message: "no transcript" } }));
    expect(screen.getByText("no transcript")).toBeInTheDocument();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
