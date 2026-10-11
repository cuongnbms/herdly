import { create } from "zustand";
import { activeItem, findPane, useApp, type AppState } from "./app";
import { itemKey, type OpenItem } from "./openItems";

/** How many places Back remembers. */
const LIMIT = 50;

/** The items shown before (`back`, most recent last) and after (`forward`, next last) the current one,
 *  for the mouse's Back and Forward buttons and ⌘[ / ⌘]. Not persisted. */
interface HistoryState {
  back: OpenItem[];
  forward: OpenItem[];
}

export const useHistory = create<HistoryState>(() => ({ back: [], forward: [] }));

const shown = (s: AppState) => activeItem(s);

/** Set while Back or Forward moves the view, so the move is not recorded as a new place. */
let navigating = false;

useApp.subscribe((s, prev) => {
  const from = shown(prev);
  const to = shown(s);
  if (navigating || !from || (to && itemKey(to) === itemKey(from))) return;
  useHistory.setState((h) => {
    const top = h.back[h.back.length - 1];
    const back = top && itemKey(top) === itemKey(from) ? h.back : [...h.back, from].slice(-LIMIT);
    return { back, forward: [] };
  });
});

/** Whether `item` can still be shown: its Pane, or its file's Workspace, must still exist. */
function reachable(item: OpenItem): boolean {
  const { machines } = useApp.getState();
  if (item.kind === "agent") return !!findPane(machines, item.ref);
  const { machine_id, session, workspace_id } = item.ws;
  return !!machines[machine_id]?.sessions.find((x) => x.name === session)?.workspaces.some((w) => w.workspace_id === workspace_id);
}

function show(item: OpenItem) {
  navigating = true;
  try {
    const s = useApp.getState();
    if (item.kind === "agent") s.select(item.ref);
    else s.openFile(item.ws, item.root, item.rel, { pin: false });
  } finally {
    navigating = false;
  }
}

/** Moves one place along `from`, leaving the current item on `to`; places that are gone are dropped. */
function step(from: "back" | "forward", to: "back" | "forward") {
  const h = useHistory.getState();
  const stack = [...h[from]];
  const cur = shown(useApp.getState());
  let next: OpenItem | undefined;
  while ((next = stack.pop())) {
    if (reachable(next) && (!cur || itemKey(next) !== itemKey(cur))) break;
  }
  if (!next) return useHistory.setState({ [from]: stack } as Partial<HistoryState>);
  useHistory.setState({ [from]: stack, [to]: cur ? [...h[to], cur].slice(-LIMIT) : h[to] } as Partial<HistoryState>);
  show(next);
}

export const goBack = () => step("back", "forward");
export const goForward = () => step("forward", "back");
