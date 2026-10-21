import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useWeb } from "../store";
import { ChatScreen } from "./ChatScreen";
import { Markdown } from "./Markdown";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), chatPage: vi.fn(), panePrompt: vi.fn(), paneRead: vi.fn().mockResolvedValue("Do you want to proceed?\n❯ 1. Yes\n  2. No\n") }));
// A pass-through spy: counts how often a Transcript item's Markdown is parsed again.
vi.mock("./Markdown", async (orig) => {
  const real = await orig<typeof import("./Markdown")>();
  return { Markdown: vi.fn(real.Markdown) };
});

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

  it("does not parse the Markdown of items already shown again when an item is appended", () => {
    open([{ kind: "assistant_text", markdown: "**done**" }]);
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    vi.mocked(Markdown).mockClear();
    act(() => useWeb.getState().apply({ type: "chat", pane, event: { type: "append", items: [{ kind: "assistant_text", markdown: "*next*" }] } }));
    expect(screen.getByText("next").tagName).toBe("EM");
    expect(vi.mocked(Markdown).mock.calls.map(([props]) => props.text)).toEqual(["*next*"]);
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

  it("marks a pending message not seen yet after 30 s, without parsing the Transcript again", () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.panePrompt).mockImplementation(() => new Promise(() => {}));
      open([{ kind: "assistant_text", markdown: "**done**" }]);
      render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "run the tests" } });
      fireEvent.click(screen.getByText("Send"));
      vi.mocked(Markdown).mockClear();
      act(() => vi.advanceTimersByTime(29_000));
      expect(screen.queryByText("not seen yet")).toBeNull();
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByText("not seen yet").closest("[data-pending]")).not.toBeNull();
      expect(Markdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

  it("replaces the Composer with the prompt card while blocked and keeps Esc and Ctrl+C", async () => {
    open([]);
    expect(render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />).container).toBeTruthy();
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
    cleanup();
    const blocked = structuredClone(machine);
    blocked.sessions[0].workspaces[0].tabs[0].panes[0].status = "blocked";
    act(() => useWeb.setState({ machines: [blocked] as never }));
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.queryByText("Send")).toBeNull();
    expect(screen.getByText("Esc")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+C")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Do you want to proceed?")).toBeInTheDocument());
  });

  it("keeps the typed draft while a prompt is on screen", async () => {
    open([]);
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "half a thought" } });
    const blocked = structuredClone(machine);
    blocked.sessions[0].workspaces[0].tabs[0].panes[0].status = "blocked";
    act(() => useWeb.setState({ machines: [blocked] as never }));
    await waitFor(() => expect(screen.getByText("Do you want to proceed?")).toBeInTheDocument());
    expect(screen.queryByLabelText("Message")).toBeNull();
    act(() => useWeb.setState({ machines: [machine] as never }));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("half a thought");
  });

  it("keeps the text and the error of a send that fails while a prompt is on screen", async () => {
    let reject!: (e: unknown) => void;
    vi.mocked(api.panePrompt).mockImplementation(() => new Promise((_, rj) => (reject = rj)));
    open([]);
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(api.panePrompt).toHaveBeenCalledWith(pane, "hello"));
    const blocked = structuredClone(machine);
    blocked.sessions[0].workspaces[0].tabs[0].panes[0].status = "blocked";
    act(() => useWeb.setState({ machines: [blocked] as never }));
    await waitFor(() => expect(screen.getByText("Do you want to proceed?")).toBeInTheDocument());
    await act(async () => reject(new api.ApiError(502, "herdr_error", "pane gone")));
    act(() => useWeb.setState({ machines: [machine] as never }));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("hello");
    expect(screen.getByText("pane gone")).toBeInTheDocument();
  });

  it("starts the prompt card blank when the prompt changes", async () => {
    open([]);
    const blocked = structuredClone(machine);
    blocked.sessions[0].workspaces[0].tabs[0].panes[0].status = "blocked";
    act(() => useWeb.setState({ machines: [blocked] as never }));
    vi.mocked(api.paneRead).mockResolvedValueOnce(`────────────────────────────\n←  ☒ One  ✔ Submit  →\nFirst question?\n❯ 1. Yes\n  2. No\n  3. Type something.\n────────────────────────────\n  4. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n`);
    render(<ChatScreen pane={pane} onBack={() => {}} onRetry={() => {}} />);
    await waitFor(() => expect(screen.getByText("First question?")).toBeInTheDocument());
    const field = screen.getByLabelText("Answer") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "typed for the first" } });
    expect(field.value).toBe("typed for the first");
    vi.mocked(api.paneRead).mockResolvedValue(`────────────────────────────\n←  ☒ Two  ✔ Submit  →\nSecond question?\n❯ 1. Maybe\n  2. No\n  3. Type something.\n────────────────────────────\n  4. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n`);
    act(() => useWeb.setState({ machines: [structuredClone(blocked)].map((m) => { m.sessions[0].workspaces[0].tabs[0].panes[0].title = "next"; return m; }) as never }));
    await waitFor(() => expect(screen.getByText("Second question?")).toBeInTheDocument());
    expect((screen.getByLabelText("Answer") as HTMLInputElement).value).toBe("");
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
