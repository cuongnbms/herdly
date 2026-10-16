import type { GitEntry } from "../lib/types";

export type Row = { path: string; origPath: string | null; letter: string; scope: "worktree" | "staged"; untracked: boolean };

/** `M A D R C T` as is, `"?"` for anything else. */
export function letterOf(c: string): string {
  return "MADRCT".includes(c) && c.length === 1 ? c : "?";
}

/**
 * Splits `git status` entries the way VS Code's Source Control does. Unmerged entries appear only in `merge`.
 * A rename's old path stays on its staged row; a nested repository (`? dir/`) is left out.
 */
export function sections(entries: GitEntry[]): { merge: Row[]; staged: Row[]; changes: Row[] } {
  const merge: Row[] = [];
  const staged: Row[] = [];
  const changes: Row[] = [];
  const untracked: Row[] = [];
  for (const e of entries) {
    if (e.path.endsWith("/")) continue;
    const row = { path: e.path, origPath: null, untracked: false };
    if (e.unmerged) {
      merge.push({ ...row, letter: "!", scope: "worktree" });
      continue;
    }
    if (e.index === "?" && e.worktree === "?") {
      untracked.push({ ...row, letter: "U", scope: "worktree", untracked: true });
      continue;
    }
    if (e.index !== "." && e.index !== "?") staged.push({ ...row, origPath: e.orig_path, letter: letterOf(e.index), scope: "staged" });
    if (e.worktree !== "." && e.worktree !== "?") changes.push({ ...row, letter: letterOf(e.worktree), scope: "worktree" });
  }
  return { merge, staged, changes: [...changes, ...untracked] };
}
