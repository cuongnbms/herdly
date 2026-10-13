import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ chatImage: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer) }));
import { ChatItemView } from "./ChatItemView";
import { ChatPaneContext } from "./images";
import { useApp, viewedItems } from "../store/app";
import { useFiles } from "../files/store";
describe("ChatItemView", () => {
  it("renders markdown", () => {
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "Hello **world**" }} />);
    expect(screen.getByText("world").tagName).toBe("STRONG");
  });
  it("renders a GFM table", () => {
    const { container } = render(<ChatItemView item={{ kind: "assistant_text", markdown: "| a | b |\n|---|---|\n| 1 | 2 |" }} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(screen.getByText("2").tagName).toBe("TD");
  });
  it("collapses a tool call and expands to its result", () => {
    render(<ChatItemView item={{ kind: "tool_call", id: "t1", name: "Bash", input_summary: "ls", input: { command: "ls" } }}
      result={{ kind: "tool_result", call_id: "t1", output: "a.txt", is_error: false }} />);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.queryByText("a.txt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Bash/ }));
    expect(screen.getByText("a.txt")).toBeTruthy();
  });
  it("marks a tool row with the tool's icon", () => {
    render(<ChatItemView item={{ kind: "tool_call", id: "t1", name: "Bash", input_summary: "ls", input: { command: "ls" } }} />);
    const row = screen.getByRole("button", { name: /Bash/ });
    expect(row.querySelector("svg.chat-tool-icon")).toBeTruthy();
  });
  it("renders Edit as a diff", () => {
    render(<ChatItemView item={{ kind: "tool_call", id: "t2", name: "Edit", input_summary: "/a.rs", input: { file_path: "/a.rs", old_string: "let a = 1;", new_string: "let a = 2;" } }} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(screen.getByText("- let a = 1;")).toBeTruthy();
    expect(screen.getByText("+ let a = 2;")).toBeTruthy();
  });
  it("renders Write as all-added lines", () => {
    render(<ChatItemView item={{ kind: "tool_call", id: "t3", name: "Write", input_summary: "/b.rs", input: { file_path: "/b.rs", content: "one\ntwo" } }} />);
    fireEvent.click(screen.getByRole("button", { name: /Write/ }));
    expect(screen.getByText("+ one")).toBeTruthy();
    expect(screen.getByText("+ two")).toBeTruthy();
  });
  it("renders MultiEdit as consecutive diffs", () => {
    render(<ChatItemView item={{ kind: "tool_call", id: "t4", name: "MultiEdit", input_summary: "/c", input: { file_path: "/c", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] } }} />);
    fireEvent.click(screen.getByRole("button", { name: /MultiEdit/ }));
    expect(screen.getByText("- c")).toBeTruthy();
    expect(screen.getByText("+ d")).toBeTruthy();
  });
  it("renders a shell command as a monospace bubble that copies the command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = render(<ChatItemView item={{ kind: "shell_command", command: "ls -la" }} copy />);
    expect(container.querySelector(".chat-bubble.chat-shell-command")?.textContent).toBe("!ls -la");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("ls -la"));
  });
  it("renders shell output with stderr marked as an error", () => {
    const { container } = render(<ChatItemView item={{ kind: "shell_output", stdout: "a.txt", stderr: "denied" }} />);
    expect(screen.getByText("a.txt").className).toBe("chat-result");
    expect(screen.getByText("denied").className).toBe("chat-result error");
    expect(container.querySelector(".chat-shell-more")).toBeNull();
  });
  it("folds long shell output until expanded", () => {
    const stdout = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    render(<ChatItemView item={{ kind: "shell_output", stdout, stderr: "" }} />);
    expect(screen.getByText(/line 12$/)).toBeTruthy();
    expect(screen.queryByText(/line 13/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 18 more lines" }));
    expect(screen.getByText(/line 30$/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /more lines/ })).toBeNull();
  });
  it("copies a user message and an answer's markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { unmount } = render(<ChatItemView item={{ kind: "user", text: "fix the bug" }} copy />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("fix the bug"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    unmount();
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "Done **now**" }} copy />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Done **now**"));
  });
  it("copies a code block's source from its head", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "Run:\n\n```sh\necho hi\nls\n```\n" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("echo hi\nls"));
  });
  it("offers no copy unless asked (narration in a work block)", () => {
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "Looking at the file" }} />);
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
  it("highlights fenced code", () => {
    const { container } = render(<ChatItemView item={{ kind: "assistant_text", markdown: "```js\nconst a = 1;\n```" }} />);
    expect(container.querySelector("code.hljs, code .hljs-keyword")).toBeTruthy();
  });
  it("shows a user turn's images above an image-only bubble", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    render(<ChatPaneContext.Provider value={{ machine_id: "m", session: "s", pane_id: "p" }}>
      <ChatItemView item={{ kind: "user", text: "", images: [{ ref: "u:0", media_type: "image/png" }] }} copy />
    </ChatPaneContext.Provider>);
    expect(await screen.findByRole("img", { name: "Image 1" })).toBeTruthy();
    expect(document.querySelector(".chat-bubble")).toBeNull();
  });
  it("offers no copy on an image-only user turn", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    render(<ChatPaneContext.Provider value={{ machine_id: "m", session: "s", pane_id: "p" }}>
      <ChatItemView item={{ kind: "user", text: "", images: [{ ref: "u:0", media_type: "image/png" }] }} copy />
    </ChatPaneContext.Provider>);
    await screen.findByRole("img", { name: "Image 1" });
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
  it("puts the copy button beside the user bubble, images above, Skill chips below", () => {
    const { container } = render(
      <ChatItemView item={{ kind: "user", text: "go", skills: [{ name: "tdd", path: "/s/tdd" }] }} copy />,
    );
    const row = container.querySelector(".chat-user")!;
    const line = row.querySelector(":scope > .chat-user-line")!;
    expect(line.querySelector(".chat-bubble")).toBeTruthy();
    expect(line.querySelector(".chat-copy")).toBeTruthy();
    expect(row.lastElementChild!.classList.contains("skill-chips")).toBe(true);
  });
});

describe("file paths open in Files", () => {
  const pane = { machine_id: "local", session: "default", pane_id: "p1" };
  beforeEach(() => {
    localStorage.clear();
    useFiles.setState({ byWs: {} });
    useApp.setState({
      selected: pane,
      machines: {
        local: { id: "local", sessions: [{ name: "default", workspaces: [{ workspace_id: "w1", tabs: [{ panes: [{ pane_id: "p1", cwd: "/w/app" }] }] }] }] },
      } as never,
    });
  });
  const inPane = (ui: React.ReactNode) => render(<ChatPaneContext.Provider value={pane}>{ui}</ChatPaneContext.Provider>);

  it("opens inline code that reads as a path on ⌘-click", () => {
    inPane(<ChatItemView item={{ kind: "assistant_text", markdown: "Wrote `docs/a.md` and `/point`." }} />);
    const before = viewedItems(useApp.getState()).items;
    fireEvent.click(screen.getByRole("link", { name: "docs/a.md" }));
    expect(viewedItems(useApp.getState()).items).toBe(before);
    fireEvent.click(screen.getByRole("link", { name: "docs/a.md" }), { metaKey: true });
    expect(viewedItems(useApp.getState()).active).toBe("file:local/default/w1|/w/app|docs/a.md");
    expect(useApp.getState().selected).toEqual(pane);
    expect(screen.queryByRole("link", { name: "/point" })).toBeNull();
  });
  it("leaves inline code plain outside a chat pane and in a fenced block", () => {
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "`docs/a.md`" }} />);
    expect(screen.queryByRole("link")).toBeNull();
    inPane(<ChatItemView item={{ kind: "assistant_text", markdown: "```\ndocs/b.md\n```" }} />);
    expect(screen.queryByRole("link", { name: /docs\/b\.md/ })).toBeNull();
  });
  it("opens a tool call's file on ⌘-click without toggling the call", () => {
    inPane(<ChatItemView item={{ kind: "tool_call", id: "t1", name: "Write", input_summary: "/w/app/src/x.ts", input: { file_path: "/w/app/src/x.ts", content: "x" } }} />);
    fireEvent.click(screen.getByRole("link", { name: "/w/app/src/x.ts" }), { metaKey: true });
    expect(viewedItems(useApp.getState()).active).toBe("file:local/default/w1|/w/app|src/x.ts");
    expect(screen.getByRole("button", { name: /Write/ }).getAttribute("aria-expanded")).toBe("false");
  });
  it("toggles the tool call on a plain click of its file", () => {
    inPane(<ChatItemView item={{ kind: "tool_call", id: "t1", name: "Write", input_summary: "/w/app/src/x.ts", input: { file_path: "/w/app/src/x.ts", content: "x" } }} />);
    const before = viewedItems(useApp.getState()).items;
    fireEvent.click(screen.getByRole("link", { name: "/w/app/src/x.ts" }));
    expect(viewedItems(useApp.getState()).items).toBe(before);
    expect(screen.getByRole("button", { name: /Write/ }).getAttribute("aria-expanded")).toBe("true");
  });
  it("says so when the file is outside the workspace folder", () => {
    inPane(<ChatItemView item={{ kind: "assistant_text", markdown: "`/etc/x.conf`" }} />);
    const before = viewedItems(useApp.getState()).items;
    fireEvent.click(screen.getByRole("link", { name: "/etc/x.conf" }), { metaKey: true });
    expect(viewedItems(useApp.getState()).items).toBe(before);
  });
});

describe("a long tool path", () => {
  it("still opens when the summary cut it short", () => {
    const pane = { machine_id: "local", session: "default", pane_id: "p1" };
    useApp.setState({
      selected: pane,
      machines: { local: { id: "local", sessions: [{ name: "default", workspaces: [{ workspace_id: "w1", tabs: [{ panes: [{ pane_id: "p1", cwd: "/w/app" }] }] }] }] } } as never,
    });
    const file = "/w/app/" + "d/".repeat(70) + "x.md";
    render(
      <ChatPaneContext.Provider value={pane}>
        <ChatItemView item={{ kind: "tool_call", id: "t1", name: "Read", input_summary: file.slice(0, 120) + "…", input: { file_path: file } }} />
      </ChatPaneContext.Provider>,
    );
    fireEvent.click(screen.getByRole("link"), { metaKey: true });
    expect(viewedItems(useApp.getState()).active).toMatch(/^file:local\/default\/w1\|\/w\/app\|d\/d\//);
  });
});

describe("Fork button", () => {
  it("shows on a user message with an id and forks with its id and text", () => {
    const onFork = vi.fn();
    render(<ChatItemView item={{ kind: "user", id: "u4", text: "three" }} copy onFork={onFork} />);
    fireEvent.click(screen.getByRole("button", { name: "Fork from here" }));
    expect(onFork).toHaveBeenCalledWith({ id: "u4", text: "three" });
  });

  it("is absent without an id or without onFork", () => {
    const { rerender } = render(<ChatItemView item={{ kind: "user", text: "x" }} copy onFork={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Fork from here" })).toBeNull();
    rerender(<ChatItemView item={{ kind: "user", id: "u1", text: "x" }} copy />);
    expect(screen.queryByRole("button", { name: "Fork from here" })).toBeNull();
  });

  it("is disabled and busy while its fork runs", () => {
    const onFork = vi.fn();
    const { rerender } = render(<ChatItemView item={{ kind: "user", id: "u4", text: "three" }} copy onFork={onFork} forking />);
    const button = screen.getByRole("button", { name: "Fork from here" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onFork).not.toHaveBeenCalled();
    rerender(<ChatItemView item={{ kind: "user", id: "u4", text: "three" }} copy onFork={onFork} />);
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("Fork from latest button", () => {
  it("shows on an answer given onForkLatest and forks from the latest entry", () => {
    const onForkLatest = vi.fn();
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "done" }} copy onForkLatest={onForkLatest} />);
    fireEvent.click(screen.getByRole("button", { name: "Fork from latest" }));
    expect(onForkLatest).toHaveBeenCalledTimes(1);
  });

  it("is absent without onForkLatest", () => {
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "done" }} copy />);
    expect(screen.queryByRole("button", { name: "Fork from latest" })).toBeNull();
  });

  it("is disabled and busy while its fork runs", () => {
    const onForkLatest = vi.fn();
    render(<ChatItemView item={{ kind: "assistant_text", markdown: "done" }} copy onForkLatest={onForkLatest} forking />);
    const button = screen.getByRole("button", { name: "Fork from latest" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});
