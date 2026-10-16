import { describe, expect, it } from "vitest";
import { sections } from "./sections";

const e = (path: string, index: string, worktree: string, extra: Partial<{ orig_path: string; unmerged: boolean }> = {}) => ({ path, index, worktree, orig_path: extra.orig_path ?? null, unmerged: extra.unmerged ?? false });

describe("sections", () => {
  it("puts a staged-then-edited file in both lists, untracked last, conflicts apart", () => {
    const s = sections([e("u.txt", "?", "?"), e("b.rs", "M", "M"), e("c.rs", ".", "D"), e("n.rs", "R", ".", { orig_path: "o.rs" }), e("x.rs", "U", "U", { unmerged: true })]);
    expect(s.merge.map((r) => [r.path, r.letter])).toEqual([["x.rs", "!"]]);
    expect(s.staged.map((r) => [r.path, r.letter, r.origPath])).toEqual([["b.rs", "M", null], ["n.rs", "R", "o.rs"]]);
    expect(s.changes.map((r) => [r.path, r.letter, r.untracked])).toEqual([["b.rs", "M", false], ["c.rs", "D", false], ["u.txt", "U", true]]);
    expect(s.staged.every((r) => r.scope === "staged") && s.changes.every((r) => r.scope === "worktree")).toBe(true);
  });
});
