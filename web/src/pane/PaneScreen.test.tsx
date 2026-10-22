import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Socket } from "../socket";
import { useWeb } from "../store";
import { TerminalSocket } from "../terminal/socket";
import type { LensHandlers, TransportFactory } from "../terminal/TerminalLens";
import type { WebPane } from "../types";
import { PaneScreen } from "./PaneScreen";

const pane: WebPane = { session: "s", pane_id: "p1" };

/** One machine view with a single Pane whose Agent the test chooses. */
function machine(agent: string | null) {
  return {
    id: "local",
    label: "local",
    kind: "local",
    state: "connected",
    error: null,
    version: null,
    pi_agent_dir: null,
    has_pi: false,
    status: "idle",
    sessions: [
      {
        name: "s",
        running: true,
        status: "idle",
        error: null,
        workspaces: [
          {
            workspace_id: "w",
            label: "w",
            number: 1,
            status: "idle",
            tabs: [
              {
                tab_id: "t",
                label: "t",
                number: 1,
                status: "idle",
                panes: [{ pane_id: "p1", terminal_id: "t1", title: "alpha", cwd: null, agent, status: "idle" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function rig() {
  const socket = { subscribe: vi.fn(), unsubscribe: vi.fn() };
  const view = render(<PaneScreen pane={pane} socket={socket as never} onBack={() => {}} onSwitch={() => {}} onMenu={() => {}} />);
  return { socket, view };
}

beforeEach(() => {
  localStorage.clear();
  useWeb.setState({ conn: "open", authLost: false, lost: false, machines: [], chats: {}, open: pane });
});

afterEach(() => cleanup());

describe("PaneScreen Lens selector", () => {
  it("shows Chat and Terminal controls with the chosen Lens selected", () => {
    useWeb.setState({ machines: [machine("claude")] as never });
    rig();
    const chat = screen.getByRole("button", { name: "Chat" });
    const terminal = screen.getByRole("button", { name: "Terminal" });
    expect(chat).toHaveAttribute("aria-pressed", "true");
    expect(terminal).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(terminal);
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "false");
  });

  it("opens Chat once the Pane's Agent view arrives after the screen mounted", () => {
    // The Pane list needs a Machine view to show anything, but a Pane can be selected while a
    // fresh machine frame replaces the old one: the default must follow the Agent, not the
    // first render.
    const { socket } = rig();
    expect(socket.subscribe).not.toHaveBeenCalled();
    act(() => useWeb.setState({ machines: [machine("claude")] as never }));
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
    // The rendered body switched to Chat, so the transcript must be fetched too.
    expect(socket.subscribe).toHaveBeenCalledWith(pane);
  });

  it("disables Chat for a Pane whose Agent has no Chat lens, and opens Terminal", () => {
    useWeb.setState({ machines: [machine("codex")] as never });
    rig();
    expect(screen.getByRole("button", { name: "Chat" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("PaneScreen Chat subscription", () => {
  it("subscribes the Chat socket while Chat is shown and unsubscribes when it is hidden", () => {
    useWeb.setState({ machines: [machine("claude")] as never });
    const { socket } = rig();
    expect(socket.subscribe).toHaveBeenCalledWith(pane);
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(socket.unsubscribe).toHaveBeenCalledWith(pane);
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(socket.subscribe).toHaveBeenCalledTimes(2);
  });

  it("never subscribes Chat for a shell Pane", () => {
    useWeb.setState({ machines: [machine(null)] as never });
    const { socket } = rig();
    expect(socket.subscribe).not.toHaveBeenCalled();
  });

  it("unsubscribes when the Pane's Agent stops having a Chat lens", () => {
    useWeb.setState({ machines: [machine("claude")] as never });
    const { socket } = rig();
    expect(socket.subscribe).toHaveBeenCalledWith(pane);
    act(() => useWeb.setState({ machines: [machine("codex")] as never }));
    expect(socket.unsubscribe).toHaveBeenCalledWith(pane);
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Chat" })).toBeDisabled();
  });

  it("falls back to Terminal when a Pane the user put on Chat loses its Chat lens", () => {
    useWeb.setState({ machines: [machine("claude")] as never });
    const { socket } = rig();
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
    // The same Pane now runs an Agent with no Chat lens: only Terminal can show it.
    act(() => useWeb.setState({ machines: [machine("codex")] as never }));
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Chat" })).toBeDisabled();
    expect(socket.unsubscribe).toHaveBeenCalledWith(pane);
  });

  it("unsubscribes on unmount", () => {
    useWeb.setState({ machines: [machine("claude")] as never });
    const { socket, view } = rig();
    act(() => view.unmount());
    expect(socket.unsubscribe).toHaveBeenCalledWith(pane);
  });
});

describe("PaneScreen terminal target", () => {
  /** A transport double that records the attempts PaneScreen's Terminal asked for. */
  function attempts() {
    const transports: { pane: WebPane; started: number; stopped: number; handlers: LensHandlers }[] = [];
    const transport: TransportFactory = (p, on) => {
      const t = { pane: p, started: 0, stopped: 0, handlers: on };
      transports.push(t);
      return {
        start: () => { t.started++; },
        stop: () => { t.stopped++; },
        input: () => {},
        reply: () => {},
        resize: () => {},
      };
    };
    return { transports, transport };
  }

  it("starts a fresh attempt when the Pane's terminal_id changes", () => {
    localStorage.clear();
    useWeb.setState({ machines: [machine(null)] as never });
    const a = attempts();
    render(<PaneScreen pane={pane} transport={a.transport} onBack={() => {}} onSwitch={() => {}} onMenu={() => {}} />);
    expect(a.transports).toHaveLength(1);
    expect(a.transports[0].started).toBe(1);
    // The Pane's terminal was replaced: the old attempt is disposed, not written to again.
    act(() => useWeb.setState({ machines: [{ ...machine(null), sessions: [{ ...machine(null).sessions[0], workspaces: [{ ...machine(null).sessions[0].workspaces[0], tabs: [{ ...machine(null).sessions[0].workspaces[0].tabs[0], panes: [{ pane_id: "p1", terminal_id: "t2", title: "alpha", cwd: null, agent: null, status: "idle" }] }] }] }] }] as never }));
    expect(a.transports).toHaveLength(2);
    expect(a.transports[0].stopped).toBe(1);
    expect(a.transports[1].started).toBe(1);
  });
});

describe("PaneScreen header", () => {
  it("renders exactly one header", () => {
    useWeb.setState({ machines: [machine("claude")] as never });
    rig();
    expect(document.querySelectorAll("header.chat-header")).toHaveLength(1);
  });
});

/**
 * The real Chat socket and the real terminal transport on the real store, wired the way
 * main.tsx and TerminalLens wire them. Only the WebSocket factory, `/api/me` and the timers are
 * faked, because those are the OS and network boundaries. This is the integration the store's
 * sticky `authLost` exists for: a proof through the setter alone would not catch a Chat frame or
 * a still-open Chat socket bringing the paired UI back.
 */
describe("PaneScreen pairing loss found by the terminal", () => {
  class FakeWs {
    sent: string[] = [];
    binaryType = "blob";
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    send(d: string | ArrayBufferView) { this.sent.push(typeof d === "string" ? d : "<binary>"); }
    close() {}
  }

  /** A real Chat socket, and the real terminal transport factory on the same boundary fakes. */
  function wires() {
    const chat: FakeWs[] = [];
    const term: FakeWs[] = [];
    const timers: (() => void)[] = [];
    const chatSocket = new Socket("ws://h/ws", { frame: useWeb.getState().apply, conn: useWeb.getState().setConn }, {
      open: () => { const w = new FakeWs(); chat.push(w); return w as never; },
      me: vi.fn().mockResolvedValue(200),
      setTimeout: (fn) => timers.push(fn),
    });
    const transport: TransportFactory = (p, on) =>
      new TerminalSocket("ws://h/ws/terminal", p, on, {
        open: () => { const w = new FakeWs(); term.push(w); return w as never; },
        me: vi.fn().mockResolvedValue(200),
        setTimeout: () => 0,
        clearTimeout: () => {},
      });
    return { chatSocket, chat, term, transport, timers };
  }

  it("keeps Not paired when the still-open Chat socket reports success after the terminal lost auth", async () => {
    useWeb.setState({ conn: "open", authLost: false, lost: false, machines: [machine(null)] as never, chats: {}, open: pane });
    const w = wires();
    // The Chat socket began its handshake before the revocation, so its `onopen` is still queued.
    w.chatSocket.start();
    // The shell Pane opens on Terminal, so this mounts the real terminal transport.
    render(<PaneScreen pane={pane} socket={w.chatSocket as never} transport={w.transport} onBack={() => {}} onSwitch={() => {}} onMenu={() => {}} />);
    await waitFor(() => expect(w.term).toHaveLength(1));
    // The server answers the attempt as revoked: only re-pairing opens another one.
    act(() => w.term[0].onclose!({ code: 4401 }));
    expect(useWeb.getState().conn).toBe("unpaired");
    expect(useWeb.getState().authLost).toBe(true);
    // Its queued `onopen` is a success for a handshake that began before the revocation: it is
    // not fresh authentication, so the paired UI stays away.
    act(() => w.chat[0].onopen!());
    expect(useWeb.getState().conn).toBe("unpaired");
    // A Machine frame from it is not either.
    act(() => w.chat[0].onmessage!({ data: JSON.stringify({ type: "machine", view: machine(null) }) }));
    expect(useWeb.getState().conn).toBe("unpaired");
    expect(useWeb.getState().authLost).toBe(true);
    w.chatSocket.stop();
  });

  it("leaves Not paired only when the Chat socket opens again", async () => {
    useWeb.setState({ conn: "open", authLost: false, lost: false, machines: [machine(null)] as never, chats: {}, open: pane });
    const w = wires();
    w.chatSocket.start();
    w.chat[0].onopen!();
    render(<PaneScreen pane={pane} socket={w.chatSocket as never} transport={w.transport} onBack={() => {}} onSwitch={() => {}} onMenu={() => {}} />);
    await waitFor(() => expect(w.term).toHaveLength(1));
    act(() => w.term[0].onclose!({ code: 4401 }));
    expect(useWeb.getState().conn).toBe("unpaired");
    // A socket that opens is fresh authentication, so the paired UI may return.
    act(() => w.chat[0].onclose!({ code: 1006 }));
    act(() => w.chatSocket.start());
    act(() => w.chat.at(-1)!.onopen!());
    expect(useWeb.getState().conn).toBe("open");
    expect(useWeb.getState().authLost).toBe(false);
    w.chatSocket.stop();
  });
});
