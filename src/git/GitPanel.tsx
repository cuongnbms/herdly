import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useFilesPanel } from "../files/panelStore";
import { latestOnly, STALE } from "../files/latest";
import { shownWorkspace } from "../files/root";
import { wsKey } from "../files/store";
import { useFilesRoot } from "../files/useFilesRoot";
import { gitLog, gitRepo } from "../lib/ipc";
import type { DiffScope, GitCommit, GitCommitFile } from "../lib/types";
import { ContextMenu, type MenuItem } from "../sidebar/ContextMenu";
import { activeItem, useApp } from "../store/app";
import { itemKey, type DiffItem } from "../store/openItems";
import { CopyIcon, FileIcon, GitBranchIcon, RefreshIcon } from "../ui/icons";
import type { WorkspaceRef } from "../workspaces/folder";
import { ChangeList } from "./ChangeList";
import { CommitList } from "./CommitList";
import { relInRoot } from "./paths";
import { useGitRefresh } from "./refresh";
import type { Row } from "./sections";
import { letterOf } from "./sections";
import { LOG_PAGE, repoKey, useGit } from "./store";

const messageOf = (e: unknown) => (e as { message?: string } | null)?.message ?? String(e);
const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/** The Git view of the Files root's repository, under the agent list. */
export function GitPanel() {
  const view = useFilesPanel((s) => s.view);
  const pinned = useFilesPanel((s) => s.pinned);
  const ws = useApp(useShallow((s) => shownWorkspace(s, pinned)));
  if (view !== "git") return null;
  return (
    <section className="git-panel" aria-label="Git">
      {ws ? <WorkspaceGit key={wsKey(ws)} wsRef={ws} /> : <div className="git-empty">Select an agent to see its changes</div>}
    </section>
  );
}

type Menu =
  | { x: number; y: number; kind: "file"; path: string; letter: string }
  | { x: number; y: number; kind: "commit"; commit: GitCommit };

function WorkspaceGit({ wsRef: ref }: { wsRef: WorkspaceRef }) {
  const machineId = ref.machine_id;
  const online = useApp((s) => s.machines[machineId]?.state === "connected");
  const root = useFilesRoot(ref);
  const rootPath = root?.path ?? null;
  const rootKey = rootPath === null ? null : repoKey(machineId, rootPath);
  const repo = useGit((s) => (rootKey === null ? null : (s.repos[rootKey] ?? null)));
  const loaded = useGit((s) => rootKey !== null && rootKey in s.repos);
  const key = rootPath === null ? null : repoKey(machineId, repo?.root ?? rootPath);
  const log = useGit((s) => (key === null ? undefined : s.logs[key]));
  const tick = useGitRefresh(ref, rootPath, key);
  const active = useApp((s) => {
    const it = activeItem(s);
    return it ? itemKey(it) : null;
  });
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  const readRepo = useMemo(() => latestOnly(gitRepo), []);
  const readLog = useMemo(() => latestOnly(gitLog), []);
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const loadRepo = useCallback(() => {
    if (rootPath === null || rootKey === null || !onlineRef.current) return;
    readRepo(machineId, rootPath).then(
      (r) => {
        if (r === STALE) return;
        setError(null);
        useGit.getState().setRepo(rootKey, r);
      },
      (e: unknown) => setError({ message: messageOf(e), retry: loadRepo }),
    );
  }, [machineId, rootPath, rootKey, readRepo]);

  useEffect(loadRepo, [loadRepo, tick, online]);

  const repoRoot = repo?.root ?? null;
  const head = repo?.head ?? null;
  const loadLog = useCallback(
    (skip: number) => {
      if (repoRoot === null || !onlineRef.current) return;
      const k = repoKey(machineId, repoRoot);
      readLog(machineId, repoRoot, skip, LOG_PAGE).then(
        (page) => {
          if (page === STALE) return;
          setError(null);
          const done = page.length < LOG_PAGE;
          const st = useGit.getState();
          if (skip === 0) st.setLog(k, page, done);
          else st.appendLog(k, page, done);
        },
        (e: unknown) => setError({ message: messageOf(e), retry: () => loadLog(skip) }),
      );
    },
    [machineId, repoRoot, readLog],
  );
  // The first page, and again whenever HEAD moves.
  useEffect(() => loadLog(0), [loadLog, head, online]);

  const keyOfDiff = (path: string, scope: DiffScope) => itemKey({ kind: "diff", ws: ref, root: rootPath ?? "", repo: repoRoot ?? "", prefix: "", path, origPath: null, scope, untracked: false });

  const openDiff = (path: string, origPath: string | null, scope: DiffScope, untracked: boolean, pin: boolean) => {
    if (!repo || rootPath === null) return;
    const item: DiffItem = { kind: "diff", ws: ref, root: rootPath, repo: repo.root, prefix: repo.prefix, path, origPath, scope, untracked };
    useApp.getState().openDiff(item, { pin });
  };

  const fileItems = (path: string, letter: string): MenuItem[] => {
    const items: MenuItem[] = [];
    const rel = repo ? relInRoot(repo.prefix, path) : null;
    if (rel !== null && letter !== "D" && rootPath !== null) {
      items.push({ label: "Open file", icon: FileIcon, onSelect: () => useApp.getState().openFile(ref, rootPath, rel, { pin: false }) });
    }
    items.push({ label: "Copy path", icon: CopyIcon, group: items.length > 0, onSelect: () => void writeText(`${repo?.root ?? ""}/${path}`) });
    return items;
  };

  const menuItems = (m: Menu): MenuItem[] =>
    m.kind === "file"
      ? fileItems(m.path, m.letter)
      : [
          { label: "Copy sha", icon: CopyIcon, onSelect: () => void writeText(m.commit.sha) },
          { label: "Copy message", icon: CopyIcon, onSelect: () => void writeText(`${m.commit.subject}\n\n${m.commit.body}`.trim()) },
        ];

  const refresh = () => {
    if (key === null) return;
    useGit.getState().bump(key);
    loadLog(0);
  };

  if (rootPath === null) return <div className="git-empty">Select an agent to see its changes</div>;

  const showError = error !== null;
  return (
    <div className={online ? "git-ws" : "git-ws offline"}>
      <header className="git-head">
        <span className="git-repo-name">{baseName(repo?.root ?? rootPath)}</span>
        {repo && (
          <>
            <GitBranchIcon />
            <span className="git-branch">{repo.branch ?? "detached"}</span>
            {repo.upstream && repo.ahead > 0 && <span className="git-ahead">{`↑${repo.ahead}`}</span>}
            {repo.upstream && repo.behind > 0 && <span className="git-behind">{`↓${repo.behind}`}</span>}
          </>
        )}
        <span className="git-head-spacer" />
        <button type="button" className="git-refresh" aria-label="Refresh" onClick={refresh}>
          <RefreshIcon />
        </button>
      </header>
      {/* Outside the dimmed head and body, so it stays at full opacity. */}
      {!online && <div className="git-banner">Offline</div>}
      <div className="git-body">
        {showError && (
          <div className="git-empty">
            {error.message}
            <button type="button" onClick={error.retry}>
              Retry
            </button>
          </div>
        )}
        {!showError && repo === null && rootKey !== null && loaded && (
          <div className="git-empty">
            Not a git repository
            <div className="git-row-dir">{rootPath}</div>
          </div>
        )}
        {repo && key !== null && (
          <>
            <ChangeList
              repo={repo}
              activeKey={active}
              keyOf={(r: Row) => keyOfDiff(r.path, { kind: r.scope })}
              onOpen={(r, pin) => openDiff(r.path, r.origPath, { kind: r.scope }, r.untracked, pin)}
              onMenu={(r, x, y) => setMenu({ x, y, kind: "file", path: r.path, letter: r.letter })}
            />
            <CommitList
              machineId={machineId}
              repo={repo}
              repoKey={key}
              activeKey={active}
              keyOf={(c: GitCommit, f: GitCommitFile) => keyOfDiff(f.path, { kind: "commit", sha: c.sha, short: c.short })}
              onOpen={(c, f, pin) => openDiff(f.path, f.orig_path, { kind: "commit", sha: c.sha, short: c.short }, false, pin)}
              onLoadMore={() => loadLog(log?.commits.length ?? 0)}
              onMenu={(c, x, y) => setMenu({ x, y, kind: "commit", commit: c })}
              onFileMenu={(_c, f, x, y) => setMenu({ x, y, kind: "file", path: f.path, letter: letterOf(f.status) })}
            />
          </>
        )}
      </div>
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />, document.body)}
    </div>
  );
}
