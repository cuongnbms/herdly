// Pure layout model for sidebar Groups and Bookmarks.
// Must not import from src/store/ (the store imports this file).

import { create } from "zustand";
import type { MachineView, SessionView } from "../lib/types";

export type SessionKey = string;

export const sessionKey = (machineId: string, session: string): SessionKey =>
  `${encodeURIComponent(machineId)}/${encodeURIComponent(session)}`;

export type GroupNode = { kind: "group"; id: string; label: string; children: LayoutNode[] };
export type SessionNode = { kind: "session"; key: SessionKey };
export type LayoutNode = GroupNode | SessionNode;

export interface Layout {
  tree: LayoutNode[];
  bookmarks: SessionKey[];
}

export const EMPTY_LAYOUT: Layout = { tree: [], bookmarks: [] };

export type NodeRef = { kind: "group"; id: string } | { kind: "session"; key: SessionKey };
export type Target =
  | { kind: "before" | "after"; ref: NodeRef }
  | { kind: "into"; groupId: string | null; first?: boolean };

const matches = (n: LayoutNode, ref: NodeRef): boolean =>
  sameRef(n.kind === "group" ? { kind: "group", id: n.id } : { kind: "session", key: n.key }, ref);

const sameRef = (a: NodeRef, b: NodeRef): boolean =>
  a.kind === "group" ? b.kind === "group" && a.id === b.id : b.kind === "session" && a.key === b.key;

function find(nodes: LayoutNode[], ref: NodeRef): LayoutNode | null {
  for (const n of nodes) {
    if (matches(n, ref)) return n;
    if (n.kind === "group") {
      const f = find(n.children, ref);
      if (f) return f;
    }
  }
  return null;
}

function findGroup(nodes: LayoutNode[], id: string): GroupNode | null {
  const n = find(nodes, { kind: "group", id });
  return n && n.kind === "group" ? n : null;
}

/** Remove the node everywhere it appears; returns a new array (unchanged branches are shared). */
function detach(nodes: LayoutNode[], ref: NodeRef): LayoutNode[] {
  let changed = false;
  const out: LayoutNode[] = [];
  for (const n of nodes) {
    if (matches(n, ref)) {
      changed = true;
      continue;
    }
    if (n.kind === "group") {
      const children = detach(n.children, ref);
      if (children !== n.children) {
        changed = true;
        out.push({ ...n, children });
        continue;
      }
    }
    out.push(n);
  }
  return changed ? out : nodes;
}

/** Insert next to `ref` (offset 0 = before, 1 = after). Returns null when `ref` is absent. */
function insertBeside(nodes: LayoutNode[], ref: NodeRef, offset: 0 | 1, node: LayoutNode): LayoutNode[] | null {
  const i = nodes.findIndex((n) => matches(n, ref));
  if (i >= 0) return [...nodes.slice(0, i + offset), node, ...nodes.slice(i + offset)];
  for (let j = 0; j < nodes.length; j++) {
    const n = nodes[j];
    if (n.kind !== "group") continue;
    const children = insertBeside(n.children, ref, offset, node);
    if (children) return [...nodes.slice(0, j), { ...n, children }, ...nodes.slice(j + 1)];
  }
  return null;
}

function insertInto(nodes: LayoutNode[], groupId: string, first: boolean, node: LayoutNode): LayoutNode[] | null {
  for (let j = 0; j < nodes.length; j++) {
    const n = nodes[j];
    if (n.kind !== "group") continue;
    let children: LayoutNode[] | null;
    if (n.id === groupId) children = first ? [node, ...n.children] : [...n.children, node];
    else children = insertInto(n.children, groupId, first, node);
    if (children) return [...nodes.slice(0, j), { ...n, children }, ...nodes.slice(j + 1)];
  }
  return null;
}

function sameTree(a: LayoutNode[], b: LayoutNode[]): boolean {
  return (
    a.length === b.length &&
    a.every((n, i) => {
      const m = b[i];
      if (n === m) return true;
      if (n.kind === "session") return m.kind === "session" && n.key === m.key;
      return m.kind === "group" && n.id === m.id && n.label === m.label && sameTree(n.children, m.children);
    })
  );
}

const refOfTarget = (t: Target): NodeRef | null =>
  t.kind === "into" ? (t.groupId === null ? null : { kind: "group", id: t.groupId }) : t.ref;

export function canMove(layout: Layout, node: NodeRef, target: Target): boolean {
  const ref = refOfTarget(target);
  // A node dropped on its own row would not move.
  if (ref && sameRef(node, ref)) return false;
  if (node.kind !== "group") return true;
  const self = findGroup(layout.tree, node.id);
  if (!self) return true;
  if (!ref) return true;
  if (matches(self, ref)) return false;
  return find(self.children, ref) === null;
}

export function moveNode(layout: Layout, node: NodeRef, target: Target, unplaced: SessionKey[] = []): Layout {
  if (!canMove(layout, node, target)) return layout;

  const known = new Set<SessionKey>();
  const collect = (nodes: LayoutNode[]) => {
    for (const n of nodes) {
      if (n.kind === "session") known.add(n.key);
      else collect(n.children);
    }
  };
  collect(layout.tree);
  const extra: SessionNode[] = [];
  for (const key of unplaced) {
    if (known.has(key)) continue;
    known.add(key);
    extra.push({ kind: "session", key });
  }
  const base = extra.length ? [...layout.tree, ...extra] : layout.tree;

  const moving = find(base, node);
  if (!moving) return layout;
  const rest = detach(base, node);

  let tree: LayoutNode[] | null;
  if (target.kind === "into") {
    tree =
      target.groupId === null
        ? target.first ? [moving, ...rest] : [...rest, moving]
        : insertInto(rest, target.groupId, !!target.first, moving);
  } else {
    tree = insertBeside(rest, target.ref, target.kind === "before" ? 0 : 1, moving);
  }
  if (!tree || (!extra.length && sameTree(tree, layout.tree))) return layout;
  return { ...layout, tree };
}

export function addGroup(layout: Layout, parentId: string | null, label: string): { layout: Layout; id: string | null } {
  const text = label.trim();
  if (!text) return { layout, id: null };
  const id = crypto.randomUUID();
  const group: GroupNode = { kind: "group", id, label: text, children: [] };
  const tree = parentId === null ? [...layout.tree, group] : insertInto(layout.tree, parentId, false, group);
  if (!tree) return { layout, id: null };
  return { layout: { ...layout, tree }, id };
}

function mapGroup(nodes: LayoutNode[], id: string, fn: (g: GroupNode) => LayoutNode[]): LayoutNode[] {
  let changed = false;
  const out: LayoutNode[] = [];
  for (const n of nodes) {
    if (n.kind !== "group") {
      out.push(n);
      continue;
    }
    if (n.id === id) {
      changed = true;
      out.push(...fn(n));
      continue;
    }
    const children = mapGroup(n.children, id, fn);
    if (children !== n.children) {
      changed = true;
      out.push({ ...n, children });
    } else out.push(n);
  }
  return changed ? out : nodes;
}

export function renameGroup(layout: Layout, id: string, label: string): Layout {
  const text = label.trim();
  if (!text) return layout;
  const current = findGroup(layout.tree, id);
  if (!current || current.label === text) return layout;
  const tree = mapGroup(layout.tree, id, (g) => [g.label === text ? g : { ...g, label: text }]);
  return tree === layout.tree ? layout : { ...layout, tree };
}

/** Delete a group; its children take its place. */
export function deleteGroup(layout: Layout, id: string): Layout {
  const tree = mapGroup(layout.tree, id, (g) => g.children);
  return tree === layout.tree ? layout : { ...layout, tree };
}

export function setBookmarked(layout: Layout, key: SessionKey, on: boolean): Layout {
  const has = layout.bookmarks.includes(key);
  if (on === has) return layout;
  return { ...layout, bookmarks: on ? [...layout.bookmarks, key] : layout.bookmarks.filter((k) => k !== key) };
}

/** Move a bookmark before `beforeKey`, or to the end when null. */
export function moveBookmark(layout: Layout, key: SessionKey, beforeKey: SessionKey | null): Layout {
  if (!layout.bookmarks.includes(key) || key === beforeKey) return layout;
  const rest = layout.bookmarks.filter((k) => k !== key);
  let at = rest.length;
  if (beforeKey !== null) {
    at = rest.indexOf(beforeKey);
    if (at < 0) return layout;
  }
  const bookmarks = [...rest.slice(0, at), key, ...rest.slice(at)];
  return bookmarks.every((k, i) => k === layout.bookmarks[i]) ? layout : { ...layout, bookmarks };
}

function forgetWhere(layout: Layout, drop: (key: SessionKey) => boolean): Layout {
  const prune = (nodes: LayoutNode[]): LayoutNode[] => {
    let changed = false;
    const out: LayoutNode[] = [];
    for (const n of nodes) {
      if (n.kind === "session") {
        if (drop(n.key)) changed = true;
        else out.push(n);
      } else {
        const children = prune(n.children);
        if (children !== n.children) {
          changed = true;
          out.push({ ...n, children });
        } else out.push(n);
      }
    }
    return changed ? out : nodes;
  };
  const tree = prune(layout.tree);
  const kept = layout.bookmarks.filter((k) => !drop(k));
  const bookmarks = kept.length === layout.bookmarks.length ? layout.bookmarks : kept;
  return tree === layout.tree && bookmarks === layout.bookmarks ? layout : { tree, bookmarks };
}

export function forgetSessions(layout: Layout, keys: SessionKey[]): Layout {
  if (!keys.length) return layout;
  const set = new Set(keys);
  return forgetWhere(layout, (k) => set.has(k));
}

export function forgetMachine(layout: Layout, machineId: string): Layout {
  const prefix = `${encodeURIComponent(machineId)}/`;
  return forgetWhere(layout, (k) => k.startsWith(prefix));
}

export function groupPaths(layout: Layout): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  const walk = (nodes: LayoutNode[], prefix: string[]) => {
    for (const n of nodes) {
      if (n.kind !== "group") continue;
      const path = [...prefix, n.label];
      out.push({ id: n.id, path: path.join(" › ") });
      walk(n.children, path);
    }
  };
  walk(layout.tree, []);
  return out;
}

/** Where the layout lived before it moved to a file; read once to migrate, removed once the file holds it. */
export const LAYOUT_KEY = "herdly:sidebar-layout";

function parseLayout(v: unknown): Layout | null {
  const p = v as Partial<Layout> | null;
  return p && Array.isArray(p.tree) && Array.isArray(p.bookmarks) ? { tree: p.tree, bookmarks: p.bookmarks } : null;
}

/** The legacy localStorage layout; empty when missing, corrupt or unreadable. */
export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return parseLayout(JSON.parse(raw)) ?? EMPTY_LAYOUT;
  } catch {
    /* storage unavailable or corrupt */
  }
  return EMPTY_LAYOUT;
}

const forgetLegacyLayout = () => {
  try {
    localStorage.removeItem(LAYOUT_KEY);
  } catch {
    /* storage unavailable */
  }
};

export interface LayoutIO {
  load: () => Promise<unknown>;
  save: (l: Layout) => Promise<void>;
}

// Null until `initLayout` read the file, so nothing can overwrite it with an unloaded layout.
let persist: ((l: Layout) => void) | null = null;

/** Load the layout file, migrating the localStorage layout when there is no file yet. */
export async function initLayout(io: LayoutIO): Promise<void> {
  persist = null;
  let stored: unknown;
  try {
    stored = await io.load();
  } catch (e) {
    // Keep the file as it is: show the old layout and save nothing this run.
    console.error("cannot read the sidebar layout file", e);
    useLayout.setState({ layout: loadLayout() });
    return;
  }
  let queue: Promise<boolean> = Promise.resolve(true);
  // Each write settles to whether it succeeded, so the queue never rejects.
  const write = (l: Layout) =>
    (queue = queue.then(() =>
      io.save(l).then(
        () => true,
        (e) => {
          console.error("cannot save the sidebar layout", e);
          return false;
        },
      ),
    ));
  persist = (l) => void write(l);
  const saved = parseLayout(stored);
  if (saved) {
    useLayout.setState({ layout: saved });
    forgetLegacyLayout();
    return;
  }
  const legacy = loadLayout();
  useLayout.setState({ layout: legacy });
  if (legacy === EMPTY_LAYOUT) forgetLegacyLayout();
  // Drop the old key only once the file holds the layout.
  else void write(legacy).then((ok) => ok && forgetLegacyLayout());
}

interface LayoutState {
  layout: Layout;
  update: (fn: (l: Layout) => Layout) => void;
}

export const useLayout = create<LayoutState>((set, get) => ({
  layout: EMPTY_LAYOUT,
  update: (fn) => {
    const prev = get().layout;
    const next = fn(prev);
    if (next === prev) return;
    set({ layout: next });
    persist?.(next);
  },
}));

export type RSession = { kind: "session"; key: SessionKey; machine: MachineView; session: SessionView };
export type RGroup = { kind: "group"; id: string; label: string; children: RNode[] };
export type RNode = RGroup | RSession;

/** Join the layout with live machines. Placed sessions that no longer exist are hidden (but stay
 *  in storage); sessions the layout has not placed are appended to the root in `order`. */
export function resolve(
  layout: Layout,
  machines: Record<string, MachineView>,
  order: string[],
): { tree: RNode[]; bookmarks: RSession[]; unplaced: SessionKey[] } {
  const live = new Map<SessionKey, RSession>();
  for (const id of order) {
    const machine = machines[id];
    if (!machine) continue;
    for (const session of machine.sessions) {
      const key = sessionKey(machine.id, session.name);
      live.set(key, { kind: "session", key, machine, session });
    }
  }

  const placed = new Set<SessionKey>();
  const build = (nodes: LayoutNode[]): RNode[] => {
    const out: RNode[] = [];
    for (const n of nodes) {
      if (n.kind === "group") {
        out.push({ kind: "group", id: n.id, label: n.label, children: build(n.children) });
      } else {
        placed.add(n.key);
        const r = live.get(n.key);
        if (r) out.push(r);
      }
    }
    return out;
  };
  const tree = build(layout.tree);

  const unplaced: SessionKey[] = [];
  for (const [key, r] of live) {
    if (placed.has(key)) continue;
    unplaced.push(key);
    tree.push(r);
  }

  const bookmarks = layout.bookmarks.flatMap((k) => {
    const r = live.get(k);
    return r ? [r] : [];
  });
  return { tree, bookmarks, unplaced };
}
