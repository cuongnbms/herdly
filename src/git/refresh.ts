import { useEffect, useRef, useState } from "react";
import { useFilesBus } from "../files/bus";
import { filesKey } from "../files/store";
import { useApp } from "../store/app";
import type { WorkspaceRef } from "../workspaces/folder";
import { useGit } from "./store";

const DEBOUNCE_MS = 300;

/** Pane ids of the Workspace that are working, sorted and joined (a string, so the selector is stable). */
function workingPanes(machines: ReturnType<typeof useApp.getState>["machines"], ws: WorkspaceRef): string {
  const sess = machines[ws.machine_id]?.sessions.find((s) => s.name === ws.session);
  const w = sess?.workspaces.find((x) => x.workspace_id === ws.workspace_id);
  const ids: string[] = [];
  for (const t of w?.tabs ?? []) for (const p of t.panes) if (p.status === "working") ids.push(p.pane_id);
  return ids.sort().join("\n");
}

/**
 * A counter that goes up whenever the Git view should read the repository again: a debounced Files watch batch
 * for `root`, an Agent of `ws` leaving working, window focus, or a bump of `ticks[repoKey]`.
 * A null `root` or `repoKey` turns that trigger off.
 */
export function useGitRefresh(ws: WorkspaceRef, root: string | null, repoKey: string | null): number {
  const [tick, setTick] = useState(0);
  const up = () => setTick((n) => n + 1);

  const batchKey = root === null ? null : filesKey(ws, root);
  const seq = useFilesBus((s) => (batchKey === null ? 0 : (s.batches[batchKey]?.seq ?? 0)));
  const seenSeq = useRef(seq);
  useEffect(() => {
    if (seq === seenSeq.current) return;
    seenSeq.current = seq;
    const timer = setTimeout(up, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [seq]);

  const working = useApp((s) => workingPanes(s.machines, ws));
  const prevWorking = useRef(working);
  useEffect(() => {
    const before = prevWorking.current ? prevWorking.current.split("\n") : [];
    prevWorking.current = working;
    const now = new Set(working ? working.split("\n") : []);
    if (before.some((id) => !now.has(id))) up();
  }, [working]);

  useEffect(() => {
    window.addEventListener("focus", up);
    return () => window.removeEventListener("focus", up);
  }, []);

  const bumped = useGit((s) => (repoKey === null ? 0 : (s.ticks[repoKey] ?? 0)));
  const seenBump = useRef(bumped);
  useEffect(() => {
    if (bumped === seenBump.current) return;
    seenBump.current = bumped;
    up();
  }, [bumped]);

  return tick;
}
