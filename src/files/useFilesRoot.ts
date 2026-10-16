import { useEffect, useRef } from "react";
import { create } from "zustand";
import { activeItem, useApp } from "../store/app";
import { useFolder } from "../workspaces/folder";
import type { WorkspaceRef } from "../workspaces/folder";
import { panelRoot, type Root } from "./root";
import { wsKey } from "./store";

/** The root each Workspace was resolved to, keyed by `wsKey`: shared by the Files and Git panels. */
export const useResolvedRoots = create<{ roots: Record<string, Root | null> }>(() => ({ roots: {} }));

/**
 * The root of `ref`'s Workspace. The first caller resolves it, and it is resolved again only
 * when the Workspace folder is set: a cd in the pane must not move the root under the open files.
 * The root of the active file item of this Workspace overrides it.
 */
export function useFilesRoot(ref: WorkspaceRef): Root | null {
  const key = wsKey(ref);
  const folder = useFolder(ref);
  const stored = useResolvedRoots((s) => s.roots[key]);
  // Until the first caller has stored it, resolve for this render.
  const resolved: Root | null = stored !== undefined ? stored : panelRoot(ref, useApp.getState());
  const folderSeen = useRef(folder);
  useEffect(() => {
    const roots = useResolvedRoots.getState().roots;
    const changed = folderSeen.current !== folder;
    folderSeen.current = folder;
    if (!changed && key in roots) return;
    useResolvedRoots.setState({ roots: { ...roots, [key]: panelRoot(ref, useApp.getState()) } });
  }, [key, folder]);

  const itemRoot = useApp((s) => {
    const item = activeItem(s);
    return item?.kind === "file" && wsKey(item.ws) === key ? item.root : null;
  });
  return itemRoot !== null ? { path: itemRoot, source: resolved?.path === itemRoot ? resolved.source : "folder" } : resolved;
}
