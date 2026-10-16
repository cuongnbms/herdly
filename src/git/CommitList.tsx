import { ChevronIcon } from "../ui/icons";
import { gitCommitFiles } from "../lib/ipc";
import type { GitCommit, GitCommitFile, GitRepo } from "../lib/types";
import { timeAgo } from "./format";
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
}

export function CommitList({ machineId, repo, repoKey, activeKey, keyOf, onOpen, onLoadMore, onMenu }: Props) {
  const log = useGit((s) => s.logs[repoKey]);
  const collapsed = useGit((s) => s.collapsed);
  const expanded = useGit((s) => s.expanded);
  const commitFiles = useGit((s) => s.commitFiles);
  const toggleSection = useGit((s) => s.toggleSection);
  const open = !collapsed.commits;
  const commits = log?.commits ?? [];

  const toggle = (c: GitCommit) => {
    const k = `${repoKey}|${c.sha}`;
    const st = useGit.getState();
    st.toggleCommit(k);
    if (!st.expanded[k] && !st.commitFiles[k]) {
      gitCommitFiles(machineId, repo.root, c.sha)
        .then((files) => useGit.getState().setCommitFiles(k, files))
        .catch(() => {});
    }
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
                {c.short} {c.subject}
                <span className="git-row-dir">{` ${c.author} · ${timeAgo(c.time, Date.now())}`}</span>
              </button>
              {isOpen &&
                (commitFiles[k] ?? []).map((f) => {
                  const slash = f.path.lastIndexOf("/");
                  const dir = f.orig_path ? `${f.orig_path} → ${f.path}` : slash >= 0 ? f.path.slice(0, slash) : "";
                  const L = letterOf(f.status);
                  return (
                    <button
                      type="button"
                      className="git-row"
                      key={f.path}
                      title={f.path}
                      aria-current={keyOf(c, f) === activeKey ? "true" : undefined}
                      onClick={() => onOpen(c, f, false)}
                      onDoubleClick={() => onOpen(c, f, true)}
                    >
                      <span className="git-row-name">{f.path.slice(slash + 1)}</span>
                      <span className="git-row-dir">{dir}</span>
                      <span className={`git-letter git-letter-${L}`}>{L}</span>
                    </button>
                  );
                })}
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
