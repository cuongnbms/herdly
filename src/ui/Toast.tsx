import { useSyncExternalStore } from "react";
import { AlertIcon } from "./icons";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  text: string;
  /** A warning shows the alert icon; plain information does not. */
  alert: boolean;
  /** A button shown after the text; clicking it runs it and dismisses the toast. */
  action?: ToastAction;
}

const DISMISS_MS = 5000;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Show a toast that dismisses itself after 5 s. */
export function showToast(text: string, { alert = true }: { alert?: boolean } = {}): number {
  const id = nextId++;
  items = [...items, { id, text, alert }];
  emit();
  setTimeout(() => dismissToast(id), DISMISS_MS);
  return id;
}

/** Show a toast that stays until `updateToast` replaces it. Returns its id. */
export function showProgressToast(text: string): number {
  const id = nextId++;
  items = [...items, { id, text, alert: false }];
  emit();
  return id;
}

/** Replace a toast's content in place, then let it dismiss itself after 5 s. */
export function updateToast(
  id: number,
  text: string,
  { alert = true, action }: { alert?: boolean; action?: ToastAction } = {},
) {
  if (!items.some((t) => t.id === id)) return;
  items = items.map((t) => (t.id === id ? { ...t, text, alert, action } : t));
  emit();
  setTimeout(() => dismissToast(id), DISMISS_MS);
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const snapshot = () => items;

export function Toasts() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (list.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          {t.alert && <AlertIcon />}
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
