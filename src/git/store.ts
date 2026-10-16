import { create } from "zustand";
import type { GitCommit, GitCommitFile, GitRepo } from "../lib/types";

/** Commits are read this many at a time. */
export const LOG_PAGE = 50;

export function repoKey(machineId: string, dir: string): string {
  return `${machineId}|${dir}`;
}

interface GitState {
  /** Keyed by the Files root (repoKey(machine, root.path)); null = not a repository. */
  repos: Record<string, GitRepo | null>;
  setRepo: (key: string, repo: GitRepo | null) => void;
  /** Keyed by repoKey(machine, repo.root). */
  logs: Record<string, { commits: GitCommit[]; done: boolean }>;
  setLog: (key: string, commits: GitCommit[], done: boolean) => void;
  appendLog: (key: string, commits: GitCommit[], done: boolean) => void;
  /** Keyed `repoKey + "|" + sha`. */
  commitFiles: Record<string, GitCommitFile[]>;
  setCommitFiles: (k: string, files: GitCommitFile[]) => void;
  /** Keyed by section: merge | staged | changes | commits. */
  collapsed: Record<string, true>;
  toggleSection: (section: string) => void;
  /** Keyed `repoKey + "|" + sha`. */
  expanded: Record<string, true>;
  toggleCommit: (k: string) => void;
  /** Bumped by the refresh button; useGitRefresh listens. */
  ticks: Record<string, number>;
  bump: (key: string) => void;
}

function toggled(rec: Record<string, true>, k: string): Record<string, true> {
  const next = { ...rec };
  if (next[k]) delete next[k];
  else next[k] = true;
  return next;
}

export const useGit = create<GitState>((set) => ({
  repos: {},
  setRepo: (key, repo) => set((s) => ({ repos: { ...s.repos, [key]: repo } })),
  logs: {},
  setLog: (key, commits, done) => set((s) => ({ logs: { ...s.logs, [key]: { commits, done } } })),
  appendLog: (key, commits, done) =>
    set((s) => ({ logs: { ...s.logs, [key]: { commits: [...(s.logs[key]?.commits ?? []), ...commits], done } } })),
  commitFiles: {},
  setCommitFiles: (k, files) => set((s) => ({ commitFiles: { ...s.commitFiles, [k]: files } })),
  collapsed: {},
  toggleSection: (section) => set((s) => ({ collapsed: toggled(s.collapsed, section) })),
  expanded: {},
  toggleCommit: (k) => set((s) => ({ expanded: toggled(s.expanded, k) })),
  ticks: {},
  bump: (key) => set((s) => ({ ticks: { ...s.ticks, [key]: (s.ticks[key] ?? 0) + 1 } })),
}));
