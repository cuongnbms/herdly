import { useEffect } from "react";
import { create } from "zustand";
import { activeItem, useApp } from "../store/app";
import { useFolder } from "../workspaces/folder";
import type { WorkspaceRef } from "../workspaces/folder";
import { panelRoot, type Root } from "./root";
import { wsKey } from "./store";

/** The root each Workspace was resolved to, with the folder it was resolved under, keyed by `wsKey`: shared by the Files and Git panels. */
export const useResolvedRoots = create<{ roots: Record<string, { root: Root; folder: string | null }> }>(() => ({ roots: {} }));

/**
 * The root of `ref`'s Workspace. The first caller resolves it, and it is resolved again only
 * when the Workspace folder differs from the one it was resolved under: a cd in the pane must
 * not move the root under the open files. A Workspace with no root is retried on every mount.
 * The root of the active file item of this Workspace overrides it.
 */
export function useFilesRoot(ref: WorkspaceRef): Root | null {
  const key = wsKey(ref);
  const folder = useFolder(ref);
  const entry = useResolvedRoots((s) => s.roots[key]);
  const fresh = entry !== undefined && entry.folder === folder;
  // Until a caller has stored it, resolve for this render.
  const resolved: Root | null = fresh ? entry.root : panelRoot(ref, useApp.getState());
  useEffect(() => {
    const cur = useResolvedRoots.getState().roots[key];
    if (cur !== undefined && cur.folder === folder) return;
    const root = panelRoot(ref, useApp.getState());
    if (root) useResolvedRoots.setState((s) => ({ roots: { ...s.roots, [key]: { root, folder } } }));
  }, [key, folder]);

  const itemRoot = useApp((s) => {
    const item = activeItem(s);
    return item && item.kind !== "agent" && wsKey(item.ws) === key ? item.root : null;
  });
  return itemRoot !== null ? { path: itemRoot, source: resolved?.path === itemRoot ? resolved.source : "folder" } : resolved;
}
