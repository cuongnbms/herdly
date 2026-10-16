import { create } from "zustand";
import { sessionKey } from "../sidebar/groups";
import { useApp } from "../store/app";
import type { WorkspaceRef } from "../workspaces/folder";

/** What the agents column shows: the agent list, the Files panel, or the Git view. */
export type SidebarView = "agents" | "files" | "git";

/** The last chosen view: what a Session that never chose one shows. */
const VIEW_KEY = "herdly:sidebar-view";
const VIEWS_KEY = "herdly:sidebar-views";
const PINNED_KEY = "herdly:files-pinned";

const isView = (v: unknown): v is SidebarView => v === "agents" || v === "files" || v === "git";

function storedView(): SidebarView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (isView(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return "files";
}

function storedViews(): Record<string, SidebarView> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).filter((e): e is [string, SidebarView] => isView(e[1])));
    }
  } catch {
    /* storage unavailable or unreadable */
  }
  return {};
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** The viewed Session's sessionKey, or null with none viewed. */
function viewedKey(v = useApp.getState().viewed): string | null {
  return v ? sessionKey(v.machine_id, v.session) : null;
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
  /** The viewed Session's view (see `views`), else the last chosen one. */
  view: SidebarView;
  /** The view chosen in each Session (by sessionKey). Persisted. */
  views: Record<string, SidebarView>;
  /** Bumped to focus the tree. */
  focusTick: number;
  /** Bumped to focus Go to file. */
  gotoTick: number;
  /** The ticks already acted on; a panel that mounts with a newer tick still has a request to act on. */
  focusHandled: number;
  gotoHandled: number;
  /** The workspace_id pinned from the panel's title for each Session (by sessionKey); see `shownWorkspace`. Persisted. */
  pinned: Record<string, string>;
  /** Chooses the view for the viewed Session, and for Sessions that never chose one. */
  setView(view: SidebarView): void;
  /** Pins a Workspace for its Session; a null workspace_id goes back to following the active item. */
  pinWorkspace(ref: Omit<WorkspaceRef, "workspace_id"> & { workspace_id: string | null }): void;
  /** Shows the Files view (unpersisted) and asks for the tree's focus. */
  focusTree(): void;
  /** Shows the Files view (unpersisted) and asks for Go to file's focus. */
  focusGoto(): void;
  /** Marks the pending focus requests as acted on. */
  handled(which: "tree" | "goto" | "both"): void;
}

/** Layout of the Files panel for the running app; only the views and the pinned Workspaces are persisted. */
export const useFilesPanel = create<FilesPanelState>((set) => ({
  view: storedView(),
  views: storedViews(),
  focusTick: 0,
  gotoTick: 0,
  focusHandled: 0,
  gotoHandled: 0,
  pinned: storedPinned(),
  setView: (view) =>
    set((s) => {
      const key = viewedKey();
      const views = key === null ? s.views : { ...s.views, [key]: view };
      store(VIEW_KEY, view);
      store(VIEWS_KEY, JSON.stringify(views));
      return { view, views };
    }),
  pinWorkspace: ({ machine_id, session, workspace_id }) =>
    set((s) => {
      const { [sessionKey(machine_id, session)]: _, ...rest } = s.pinned;
      const pinned = workspace_id === null ? rest : { ...rest, [sessionKey(machine_id, session)]: workspace_id };
      store(PINNED_KEY, JSON.stringify(pinned));
      return { pinned };
    }),
  focusTree: () => set((s) => ({ view: "files", focusTick: s.focusTick + 1 })),
  focusGoto: () => set((s) => ({ view: "files", gotoTick: s.gotoTick + 1 })),
  handled: (which) =>
    set((s) => ({
      focusHandled: which === "goto" ? s.focusHandled : s.focusTick,
      gotoHandled: which === "tree" ? s.gotoHandled : s.gotoTick,
    })),
}));

// Viewing another Session shows the view it chose, else the last chosen one.
useApp.subscribe((s, prev) => {
  const key = viewedKey(s.viewed);
  if (key === viewedKey(prev.viewed)) return;
  useFilesPanel.setState({ view: (key !== null && useFilesPanel.getState().views[key]) || storedView() });
});
