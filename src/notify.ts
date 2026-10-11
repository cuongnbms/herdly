import { notifyPane } from "./lib/ipc";
import type { MachineView, PaneRef, PaneStatusEvent } from "./lib/types";
import { paneKey } from "./lib/types";

const SETTINGS_KEY = "herdly:settings";

export function notificationsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { notifications?: unknown };
      if (typeof p.notifications === "boolean") return p.notifications;
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return true;
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    let prev: Record<string, unknown> = {};
    try {
      prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      /* ignore corrupt */
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...prev, notifications: on }));
  } catch {
    /* ignore */
  }
}

export function shouldNotify(ev: PaneStatusEvent, selected: PaneRef | null, enabled: boolean): boolean {
  if (!enabled) return false;
  if (ev.status !== "blocked" && ev.status !== "done") return false;
  if (ev.previous === ev.status) return false;
  if (selected && paneKey(selected) === paneKey(ev.pane)) return false;
  return true;
}

export async function notifyPaneStatus(
  ev: PaneStatusEvent,
  selected: PaneRef | null,
  machines: Record<string, MachineView>,
): Promise<void> {
  if (!shouldNotify(ev, selected, notificationsEnabled())) return;
  const pane = machines[ev.pane.machine_id]
    ?.sessions.find((s) => s.name === ev.pane.session)
    ?.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes))
    .find((p) => p.pane_id === ev.pane.pane_id);
  const machine = machines[ev.pane.machine_id]?.label ?? ev.pane.machine_id;
  await notifyPane(ev.pane, `${pane?.agent ?? ev.title} is ${ev.status}`, `${machine} › ${ev.pane.session} › ${ev.title}`).catch(
    (e: unknown) => console.warn("notify_pane failed", e),
  );
}
