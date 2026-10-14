import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
/** File texts that files_read answers with, by rel ("x" otherwise). */
const texts = vi.hoisted(() => ({}) as Record<string, string>);
/** Rels that files_read reports as cut at the read limit. */
const truncated = vi.hoisted(() => new Set<string>());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { rel?: string }) => {
    if (cmd === "files_read") {
      const text = texts[args?.rel ?? ""] ?? "x";
      return { kind: "text", text, truncated: truncated.has(args?.rel ?? ""), size: text.length, mtime: 1 };
    }
    if (cmd === "files_html_put") return "t";
    return [];
  }),
  Channel: class {
    onmessage?: (e: unknown) => void;
  },
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn(), showProgressToast: vi.fn(() => 1), updateToast: vi.fn() }));
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => ({ diagramType: "flowchart" })),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 10 10"></svg>' })),
  },
}));
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { showToast } from "../ui/Toast";
import { useApp, viewedItems } from "../store/app";
import { useFilesBus } from "./bus";
import { FileViewer } from "./FileViewer";
import { HIGHLIGHT_LIMIT } from "./limits";
import { filesKey, useFiles } from "./store";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };
const key = filesKey(ref, "/r");
const file = (rel: string) => ({ kind: "file" as const, ws: ref, root: "/r", rel });
const item = file("a.txt");
const press = (k: string, extra: Partial<KeyboardEventInit> = {}) =>
  act(() => {
    fireEvent.keyDown(window, { key: k, metaKey: true, ...extra });
  });
const publish = (changes: { path: string; isDir: boolean; removed: boolean }[]) =>
  act(() => useFilesBus.getState().publish(key, changes));
const reads = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_read").length;

describe("FileViewer", () => {
  beforeEach(() => {
    localStorage.clear();
    useFiles.setState(useFiles.getInitialState(), true);
    useFilesBus.setState(useFilesBus.getInitialState(), true);
    useApp.setState(useApp.getInitialState(), true);
    vi.mocked(writeText).mockClear();
    vi.mocked(showToast).mockClear();
  });

  const frame = () => document.querySelector("iframe.files-html");

  it("opens an HTML file rendered, even past the highlight limit, with Scripts off until clicked", async () => {
    texts["r.html"] = "<h1>R</h1>" + "x".repeat(HIGHLIGHT_LIMIT);
    render(<FileViewer item={file("r.html")} online />);
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(screen.getByRole("group", { name: "HTML view" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Render" }).getAttribute("aria-pressed")).toBe("true");
    const scripts = screen.getByRole("button", { name: "Scripts" });
    expect(scripts.getAttribute("aria-pressed")).toBe("false");
    expect(frame()!.getAttribute("sandbox")).toBe("");
    fireEvent.click(scripts);
    expect(scripts.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(frame()!.getAttribute("sandbox")).toBe("allow-scripts"));
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.queryByRole("button", { name: "Scripts" })).toBeNull();
    expect(frame()).toBeNull();
  });

  it("starts with Scripts off again when the file is shown again", async () => {
    texts["r.html"] = "<p>r</p>";
    const { rerender } = render(<FileViewer key="r" item={file("r.html")} online />);
    fireEvent.click(await screen.findByRole("button", { name: "Scripts" }));
    rerender(<FileViewer key="other" item={file("a.txt")} online />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Scripts" })).toBeNull());
    rerender(<FileViewer key="r" item={file("r.html")} online />);
    expect((await screen.findByRole("button", { name: "Scripts" })).getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a cut HTML file as source only", async () => {
    texts["cut.html"] = "<p>cut";
    truncated.add("cut.html");
    // A chosen Render must not win over the cut.
    useFiles.getState().setMode(key, "cut.html", "render");
    render(<FileViewer item={file("cut.html")} online />);
    await waitFor(() => expect(document.querySelector(".files-text")).not.toBeNull());
    expect(screen.queryByRole("group", { name: "HTML view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scripts" })).toBeNull();
    expect(frame()).toBeNull();
  });

  it("shows no Scripts button while an HTML file is read", async () => {
    let release!: () => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => (release = () => r({ kind: "text", text: "<p>p</p>", truncated: false, size: 8, mtime: 1 }))));
    render(<FileViewer item={file("p.html")} online />);
    expect(screen.queryByRole("button", { name: "Scripts" })).toBeNull();
    await act(async () => release());
    expect(await screen.findByRole("button", { name: "Scripts" })).toBeTruthy();
  });

  it("⌘R stores a rendered HTML page again even when its text is unchanged", async () => {
    texts["same.html"] = "<p>same</p>";
    const puts = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_html_put").length;
    render(<FileViewer item={file("same.html")} online />);
    await waitFor(() => expect(frame()).not.toBeNull());
    const before = puts();
    press("r");
    await waitFor(() => expect(puts()).toBe(before + 1));
  });

  it("⌘F on a rendered HTML file switches to Source and finds there", async () => {
    texts["f.html"] = "<p>needle</p>";
    render(<FileViewer item={file("f.html")} online />);
    await waitFor(() => expect(frame()).not.toBeNull());
    press("f");
    expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByPlaceholderText("Find in file"), { target: { value: "needle" } });
    expect(document.querySelector(".files-find-count")!.textContent).toBe("1 / 1");
  });

  it("opens a small markdown file rendered and one over the highlight limit as source", async () => {
    texts["small.md"] = "# Small";
    texts["big.md"] = "# Big\n" + "x".repeat(HIGHLIGHT_LIMIT);
    const { rerender } = render(<FileViewer item={file("small.md")} online />);
    expect(await screen.findByRole("heading", { name: "Small" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Render" }).getAttribute("aria-pressed")).toBe("true");
    rerender(<FileViewer item={file("big.md")} online />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByRole("heading", { name: "Big" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    expect(screen.getByRole("heading", { name: "Big" })).toBeTruthy();
  });

  it("keeps a file's Render / Source choice when another item is shown and it comes back", async () => {
    texts["doc.md"] = "# Doc";
    // App remounts the viewer per item, as switching tabs does.
    const { rerender } = render(<FileViewer key="doc" item={file("doc.md")} online />);
    expect(await screen.findByRole("heading", { name: "Doc" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    rerender(<FileViewer key="other" item={file("a.txt")} online />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Source" })).toBeNull());
    rerender(<FileViewer key="doc" item={file("doc.md")} online />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByRole("heading", { name: "Doc" })).toBeNull();
  });

  it("a #L link to a markdown file opens it as source", async () => {
    texts["from.md"] = "[notes](notes.md#L2)";
    texts["notes.md"] = "# Notes\n\nsecond";
    const { rerender } = render(<FileViewer item={file("from.md")} online />);
    fireEvent.click(await screen.findByText("notes"));
    expect(viewedItems(useApp.getState()).active).toBe("file:" + key + "|notes.md");
    rerender(<FileViewer item={file("notes.md")} online />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.queryByRole("heading", { name: "Notes" })).toBeNull();
  });

  it("⌘F finds in rendered markdown without leaving Render; again refocuses it", async () => {
    texts["doc.md"] = "# Doc\n\nfoo and Foo";
    render(<FileViewer item={file("doc.md")} online />);
    await screen.findByRole("heading", { name: "Doc" });
    press("f");
    expect(screen.getByRole("button", { name: "Render" }).getAttribute("aria-pressed")).toBe("true");
    const input = screen.getByPlaceholderText("Find in file");
    fireEvent.change(input, { target: { value: "foo" } });
    expect(document.querySelector(".files-find-count")!.textContent).toBe("1 / 2");
    press("g");
    expect(document.querySelector(".files-find-count")!.textContent).toBe("2 / 2");
    expect(document.activeElement).toBe(input);
    input.blur();
    press("f");
    expect(document.activeElement).toBe(input);
  });

  it("Match case narrows the matches; ⌘G and ⇧⌘G step through them", async () => {
    texts["a.ts"] = "Foo foo\nfoo";
    render(<FileViewer item={file("a.ts")} online />);
    await waitFor(() => expect(document.querySelector(".files-text")).not.toBeNull());
    press("f");
    fireEvent.change(screen.getByPlaceholderText("Find in file"), { target: { value: "foo" } });
    const count = () => document.querySelector(".files-find-count")!.textContent;
    expect(count()).toBe("1 / 3");
    press("g");
    expect(count()).toBe("2 / 3");
    press("g");
    expect(count()).toBe("3 / 3");
    press("g", { shiftKey: true });
    expect(count()).toBe("2 / 3");
    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    expect(count()).toBe("1 / 2");
  });

  it("Copy contents copies the file's text", async () => {
    texts["a.ts"] = "one\ntwo";
    render(<FileViewer item={file("a.ts")} online />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy contents" }));
    expect(writeText).toHaveBeenCalledWith("one\ntwo");
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Contents copied"));
  });

  it("Copy contents of a cut file says only the first 2 MB was copied", async () => {
    texts["big.ts"] = "head";
    truncated.add("big.ts");
    render(<FileViewer item={file("big.ts")} online />);
    const btn = await screen.findByRole("button", { name: "Copy contents" });
    expect(btn.getAttribute("title")).toBe("Copy contents (first 2 MB only)");
    fireEvent.click(btn);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Contents copied (first 2 MB only)"));
    truncated.delete("big.ts");
  });

  it("Esc closes a zoomed diagram", async () => {
    texts["d.md"] = "```mermaid\ngraph TD; A-->B\n```\n";
    render(<FileViewer item={file("d.md")} online />);
    fireEvent.click(await screen.findByRole("button", { name: "Zoom diagram" }));
    expect(screen.getByRole("dialog", { name: "Diagram" })).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog", { name: "Diagram" })).toBeNull();
  });

  it("⌘R reloads the file through the bus", async () => {
    render(<FileViewer item={item} online />);
    await waitFor(() => expect(document.querySelector(".files-text")).toBeTruthy());
    vi.mocked(invoke).mockClear();
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_read", expect.objectContaining({ rel: "a.txt" })));
    expect(useFilesBus.getState().reloads[key]).toBe(1);
  });

  it("does not bind its keys once unmounted", () => {
    const { unmount } = render(<FileViewer item={item} online />);
    unmount();
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    expect(useFilesBus.getState().reloads[key]).toBeUndefined();
  });

  it("ignores its keys while a dialog is open over it", () => {
    render(<FileViewer item={item} online />);
    const dialog = document.createElement("div");
    dialog.className = "overlay";
    document.body.appendChild(dialog);
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    dialog.remove();
    expect(useFilesBus.getState().reloads[key]).toBeUndefined();
  });

  describe("read errors and changes", () => {
    const failing = (code: string, message: string) => {
      const prev = vi.mocked(invoke).getMockImplementation()!;
      vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
        if (cmd === "files_read") throw { code, message };
        return prev(cmd, args as never);
      }) as never);
      return () => vi.mocked(invoke).mockImplementation(prev);
    };

    it("shows a read error in place of the file", async () => {
      const restore = failing("io", "permission denied");
      render(<FileViewer item={item} online />);
      expect((await screen.findByRole("alert")).textContent).toBe("permission denied");
      restore();
    });

    it("keeps the file shown and adds a banner when a reload fails", async () => {
      const { container } = render(<FileViewer item={item} online />);
      const shown = () => container.querySelector(".files-text");
      await waitFor(() => expect(shown()).toBeTruthy());
      const restore = failing("io", "timed out");
      act(() => useFilesBus.getState().reload(key));
      expect((await screen.findByRole("alert")).textContent).toBe("Could not reload: timed out");
      expect(shown()).toBeTruthy();
      restore();
    });

    it("reloads the open file when the watch reports it written", async () => {
      const { container } = render(<FileViewer item={item} online />);
      await waitFor(() => expect(container.querySelector(".files-text")).toBeTruthy());
      const before = reads();
      publish([{ path: "a.txt", isDir: false, removed: false }]);
      await waitFor(() => expect(reads()).toBe(before + 1));
    });

    it("leaves a change to another file alone", async () => {
      const { container } = render(<FileViewer item={item} online />);
      await waitFor(() => expect(container.querySelector(".files-text")).toBeTruthy());
      const before = reads();
      publish([{ path: "b.txt", isDir: false, removed: false }]);
      await new Promise((r) => setTimeout(r, 20));
      expect(reads()).toBe(before);
    });

    it("shows File removed when the watch reports the open file removed", async () => {
      const { container } = render(<FileViewer item={item} online />);
      await waitFor(() => expect(container.querySelector(".files-text")).toBeTruthy());
      publish([{ path: "a.txt", isDir: false, removed: true }]);
      expect(await screen.findByText("File removed")).toBeTruthy();
    });

    it("shows File removed when a parent-folder change finds the open file gone", async () => {
      const { container } = render(<FileViewer item={file("src/a.txt")} online />);
      await waitFor(() => expect(container.querySelector(".files-text")).toBeTruthy());
      const restore = failing("not_found", "no such file");
      publish([{ path: "src", isDir: true, removed: false }]);
      expect(await screen.findByText("File removed")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      restore();
    });

    it("re-reads the open file when a folder above its parent changes", async () => {
      const { container } = render(<FileViewer item={file("src/deep/a.txt")} online />);
      await waitFor(() => expect(container.querySelector(".files-text")).toBeTruthy());
      const restore = failing("not_found", "no such file");
      publish([{ path: "src", isDir: true, removed: true }]);
      expect(await screen.findByText("File removed")).toBeTruthy();
      restore();
    });

    it("does not replay a batch published before it mounted", async () => {
      useFilesBus.getState().publish(key, [{ path: "a.txt", isDir: false, removed: true }]);
      render(<FileViewer item={item} online />);
      await waitFor(() => expect(document.querySelector(".files-text")).toBeTruthy());
      expect(screen.queryByText("File removed")).toBeNull();
    });
  });
});
