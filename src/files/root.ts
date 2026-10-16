import type { WorkspaceView } from "../lib/types";
import { sessionKey } from "../sidebar/groups";
import { activeItem, selectedPane } from "../store/app";
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
  return item && item.kind !== "agent" ? item.ws : workspaceOfSelection(s);
}

/**
 * The Workspace the Files panel shows: the one pinned for the followed Workspace's Session
 * (`pinned` maps a sessionKey to a workspace_id) while it still exists, else the followed one.
 */
export function shownWorkspace(s: Pick<AppState, "machines" | "selected" | "tabs" | "viewed">, pinned: Record<string, string>): WorkspaceRef | null {
  const followed = panelWorkspace(s);
  if (!followed) return null;
  const { machine_id, session } = followed;
  const workspace_id = pinned[sessionKey(machine_id, session)];
  if (!workspace_id || workspace_id === followed.workspace_id) return followed;
  const exists = s.machines[machine_id]?.sessions.find((x) => x.name === session)?.workspaces.some((w) => w.workspace_id === workspace_id);
  return exists ? { machine_id, session, workspace_id } : followed;
}
