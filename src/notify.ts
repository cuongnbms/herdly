import { notifyPane } from "./lib/ipc";
import type { MachineView, PaneRef, PaneStatusEvent } from "./lib/types";
import { paneKey } from "./lib/types";

const SETTINGS_KEY = "herdly:settings";

/** `Default` is the system notification sound and `None` is silent; the rest are macOS system sounds by name. */
export const NOTIFICATION_SOUNDS = [
  "Default",
  "Basso",
  "Blow",
  "Bottle",
  "Frog",
  "Funk",
  "Glass",
  "Hero",
  "Morse",
  "Ping",
  "Pop",
  "Purr",
  "Sosumi",
  "Submarine",
  "Tink",
  "None",
] as const;
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];

function readRaw(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const p = raw ? (JSON.parse(raw) as unknown) : null;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function save(patch: Record<string, unknown>): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readRaw(), ...patch }));
  } catch {
    /* ignore */
  }
}

export function notificationsEnabled(): boolean {
  const v = readRaw().notifications;
  return typeof v === "boolean" ? v : true;
}

export function setNotificationsEnabled(on: boolean): void {
  save({ notifications: on });
}

export function notificationSound(): NotificationSound {
  const v = readRaw().notificationSound;
  return NOTIFICATION_SOUNDS.includes(v as NotificationSound) ? (v as NotificationSound) : "Default";
}

export function setNotificationSound(sound: NotificationSound): void {
  save({ notificationSound: sound });
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
  await notifyPane(
    ev.pane,
    `${pane?.agent ?? ev.title} is ${ev.status}`,
    `${machine} › ${ev.pane.session} › ${ev.title}`,
    notificationSound(),
  ).catch((e: unknown) => console.warn("notify_pane failed", e));
}
