import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const repo = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../lib/ipc", () => ({
  gitRepo: vi.fn(async () => repo.value),
  gitLog: vi.fn(async () => [{ sha: "c".repeat(40), short: "ccccccc", author: "Ann", time: 1_700_000_000, parents: 1, subject: "feat: x", body: "" }]),
  gitCommitFiles: vi.fn(async () => []),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { gitLog, gitRepo } from "../lib/ipc";
import { useFilesPanel } from "../files/panelStore";
import { useResolvedRoots } from "../files/useFilesRoot";
import { useApp, viewedItems } from "../store/app";
import { itemKey } from "../store/openItems";
import { GitPanel } from "./GitPanel";
import { useGit } from "./store";

const machines = (state = "connected") =>
  ({ local: { id: "local", label: "local", kind: "local", state, error: null, version: null, status: "idle", sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [{ tab_id: "t1", label: "t", panes: [{ pane_id: "p1", cwd: "/r/sub", status: "idle" }] }] },
  ] }] } }) as never;
const theRepo = {
  root: "/r", prefix: "sub/", head: "h".repeat(40), branch: "main", upstream: "origin/main", ahead: 1, behind: 0, total: 2,
  entries: [
    { path: "sub/a.ts", orig_path: null, index: ".", worktree: "M", unmerged: false },
    { path: "top.md", orig_path: null, index: "A", worktree: ".", unmerged: false },
  ],
};

describe("GitPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    repo.value = theRepo;
    vi.mocked(gitRepo).mockClear();
    vi.mocked(gitLog).mockClear();
    useGit.setState(useGit.getInitialState(), true);
    useResolvedRoots.setState(useResolvedRoots.getInitialState(), true);
    // setView also stores the choice: opening an item changes the viewed Session, which restores the stored view.
    useFilesPanel.getState().setView("git");
    useApp.setState({ machines: machines(), selected: { machine_id: "local", session: "default", pane_id: "p1" }, tabs: {}, viewed: null });
  });

  it("renders nothing outside the git view", () => {
    useFilesPanel.setState({ view: "files" });
    const { container } = render(<GitPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("reads the root's repository and shows its branch, changes and commits", async () => {
    render(<GitPanel />);
    expect(await screen.findByText("main")).toBeTruthy();
    expect(gitRepo).toHaveBeenCalledWith("local", "/r/sub");
    expect(screen.getByText("↑1")).toBeTruthy();
    expect(screen.queryByText(/↓/)).toBeNull();
    expect(await screen.findByText(/feat: x/)).toBeTruthy();
    expect(gitLog).toHaveBeenCalledWith("local", "/r", 0, 50);
  });

  it("opens a change as a diff item of its scope", async () => {
    render(<GitPanel />);
    fireEvent.click(await screen.findByTitle("sub/a.ts"));
    expect(viewedItems(useApp.getState()).active).toBe("diff:local/default/w1|/r|worktree|sub/a.ts");
    fireEvent.doubleClick(screen.getByTitle("top.md"));
    const v = viewedItems(useApp.getState());
    expect(v.active).toBe("diff:local/default/w1|/r|staged|top.md");
    expect(v.items.map(itemKey)).toEqual(["diff:local/default/w1|/r|worktree|sub/a.ts", "diff:local/default/w1|/r|staged|top.md"]);
    expect(v.preview).toBeNull();
  });

  it("offers Open file only for a file under the Files root", async () => {
    render(<GitPanel />);
    fireEvent.contextMenu(await screen.findByTitle("sub/a.ts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open file" }));
    expect(viewedItems(useApp.getState()).active).toBe("file:local/default/w1|/r/sub|a.ts");
    fireEvent.contextMenu(screen.getByTitle("top.md"));
    expect(screen.queryByRole("menuitem", { name: "Open file" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith("/r/top.md");
  });

  it("Refresh bumps the repository's key, which open diffs listen on", async () => {
    render(<GitPanel />);
    await screen.findByText("main");
    const before = useGit.getState().ticks["local|/r"] ?? 0;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(useGit.getState().ticks["local|/r"]).toBe(before + 1);
  });

  it("says so outside a repository, and reads again on Refresh", async () => {
    repo.value = null;
    render(<GitPanel />);
    expect(await screen.findByText("Not a git repository")).toBeTruthy();
    repo.value = theRepo;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
    await waitFor(() => expect(screen.getByText("main")).toBeTruthy());
  });

  it("keeps the last result and reads nothing while offline", async () => {
    render(<GitPanel />);
    await screen.findByText("main");
    vi.mocked(gitRepo).mockClear();
    act(() => useApp.setState({ machines: machines("disconnected") }));
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(gitRepo).not.toHaveBeenCalled();
  });
});
