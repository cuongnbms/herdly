import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]), Channel: class {} }));
vi.mock("../lib/ipc", () => ({
  herdrCall: vi.fn(),
  chatPage: vi.fn().mockResolvedValue([]),
  chatLocate: vi.fn(() => opened),
  imageSaveTemp: vi.fn(),
  completeCommands: vi.fn().mockResolvedValue([]),
  completeFiles: vi.fn().mockResolvedValue([]),
  chatGitStatus: vi.fn().mockResolvedValue(null),
}));
let opened: Promise<unknown> = new Promise(() => {});
const channels = vi.hoisted(() => [] as { onmessage: (ev: unknown) => void }[]);
const openedPaths = vi.hoisted(() => [] as (string | null)[]);
vi.mock("./chatSession", () => ({
  openChat: (_p: unknown, path: string | null, ch: { onmessage: (ev: unknown) => void }) => {
    channels.push(ch);
    openedPaths.push(path);
    return { opened, close: () => {} };
  },
  onOpenFailure: () => "error",
  watchMachine: () => ({ sawDown: false, reopen: false }),
}));
vi.mock("./btw", async (orig) => {
  const m = await orig<typeof import("./btw")>();
  return { ...m, closeSide: vi.fn(), askSide: vi.fn().mockResolvedValue(undefined) };
});
import { askSide, closeSide, useBtw } from "./btw";
import { chatLocate, chatPage, herdrCall } from "../lib/ipc";
import { paneKey, type PaneView } from "../lib/types";
import { useApp, viewedItems } from "../store/app";
import { itemKey } from "../store/openItems";
import { sessionKey } from "../sidebar/groups";
import { ChatLens } from "./ChatLens";
import { savedPosition, savePosition } from "./readingPosition";

const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const idlePi = { status: "idle", agent: "pi", title: "pi" } as PaneView;
const picker = `
>

→ ✓ a-model [p] · default
    b-model [p]

 Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel
────────────────────────
/tmp/app
`;

let shown = "";

beforeEach(() => {
  localStorage.clear();
  opened = new Promise(() => {});
  channels.length = 0;
  openedPaths.length = 0;
  vi.mocked(chatLocate).mockClear();
  shown = "";
  vi.mocked(herdrCall)
    .mockReset()
    .mockImplementation(async (_m, _s, method) => {
      if (method === "agent.prompt") shown = picker;
      return method === "pane.read" ? { text: shown } : {};
    });
});

describe("ChatLens", () => {
  it("lets a new Claude be chatted with before its transcript exists", async () => {
    opened = Promise.resolve({ agent: "claude", path: "/h/sid.jsonl", ambiguous: false, candidates: ["/h/sid.jsonl"], pending: true });
    render(<ChatLens pane={pane} view={{ status: "idle", agent: "claude", title: "claude" } as PaneView} />);
    expect(await screen.findByText(/first message/)).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("shows pi's model picker as a card once /model is sent, though pi stays idle", async () => {
    render(<ChatLens pane={pane} view={idlePi} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/model" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Select model (currently a-model [p])")).toBeTruthy();
    expect(screen.getByRole("button", { name: /b-model/ })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/Waiting for/)).toBeNull();
  });

  it("does not read the screen of an idle pi Pane that was sent no /model", async () => {
    shown = picker;
    render(<ChatLens pane={pane} view={idlePi} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(herdrCall).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("goes back to the Composer once the picker closes", async () => {
    render(<ChatLens pane={pane} view={idlePi} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/model" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("Select model (currently a-model [p])");
    shown = "";
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy(), { timeout: 3000 });
  });

  it("forgets the /model it was sent once the Pane changes", async () => {
    // the picker never shows, so the Pane stays armed until the change
    vi.mocked(herdrCall).mockImplementation(async (_m, _s, method) => (method === "pane.read" ? { text: "" } : {}));
    const other = { ...pane, pane_id: "w1:p2" };
    const { rerender } = render(<ChatLens pane={pane} view={idlePi} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/model" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(vi.mocked(herdrCall).mock.calls.some(([, , m]) => m === "pane.read")).toBe(true));
    vi.mocked(herdrCall).mockClear();
    rerender(<ChatLens pane={other} view={idlePi} />);
    rerender(<ChatLens pane={pane} view={idlePi} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(herdrCall).mock.calls.filter(([, , m]) => m === "pane.read")).toEqual([]);
  });

  it("locates a transcript reopened from the running tail again, and follows it when it moved", async () => {
    const was = { agent: "claude", path: "/h/old.jsonl", ambiguous: false, candidates: ["/h/old.jsonl"], pending: false };
    const moved = { ...was, path: "/h/new.jsonl", candidates: ["/h/new.jsonl"] };
    opened = Promise.resolve({ ...was, cached: true });
    vi.mocked(chatLocate).mockResolvedValueOnce(moved);
    render(<ChatLens pane={pane} view={idlePi} />);
    await waitFor(() => expect(openedPaths).toEqual([null, "/h/new.jsonl"]));
    expect(chatLocate).toHaveBeenCalledTimes(1);
  });

  it("closes the side-question thread once the lens locates another transcript", async () => {
    const at = { agent: "claude", path: "/p/new.jsonl", ambiguous: false, candidates: ["/p/new.jsonl"], pending: false };
    opened = Promise.resolve(at);
    useBtw.setState({ threads: { [paneKey(pane)]: { path: "/p/old.jsonl", turns: [] } }, mode: {} });
    render(<ChatLens pane={pane} view={idlePi} />);
    await waitFor(() => expect(closeSide).toHaveBeenCalledWith(pane));
    useBtw.setState({ threads: {}, mode: {} });
  });

  it("offers a side question below the prompt card while the Agent is blocked", async () => {
    opened = Promise.resolve({ agent: "claude", path: "/p/t1.jsonl", ambiguous: false, candidates: ["/p/t1.jsonl"], pending: false });
    useBtw.setState({ threads: {}, mode: {} });
    vi.mocked(askSide).mockClear();
    // the blocked card's screen mirror asks for matchMedia
    window.matchMedia ??= ((query: string) =>
      ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList);
    const { container } = render(<ChatLens pane={pane} view={{ status: "blocked", agent: "claude", title: "claude" } as PaneView} />);
    const open = await screen.findByRole("button", { name: "btw — ask a side question" });
    const composer = () => container.querySelector<HTMLTextAreaElement>(".composer textarea");
    expect(container.querySelector(".blocked-panel")).toBeTruthy();
    expect(composer()).toBeNull();
    fireEvent.click(open);
    const box = composer()!;
    expect(box.getAttribute("placeholder")).toBe("Ask a side question (not added to the Transcript)…");
    expect(container.querySelector(".blocked-panel")).toBeTruthy();
    fireEvent.change(box, { target: { value: "why?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(askSide).toHaveBeenCalledWith(pane, "/p/t1.jsonl", "why?");
    expect(vi.mocked(herdrCall).mock.calls.some(([, , m]) => m === "agent.prompt")).toBe(false);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByRole("button", { name: "btw — ask a side question" })).toBeTruthy();
    expect(composer()).toBeNull();
    useBtw.setState({ threads: {}, mode: {} });
  });

  it("offers no side question while blocked without a located Claude transcript", async () => {
    window.matchMedia ??= ((query: string) =>
      ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList);
    render(<ChatLens pane={pane} view={{ status: "blocked", agent: "pi", title: "pi" } as PaneView} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "btw — ask a side question" })).toBeNull();
  });

  it("does not locate again after an open that located, or a reattach to the same file", async () => {
    const at = { agent: "claude", path: "/h/a.jsonl", ambiguous: false, candidates: ["/h/a.jsonl"], pending: false };
    opened = Promise.resolve(at);
    const first = render(<ChatLens pane={pane} view={idlePi} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(chatLocate).not.toHaveBeenCalled();
    first.unmount();
    opened = Promise.resolve({ ...at, cached: true });
    vi.mocked(chatLocate).mockResolvedValueOnce(at);
    render(<ChatLens pane={pane} view={idlePi} />);
    await waitFor(() => expect(chatLocate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(openedPaths).toEqual([null, null]);
  });

  it("says the transcript is loading once a located open waits for its reset", async () => {
    opened = Promise.resolve({ agent: "claude", path: "/h/a.jsonl", ambiguous: false, candidates: ["/h/a.jsonl"], pending: false });
    render(<ChatLens pane={pane} view={idlePi} />);
    expect(screen.queryByText("Loading transcript…")).toBeNull();
    expect(await screen.findByText("Loading transcript…", undefined, { timeout: 100 })).toBeTruthy();
  });

  it("does not say loading while reattaching to the running tail", async () => {
    opened = Promise.resolve({ agent: "claude", path: "/h/a.jsonl", ambiguous: false, candidates: ["/h/a.jsonl"], pending: false, cached: true });
    vi.mocked(chatLocate).mockReturnValueOnce(new Promise(() => {}));
    render(<ChatLens pane={pane} view={idlePi} />);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByText("Loading transcript…")).toBeNull();
  });

  it("says the transcript is loading until the first reset or error", async () => {
    const { unmount } = render(<ChatLens pane={pane} view={idlePi} />);
    expect(screen.queryByText("Loading transcript…")).toBeNull();
    expect(await screen.findByText("Loading transcript…")).toBeTruthy();
    act(() => channels[channels.length - 1].onmessage({ type: "reset", items: [], total: 0 }));
    expect(screen.queryByText("Loading transcript…")).toBeNull();
    unmount();
    render(<ChatLens pane={pane} view={idlePi} />);
    act(() => channels[channels.length - 1].onmessage({ type: "error", error: { code: "io", message: "gone" } }));
    expect(screen.queryByText("Loading transcript…")).toBeNull();
  });

  it("outlines the user turns beside the transcript", () => {
    render(<ChatLens pane={pane} view={idlePi} />);
    const items = [
      { kind: "user", text: "fix the header" },
      { kind: "assistant_text", markdown: "done" },
      { kind: "user", text: "now the footer" },
    ];
    act(() => channels[channels.length - 1].onmessage({ type: "reset", items, total: items.length }));
    const nav = screen.getByRole("navigation", { name: "Conversation outline" });
    expect([...nav.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["fix the header", "now the footer"]);
  });

  it("keeps the turn picked in the outline lit until the transcript is scrolled", () => {
    const { container } = render(<ChatLens pane={pane} view={idlePi} />);
    const items = [
      { kind: "user", text: "fix the header" },
      { kind: "assistant_text", markdown: "done" },
      { kind: "user", text: "now the footer" },
    ];
    act(() => channels[channels.length - 1].onmessage({ type: "reset", items, total: items.length }));
    const lit = () => screen.getByRole("navigation", { name: "Conversation outline" }).querySelector("[aria-current]")?.textContent;
    expect(lit()).toBe("fix the header");
    fireEvent.click(screen.getByRole("button", { name: "now the footer" }));
    expect(lit()).toBe("now the footer");
    fireEvent.wheel(container.querySelector(".chat-scroll")!);
    expect(lit()).toBe("fix the header");
  });
  describe("a sent message", () => {
    const outgoing = (c: HTMLElement) => [...c.querySelectorAll(".chat-outgoing")];
    const sendText = (text: string) => {
      const box = screen.getByRole("textbox");
      fireEvent.change(box, { target: { value: text } });
      fireEvent.keyDown(box, { key: "Enter" });
    };

    it("shows at once, dimmed until the send went through", async () => {
      let resolve!: (v: unknown) => void;
      vi.mocked(herdrCall).mockImplementation(() => new Promise((r) => (resolve = r)));
      const { container } = render(<ChatLens pane={pane} view={idlePi} />);
      sendText("hello there");
      expect(outgoing(container).map((e) => e.textContent)).toEqual(["hello there"]);
      expect(outgoing(container)[0].classList.contains("sending")).toBe(true);
      await act(async () => resolve({}));
      expect(outgoing(container)[0].classList.contains("sending")).toBe(false);
    });

    it("pins the pane's agent tab", () => {
      useApp.setState({ viewed: pane, tabs: { [sessionKey(pane.machine_id, pane.session)]: { items: [{ kind: "agent", ref: pane }], preview: itemKey({ kind: "agent", ref: pane }), active: null } } });
      render(<ChatLens pane={pane} view={idlePi} />);
      sendText("hello there");
      expect(viewedItems(useApp.getState()).preview).toBeNull();
    });

    it("opens the pane's agent tab pinned when it was closed", () => {
      useApp.setState({ tabs: {}, viewed: null });
      render(<ChatLens pane={pane} view={idlePi} />);
      sendText("hello there");
      expect(viewedItems(useApp.getState())).toEqual({ items: [{ kind: "agent", ref: pane }], preview: null, active: itemKey({ kind: "agent", ref: pane }) });
    });

    it("gives way to the transcript's user item", async () => {
      const { container } = render(<ChatLens pane={pane} view={idlePi} />);
      act(() => channels[channels.length - 1].onmessage({ type: "reset", items: [], total: 0 }));
      await act(async () => sendText("hello there"));
      expect(outgoing(container)).toHaveLength(1);
      act(() => channels[channels.length - 1].onmessage({ type: "append", items: [{ kind: "user", text: "something else" }] }));
      expect(outgoing(container)).toHaveLength(1);
      act(() => channels[channels.length - 1].onmessage({ type: "append", items: [{ kind: "user", text: "hello there" }] }));
      expect(outgoing(container)).toHaveLength(0);
    });

    it("goes when the send failed", async () => {
      vi.mocked(herdrCall).mockRejectedValue({ code: "timeout", message: "timed out" });
      const { container } = render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => sendText("hello there"));
      expect(outgoing(container)).toHaveLength(0);
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("hello there");
    });

    it("is not shown for a slash command", async () => {
      const { container } = render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => sendText("/compact"));
      expect(outgoing(container)).toHaveLength(0);
    });

    it("stays through a reset that does not echo it, and goes with one that does", async () => {
      const { container } = render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => sendText("one"));
      act(() => channels[channels.length - 1].onmessage({ type: "reset", items: [{ kind: "user", text: "older" }], total: 1 }));
      expect(outgoing(container)).toHaveLength(1);
      const items = [{ kind: "user", text: "older" }, { kind: "user", text: "one" }];
      act(() => channels[channels.length - 1].onmessage({ type: "reset", items, total: 2 }));
      expect(outgoing(container)).toHaveLength(0);
    });

    it("goes with a pane switch", async () => {
      const { container, rerender } = render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => sendText("two"));
      expect(outgoing(container)).toHaveLength(1);
      rerender(<ChatLens pane={{ ...pane, pane_id: "w1:p2" }} view={idlePi} />);
      expect(outgoing(container)).toHaveLength(0);
    });
  });

  describe("following the end", () => {
    const claude = { status: "working", agent: "claude", title: "claude" } as PaneView;
    const send = (ev: unknown) => act(() => channels[channels.length - 1].onmessage(ev));
    // jsdom lays nothing out: the scroll area's geometry is set by hand.
    const geometry = (el: HTMLElement) => {
      const g = { top: 0, height: 1000, view: 300 };
      Object.defineProperty(el, "scrollTop", { configurable: true, get: () => g.top, set: (v: number) => (g.top = Math.min(v, g.height - g.view)) });
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => g.height });
      Object.defineProperty(el, "clientHeight", { configurable: true, get: () => g.view });
      return g;
    };
    const setup = () => {
      const { container } = render(<ChatLens pane={pane} view={claude} />);
      send({ type: "reset", items: [{ kind: "user", text: "a" }], total: 1 });
      const el = container.querySelector(".chat-scroll") as HTMLElement;
      const g = geometry(el);
      g.top = 700;
      fireEvent.scroll(el);
      return { el, g };
    };

    it("keeps following when the scroll area grows and the browser scrolls it off the end", () => {
      // The prompt card gives way to the composer: WebKit clamps the scroll to a layout in between.
      const { el, g } = setup();
      g.view = 531;
      g.top = 300;
      fireEvent.scroll(el);
      send({ type: "append", items: [{ kind: "assistant_text", markdown: "next" }] });
      expect(screen.queryByText("New messages")).toBeNull();
    });

    it("stays put when the transcript's echo takes the place of a sent message", async () => {
      const { g } = setup();
      const box = screen.getByRole("textbox");
      fireEvent.change(box, { target: { value: "hello there" } });
      await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
      expect(g.top).toBe(700);
      // WebKit, laying out the sent message's removal with the echo's row, scrolls up by the message's height.
      const remove = Node.prototype.removeChild;
      const spy = vi.spyOn(Node.prototype, "removeChild").mockImplementation(function <T extends Node>(this: Node, child: T) {
        if ((child as unknown as Element).classList?.contains("chat-outgoing")) g.top -= 56;
        return remove.call(this, child) as T;
      });
      send({ type: "append", items: [{ kind: "user", text: "hello there" }] });
      spy.mockRestore();
      expect(document.querySelector(".chat-outgoing")).toBeNull();
      expect(g.top).toBe(700);
    });

    describe("rows coming in", () => {
      // The virtualizer renders rows only into a scroll area with a height.
      beforeEach(() => {
        vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
        vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
        return () => vi.restoreAllMocks();
      });
      const entering = (c: HTMLElement) => [...c.querySelectorAll(".chat-enter")].map((e) => e.textContent);

      it("eases in the rows an append brings, not those a reset loaded", () => {
        const { container } = render(<ChatLens pane={pane} view={claude} />);
        send({ type: "reset", items: [{ kind: "user", text: "first" }, { kind: "assistant_text", markdown: "loaded" }], total: 2 });
        expect(container.querySelectorAll("[data-index]").length).toBe(2);
        expect(entering(container)).toEqual([]);
        send({ type: "append", items: [{ kind: "user", text: "second" }, { kind: "assistant_text", markdown: "fresh" }] });
        expect(entering(container)).toEqual(["second", "fresh"]);
      });

      it("does not ease in the transcript's echo of a message already shown as sent", async () => {
        const { container } = render(<ChatLens pane={pane} view={idlePi} />);
        send({ type: "reset", items: [], total: 0 });
        const box = screen.getByRole("textbox");
        fireEvent.change(box, { target: { value: "hello there" } });
        await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
        send({ type: "append", items: [{ kind: "user", text: "hello there" }, { kind: "assistant_text", markdown: "hi" }] });
        expect(entering(container)).toEqual(["hi"]);
      });

      it("does not ease in again once it has come in", async () => {
        const { container } = render(<ChatLens pane={pane} view={claude} />);
        send({ type: "reset", items: [], total: 0 });
        send({ type: "append", items: [{ kind: "assistant_text", markdown: "fresh" }] });
        expect(entering(container)).toEqual(["fresh"]);
        await act(() => new Promise((r) => setTimeout(r, 400)));
        send({ type: "append", items: [{ kind: "assistant_text", markdown: "later" }] });
        expect(entering(container)).toEqual(["later"]);
      });
    });

    const frame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));

    it("eases down to the end after an append", async () => {
      const { el, g } = setup();
      await frame();
      g.top = 700;
      g.height = 1300;
      send({ type: "append", items: [{ kind: "assistant_text", markdown: "next" }] });
      await frame();
      expect(g.top).toBeGreaterThan(700);
      expect(g.top).toBeLessThan(1000);
      for (let i = 0; i < 40 && g.top < 1000; i++) await frame();
      expect(g.top).toBe(1000);
      fireEvent.scroll(el);
      expect(screen.queryByText("New messages")).toBeNull();
    });

    it("keeps following while its own scroll is still short of the end", async () => {
      const { el, g } = setup();
      g.height = 1300;
      send({ type: "append", items: [{ kind: "assistant_text", markdown: "next" }] });
      await frame();
      fireEvent.scroll(el);
      send({ type: "append", items: [{ kind: "assistant_text", markdown: "more" }] });
      expect(screen.queryByText("New messages")).toBeNull();
    });

    it("lands at the end at once while the window is hidden, which gets no frames", () => {
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      const { g } = setup();
      g.height = 1300;
      send({ type: "append", items: [{ kind: "assistant_text", markdown: "next" }] });
      expect(g.top).toBe(1000);
      hidden.mockRestore();
    });

    it("lands a follow under way when the window is hidden", async () => {
      const { g } = setup();
      g.height = 1300;
      send({ type: "append", items: [{ kind: "assistant_text", markdown: "next" }] });
      await frame();
      expect(g.top).toBeLessThan(1000);
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      fireEvent(document, new Event("visibilitychange"));
      expect(g.top).toBe(1000);
      hidden.mockRestore();
    });

    it("lets the reader's wheel stop the scroll to the end", async () => {
      const { el, g } = setup();
      g.height = 1300;
      send({ type: "append", items: [{ kind: "assistant_text", markdown: "next" }] });
      await frame();
      fireEvent.wheel(el);
      const at = g.top;
      await frame();
      await frame();
      expect(g.top).toBe(at);
      fireEvent.scroll(el);
      send({ type: "append", items: [{ kind: "assistant_text", markdown: "more" }] });
      expect(screen.getByText("New messages")).toBeTruthy();
    });

    it("stops following once the reader scrolls up", () => {
      const { el, g } = setup();
      g.top = 300;
      fireEvent.scroll(el);
      send({ type: "append", items: [{ kind: "assistant_text", markdown: "next" }] });
      expect(screen.getByText("New messages")).toBeTruthy();
    });
  });

  describe("the reading position", () => {
    const at = { agent: "claude", path: "/h/a.jsonl", ambiguous: false, candidates: ["/h/a.jsonl"], pending: false };
    const window = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ kind: "user", text: `m${from + i}` }));
    const reset = (from: number, total: number) =>
      act(() => channels[channels.length - 1].onmessage({ type: "reset", items: window(from, total), total }));
    beforeEach(() => vi.mocked(chatPage).mockClear());

    it("pages older items in to reach a row read before the window", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: false, item: 100, delta: 0, total: 1000 });
      opened = Promise.resolve(at);
      render(<ChatLens pane={pane} view={idlePi} />);
      reset(500, 1000);
      await waitFor(() => expect(chatPage).toHaveBeenCalledWith(pane, 500));
    });

    it("waits for the path when the reset comes first", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: false, item: 100, delta: 0, total: 1000 });
      let resolve!: (l: unknown) => void;
      opened = new Promise((r) => (resolve = r));
      render(<ChatLens pane={pane} view={idlePi} />);
      reset(500, 1000);
      expect(chatPage).not.toHaveBeenCalled();
      await act(async () => resolve(at));
      await waitFor(() => expect(chatPage).toHaveBeenCalledWith(pane, 500));
    });

    it("says there are new messages when the transcript grew while away", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: false, item: 600, delta: 0, total: 900 });
      opened = Promise.resolve(at);
      render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => {});
      reset(500, 1000);
      expect(await screen.findByText("New messages")).toBeTruthy();
      expect(chatPage).not.toHaveBeenCalled();
    });

    it("stays at the bottom for a reader who left from there, and remembers that on leaving", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: true, item: 0, delta: 0, total: 900 });
      opened = Promise.resolve(at);
      const { unmount } = render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => {});
      reset(500, 1000);
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByText("New messages")).toBeNull();
      expect(chatPage).not.toHaveBeenCalled();
      unmount();
      expect(savedPosition(paneKey(pane), at.path)).toMatchObject({ atBottom: true, total: 1000 });
    });
    it("keeps the saved row when left while older items are still being paged in", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: false, item: 100, delta: 0, total: 1000 });
      opened = Promise.resolve(at);
      vi.mocked(chatPage).mockReturnValueOnce(new Promise(() => {}));
      const { unmount } = render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => {});
      reset(500, 1000);
      await waitFor(() => expect(chatPage).toHaveBeenCalledTimes(1));
      unmount();
      expect(savedPosition(paneKey(pane), at.path)).toMatchObject({ atBottom: false, item: 100 });
    });

    it("does not restore for a later Reset of the same open", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: false, item: 100, delta: 0, total: 1000 });
      opened = Promise.resolve(at);
      let page!: (items: unknown[]) => void;
      vi.mocked(chatPage).mockReturnValueOnce(new Promise((r) => (page = r)) as never);
      render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => {});
      reset(500, 1000);
      await waitFor(() => expect(chatPage).toHaveBeenCalledTimes(1));
      reset(500, 1000);
      await act(async () => page(window(300, 500)));
      await new Promise((r) => setTimeout(r, 20));
      expect(chatPage).toHaveBeenCalledTimes(1);
    });

    it("stops at the earliest loaded row when a page comes back empty", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: false, item: 100, delta: 0, total: 900 });
      opened = Promise.resolve(at);
      render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => {});
      reset(500, 1000);
      expect(await screen.findByText("New messages")).toBeTruthy();
      expect(chatPage).toHaveBeenCalledTimes(1);
    });
  });
});
