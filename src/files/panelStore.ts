import { create } from "zustand";
import { sessionKey } from "../sidebar/groups";
import type { WorkspaceRef } from "../workspaces/folder";

/** What the agents column shows: the agent list, the Files panel, or both split. */
export type SidebarView = "agents" | "files" | "split";

const VIEW_KEY = "herdly:sidebar-view";
const PINNED_KEY = "herdly:files-pinned";

function storedView(): SidebarView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "agents" || v === "files" || v === "split") return v;
  } catch {
    /* storage unavailable */
  }
  return "split";
}

function storedPinned(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
    }
  } catch {
    /* storage unavailable or unreadable */
  }
  return {};
}

interface FilesPanelState {
  view: SidebarView;
  /** Pixels of the panel; null is half the column. */
  height: number | null;
  collapsed: boolean;
  /** Bumped to focus the tree. */
  focusTick: number;
  /** Bumped to focus Go to file. */
  gotoTick: number;
  /** The ticks already acted on; a panel that mounts with a newer tick still has a request to act on. */
  focusHandled: number;
  gotoHandled: number;
  /** The workspace_id pinned from the panel's title for each Session (by sessionKey); see `shownWorkspace`. Persisted. */
  pinned: Record<string, string>;
  setView(view: SidebarView): void;
  setHeight(px: number): void;
  /** Pins a Workspace for its Session; a null workspace_id goes back to following the active item. */
  pinWorkspace(ref: Omit<WorkspaceRef, "workspace_id"> & { workspace_id: string | null }): void;
  setCollapsed(on: boolean): void;
  /** Expands the panel (out of the agents view) and asks for the tree's focus. */
  focusTree(): void;
  /** Expands the panel (out of the agents view) and asks for Go to file's focus. */
  focusGoto(): void;
  /** Marks the pending focus requests as acted on. */
  handled(which: "tree" | "goto" | "both"): void;
}

/** Layout of the Files panel for the running app; only the view and the pinned Workspaces are persisted. */
export const useFilesPanel = create<FilesPanelState>((set) => ({
  view: storedView(),
  height: null,
  collapsed: false,
  focusTick: 0,
  gotoTick: 0,
  focusHandled: 0,
  gotoHandled: 0,
  pinned: storedPinned(),
  setView: (view) => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* storage unavailable */
    }
    set({ view });
  },
  setHeight: (height) => set({ height }),
  pinWorkspace: ({ machine_id, session, workspace_id }) =>
    set((s) => {
      const { [sessionKey(machine_id, session)]: _, ...rest } = s.pinned;
      const pinned = workspace_id === null ? rest : { ...rest, [sessionKey(machine_id, session)]: workspace_id };
      try {
        localStorage.setItem(PINNED_KEY, JSON.stringify(pinned));
      } catch {
        /* storage unavailable */
      }
      return { pinned };
    }),
  setCollapsed: (collapsed) => set({ collapsed }),
  focusTree: () => set((s) => ({ collapsed: false, view: shownView(s.view), focusTick: s.focusTick + 1 })),
  focusGoto: () => set((s) => ({ collapsed: false, view: shownView(s.view), gotoTick: s.gotoTick + 1 })),
  handled: (which) =>
    set((s) => ({
      focusHandled: which === "goto" ? s.focusHandled : s.focusTick,
      gotoHandled: which === "tree" ? s.gotoHandled : s.gotoTick,
    })),
}));

/** A view that shows the Files panel: the agents view gives way to split, unpersisted. */
function shownView(view: SidebarView): SidebarView {
  return view === "agents" ? "split" : view;
}

/** The Files panel shows nothing: hidden by the agents view, or collapsed in split. */
export const filesHidden = (s: Pick<FilesPanelState, "view" | "collapsed">) => s.view === "agents" || (s.view === "split" && s.collapsed);
