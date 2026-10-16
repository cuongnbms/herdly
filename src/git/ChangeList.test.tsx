import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeList } from "./ChangeList";
import { useGit } from "./store";
import type { GitRepo } from "../lib/types";

const repo: GitRepo = {
  root: "/r", prefix: "", head: "a".repeat(40), branch: "main", upstream: null, ahead: 0, behind: 0, total: 7,
  entries: [
    { path: "src/git.rs", orig_path: null, index: "M", worktree: "M", unmerged: false },
    { path: "docs/new.md", orig_path: "docs/old.md", index: "R", worktree: ".", unmerged: false },
    { path: "notes.md", orig_path: null, index: "?", worktree: "?", unmerged: false },
  ],
};

describe("ChangeList", () => {
  beforeEach(() => useGit.setState(useGit.getInitialState(), true));
  const props = { repo, activeKey: null, keyOf: (r: { scope: string; path: string }) => r.scope + r.path, onOpen: vi.fn(), onMenu: vi.fn() };

  it("shows Staged Changes and Changes with counts, rows like VS Code, and no Merge Changes", () => {
    render(<ChangeList {...props} />);
    expect(screen.queryByText(/Merge Changes/)).toBeNull();
    const staged = screen.getByRole("group", { name: "Staged Changes" });
    expect(within(staged).getByText("(2)")).toBeTruthy();
    const rename = within(staged).getByTitle("docs/new.md");
    expect(rename.querySelector(".git-row-name")!.textContent).toBe("new.md");
    expect(rename.querySelector(".git-row-dir")!.textContent).toBe("docs/old.md → docs/new.md");
    expect(rename.querySelector(".git-letter-R")).toBeTruthy();
    const changes = screen.getByRole("group", { name: "Changes" });
    expect(within(changes).getAllByRole("button", { name: /git\.rs|notes\.md/ }).map((b) => b.querySelector(".git-letter")!.textContent)).toEqual(["M", "U"]);
    expect(screen.getByText("… 4 more files")).toBeTruthy();
  });

  it("opens the preview on click, pins on double click, and collapses a section", () => {
    render(<ChangeList {...props} />);
    const changes = screen.getByRole("group", { name: "Changes" });
    fireEvent.click(within(changes).getByTitle("src/git.rs"));
    expect(props.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ path: "src/git.rs", scope: "worktree" }), false);
    fireEvent.doubleClick(within(changes).getByTitle("src/git.rs"));
    expect(props.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ path: "src/git.rs", scope: "worktree" }), true);
    fireEvent.click(screen.getByRole("button", { name: "Changes (2)" }));
    expect(within(screen.getByRole("group", { name: "Changes" })).queryByTitle("src/git.rs")).toBeNull();
  });

  it("marks the active row and lists conflicts first", () => {
    const withConflict = { ...repo, entries: [...repo.entries, { path: "both.rs", orig_path: null, index: "U", worktree: "U", unmerged: true }] };
    render(<ChangeList {...props} repo={withConflict} activeKey="stagedsrc/git.rs" />);
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Merge Changes", "Staged Changes", "Changes"]);
    expect(within(screen.getByRole("group", { name: "Staged Changes" })).getByTitle("src/git.rs").getAttribute("aria-current")).toBe("true");
  });
});
