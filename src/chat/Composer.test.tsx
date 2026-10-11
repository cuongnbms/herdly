import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({
  herdrCall: vi.fn().mockResolvedValue({}),
  imageSaveTemp: vi.fn(),
  completeCommands: vi.fn(),
  completeFiles: vi.fn(),
  completeEntries: vi.fn(),
  chatGitStatus: vi.fn().mockResolvedValue(null),
}));
vi.mock("./complete", async (orig) => {
  const m = await orig<typeof import("./complete")>();
  return { ...m, rankFiles: vi.fn(m.rankFiles) };
});
vi.mock("./btw", async (orig) => {
  const m = await orig<typeof import("./btw")>();
  return { ...m, askSide: vi.fn().mockResolvedValue(undefined) };
});
import { chatGitStatus, completeCommands, completeEntries, completeFiles, herdrCall, imageSaveTemp } from "../lib/ipc";
import { rankFiles } from "./complete";
import { askSide, setBtwMode, useBtw } from "./btw";
import { paneKey } from "../lib/types";
import { DEFAULT_QUICK_REPLIES, useQuickReplies } from "../settings/quickReplies";
import { Composer } from "./Composer";
import { clearCompletionCache } from "./useCompletions";
import { useDraftImages } from "./draftImages";
import { SUGGESTION_POLL_MS } from "./useClaudeSuggestion";
const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const png = () => new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
const sendButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
const paste = (box: HTMLElement, files: File[], text = "") =>
  fireEvent.paste(box, { clipboardData: { files, getData: () => text } });

beforeEach(() => {
  vi.mocked(herdrCall).mockReset().mockResolvedValue({});
  vi.mocked(imageSaveTemp).mockReset().mockResolvedValue("/tmp/herdr-paste-1.png");
  clearCompletionCache();
  localStorage.clear();
  useDraftImages.setState({ byPane: {} });
  vi.mocked(completeCommands).mockReset().mockResolvedValue([
    { name: "clear", description: "Clear the conversation", source: "builtin" },
    { name: "compact", description: "Compact conversation context", source: "builtin" },
  ]);
  vi.mocked(completeFiles).mockReset().mockResolvedValue(["README.md", "src/x.ts", "src/y.ts", "my docs/a.md"]);
  vi.mocked(completeEntries)
    .mockReset()
    .mockImplementation(async (_p, dir) => (dir === "../" ? ["shared/", "Sibling/", ".hidden/", "notes.md"] : ["a.ts"]));
});

describe("Composer", () => {
  it("sends on Enter, newline on Shift+Enter", () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "fix the bug" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(herdrCall).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "fix the bug" });
    expect((box as HTMLTextAreaElement).value).toBe("");
  });
  it("moves the caret to the line's start and end with Home and End", () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(box, { target: { value: "first line\nsecond line" } });
    box.setSelectionRange(15, 15);
    fireEvent.keyDown(box, { key: "Home" });
    expect([box.selectionStart, box.selectionEnd]).toEqual([11, 11]);
    fireEvent.keyDown(box, { key: "End" });
    expect([box.selectionStart, box.selectionEnd]).toEqual([22, 22]);
    box.setSelectionRange(4, 4);
    fireEvent.keyDown(box, { key: "End" });
    expect([box.selectionStart, box.selectionEnd]).toEqual([10, 10]);
  });
  it("selects to the line's edge with Shift and to the text's edge with Cmd", () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(box, { target: { value: "first line\nsecond line" } });
    box.setSelectionRange(15, 15);
    fireEvent.keyDown(box, { key: "Home", shiftKey: true });
    expect([box.selectionStart, box.selectionEnd, box.selectionDirection]).toEqual([11, 15, "backward"]);
    fireEvent.keyDown(box, { key: "End", shiftKey: true });
    expect([box.selectionStart, box.selectionEnd]).toEqual([15, 22]);
    fireEvent.keyDown(box, { key: "Home", metaKey: true });
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 0]);
    fireEvent.keyDown(box, { key: "End", ctrlKey: true, shiftKey: true });
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 22]);
  });
  it("sends Esc", () => {
    render(<Composer pane={pane} agent="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.send_keys", { target: "w1:p1", keys: ["esc"] });
  });

  it("enables Stop only while the agent works, and Stop sends Esc", () => {
    const stop = () => screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    const { rerender } = render(<Composer pane={pane} agent="claude" status="idle" />);
    expect(stop().disabled).toBe(true);
    rerender(<Composer pane={pane} agent="claude" status="working" />);
    expect(stop().disabled).toBe(false);
    fireEvent.click(stop());
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.send_keys", { target: "w1:p1", keys: ["esc"] });
    // Text typed while the agent works still sends: the agent queues it.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "also check the docs" } });
    expect(sendButton().disabled).toBe(false);
  });

  it("keeps each pane's unsent text across remounts and clears it once sent", () => {
    const other = { ...pane, pane_id: "w1:p2" };
    const first = render(<Composer pane={pane} agent="claude" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "half a thought" } });
    first.unmount();

    const second = render(<Composer pane={other} agent="claude" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    second.unmount();

    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.value).toBe("half a thought");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(localStorage.getItem("herdly:draft:devtuf/default/w1:p1")).toBeNull();
  });

  it("restores the draft when the send fails", async () => {
    vi.mocked(herdrCall).mockRejectedValueOnce({ code: "timeout", message: "timed out" });
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "try again" } });
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(box.value).toBe("try again");
    // Written once the debounce passes.
    await waitFor(() => expect(localStorage.getItem("herdly:draft:devtuf/default/w1:p1")).toBe("try again"));
  });

  it("reports a send before it goes out and settles it once it went through", async () => {
    let resolve!: () => void;
    vi.mocked(herdrCall).mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)));
    const settle = vi.fn();
    const onSend = vi.fn(() => settle);
    render(<Composer pane={pane} agent="claude" onSend={onSend} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello", []);
    expect(settle).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(settle).toHaveBeenCalledWith(true);
  });

  it("reports a quick reply as a send", async () => {
    useQuickReplies.setState({ show: true, replies: ["yes"] });
    const settle = vi.fn();
    const onSend = vi.fn(() => settle);
    render(<Composer pane={pane} agent="claude" onSend={onSend} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "yes" })));
    expect(onSend).toHaveBeenCalledWith("yes", []);
    expect(settle).toHaveBeenCalledWith(true);
  });

  it("settles a failed send as failed and keeps the pasted image for the restored draft", async () => {
    vi.mocked(herdrCall).mockRejectedValue({ code: "timeout", message: "timed out" });
    const settle = vi.fn();
    const onSend = vi.fn(() => settle);
    render(<Composer pane={pane} agent="pi" onSend={onSend} />);
    const box = screen.getByRole("textbox");
    paste(box, [png()]);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(onSend).toHaveBeenCalledWith("", [expect.any(String)]);
    expect(settle).toHaveBeenCalledWith(false);
    expect(screen.getByRole("img", { name: "Pasted image 1" })).toBeTruthy();
  });

  it("saves a pasted image on the pane's machine and shows it as an attachment", async () => {
    render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [png()]);
    expect(sendButton().disabled).toBe(true);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    expect(imageSaveTemp).toHaveBeenCalledWith("devtuf", expect.any(Uint8Array), "png");
    expect(screen.getByRole("img", { name: "Pasted image 1" })).toBeTruthy();
  });

  it("pastes each image path for claude, then submits the text", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    paste(box, [png()]);
    fireEvent.change(box, { target: { value: "what is this" } });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    // The submit waits for Claude to attach the pasted image.
    expect(vi.mocked(herdrCall).mock.calls.map((c) => c[2])).toEqual(["pane.send_text"]);
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(vi.mocked(herdrCall).mock.calls).toEqual([
      ["devtuf", "default", "pane.send_text", { pane_id: "w1:p1", text: "\x1b[200~/tmp/herdr-paste-1.png\x1b[201~" }],
      ["devtuf", "default", "agent.prompt", { target: "w1:p1", text: "what is this" }],
    ]);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("submits images alone with Enter", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    paste(box, [png()]);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(vi.mocked(herdrCall).mock.calls.map((c) => c[2])).toEqual(["pane.send_text", "agent.send_keys"]);
    expect(herdrCall).toHaveBeenLastCalledWith("devtuf", "default", "agent.send_keys", { target: "w1:p1", keys: ["enter"] });
  });

  it("mentions image paths with @ for agents without path-paste attachments", async () => {
    render(<Composer pane={pane} agent="pi" />);
    const box = screen.getByRole("textbox");
    paste(box, [png()]);
    fireEvent.change(box, { target: { value: "describe" } });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(vi.mocked(herdrCall).mock.calls).toEqual([
      ["devtuf", "default", "agent.prompt", { target: "w1:p1", text: "@/tmp/herdr-paste-1.png describe" }],
    ]);
  });

  it("removes an attachment", async () => {
    render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [png()]);
    await waitFor(() => expect(screen.getByRole("img", { name: "Pasted image 1" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove image 1" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(sendButton().disabled).toBe(true);
  });

  it("drops the attachment and reports a failed save", async () => {
    vi.mocked(imageSaveTemp).mockRejectedValue({ code: "not_found", message: "machine devtuf is not connected" });
    render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [png()]);
    expect((await screen.findByRole("alert")).textContent).toContain("machine devtuf is not connected");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps a pasted image through a tab switch, for its own pane only", async () => {
    const { unmount } = render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [png()]);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    unmount();
    const other = render(<Composer pane={{ ...pane, pane_id: "w1:p2" }} agent="claude" />);
    expect(screen.queryByRole("img")).toBeNull();
    other.unmount();
    render(<Composer pane={pane} agent="claude" />);
    expect(screen.getByRole("img", { name: "Pasted image 1" })).toBeTruthy();
    expect(sendButton().disabled).toBe(false);
  });

  it("finishes saving an image pasted just before a tab switch", async () => {
    let finish: (path: string) => void = () => {};
    vi.mocked(imageSaveTemp).mockReturnValue(new Promise((r) => (finish = r)));
    const { unmount } = render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [png()]);
    await waitFor(() => expect(imageSaveTemp).toHaveBeenCalled());
    unmount();
    await act(async () => finish("/tmp/herdr-paste-1.png"));
    render(<Composer pane={pane} agent="claude" />);
    expect(screen.getByRole("img", { name: "Pasted image 1" })).toBeTruthy();
    expect(sendButton().disabled).toBe(false);
  });

  it("shows each pane's own images when one Composer switches panes", async () => {
    const { rerender } = render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [png()]);
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    rerender(<Composer pane={{ ...pane, pane_id: "w1:p2" }} agent="claude" />);
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<Composer pane={pane} agent="claude" />);
    expect(screen.getByRole("img", { name: "Pasted image 1" })).toBeTruthy();
  });

  it("leaves text-only pastes to the textarea", () => {
    render(<Composer pane={pane} agent="claude" />);
    paste(screen.getByRole("textbox"), [], "hello");
    expect(imageSaveTemp).not.toHaveBeenCalled();
  });
});

const RULE = "\u001b[38;2;136;136;136m" + "─".repeat(60) + "\u001b[0m";
const claudeScreen = (suggestion: string) => ["● done", RULE, `❯ \u001b[2m${suggestion}\u001b[0m`, RULE, "  ⏵⏵ accept edits on"].join("\r\n");
const reads = () => vi.mocked(herdrCall).mock.calls.filter((c) => c[2] === "pane.read");

describe("Composer suggestion", () => {
  beforeEach(() => {
    vi.mocked(herdrCall).mockImplementation(async (_m, _s, method) =>
      method === "pane.read" ? { text: claudeScreen("run the tests again") } : {},
    );
  });

  it("shows Claude's suggestion as the placeholder and takes it with Tab", async () => {
    render(<Composer pane={pane} agent="claude" status="done" />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(box.placeholder).toContain("run the tests again"));
    expect(reads()[0][3]).toEqual({ pane_id: "w1:p1", source: "visible", format: "ansi", strip_ansi: false });
    const tab = fireEvent.keyDown(box, { key: "Tab" });
    expect(tab).toBe(false);
    expect(box.value).toBe("run the tests again");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "run the tests again" });
  });

  it("does not read the old suggestion back while a send is on its way", async () => {
    let finish!: () => void;
    render(<Composer pane={pane} agent="claude" status="idle" />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(box.placeholder).toContain("run the tests again"));
    vi.mocked(herdrCall).mockImplementation(async (_m, _s, method) => {
      if (method === "pane.read") return { text: claudeScreen("run the tests again") };
      await new Promise<void>((r) => (finish = r));
      return {};
    });
    const before = reads().length;
    fireEvent.change(box, { target: { value: "something else" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await act(async () => {});
    expect(reads()).toHaveLength(before);
    expect(box.placeholder).not.toContain("run the tests again");
    await act(async () => finish());
  });

  it("leaves Tab alone while something is typed", async () => {
    render(<Composer pane={pane} agent="claude" status="idle" />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(box.placeholder).toContain("run the tests again"));
    fireEvent.change(box, { target: { value: "my own" } });
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
    expect(box.value).toBe("my own");
  });

  it("reads again while Claude waits, and drops the suggestion once it works", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Composer pane={pane} agent="claude" status="idle" />);
      await act(async () => {});
      expect(reads()).toHaveLength(1);
      vi.mocked(herdrCall).mockImplementation(async (_m, _s, method) =>
        method === "pane.read" ? { text: claudeScreen("commit it") } : {},
      );
      await act(async () => vi.advanceTimersByTime(SUGGESTION_POLL_MS));
      expect(reads()).toHaveLength(2);
      const box = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(box.placeholder).toContain("commit it");

      rerender(<Composer pane={pane} agent="claude" status="working" />);
      expect(box.placeholder).not.toContain("commit it");
      await act(async () => vi.advanceTimersByTime(SUGGESTION_POLL_MS * 3));
      expect(reads()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads no suggestion for other agents", async () => {
    render(<Composer pane={pane} agent="codex" status="idle" />);
    await act(async () => {});
    expect(reads()).toHaveLength(0);
  });
});

const type = (box: HTMLElement, value: string) =>
  fireEvent.change(box, { target: { value, selectionStart: value.length, selectionEnd: value.length } });

describe("Composer completion", () => {
  it("inserts the chosen slash command without sending and counts the pick", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    await screen.findByRole("option", { name: /\/clear/ });
    expect(completeCommands).toHaveBeenCalledWith(pane);
    expect(screen.getByText("dismiss")).toBeTruthy();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
    expect(herdrCall).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(JSON.parse(localStorage.getItem("herdly:slash-usage:claude")!)).toEqual({ compact: 1 });
  });

  it("dismisses with Escape, after which Enter sends", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "/c" });
  });

  it("completes a file path with Tab", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "look at @src/x");
    await screen.findByRole("option", { name: /src\/x\.ts/ });
    expect(completeFiles).toHaveBeenCalledWith(pane);
    fireEvent.keyDown(box, { key: "Tab" });
    expect((box as HTMLTextAreaElement).value).toBe("look at @src/x.ts ");
  });

  it("lists the parent folder for @../ and drills into a chosen folder", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "@../");
    await screen.findByRole("option", { name: /\.\.\/shared\// });
    expect(completeEntries).toHaveBeenCalledWith(pane, "../");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("../shared/"),
      expect.stringContaining("../Sibling/"),
      expect.stringContaining("../notes.md"),
    ]);
    type(box, "@../s");
    await screen.findByRole("option", { name: /\.\.\/Sibling\// });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(box, { key: "Tab" });
    expect((box as HTMLTextAreaElement).value).toBe("@../shared/");
    await screen.findByRole("option", { name: /\.\.\/shared\/a\.ts/ });
    expect(completeEntries).toHaveBeenCalledWith(pane, "../shared/");
    fireEvent.keyDown(box, { key: "Tab" });
    expect((box as HTMLTextAreaElement).value).toBe("@../shared/a.ts ");
  });

  it("ranks files only when the list or the query changes", async () => {
    const { rerender } = render(<Composer pane={pane} agent="claude" status="idle" />);
    const box = screen.getByRole("textbox");
    type(box, "@src");
    await screen.findByRole("option", { name: /src\/x\.ts/ });
    const calls = vi.mocked(rankFiles).mock.calls.length;
    rerender(<Composer pane={pane} agent="claude" status="working" />);
    expect(vi.mocked(rankFiles).mock.calls.length).toBe(calls);
    type(box, "@src/y");
    await screen.findByRole("option", { name: /src\/y\.ts/ });
    expect(vi.mocked(rankFiles).mock.calls.length).toBe(calls + 1);
  });

  it("quotes a path with spaces", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "@my");
    await screen.findByRole("option", { name: /my docs\/a\.md/ });
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toBe('@"my docs/a.md" ');
  });

  it("chooses a row with the mouse", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    fireEvent.mouseDown(await screen.findByRole("option", { name: /\/compact/ }));
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
  });

  it("offers no slash commands to other agents", async () => {
    render(<Composer pane={pane} agent="gemini" />);
    type(screen.getByRole("textbox"), "/c");
    await act(async () => {});
    expect(completeCommands).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows a failed listing in the list and still sends on Enter", async () => {
    vi.mocked(completeFiles).mockRejectedValue({ code: "not_found", message: "machine devtuf is not connected" });
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "see @sr");
    expect(await screen.findByText("Couldn't list files")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "see @sr" });
  });

  it("closes a failed listing with Escape", async () => {
    vi.mocked(completeFiles).mockRejectedValue({ code: "not_found", message: "machine devtuf is not connected" });
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "see @sr");
    await screen.findByText("Couldn't list files");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(herdrCall).not.toHaveBeenCalled();
  });

  it("closes a loading listing with Escape", async () => {
    vi.mocked(completeCommands).mockReturnValue(new Promise(() => {}));
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    expect(await screen.findByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("leaves Shift+Enter a newline while the list is open", async () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole("textbox");
    type(box, "/c");
    await screen.findByRole("option", { name: /\/clear/ });
    const shiftEnter = fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    // Not prevented: the textarea inserts its newline.
    expect(shiftEnter).toBe(true);
    expect((box as HTMLTextAreaElement).value).toBe("/c");
    expect(herdrCall).not.toHaveBeenCalled();
  });

  it("keeps showing an expired listing while it refetches", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000_000);
      const first = render(<Composer pane={pane} agent="claude" />);
      type(screen.getByRole("textbox"), "/c");
      await screen.findByRole("option", { name: /\/clear/ });
      first.unmount();
      // Start blank rather than from the "/c" draft, so typing it again is a change.
      localStorage.removeItem("herdly:draft:devtuf/default/w1:p1");

      render(<Composer pane={pane} agent="claude" />);
      const box = screen.getByRole("textbox");
      type(box, "/c");
      expect(screen.getByRole("option", { name: /\/clear/ })).toBeTruthy();
      expect(completeCommands).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1_031_000);
      type(box, "/co");
      expect(screen.getByRole("option", { name: /\/compact/ })).toBeTruthy();
      expect(screen.queryByText(/Loading/)).toBeNull();
      await waitFor(() => expect(completeCommands).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole("option", { name: /\/compact/ })).toBeTruthy();
    } finally {
      now.mockRestore();
    }
  });
});

describe("Composer quick replies", () => {
  beforeEach(() => useQuickReplies.setState({ show: true, replies: [...DEFAULT_QUICK_REPLIES] }));

  it("sends a quick reply at once, leaving the draft alone", () => {
    render(<Composer pane={pane} agent="claude" />);
    const box = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(box, { target: { value: "half a thought" } });
    const group = screen.getByRole("group", { name: "Quick replies" });
    fireEvent.click(within(group).getByRole("button", { name: "continue" }));
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "continue" });
    expect(box.value).toBe("half a thought");
  });

  it("disables the replies while one is on its way", async () => {
    let finish: (v: unknown) => void = () => {};
    vi.mocked(herdrCall).mockReturnValueOnce(new Promise((r) => (finish = r)));
    render(<Composer pane={pane} agent="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "yes" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "no" }).disabled).toBe(true);
    await act(async () => finish({}));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "no" }).disabled).toBe(false);
  });

  it("shows the replies with text only, and none when switched off", () => {
    useQuickReplies.setState({ replies: ["ship it", "  "] });
    const { unmount } = render(<Composer pane={pane} agent="claude" />);
    expect(within(screen.getByRole("group", { name: "Quick replies" })).getAllByRole("button")).toHaveLength(1);
    unmount();
    useQuickReplies.setState({ show: false });
    render(<Composer pane={pane} agent="claude" />);
    expect(screen.queryByRole("group", { name: "Quick replies" })).toBeNull();
  });
});

describe("Composer /model to pi", () => {
  const sendText = (value: string) => {
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value } });
    fireEvent.keyDown(box, { key: "Enter" });
  };

  it("calls onPiModel once /model has gone to pi", async () => {
    const onPiModel = vi.fn();
    render(<Composer pane={pane} agent="pi" onPiModel={onPiModel} />);
    sendText(" /model ");
    await waitFor(() => expect(onPiModel).toHaveBeenCalledTimes(1));
  });

  it("calls onPiModel for /model with a name after it", async () => {
    const onPiModel = vi.fn();
    render(<Composer pane={pane} agent="pi" onPiModel={onPiModel} />);
    sendText("/model sonnet");
    await waitFor(() => expect(onPiModel).toHaveBeenCalledTimes(1));
  });

  it("does not call onPiModel for claude, for another command, or for a failed send", async () => {
    const onPiModel = vi.fn();
    const { unmount } = render(<Composer pane={pane} agent="claude" onPiModel={onPiModel} />);
    sendText("/model");
    unmount();
    render(<Composer pane={{ ...pane, pane_id: "w1:p2" }} agent="pi" onPiModel={onPiModel} />);
    sendText("/models");
    sendText("/tree");
    vi.mocked(herdrCall).mockRejectedValueOnce({ code: "timeout", message: "timed out" });
    sendText("/model");
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(4));
    await act(async () => {});
    expect(onPiModel).not.toHaveBeenCalled();
  });
});

describe("Composer model label", () => {
  it("shows the Model, effort and context tokens when known", () => {
    render(<Composer pane={pane} agent="claude" meta={{ model: "claude-opus-5-5", effort: "high", context_tokens: 48612 }} />);
    const label = screen.getByTitle("Model · reasoning effort · context tokens");
    expect(label.textContent).toBe("claude-opus-5-5 · high · 48.6k");
  });
  it("shows nothing when neither is known", () => {
    render(<Composer pane={pane} agent="pi" meta={{ model: null, effort: null, context_tokens: null }} />);
    expect(screen.queryByTitle("Model · reasoning effort · context tokens")).toBeNull();
  });
  it("stays plain text for agents other than Claude", () => {
    render(<Composer pane={pane} agent="pi" meta={{ model: "gpt-5", effort: null, context_tokens: null }} />);
    expect(screen.getByTitle("Model · reasoning effort · context tokens").tagName).toBe("SPAN");
  });
});

describe("Composer model menu", () => {
  const meta = { model: "claude-opus-5-5", effort: "high", context_tokens: null };
  const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /claude-opus-5-5 · high/ }));

  it("switches Claude's model with /model", () => {
    render(<Composer pane={pane} agent="claude" status="idle" meta={meta} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "sonnet" }));
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "/model sonnet" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("sets Claude's effort with /effort", () => {
    render(<Composer pane={pane} agent="claude" status="idle" meta={meta} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "max" }));
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "agent.prompt", { target: "w1:p1", text: "/effort max" });
  });
  it("checks the current model and effort", () => {
    render(<Composer pane={pane} agent="claude" status="idle" meta={meta} />);
    openMenu();
    expect(screen.getByRole("menuitemradio", { name: "opus" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "fable" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("menuitemradio", { name: "high" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "sonnet" }).getAttribute("aria-checked")).toBe("false");
  });
  it("closes on Escape without sending", () => {
    render(<Composer pane={pane} agent="claude" status="idle" meta={meta} />);
    openMenu();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(herdrCall).not.toHaveBeenCalledWith("devtuf", "default", "agent.prompt", expect.anything());
  });
  it("offers the menu before the Transcript names a model", () => {
    render(<Composer pane={pane} agent="claude" status="idle" />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("menu")).toBeTruthy();
  });
  it("is unavailable while Claude works or waits on a prompt", () => {
    const { rerender } = render(<Composer pane={pane} agent="claude" status="working" meta={meta} />);
    const button = () => screen.getByRole<HTMLButtonElement>("button", { name: /claude-opus-5-5 · high/ });
    expect(button().disabled).toBe(true);
    rerender(<Composer pane={pane} agent="claude" status="blocked" meta={meta} />);
    expect(button().disabled).toBe(true);
  });
});

describe("btw mode", () => {
  beforeEach(() => {
    vi.mocked(askSide).mockClear();
    useBtw.setState({ threads: {}, mode: {} });
  });

  it("has no btw button without a transcript path", () => {
    render(<Composer pane={pane} agent="claude" />);
    expect(screen.queryByRole("button", { name: "btw" })).toBeNull();
  });

  it("Cmd+B switches to btw mode and Enter asks a side question, not the agent", async () => {
    render(<Composer pane={pane} agent="claude" btwPath="/p/t1.jsonl" />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "main draft" } });
    fireEvent.keyDown(box, { key: "b", code: "KeyB", metaKey: true });
    expect(screen.getByRole("button", { name: "btw" }).getAttribute("aria-pressed")).toBe("true");
    expect((box as HTMLTextAreaElement).value).toBe("");
    expect(box.getAttribute("placeholder")).toBe("Ask a side question (not added to the Transcript)…");
    fireEvent.change(box, { target: { value: "why?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(askSide).toHaveBeenCalledWith(pane, "/p/t1.jsonl", "why?");
    expect(herdrCall).not.toHaveBeenCalledWith("devtuf", "default", "agent.prompt", expect.anything());
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByRole("button", { name: "btw" }).getAttribute("aria-pressed")).toBe("false");
    expect((box as HTMLTextAreaElement).value).toBe("main draft");
  });

  it("swaps Drafts when the mode changes from outside", () => {
    render(<Composer pane={pane} agent="claude" btwPath="/p/t1.jsonl" />);
    const box = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.change(box, { target: { value: "main draft" } });
    act(() => setBtwMode(paneKey(pane), true));
    expect(box.value).toBe("");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.value).toBe("main draft");
  });

  it("hides Stop in btw mode, since it would interrupt the Agent, but keeps its place in the row", () => {
    const { container } = render(<Composer pane={pane} agent="claude" status="working" btwPath="/p/t1.jsonl" />);
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    act(() => setBtwMode(paneKey(pane), true));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    const kept = container.querySelector<HTMLButtonElement>("button.stop")!;
    expect(kept.hidden).toBe(true);
    expect(kept.disabled).toBe(true);
  });

  it("btwOnly is always in btw mode, with nothing that talks to the Agent", () => {
    useQuickReplies.setState({ show: true, replies: DEFAULT_QUICK_REPLIES });
    vi.mocked(chatGitStatus).mockClear();
    const { container } = render(<Composer pane={pane} agent="claude" status="blocked" btwPath="/p/t1.jsonl" btwOnly />);
    const box = screen.getByRole("textbox");
    expect(box.getAttribute("placeholder")).toBe("Ask a side question (not added to the Transcript)…");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(container.querySelector(".composer-model")).toBeNull();
    expect(container.querySelector(".composer-quick")).toBeNull();
    expect(container.querySelector(".composer-keys")).toBeNull();
    expect(chatGitStatus).not.toHaveBeenCalled(); // no git status line
    fireEvent.change(box, { target: { value: "why?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(askSide).toHaveBeenCalledWith(pane, "/p/t1.jsonl", "why?");
    expect(herdrCall).not.toHaveBeenCalledWith("devtuf", "default", "agent.prompt", expect.anything());
  });

  it("Esc, Cmd+B and the btw button turn btwOnly's mode off", () => {
    render(<Composer pane={pane} agent="claude" btwPath="/p/t1.jsonl" btwOnly />);
    const box = screen.getByRole("textbox");
    for (const leave of [
      () => fireEvent.keyDown(box, { key: "Escape" }),
      () => fireEvent.keyDown(box, { key: "b", code: "KeyB", metaKey: true }),
      () => fireEvent.click(screen.getByRole("button", { name: "btw" })),
    ]) {
      act(() => setBtwMode(paneKey(pane), true));
      leave();
      expect(useBtw.getState().mode[paneKey(pane)]).toBe(false);
    }
  });

  it("disables Send while the side question runs", () => {
    useBtw.setState({
      threads: { [paneKey(pane)]: { path: "/p/t1.jsonl", turns: [{ q: "q", a: "", tools: [], running: true }] } },
      mode: { [paneKey(pane)]: true },
    });
    render(<Composer pane={pane} agent="claude" btwPath="/p/t1.jsonl" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "next" } });
    expect(sendButton().disabled).toBe(true);
  });
});
