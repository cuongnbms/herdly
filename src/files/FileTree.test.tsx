import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const dialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => dialogOpen(...a) }));
const startUpload = vi.fn(async (..._a: unknown[]) => true);
const startDownload = vi.fn(async (..._a: unknown[]) => {});
vi.mock("./transfer", () => ({
  startUpload: (...a: unknown[]) => startUpload(...a),
  startDownload: (...a: unknown[]) => startDownload(...a),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { showToast } from "../ui/Toast";
import { FileTree } from "./FileTree";
import { DEFAULT_HIDDEN_FOLDERS, useHiddenFolders } from "../settings/hiddenFolders";
import { draftKey, useDrafts } from "./drafts";

describe("FileTree", () => {
  it("loads lazily and opens files as preview or pinned", async () => {
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [{ name: "x.ts", kind: "file" }],
    );
    const onOpen = vi.fn();
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w1" onOpen={onOpen} reloadKey={0} />);
    fireEvent.click(await screen.findByText("a.md"));
    expect(onOpen).toHaveBeenLastCalledWith("a.md", false);
    fireEvent.doubleClick(screen.getByText("a.md"));
    expect(onOpen).toHaveBeenLastCalledWith("a.md", true);
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(await screen.findByText("x.ts"));
    expect(onOpen).toHaveBeenLastCalledWith("src/x.ts", false);
  });

  it("shows a retry row when a folder fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: "io", message: "Permission denied" });
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w2" onOpen={() => {}} reloadKey={0} />);
    expect(await screen.findByText("Could not list: Permission denied")).toBeTruthy();
    vi.mocked(invoke).mockResolvedValueOnce([{ name: "ok.md", kind: "file" }]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("ok.md")).toBeTruthy());
  });

  it("refetches the root and expanded folders when reloadKey changes", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }] : [{ name: "x.ts", kind: "file" }],
    );
    const { rerender } = render(<FileTree machineId="local" root="/r" filesKey="local/default/w3" onOpen={() => {}} reloadKey={0} />);
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("x.ts");
    const before = vi.mocked(invoke).mock.calls.length;
    rerender(<FileTree machineId="local" root="/r" filesKey="local/default/w3" onOpen={() => {}} reloadKey={1} />);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBe(before + 2));
  });

  it("moves focus and expands with the keyboard", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [{ name: "x.ts", kind: "file" }],
    );
    const onOpen = vi.fn();
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w4" onOpen={onOpen} reloadKey={0} />);
    const src = (await screen.findByText("src")).closest("[role=treeitem]") as HTMLElement;
    src.focus();
    fireEvent.keyDown(src, { key: "ArrowRight" });
    await screen.findByText("x.ts");
    expect(src.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(src, { key: "ArrowDown" });
    const x = screen.getByText("x.ts").closest("[role=treeitem]") as HTMLElement;
    expect(document.activeElement).toBe(x);
    fireEvent.keyDown(x, { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("src/x.ts", true);
    fireEvent.keyDown(x, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(src);
    fireEvent.keyDown(src, { key: "ArrowLeft" });
    expect(src.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands a linked folder like a folder", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "lib", kind: "dirlink" }] : [{ name: "y.ts", kind: "file" }],
    );
    const onOpen = vi.fn();
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w5" onOpen={onOpen} reloadKey={0} />);
    const lib = (await screen.findByText("lib")).closest("[role=treeitem]") as HTMLElement;
    expect(lib.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(lib);
    fireEvent.click(await screen.findByText("y.ts"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith("lib/y.ts", false);
    lib.focus();
    fireEvent.keyDown(lib, { key: "ArrowLeft" });
    expect(lib.getAttribute("aria-expanded")).toBe("false");
  });

  it("every click toggles a folder, however quick", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }] : [{ name: "x.ts", kind: "file" }],
    );
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w6" onOpen={() => {}} reloadKey={0} />);
    const src = (await screen.findByText("src")).closest("[role=treeitem]") as HTMLElement;
    fireEvent.click(src, { detail: 1 });
    expect(src.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(src, { detail: 2 });
    fireEvent.doubleClick(src);
    expect(src.getAttribute("aria-expanded")).toBe("false");
  });

  it("a quick click on another folder still toggles it", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "docs", kind: "dir" }, { name: "infra", kind: "dir" }] : [],
    );
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w6b" onOpen={() => {}} reloadKey={0} />);
    const infra = (await screen.findByText("infra")).closest("[role=treeitem]") as HTMLElement;
    const docs = screen.getByText("docs").closest("[role=treeitem]") as HTMLElement;
    // macOS counts clicks by time, not by row: the click on docs arrives as the second of a double click.
    fireEvent.click(infra, { detail: 1 });
    fireEvent.click(docs, { detail: 2 });
    expect(infra.getAttribute("aria-expanded")).toBe("true");
    expect(docs.getAttribute("aria-expanded")).toBe("true");
  });

  it("has one tab stop: the first item, then the last focused one", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async () => [{ name: "a.md", kind: "file" }, { name: "b.md", kind: "file" }]);
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w7" onOpen={() => {}} reloadKey={0} />);
    const a = (await screen.findByText("a.md")).closest("[role=treeitem]") as HTMLElement;
    const b = screen.getByText("b.md").closest("[role=treeitem]") as HTMLElement;
    expect([a.tabIndex, b.tabIndex]).toEqual([0, -1]);
    fireEvent.focus(b);
    expect([a.tabIndex, b.tabIndex]).toEqual([-1, 0]);
  });

  it("drops a collapsed folder's children on reload and lists it again when expanded", async () => {
    vi.mocked(invoke).mockReset();
    let gen = 0;
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }] : [{ name: `x${gen}.ts`, kind: "file" }],
    );
    const { rerender } = render(<FileTree machineId="local" root="/r" filesKey="local/default/w8" onOpen={() => {}} reloadKey={0} />);
    const src = await screen.findByText("src");
    fireEvent.click(src);
    await screen.findByText("x0.ts");
    fireEvent.click(src, { detail: 1 });
    expect(screen.queryByText("x0.ts")).toBeNull();
    gen = 1;
    rerender(<FileTree machineId="local" root="/r" filesKey="local/default/w8" onOpen={() => {}} reloadKey={1} />);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBe(3));
    fireEvent.click(screen.getByText("src"), { detail: 1 });
    expect(await screen.findByText("x1.ts")).toBeTruthy();
  });

  it("shows nothing of the old root while the new one loads", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.root === "/r" ? [{ name: "old.md", kind: "file" }] : new Promise(() => {}),
    );
    const { rerender } = render(<FileTree machineId="local" root="/r" filesKey="local/default/w9" onOpen={() => {}} reloadKey={0} />);
    await screen.findByText("old.md");
    rerender(<FileTree machineId="local" root="/s" filesKey="local/default/w9" onOpen={() => {}} reloadKey={0} />);
    expect(screen.queryByText("old.md")).toBeNull();
  });
  it("shows a chevron and folder icon on folders, a file icon on files", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [],
    );
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w10" onOpen={() => {}} reloadKey={0} />);
    const src = (await screen.findByText("src")).closest("[role=treeitem]") as HTMLElement;
    const a = screen.getByText("a.md").closest("[role=treeitem]") as HTMLElement;
    const icons = (el: HTMLElement) => [...el.querySelectorAll("svg")].map((s) => s.dataset.icon);
    expect(icons(src)).toEqual(["chevron", "folder"]);
    expect(icons(a)).toEqual(["file"]);
    fireEvent.click(src);
    await waitFor(() => expect(icons(src)).toEqual(["chevron", "folder-open"]));
    expect(src.classList.contains("open")).toBe(true);
  });
  it("copies a row's path or relative path from its context menu", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }] : [{ name: "x.ts", kind: "file" }],
    );
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w11" onOpen={() => {}} reloadKey={0} />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.contextMenu(await screen.findByText("x.ts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Path" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("/r/src/x.ts"));
    expect(showToast).toHaveBeenLastCalledWith("Path copied");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Relative Path" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("src"));
    expect(showToast).toHaveBeenLastCalledWith("Relative path copied");
  });

  it("joins the path onto a filesystem root without doubling the slash", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async () => [{ name: "etc", kind: "dir" }]);
    render(<FileTree machineId="local" root="/" filesKey="local/default/w12" onOpen={() => {}} reloadKey={0} />);
    fireEvent.contextMenu(await screen.findByText("etc"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Path" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("/etc"));
  });
  it("hides the folders set in Settings unless showHeavy is on, and relists when either changes", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.hidden.includes("node_modules") ? [{ name: "a.md", kind: "file" }] : [{ name: "node_modules", kind: "dir" }, { name: "a.md", kind: "file" }],
    );
    const props = { machineId: "local", root: "/r", filesKey: "local/default/w13", onOpen: () => {}, reloadKey: 0 };
    const { rerender } = render(<FileTree {...props} />);
    await screen.findByText("a.md");
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("files_list_dir", { machineId: "local", root: "/r", rel: "", hidden: DEFAULT_HIDDEN_FOLDERS });
    rerender(<FileTree {...props} showHeavy />);
    expect(await screen.findByText("node_modules")).toBeTruthy();
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("files_list_dir", { machineId: "local", root: "/r", rel: "", hidden: [] });
    rerender(<FileTree {...props} />);
    await waitFor(() => expect(screen.queryByText("node_modules")).toBeNull());
    act(() => useHiddenFolders.getState().setFolders(["dist"]));
    expect(await screen.findByText("node_modules")).toBeTruthy();
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("files_list_dir", { machineId: "local", root: "/r", rel: "", hidden: ["dist"] });
    act(() => useHiddenFolders.getState().reset());
  });

  it("relists only loaded folders named by a change batch, once per batch", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "lib", kind: "dir" }] : [{ name: "x.ts", kind: "file" }],
    );
    const props = { machineId: "local", root: "/r", filesKey: "local/default/w9", onOpen: () => {}, reloadKey: 0 };
    const { rerender } = render(<FileTree {...props} changes={null} />);
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("x.ts");
    vi.mocked(invoke).mockClear();
    const batch = { seq: 1, changes: [{ path: "src/new.ts", isDir: false, removed: false }, { path: "lib/y.ts", isDir: false, removed: false }] };
    rerender(<FileTree {...props} changes={batch} />);
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("files_list_dir", { machineId: "local", root: "/r", rel: "src", hidden: DEFAULT_HIDDEN_FOLDERS });
    rerender(<FileTree {...props} changes={batch} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it("does not replay a batch that was published before it mounted", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async () => [{ name: "a.md", kind: "file" }]);
    // Replayed, a removal of the root would forget the listing the mount just started.
    const batch = { seq: 3, changes: [{ path: "", isDir: true, removed: true }] };
    render(<FileTree machineId="local" root="/r" filesKey="local/default/w-stale" onOpen={() => {}} reloadKey={0} changes={batch} />);
    expect(await screen.findByText("a.md")).toBeTruthy();
  });

  it("lists a removed then re-created expanded folder afresh", async () => {
    vi.mocked(invoke).mockReset();
    let state: "up" | "down" = "up";
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) => {
      if (args.rel === "") return state === "up" ? [{ name: "build", kind: "dir" }] : [];
      if (state === "down") throw { code: "io", message: "gone" };
      return [{ name: "out.js", kind: "file" }];
    });
    const props = { machineId: "local", root: "/r", filesKey: "local/default/w10", onOpen: () => {}, reloadKey: 0 };
    const { rerender } = render(<FileTree {...props} changes={null} />);
    fireEvent.click(await screen.findByText("build"));
    await screen.findByText("out.js");
    state = "down";
    rerender(<FileTree {...props} changes={{ seq: 1, changes: [{ path: "build", isDir: true, removed: true }] }} />);
    await waitFor(() => expect(screen.queryByText("build")).toBeNull());
    expect(screen.queryByText("out.js")).toBeNull();
    state = "up";
    rerender(<FileTree {...props} changes={{ seq: 2, changes: [{ path: "build", isDir: true, removed: false }] }} />);
    expect(await screen.findByText("out.js")).toBeTruthy();
    expect(screen.queryByText(/Could not list/)).toBeNull();
  });

  it("drops a removed folder's subtree", async () => {
    vi.mocked(invoke).mockReset();
    let rootList = [{ name: "a", kind: "dir" }];
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) => {
      if (args.rel === "") return rootList;
      if (args.rel === "a") return [{ name: "b", kind: "dir" }];
      return [{ name: "deep.ts", kind: "file" }];
    });
    const props = { machineId: "local", root: "/r", filesKey: "local/default/w11", onOpen: () => {}, reloadKey: 0 };
    const { rerender } = render(<FileTree {...props} changes={null} />);
    fireEvent.click(await screen.findByText("a"));
    fireEvent.click(await screen.findByText("b"));
    await screen.findByText("deep.ts");
    rootList = [];
    rerender(<FileTree {...props} changes={{ seq: 1, changes: [{ path: "a", isDir: true, removed: true }] }} />);
    await waitFor(() => expect(screen.queryByText("a")).toBeNull());
    expect(screen.queryByText("b")).toBeNull();
    expect(screen.queryByText("deep.ts")).toBeNull();
  });
});

describe("FileTree context menu", () => {
  const listing = async (_cmd: string, args: any) =>
    args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [{ name: "x.ts", kind: "file" }];
  const menuLabels = () => screen.getAllByRole("menuitem").map((b) => b.textContent);

  it("offers every action on rows, New and Upload on empty space", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    render(<FileTree machineId="m" root="/r" filesKey="m/default/c1" onOpen={() => {}} reloadKey={0} />);
    fireEvent.contextMenu(await screen.findByText("src"));
    expect(menuLabels()).toEqual(["New File…", "New Folder…", "Copy Path", "Copy Relative Path", "Upload Files…", "Upload Folder…", "Download", "Rename…", "Delete…"]);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.contextMenu(screen.getByRole("tree"));
    expect(menuLabels()).toEqual(["New File…", "New Folder…", "Upload Files…", "Upload Folder…"]);
  });

  it("a right-click on the open menu does not swap it for the root menu", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    render(<FileTree machineId="m" root="/r" filesKey="m/default/c6" onOpen={() => {}} reloadKey={0} />);
    fireEvent.contextMenu(await screen.findByText("a.md"));
    expect(menuLabels()).toEqual(["New File…", "New Folder…", "Copy Path", "Copy Relative Path", "Upload Files…", "Upload Folder…", "Download", "Rename…", "Delete…"]);
    fireEvent.contextMenu(screen.getByRole("menuitem", { name: "Download" }));
    // The menu's own overlay closes it; the tree must not open its root menu in its place.
    expect(screen.queryAllByRole("menuitem").map((b) => b.textContent)).not.toEqual(["New File…", "New Folder…", "Upload Files…", "Upload Folder…"]);
    expect(screen.queryAllByRole("menuitem")).toEqual([]);
  });

  it("uploads into the folder, the file's folder, or the root, then reloads it", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    dialogOpen.mockResolvedValue(["/Users/u/n.md"]);
    render(<FileTree machineId="m" root="/r" filesKey="m/default/c2" onOpen={() => {}} reloadKey={0} />);
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("x.ts");

    fireEvent.contextMenu(screen.getByText("x.ts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload Files…" }));
    await waitFor(() => expect(startUpload).toHaveBeenLastCalledWith("m", "/r", "src", ["/Users/u/n.md"]));
    expect(dialogOpen).toHaveBeenLastCalledWith({ multiple: true, directory: false });
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([, a]: any) => a.rel === "src").length).toBe(2));

    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload Folder…" }));
    await waitFor(() => expect(startUpload).toHaveBeenLastCalledWith("m", "/r", "src", ["/Users/u/n.md"]));
    expect(dialogOpen).toHaveBeenLastCalledWith({ multiple: true, directory: true });

    fireEvent.contextMenu(screen.getByRole("tree"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload Files…" }));
    await waitFor(() => expect(startUpload).toHaveBeenLastCalledWith("m", "/r", "", ["/Users/u/n.md"]));
  });

  it("does nothing when the open panel is cancelled", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    startUpload.mockClear();
    dialogOpen.mockResolvedValue(null);
    render(<FileTree machineId="m" root="/r" filesKey="m/default/c3" onOpen={() => {}} reloadKey={0} />);
    fireEvent.contextMenu(await screen.findByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload Files…" }));
    await waitFor(() => expect(dialogOpen).toHaveBeenCalled());
    expect(startUpload).not.toHaveBeenCalled();
  });

  it("downloads the row", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    render(<FileTree machineId="m" root="/r" filesKey="m/default/c4" onOpen={() => {}} reloadKey={0} />);
    fireEvent.contextMenu(await screen.findByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(startDownload).toHaveBeenCalledWith("m", "/r", "a.md");
  });

  it("does not reload the old root after the root changed mid-upload", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    dialogOpen.mockResolvedValue(["/Users/u/n.md"]);
    let finish!: (ok: boolean) => void;
    startUpload.mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)));
    const { rerender } = render(<FileTree machineId="m" root="/r" filesKey="m/default/c5" onOpen={() => {}} reloadKey={0} />);
    fireEvent.contextMenu(await screen.findByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload Files…" }));
    await waitFor(() => expect(startUpload).toHaveBeenCalled());
    rerender(<FileTree machineId="m" root="/s" filesKey="m/default/c5" onOpen={() => {}} reloadKey={0} />);
    await screen.findByText("a.md");
    const before = vi.mocked(invoke).mock.calls.length;
    finish(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(invoke).mock.calls.slice(before).filter(([, a]: any) => a.root === "/r")).toEqual([]);
    expect(vi.mocked(invoke).mock.calls.length).toBe(before);
  });
});

describe("FileTree edits", () => {
  const listing = async (cmd: string, args: any) => {
    if (cmd === "files_rename") return args.rel.replace(/[^/]*$/, args.name);
    if (cmd !== "files_list_dir") return null;
    return args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [{ name: "x.ts", kind: "file" }];
  };
  const calls = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);
  const lists = (rel: string) => calls("files_list_dir").filter((a: any) => a.rel === rel).length;
  const type = (value: string) => {
    const input = screen.getByRole("dialog").querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
  };
  const setup = async (fk: string, extra: { onOpen?: any; onMoved?: any } = {}) => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    vi.mocked(showToast).mockClear();
    const view = render(<FileTree machineId="m" root="/r" filesKey={fk} onOpen={extra.onOpen ?? (() => {})} onMoved={extra.onMoved} reloadKey={0} />);
    await screen.findByText("src");
    return view;
  };

  it("creates a file in the folder, opens it pinned and relists the folder", async () => {
    const onOpen = vi.fn();
    await setup("m/default/e1", { onOpen });
    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File…" }));
    const before = lists("src");
    type("b.ts");
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("src/b.ts", true));
    expect(calls("files_create")).toEqual([{ machineId: "m", root: "/r", rel: "src/b.ts", isDir: false }]);
    await waitFor(() => expect(lists("src")).toBeGreaterThan(before));
  });

  it("creates a folder beside a file, or at the root from empty space", async () => {
    const onOpen = vi.fn();
    await setup("m/default/e2", { onOpen });
    fireEvent.contextMenu(screen.getByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New Folder…" }));
    type("docs");
    await waitFor(() => expect(calls("files_create")).toEqual([{ machineId: "m", root: "/r", rel: "docs", isDir: true }]));
    fireEvent.contextMenu(screen.getByRole("tree"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File…" }));
    type("notes/today.md");
    await waitFor(() => expect(calls("files_create")[1]).toEqual({ machineId: "m", root: "/r", rel: "notes/today.md", isDir: false }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("expands a collapsed folder a file is created in", async () => {
    await setup("m/default/e3");
    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File…" }));
    type("b.ts");
    await screen.findByText("x.ts");
    expect(screen.getByText("src").closest("[role=treeitem]")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("ignores an empty name", async () => {
    await setup("m/default/e4");
    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File…" }));
    type("  ");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls("files_create")).toEqual([]);
  });

  it("shows why a create failed and opens nothing", async () => {
    const onOpen = vi.fn();
    await setup("m/default/e5", { onOpen });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "files_create") throw { code: "invalid", message: "src/x.ts already exists" };
      return listing(cmd, args);
    });
    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New File…" }));
    type("x.ts");
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Cannot create x.ts: src/x.ts already exists"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renames in place with the old name filled in, then reports the move", async () => {
    const onMoved = vi.fn();
    await setup("m/default/e6", { onMoved });
    fireEvent.contextMenu(screen.getByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    expect((screen.getByRole("dialog").querySelector("input") as HTMLInputElement).value).toBe("a.md");
    type("b.md");
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith("a.md", "b.md"));
    expect(calls("files_rename")).toEqual([{ machineId: "m", root: "/r", rel: "a.md", name: "b.md" }]);
  });

  it("does not rename to the same name", async () => {
    const onMoved = vi.fn();
    await setup("m/default/e7", { onMoved });
    fireEvent.contextMenu(screen.getByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    type("a.md");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls("files_rename")).toEqual([]);
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("deletes a folder only after confirming, then reports it gone", async () => {
    const onMoved = vi.fn();
    await setup("m/default/e8", { onMoved });
    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(screen.getByRole("dialog").textContent).toContain('Delete "src" and everything in it? This cannot be undone.');
    expect(calls("files_delete")).toEqual([]);
    const before = lists("");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith("src", null));
    expect(calls("files_delete")).toEqual([{ machineId: "m", root: "/r", rel: "src" }]);
    await waitFor(() => expect(lists("")).toBeGreaterThan(before));
  });

  it("warns in the Delete confirm when a file under it has unsaved changes", async () => {
    await setup("m/default/e10");
    useDrafts.getState().open({ fk: "m/default/e10", machineId: "m", root: "/r", rel: "a.md" }, { text: "t", size: 1, mtime: 1, cksum: 1 });
    const key = draftKey("m/default/e10", "a.md");
    act(() => useDrafts.getState().update(key, useDrafts.getState().drafts[key].state.update({ changes: { from: 0, insert: "!" } }).state));
    fireEvent.contextMenu(screen.getByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(await screen.findByText('Delete "a.md"? This cannot be undone. Unsaved changes will be lost.')).toBeTruthy();
    useDrafts.setState({ drafts: {} });
  });

  it("cancelling a delete deletes nothing", async () => {
    await setup("m/default/e9");
    fireEvent.contextMenu(screen.getByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(screen.getByRole("dialog").textContent).toContain('Delete "a.md"? This cannot be undone.');
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("files_delete")).toEqual([]);
  });

  it("shows why a delete failed and reports nothing", async () => {
    const onMoved = vi.fn();
    await setup("m/default/e10", { onMoved });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "files_delete") throw { code: "io", message: "Permission denied" };
      return listing(cmd, args);
    });
    fireEvent.contextMenu(screen.getByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Cannot delete a.md: Permission denied"));
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("still reports a rename that finished after the root changed, without relisting the old root", async () => {
    const onMoved = vi.fn();
    const { rerender } = await setup("m/default/e11", { onMoved });
    let finish!: (to: string) => void;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args: any) =>
      cmd === "files_rename" ? new Promise((r) => (finish = r)) : listing(cmd, args),
    );
    fireEvent.contextMenu(screen.getByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    type("b.md");
    await waitFor(() => expect(calls("files_rename")).toHaveLength(1));
    rerender(<FileTree machineId="m" root="/s" filesKey="m/default/e11" onOpen={() => {}} onMoved={onMoved} reloadKey={0} />);
    await screen.findByText("a.md");
    const before = vi.mocked(invoke).mock.calls.length;
    finish("b.md");
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith("a.md", "b.md"));
    expect(vi.mocked(invoke).mock.calls.slice(before)).toEqual([]);
  });
});
