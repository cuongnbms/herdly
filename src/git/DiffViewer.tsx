import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_LINE_H, lineHeight } from "../files/TextView";
import { latestOnly, STALE } from "../files/latest";
import { gitDiff } from "../lib/ipc";
import type { FileDiff } from "../lib/types";
import { useApp } from "../store/app";
import type { DiffItem } from "../store/openItems";
import { diffRows, type DiffRow } from "./diffLines";
import { timeAgo } from "./format";
import { relInRoot } from "./paths";
import { useGitRefresh } from "./refresh";
import { repoKey, useGit } from "./store";

const errMessage = (e: unknown) => String((e as { message?: string } | null)?.message ?? e);

const rowText = (r: DiffRow) => ("text" in r ? r.text : r.segs.map((s) => s.text).join(""));
function sameRow(a: DiffRow, b: DiffRow): boolean {
  if (a.kind !== b.kind || rowText(a) !== rowText(b)) return false;
  if (a.kind === "hunk" || a.kind === "note" || b.kind === "hunk" || b.kind === "note") return true;
  return a.oldNo === b.oldNo && a.newNo === b.newNo && a.mark === b.mark;
}

/** The unified diff of one file (or of one file in a commit), as the main area shows it for a `diff` Open item. */
export function DiffViewer({ item, online }: { item: DiffItem; online: boolean }) {
  const { ws, repo, path, origPath, scope, untracked } = item;
  const machineId = ws.machine_id;
  const key = repoKey(machineId, repo);
  const live = scope.kind !== "commit";
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useMemo(() => latestOnly(gitDiff), []);
  const tick = useGitRefresh(ws, item.root, key);

  const load = useCallback(() => {
    read(machineId, repo, path, origPath, scope, untracked).then(
      (d) => {
        if (d === STALE) return;
        setDiff(d);
        setError(null);
      },
      (e) => setError(errMessage(e)),
    );
  }, [read, machineId, repo, path, origPath, scope, untracked]);

  // A working-tree or staged diff is read again on each tick while the Machine is up; a commit's is read until one read succeeds.
  const liveTick = live ? tick : 0;
  const needsRead = live || diff === null;
  useEffect(() => {
    if (!online || !needsRead) return;
    load();
  }, [load, liveTick, online, needsRead]);

  const commit = useGit((s) => (scope.kind === "commit" ? s.logs[key]?.commits.find((c) => c.sha === scope.sha) : undefined));
  const rows = useMemo(() => (diff ? diffRows(diff, path) : []), [diff, path]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(DEFAULT_LINE_H);
  useLayoutEffect(() => setRowH(lineHeight(scrollRef.current)), []);
  // The widest row in columns (a tab counts as 8): the stylesheet sizes every row to it, so backgrounds span the horizontal scroll.
  const cols = useMemo(() => rows.reduce((m, r) => Math.max(m, rowText(r).replace(/\t/g, "        ").length), 0), [rows]);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowH, overscan: 20 });
  // estimateSize is not part of the virtualizer's measurement cache key, so re-measure on change.
  useLayoutEffect(() => virt.measure(), [rowH]);

  // After a re-read the scroll position stays when everything above the first visible row is as it was.
  const prevRows = useRef<DiffRow[] | null>(null);
  useLayoutEffect(() => {
    const prev = prevRows.current;
    prevRows.current = rows;
    const el = scrollRef.current;
    if (!prev || !el || prev === rows || el.scrollTop === 0) return;
    const first = Math.floor(el.scrollTop / rowH);
    let same = first <= prev.length && first <= rows.length;
    for (let i = 0; same && i < first; i++) same = sameRow(prev[i], rows[i]);
    if (!same) el.scrollTop = 0;
  }, [rows, rowH]);

  const deleted = diff !== null && diff.old_mode !== null && diff.new_mode === null;
  const rel = relInRoot(item.prefix, path);
  const modeChanged = diff !== null && diff.old_mode !== null && diff.new_mode !== null && diff.old_mode !== diff.new_mode;
  const empty = diff !== null && !diff.binary && diff.hunks.length === 0;

  return (
    <div className="diff-view">
      <div className="diff-head">
        <div className="diff-title">
          <span className="diff-path">{origPath && scope.kind !== "worktree" ? `${origPath} → ${path}` : path}</span>
          {diff && <span className="diff-added">+{diff.added}</span>}
          {diff && <span className="diff-removed">−{diff.removed}</span>}
          {rel !== null && diff && !deleted && (
            <button type="button" onClick={() => useApp.getState().openFile(ws, item.root, rel, { pin: false })}>
              Open file
            </button>
          )}
        </div>
        {scope.kind === "commit" && (
          <div className="diff-commit">
            <span className="diff-sha">{scope.short}</span>
            {commit && <span className="diff-subject">{commit.subject}</span>}
            {commit && <span className="diff-author">{commit.author}</span>}
            {commit && <span className="diff-when">{timeAgo(commit.time, Date.now())}</span>}
          </div>
        )}
      </div>
      {!online && <div className="diff-notice">Machine offline</div>}
      {error !== null && (
        <div className="diff-notice" role="alert">
          <span>{error}</span>
          <button type="button" onClick={load}>Retry</button>
        </div>
      )}
      {diff?.binary && <div className="diff-notice">Binary file changed</div>}
      {modeChanged && <div className="diff-notice">Mode changed {diff.old_mode} → {diff.new_mode}</div>}
      {empty && diff.rename !== null && <div className="diff-notice">Renamed, no content changes</div>}
      {empty && diff.rename === null && !modeChanged && <div className="diff-notice">No changes</div>}
      <div ref={scrollRef} className="diff-body">
        <div style={{ height: virt.getTotalSize(), position: "relative", "--diff-cols": cols } as CSSProperties}>
          {virt.getVirtualItems().map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            const style = { position: "absolute" as const, top: 0, left: 0, height: rowH, transform: `translateY(${v.start}px)` };
            if (row.kind === "hunk" || row.kind === "note") {
              return (
                <div key={v.key} className={`diff-row diff-${row.kind}`} style={style}>
                  {row.text}
                </div>
              );
            }
            return (
              <div key={v.key} className={`diff-row diff-${row.kind}`} style={style}>
                <span className="diff-no" data-n={row.oldNo ?? ""} />
                <span className="diff-no" data-n={row.newNo ?? ""} />
                <span className="diff-mark" data-m={row.mark} />
                <span className="diff-code">
                  {row.segs.map((s, i) => (
                    <span key={i} className={s.cls || undefined}>{s.text}</span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
        {diff?.truncated && <div className="diff-notice">Diff truncated at 2 MB</div>}
      </div>
    </div>
  );
}
