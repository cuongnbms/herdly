import { paneKey, type WorkspaceView } from "../lib/types";
import { activeItem, selectedPane, viewedItems } from "../store/app";
import type { AppState } from "../store/app";
import { getFolder, suggestFolder } from "../workspaces/folder";
import type { WorkspaceRef } from "../workspaces/folder";

export type Root = { path: string; source: "folder" | "pane" };

/** The absolute path of `rel` below `root`, without doubling the slash of `/`. */
export const absPath = (root: string, rel: string) => `${root === "/" ? "" : root}/${rel}`;

/**
 * The folder the Files panel browses: the Workspace's folder, else a pane's cwd.
 * `selectedCwd` must be `null` unless the selected pane belongs to `ref`'s Workspace;
 * another Workspace's cwd would become this one's root.
 */
export function resolveRoot(ref: WorkspaceRef, ws: WorkspaceView | undefined, selectedCwd: string | null): Root | null {
  const folder = getFolder(ref);
  if (folder) return { path: folder, source: "folder" };
  const path = selectedCwd || (ws ? suggestFolder(ws) : "");
  return path ? { path, source: "pane" } : null;
}

/**
 * The root the Files panel opens on for `ref`: as `resolveRoot`, counting the selected pane's
 * cwd only when that pane belongs to this Workspace.
 */
export function panelRoot(ref: WorkspaceRef, state: Pick<AppState, "machines" | "selected">): Root | null {
  const ws = state.machines[ref.machine_id]?.sessions.find((s) => s.name === ref.session)?.workspaces.find((w) => w.workspace_id === ref.workspace_id);
  const sel = state.selected;
  let cwd: string | null = null;
  if (sel && ws && sel.machine_id === ref.machine_id && sel.session === ref.session) {
    cwd = ws.tabs.flatMap((t) => t.panes).find((p) => p.pane_id === sel.pane_id)?.cwd ?? null;
  }
  return resolveRoot(ref, ws, cwd);
}

/** The Workspace holding the selected pane, if any. */
export function workspaceOfSelection(state: Pick<AppState, "machines" | "selected">): WorkspaceRef | null {
  const sel = selectedPane(state);
  if (!sel) return null;
  return { machine_id: sel.machine.id, session: sel.session.name, workspace_id: sel.workspace.workspace_id };
}

/** The Workspace the Files panel shows: the active item's, else the selected Pane's. */
export function panelWorkspace(s: Pick<AppState, "machines" | "selected" | "tabs" | "viewed">): WorkspaceRef | null {
  const item = activeItem(s);
  return item?.kind === "file" ? item.ws : workspaceOfSelection(s);
}

/** A Workspace the user picked in the Files panel, kept while the active item and selection are still `anchor`. */
export type PickedWorkspace = { ws: WorkspaceRef; anchor: string };

/** What the Files panel follows: the active item and the selected Pane. A pick lasts until it changes. */
export function panelAnchor(s: Pick<AppState, "selected" | "tabs" | "viewed">): string {
  return `${viewedItems(s).active ?? ""}|${s.selected ? paneKey(s.selected) : ""}`;
}

/** The Workspace the Files panel shows: the picked one while its anchor holds and it still exists, else the followed one. */
export function shownWorkspace(s: Pick<AppState, "machines" | "selected" | "tabs" | "viewed">, picked: PickedWorkspace | null): WorkspaceRef | null {
  if (picked && picked.anchor === panelAnchor(s)) {
    const { machine_id, session, workspace_id } = picked.ws;
    const exists = s.machines[machine_id]?.sessions.find((x) => x.name === session)?.workspaces.some((w) => w.workspace_id === workspace_id);
    if (exists) return picked.ws;
  }
  return panelWorkspace(s);
}
