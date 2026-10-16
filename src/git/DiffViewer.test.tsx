import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () => Array.from({ length: o.count }, (_, index) => ({ index, key: index, start: index * o.estimateSize() })),
    getTotalSize: () => o.count * o.estimateSize(),
    measure: () => {},
    scrollToIndex: () => {},
  }),
}));
const answer = vi.hoisted(() => ({ value: null as unknown, fail: false }));
vi.mock("../lib/ipc", () => ({
  gitDiff: vi.fn(async () => {
    if (answer.fail) throw { code: "git", message: "fatal: bad object" };
    return answer.value;
  }),
}));
import { gitDiff } from "../lib/ipc";
import { useApp } from "../store/app";
import { useGit } from "./store";
import { DiffViewer } from "./DiffViewer";
import type { DiffItem } from "../store/openItems";

const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
const item = (over: Partial<DiffItem> = {}): DiffItem => ({ kind: "diff", ws, root: "/r", repo: "/r", prefix: "", path: "src/a.ts", origPath: null, scope: { kind: "worktree" }, untracked: false, ...over });
const fd = (over = {}) => ({ binary: false, old_mode: null, new_mode: null, rename: null, added: 1, removed: 1, truncated: false, hunks: [{ header: "@@ -1,2 +1,2 @@ fn", old_start: 1, new_start: 1, lines: [
  { kind: "context", old_no: 1, new_no: 1, text: "a", no_newline: false },
  { kind: "del", old_no: 2, new_no: null, text: "b", no_newline: false },
  { kind: "add", old_no: null, new_no: 2, text: "B", no_newline: false },
] }], ...over });

describe("DiffViewer", () => {
  beforeEach(() => {
    answer.value = fd();
    answer.fail = false;
    vi.mocked(gitDiff).mockClear();
    useGit.setState(useGit.getInitialState(), true);
    useApp.setState({ machines: {} as never, tabs: {}, viewed: null });
  });

  it("reads the item's scope and shows counts, the hunk header and numbered rows", async () => {
    const { container } = render(<DiffViewer item={item()} online />);
    await screen.findByText("@@ -1,2 +1,2 @@ fn");
    expect(gitDiff).toHaveBeenCalledWith("local", "/r", "src/a.ts", null, { kind: "worktree" }, false);
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    const del = container.querySelector(".diff-row.diff-del")!;
    expect([...del.querySelectorAll(".diff-no")].map((n) => n.getAttribute("data-n"))).toEqual(["2", ""]);
    expect(del.querySelector(".diff-mark")!.getAttribute("data-m")).toBe("-");
    expect(del.querySelector(".diff-code")!.textContent).toBe("b");
  });

  it.each([
    [{ binary: true, hunks: [] }, "Binary file changed"],
    [{ rename: "old.ts", hunks: [] }, "Renamed, no content changes"],
    [{ old_mode: "100644", new_mode: "100755", hunks: [] }, "Mode changed 100644 → 100755"],
    [{ hunks: [], added: 0, removed: 0 }, "No changes"],
    [{ truncated: true }, "Diff truncated at 2 MB"],
  ])("shows a notice for %j", async (over, notice) => {
    answer.value = fd(over);
    render(<DiffViewer item={item()} online />);
    expect(await screen.findByText(notice)).toBeTruthy();
  });

  it("shows a rename in the header and git's error with Retry", async () => {
    answer.value = fd({ rename: "src/old.ts" });
    const { unmount } = render(<DiffViewer item={item({ origPath: "src/old.ts", scope: { kind: "staged" } })} online />);
    expect(await screen.findByText("src/old.ts → src/a.ts")).toBeTruthy();
    unmount();
    answer.fail = true;
    render(<DiffViewer item={item()} online />);
    expect(await screen.findByText("fatal: bad object")).toBeTruthy();
    answer.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("@@ -1,2 +1,2 @@ fn")).toBeTruthy();
  });

  it("reads a working-tree diff again on ⟳ but a commit diff only once", async () => {
    const { unmount } = render(<DiffViewer item={item()} online />);
    await screen.findByText("@@ -1,2 +1,2 @@ fn");
    useGit.getState().bump("local|/r");
    await waitFor(() => expect(gitDiff).toHaveBeenCalledTimes(2));
    unmount();
    vi.mocked(gitDiff).mockClear();
    render(<DiffViewer item={item({ scope: { kind: "commit", sha: "c".repeat(40), short: "ccccccc" } })} online />);
    await screen.findByText("@@ -1,2 +1,2 @@ fn");
    useGit.getState().bump("local|/r");
    await new Promise((r) => setTimeout(r, 20));
    expect(gitDiff).toHaveBeenCalledTimes(1);
    expect(screen.getByText("ccccccc")).toBeTruthy();
  });

  it("keeps the last read and shows the offline banner when the Machine drops", async () => {
    const { rerender } = render(<DiffViewer item={item()} online />);
    await screen.findByText("@@ -1,2 +1,2 @@ fn");
    rerender(<DiffViewer item={item()} online={false} />);
    expect(screen.getByText("Machine offline")).toBeTruthy();
    expect(screen.getByText("@@ -1,2 +1,2 @@ fn")).toBeTruthy();
  });
  it("shows the commit's subject and author when it is in the log, and Open file unless deleted", async () => {
    const sha = "c".repeat(40);
    useGit.getState().setLog("local|/r", [{ sha, short: "ccccccc", author: "Ann", time: 0, parents: 1, subject: "Fix it", body: "" }], true);
    const openFile = vi.fn();
    useApp.setState({ openFile } as never);
    const { unmount } = render(<DiffViewer item={item({ prefix: "pkg/", path: "pkg/src/a.ts", scope: { kind: "commit", sha, short: "ccccccc" } })} online />);
    expect(await screen.findByText("Fix it")).toBeTruthy();
    expect(screen.getByText("Ann")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open file" }));
    expect(openFile).toHaveBeenCalledWith(ws, "/r", "src/a.ts", { pin: false });
    unmount();
    answer.value = fd({ old_mode: "100644", new_mode: null });
    render(<DiffViewer item={item()} online />);
    await screen.findByText("@@ -1,2 +1,2 @@ fn");
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
  });
  it("reads a commit diff only once the Machine is online, and not again after it succeeded", async () => {
    const commit = item({ scope: { kind: "commit", sha: "c".repeat(40), short: "ccccccc" } });
    const { rerender } = render(<DiffViewer item={commit} online={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(gitDiff).not.toHaveBeenCalled();
    expect(screen.getByText("Machine offline")).toBeTruthy();
    rerender(<DiffViewer item={commit} online />);
    await screen.findByText("@@ -1,2 +1,2 @@ fn");
    expect(gitDiff).toHaveBeenCalledTimes(1);
    rerender(<DiffViewer item={commit} online={false} />);
    rerender(<DiffViewer item={commit} online />);
    await new Promise((r) => setTimeout(r, 20));
    expect(gitDiff).toHaveBeenCalledTimes(1);
  });

});
