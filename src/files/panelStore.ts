import { create } from "zustand";

/** What the agents column shows: the agent list, the Files panel, or both split. */
export type SidebarView = "agents" | "files" | "split";

const VIEW_KEY = "herdly:sidebar-view";

function storedView(): SidebarView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "agents" || v === "files" || v === "split") return v;
  } catch {
    /* storage unavailable */
  }
  return "split";
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
  setView(view: SidebarView): void;
  setHeight(px: number): void;
  setCollapsed(on: boolean): void;
  /** Expands the panel (out of the agents view) and asks for the tree's focus. */
  focusTree(): void;
  /** Expands the panel (out of the agents view) and asks for Go to file's focus. */
  focusGoto(): void;
  /** Marks the pending focus requests as acted on. */
  handled(which: "tree" | "goto" | "both"): void;
}

/** Layout of the Files panel for the running app; only the view is persisted. */
export const useFilesPanel = create<FilesPanelState>((set) => ({
  view: storedView(),
  height: null,
  collapsed: false,
  focusTick: 0,
  gotoTick: 0,
  focusHandled: 0,
  gotoHandled: 0,
  setView: (view) => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* storage unavailable */
    }
    set({ view });
  },
  setHeight: (height) => set({ height }),
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
