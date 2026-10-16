import { useState } from "react";
import { ChevronIcon } from "../ui/icons";
import { gitCommitFiles } from "../lib/ipc";
import type { GitCommit, GitCommitFile, GitRepo } from "../lib/types";
import { timeAgo } from "./format";
import { FileRow } from "./FileRow";
import { letterOf } from "./sections";
import { useGit } from "./store";

interface Props {
  machineId: string;
  repo: GitRepo;
  repoKey: string;
  activeKey: string | null;
  keyOf(c: GitCommit, f: GitCommitFile): string;
  onOpen(c: GitCommit, f: GitCommitFile, pin: boolean): void;
  onLoadMore(): void;
  onMenu(c: GitCommit, x: number, y: number): void;
  onFileMenu?(c: GitCommit, f: GitCommitFile, x: number, y: number): void;
}

export function CommitList({ machineId, repo, repoKey, activeKey, keyOf, onOpen, onLoadMore, onMenu, onFileMenu }: Props) {
  const log = useGit((s) => s.logs[repoKey]);
  const collapsed = useGit((s) => s.collapsed);
  const expanded = useGit((s) => s.expanded);
  const commitFiles = useGit((s) => s.commitFiles);
  const toggleSection = useGit((s) => s.toggleSection);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const open = !collapsed.commits;
  const commits = log?.commits ?? [];

  const load = (c: GitCommit) => {
    const k = `${repoKey}|${c.sha}`;
    setErrors((e) => {
      const { [k]: _gone, ...rest } = e;
      return rest;
    });
    gitCommitFiles(machineId, repo.root, c.sha)
      .then((files) => useGit.getState().setCommitFiles(k, files))
      .catch((err: unknown) => {
        const msg = (err as { message?: string } | null)?.message ?? String(err);
        setErrors((e) => ({ ...e, [k]: msg }));
      });
  };

  const toggle = (c: GitCommit) => {
    const k = `${repoKey}|${c.sha}`;
    const st = useGit.getState();
    st.toggleCommit(k);
    if (!st.expanded[k] && !st.commitFiles[k]) load(c);
  };

  return (
    <div className="git-section" role="group" aria-label="Commits">
      <button type="button" className="git-section-head" aria-expanded={open} onClick={() => toggleSection("commits")}>
        <ChevronIcon className={open ? "open" : undefined} />
        Commits <span className="git-count">({commits.length})</span>
      </button>
      {open &&
        commits.map((c) => {
          const k = `${repoKey}|${c.sha}`;
          const isOpen = !!expanded[k];
          return (
            <div key={c.sha}>
              <button
                type="button"
                className="git-commit"
                aria-expanded={isOpen}
                title={`${c.sha}\n${c.author} · ${new Date(c.time * 1000).toLocaleString()}\n\n${c.subject}\n\n${c.body}`}
                onClick={() => toggle(c)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu(c, e.clientX, e.clientY);
                }}
              >
                <ChevronIcon className={isOpen ? "open" : undefined} />
                <span className="git-sha">{c.short}</span> {c.subject}
                <span className="git-row-dir">{` ${c.author} · ${timeAgo(c.time, Date.now())}`}</span>
              </button>
              {isOpen &&
                (errors[k] ? (
                  <div className="git-empty">
                    {errors[k]}
                    <button type="button" onClick={() => load(c)}>
                      Retry
                    </button>
                  </div>
                ) : (
                  (commitFiles[k] ?? []).map((f) => (
                    <FileRow
                      key={f.path}
                      path={f.path}
                      origPath={f.orig_path}
                      letter={letterOf(f.status)}
                      active={keyOf(c, f) === activeKey}
                      onOpen={(pin) => onOpen(c, f, pin)}
                      onMenu={onFileMenu && ((x, y) => onFileMenu(c, f, x, y))}
                    />
                  ))
                ))}
            </div>
          );
        })}
      {open && log && !log.done && (
        <button type="button" className="git-more" onClick={onLoadMore}>
          Load more
        </button>
      )}
    </div>
  );
}
