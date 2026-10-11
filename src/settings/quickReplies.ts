import { create } from "zustand";

/** Shared with store.ts, theme.ts and notify.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdly:settings";

export const DEFAULT_QUICK_REPLIES = ["continue", "yes", "no", "commit and push", "retry"];
export const QUICK_REPLIES_MAX = 12;
export const QUICK_REPLY_MAX_CHARS = 200;

export interface QuickReplies {
  /** Whether the buttons show above the Composer. */
  show: boolean;
  /** As edited in Settings, blank rows included. */
  replies: string[];
}

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

/** Strings only, capped in count and length; anything but a list falls back to the defaults. */
export function normalizeReplies(v: unknown): string[] {
  if (!Array.isArray(v)) return [...DEFAULT_QUICK_REPLIES];
  return v
    .filter((r): r is string => typeof r === "string")
    .slice(0, QUICK_REPLIES_MAX)
    .map((r) => r.slice(0, QUICK_REPLY_MAX_CHARS));
}

/** The replies worth a button: the list without the blank rows still being written. */
export function quickReplyButtons(replies: string[]): string[] {
  return replies.filter((r) => r.trim() !== "");
}

/**
 * The list with the reply at `from` moved to one side of the reply at `target`; null when that
 * would leave it where it is, or either index is outside the list.
 */
export function moveReply(replies: string[], from: number, target: number, side: "before" | "after"): string[] | null {
  if (from < 0 || from >= replies.length || target < 0 || target >= replies.length) return null;
  const gap = target + (side === "after" ? 1 : 0);
  if (gap === from || gap === from + 1) return null;
  const next = [...replies];
  const [moved] = next.splice(from, 1);
  next.splice(gap > from ? gap - 1 : gap, 0, moved);
  return next;
}

export function loadQuickReplies(): QuickReplies {
  const raw = readRaw();
  return {
    show: typeof raw.showQuickReplies === "boolean" ? raw.showQuickReplies : true,
    replies: normalizeReplies(raw.quickReplies),
  };
}

interface QuickRepliesStore extends QuickReplies {
  setShow: (show: boolean) => void;
  setReplies: (replies: string[]) => void;
  reset: () => void;
}

export const useQuickReplies = create<QuickRepliesStore>((setState) => ({
  ...loadQuickReplies(),
  setShow: (show) => {
    save({ showQuickReplies: show });
    setState({ show });
  },
  setReplies: (next) => {
    const replies = normalizeReplies(next);
    save({ quickReplies: replies });
    setState({ replies });
  },
  reset: () => {
    save({ quickReplies: DEFAULT_QUICK_REPLIES });
    setState({ replies: [...DEFAULT_QUICK_REPLIES] });
  },
}));
