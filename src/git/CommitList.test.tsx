import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ gitCommitFiles: vi.fn(async () => [{ status: "M", path: "src/a.ts", orig_path: null }]) }));
import { gitCommitFiles } from "../lib/ipc";
import { CommitList } from "./CommitList";
import { useGit } from "./store";
import type { GitRepo } from "../lib/types";

const repo = { root: "/r", prefix: "", head: null, branch: "main", upstream: null, ahead: 0, behind: 0, entries: [], total: 0 } as GitRepo;
const commit = (n: number) => ({ sha: `${n}`.repeat(40).slice(0, 40), short: `${n}`.repeat(7), author: "Ann", time: 1_700_000_000, parents: 1, subject: `subject ${n}`, body: "" });

describe("CommitList", () => {
  beforeEach(() => {
    useGit.setState(useGit.getInitialState(), true);
    vi.mocked(gitCommitFiles).mockClear();
  });
  const props = { machineId: "local", repo, repoKey: "local|/r", activeKey: null, keyOf: () => "", onOpen: vi.fn(), onLoadMore: vi.fn(), onMenu: vi.fn() };

  it("expands a commit to its files once, and opens a file", async () => {
    useGit.getState().setLog("local|/r", [commit(1), commit(2)], true);
    render(<CommitList {...props} />);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1111111 subject 1/ }));
    fireEvent.click(await screen.findByTitle("src/a.ts"));
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ short: "1111111" }), expect.objectContaining({ path: "src/a.ts" }), false);
    fireEvent.click(screen.getByRole("button", { name: /1111111 subject 1/ }));
    fireEvent.click(screen.getByRole("button", { name: /1111111 subject 1/ }));
    await waitFor(() => expect(screen.getByTitle("src/a.ts")).toBeTruthy());
    expect(gitCommitFiles).toHaveBeenCalledTimes(1);
    expect(gitCommitFiles).toHaveBeenCalledWith("local", "/r", "1".repeat(40));
  });

  it("offers Load more while the last page was full", () => {
    useGit.getState().setLog("local|/r", [commit(1)], false);
    render(<CommitList {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(props.onLoadMore).toHaveBeenCalled();
  });

  it("shows a failed file read in place and retries it", async () => {
    vi.mocked(gitCommitFiles).mockRejectedValueOnce({ code: "git", message: "fatal: bad object" });
    useGit.getState().setLog("local|/r", [commit(1)], true);
    render(<CommitList {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /1111111 subject 1/ }));
    expect(await screen.findByText("fatal: bad object")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTitle("src/a.ts")).toBeTruthy();
    expect(gitCommitFiles).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("fatal: bad object")).toBeNull();
  });

  it("sends a right-click on a commit file to onFileMenu", async () => {
    const onFileMenu = vi.fn();
    useGit.getState().setLog("local|/r", [commit(1)], true);
    render(<CommitList {...props} onFileMenu={onFileMenu} />);
    fireEvent.click(screen.getByRole("button", { name: /1111111 subject 1/ }));
    fireEvent.contextMenu(await screen.findByTitle("src/a.ts"), { clientX: 12, clientY: 34 });
    expect(onFileMenu).toHaveBeenCalledWith(expect.objectContaining({ short: "1111111" }), expect.objectContaining({ path: "src/a.ts" }), 12, 34);
  });
});
