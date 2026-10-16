import { paneKey, type DiffScope, type MachineView, type PaneRef } from "../lib/types";
import { filesKey, relUnder, wsKey } from "../files/store";
import type { WorkspaceRef } from "../workspaces/folder";

export type CloseScope = "others" | "right" | "all";

/** One file's diff in a Workspace's repository: `repo` is the repository root, `prefix` the Files root's path below it, `path` repository-relative. */
export type DiffItem = {
  kind: "diff";
  ws: WorkspaceRef;
  root: string;
  repo: string;
  prefix: string;
  path: string;
  origPath: string | null;
  scope: DiffScope;
  untracked: boolean;
};

/** A pane (an agent or a plain terminal), a file, or a file's diff the user has opened. */
export type OpenItem = { kind: "agent"; ref: PaneRef } | { kind: "file"; ws: WorkspaceRef; root: string; rel: string } | DiffItem;

export const scopeKey = (s: DiffScope) => (s.kind === "commit" ? s.sha : s.kind);

/** Everything the user has opened, across machines and workspaces, in the order opened. */
export interface OpenItems {
  items: OpenItem[];
  /** The key of the one item (if any) that the next unpinned open replaces. */
  preview: string | null;
  /** The key of the item being shown. */
  active: string | null;
}

export const NO_ITEMS: OpenItems = { items: [], preview: null, active: null };

/** The key of the file `rel` in the files root keyed `fk` (see `filesKey`). */
export const fileItemKey = (fk: string, rel: string) => "file:" + fk + "|" + rel;

export function itemKey(item: OpenItem): string {
  if (item.kind === "agent") return "agent:" + paneKey(item.ref);
  if (item.kind === "diff") return "diff:" + wsKey(item.ws) + "|" + item.repo + "|" + scopeKey(item.scope) + "|" + item.path;
  return fileItemKey(filesKey(item.ws, item.root), item.rel);
}

export function findItem(s: OpenItems, key: string): OpenItem | undefined {
  return s.items.find((i) => itemKey(i) === key);
}

const indexOfKey = (items: OpenItem[], key: string) => items.findIndex((i) => itemKey(i) === key);

const keepKey = (items: OpenItem[], key: string | null) => (key && indexOfKey(items, key) >= 0 ? key : null);

/** Opens `item` (pinned or as the preview) and makes it active. */
export function openItem(s: OpenItems, item: OpenItem, { pin }: { pin: boolean }): OpenItems {
  const key = itemKey(item);
  const at = indexOfKey(s.items, key);
  // The key leaves out fields that can change (a diff's `untracked`), so the stored item is replaced.
  if (at >= 0) return { items: s.items.map((i, n) => (n === at ? item : i)), preview: pin && s.preview === key ? null : s.preview, active: key };
  // A pinned open promotes the current preview, so it stays.
  if (pin) return { items: [...s.items, item], preview: null, active: key };
  const prev = s.preview ? indexOfKey(s.items, s.preview) : -1;
  const items = prev >= 0 ? s.items.map((i, n) => (n === prev ? item : i)) : [...s.items, item];
  return { items, preview: key, active: key };
}

export function pinItem(s: OpenItems, key: string): OpenItems {
  return s.preview === key ? { ...s, preview: null } : s;
}

export function setActive(s: OpenItems, key: string | null): OpenItems {
  if (key !== null && indexOfKey(s.items, key) < 0) return s;
  return { ...s, active: key };
}

/** Closes relative to `key`; a closed active item hands over to `key` if it survives, else the item now at its index, else the one before, else null. Unknown key → s. */
export function closeItems(s: OpenItems, scope: "one" | CloseScope, key: string): OpenItems {
  const at = indexOfKey(s.items, key);
  if (at < 0) return s;
  const items =
    scope === "one" ? s.items.filter((_, i) => i !== at) : scope === "others" ? [s.items[at]] : scope === "right" ? s.items.slice(0, at + 1) : [];
  return { items, preview: keepKey(items, s.preview), active: nextActive(s, items, key) };
}

/** The keys `closeItems(s, scope, key)` would remove, in tab order. Derived from `closeItems` so the two cannot drift. */
export function closingKeys(s: OpenItems, scope: "one" | CloseScope, key: string): string[] {
  const kept = new Set(closeItems(s, scope, key).items.map(itemKey));
  return s.items.map(itemKey).filter((k) => !kept.has(k));
}

function nextActive(s: OpenItems, items: OpenItem[], key: string): string | null {
  if (s.active === null || indexOfKey(items, s.active) >= 0) return s.active;
  if (indexOfKey(items, key) >= 0) return key;
  const from = indexOfKey(s.items, s.active);
  const next = items[from] ?? items[from - 1];
  return next ? itemKey(next) : null;
}

/** Moves the item `from` to just `side` of `to`; preview and active are unchanged. Unknown key, same key or no change → s. */
export function moveItem(s: OpenItems, from: string, to: string, side: "before" | "after"): OpenItems {
  const at = indexOfKey(s.items, from);
  if (at < 0 || from === to || indexOfKey(s.items, to) < 0) return s;
  const rest = s.items.filter((_, i) => i !== at);
  const dest = indexOfKey(rest, to) + (side === "after" ? 1 : 0);
  if (dest === at) return s;
  return { ...s, items: [...rest.slice(0, dest), s.items[at], ...rest.slice(dest)] };
}

/** Moves `active` by `delta`, wrapping; no active → first item. Empty → s. */
export function cycleItem(s: OpenItems, delta: 1 | -1): OpenItems {
  if (s.items.length === 0) return s;
  const at = s.active ? indexOfKey(s.items, s.active) : -1;
  const next = at < 0 ? 0 : (at + delta + s.items.length) % s.items.length;
  return { ...s, active: itemKey(s.items[next]) };
}

/** For machine `v`: drops agent items whose Pane is gone and file items whose Workspace is gone. Call only with a connected snapshot. */
export function pruneItems(s: OpenItems, v: MachineView): OpenItems {
  const panes = new Set<string>();
  const workspaces = new Set<string>();
  for (const session of v.sessions)
    for (const w of session.workspaces) {
      workspaces.add([session.name, w.workspace_id].join("\0"));
      for (const t of w.tabs) for (const p of t.panes) panes.add(paneKey({ machine_id: v.id, session: session.name, pane_id: p.pane_id }));
    }
  return dropItems(s, (i) =>
    i.kind === "agent"
      ? i.ref.machine_id === v.id && !panes.has(paneKey(i.ref))
      : i.ws.machine_id === v.id && !workspaces.has([i.ws.session, i.ws.workspace_id].join("\0")),
  );
}

/** Drops the items `gone` matches; returns s when none match. A dropped active becomes null. */
export function dropItems(s: OpenItems, gone: (i: OpenItem) => boolean): OpenItems {
  const items = s.items.filter((i) => !gone(i));
  if (items.length === s.items.length) return s;
  return { items, preview: keepKey(items, s.preview), active: keepKey(items, s.active) };
}

const inRoot = (i: OpenItem, fk: string): i is Extract<OpenItem, { kind: "file" }> =>
  i.kind === "file" && filesKey(i.ws, i.root) === fk;

/** After `from` was renamed to `to` below `root`: its file items (and those inside it) follow, keeping preview and active. */
export function renameFileItems(s: OpenItems, ws: WorkspaceRef, root: string, from: string, to: string): OpenItems {
  const fk = filesKey(ws, root);
  const renamed = new Map<string, string>();
  const items = s.items.map((i) => {
    if (!inRoot(i, fk) || !relUnder(i.rel, from)) return i;
    const next = { ...i, rel: to + i.rel.slice(from.length) };
    renamed.set(itemKey(i), itemKey(next));
    return next;
  });
  if (!renamed.size) return s;
  const remap = (key: string | null) => (key && renamed.get(key)) ?? key;
  return { items, preview: remap(s.preview), active: remap(s.active) };
}

/** After `rel` was deleted below `root`: closes its file items and those inside it, as closing their tabs would. */
export function dropFileItems(s: OpenItems, ws: WorkspaceRef, root: string, rel: string): OpenItems {
  const fk = filesKey(ws, root);
  const gone = s.items.filter((i) => inRoot(i, fk) && relUnder(i.rel, rel)).map(itemKey);
  return gone.reduce((acc, key) => closeItems(acc, "one", key), s);
}
