import { describe, expect, it } from "vitest";
import type { DiffScope, MachineView, PaneRef } from "../lib/types";
import { closeItems, closingKeys, cycleItem, dropFileItems, dropItems, itemKey, renameFileItems, moveItem, NO_ITEMS, openItem, pinItem, pruneItems, setActive, type DiffItem, type OpenItem, type OpenItems } from "./openItems";

const ws = (workspace_id = "w1", session = "s", machine_id = "local") => ({ machine_id, session, workspace_id });
const a = (pane_id: string, session = "s", machine_id = "local"): OpenItem => ({ kind: "agent", ref: { machine_id, session, pane_id } as PaneRef });
const f = (rel: string, w = ws(), root = "/r"): OpenItem => ({ kind: "file", ws: w, root, rel });
const k = itemKey;
const pin = { pin: true };
const peek = { pin: false };
const of = (items: OpenItem[], preview: OpenItem | null = null, active: OpenItem | null = null): OpenItems => ({
  items, preview: preview && k(preview), active: active && k(active),
});

describe("open items", () => {
  it("keys agents by pane and files by workspace, root and path", () => {
    expect(k(a("p1"))).toBe("agent:local/s/p1");
    expect(k(f("src/a.ts"))).toBe("file:local/s/w1|/r|src/a.ts");
  });

  it("an unpinned open of either kind replaces the preview in place and becomes active", () => {
    let s = openItem(of([a("p1")]), f("x.md"), peek);
    expect(s).toEqual(of([a("p1"), f("x.md")], f("x.md"), f("x.md")));
    s = openItem(s, a("p2"), peek);
    expect(s).toEqual(of([a("p1"), a("p2")], a("p2"), a("p2")));
  });

  it("a pinned open promotes the preview; opening an open item only activates it", () => {
    const s = openItem(of([a("p1")]), f("x.md"), peek);
    expect(openItem(s, a("p2"), pin)).toEqual(of([a("p1"), f("x.md"), a("p2")], null, a("p2")));
    expect(openItem(s, a("p1"), peek)).toEqual(of([a("p1"), f("x.md")], f("x.md"), a("p1")));
    expect(openItem(s, f("x.md"), pin)).toEqual(of([a("p1"), f("x.md")], null, f("x.md")));
    expect(pinItem(s, k(f("x.md")))).toEqual(of([a("p1"), f("x.md")], null, f("x.md")));
    expect(pinItem(s, k(a("p1")))).toBe(s);
  });

  it("closes one, others, to the right, or all, handing the active item over", () => {
    const s = of([a("p1"), f("b"), a("p3"), f("d")], f("d"), f("b"));
    expect(closeItems(s, "one", k(f("b")))).toEqual(of([a("p1"), a("p3"), f("d")], f("d"), a("p3")));
    expect(closeItems(of([a("p1"), f("b")], null, f("b")), "one", k(f("b")))).toEqual(of([a("p1")], null, a("p1")));
    expect(closeItems(s, "others", k(a("p3")))).toEqual(of([a("p3")], null, a("p3")));
    expect(closeItems(s, "right", k(f("b")))).toEqual(of([a("p1"), f("b")], null, f("b")));
    expect(closeItems(s, "all", k(f("b")))).toEqual(NO_ITEMS);
    expect(closeItems(s, "one", k(a("nope")))).toBe(s);
  });

  it("cycles the active item with wrap-around", () => {
    const s = of([a("p1"), f("b"), a("p3")], null, a("p3"));
    expect(cycleItem(s, 1).active).toBe(k(a("p1")));
    expect(cycleItem(s, -1).active).toBe(k(f("b")));
    expect(cycleItem(of([a("p1"), f("b")]), 1).active).toBe(k(a("p1")));
    expect(cycleItem(NO_ITEMS, 1)).toBe(NO_ITEMS);
  });

  it("moves an item before or after another, keeping preview and active", () => {
    const s = of([a("p1"), f("b"), a("p3")], f("b"), a("p3"));
    expect(moveItem(s, k(a("p3")), k(a("p1")), "before")).toEqual(of([a("p3"), a("p1"), f("b")], f("b"), a("p3")));
    expect(moveItem(s, k(a("p1")), k(a("p3")), "after")).toEqual(of([f("b"), a("p3"), a("p1")], f("b"), a("p3")));
    expect(moveItem(s, k(a("p1")), k(a("p3")), "before")).toEqual(of([f("b"), a("p1"), a("p3")], f("b"), a("p3")));
    expect(moveItem(s, k(a("p1")), k(f("b")), "before")).toBe(s);
    expect(moveItem(s, k(a("p1")), k(a("p1")), "after")).toBe(s);
    expect(moveItem(s, k(a("nope")), k(a("p1")), "after")).toBe(s);
    expect(moveItem(s, k(a("p1")), k(a("nope")), "after")).toBe(s);
  });

  it("setActive ignores unknown keys", () => {
    const s = of([a("p1")]);
    expect(setActive(s, k(a("p1"))).active).toBe(k(a("p1")));
    expect(setActive(s, "agent:nope")).toBe(s);
    expect(setActive(s, null).active).toBeNull();
  });

  it("prunes gone panes and gone workspaces of that machine only", () => {
    const v = { id: "local", sessions: [{ name: "s", workspaces: [{ workspace_id: "w1", tabs: [{ panes: [{ pane_id: "p1" }] }] }] }] } as unknown as MachineView;
    const s = of([a("p1"), a("p2"), f("x", ws("w1")), f("y", ws("w2")), a("p9", "s", "devtuf"), f("z", ws("w2", "s", "devtuf"))], null, f("y", ws("w2")));
    expect(pruneItems(s, v)).toEqual(of([a("p1"), f("x", ws("w1")), a("p9", "s", "devtuf"), f("z", ws("w2", "s", "devtuf"))]));
  });

  it("dropItems keeps the same object when nothing matches", () => {
    const s = of([a("p1"), f("x")]);
    expect(dropItems(s, () => false)).toBe(s);
    expect(dropItems(s, (i) => i.kind === "file")).toEqual(of([a("p1")]));
  });

  it("renames a file item and keeps it active and the preview", () => {
    const s = of([a("p1"), f("src/a.ts")], f("src/a.ts"), f("src/a.ts"));
    expect(renameFileItems(s, ws(), "/r", "src/a.ts", "src/b.ts")).toEqual(of([a("p1"), f("src/b.ts")], f("src/b.ts"), f("src/b.ts")));
  });

  it("renames the files inside a renamed folder, not its namesakes", () => {
    const s = of([f("src/a.ts"), f("src/x/y.md"), f("srcs/a.ts"), f("src/a.ts", ws("w2")), f("src/a.ts", ws(), "/other")], null, f("src/x/y.md"));
    expect(renameFileItems(s, ws(), "/r", "src", "lib")).toEqual(
      of([f("lib/a.ts"), f("lib/x/y.md"), f("srcs/a.ts"), f("src/a.ts", ws("w2")), f("src/a.ts", ws(), "/other")], null, f("lib/x/y.md")),
    );
  });

  it("returns the same state when no file is renamed", () => {
    const s = of([f("a")]);
    expect(renameFileItems(s, ws(), "/r", "b", "c")).toBe(s);
  });

  it("closes a deleted file and the files inside a deleted folder", () => {
    const s = of([a("p1"), f("src/a.ts"), f("src/x/y.md"), f("srcs/a.ts"), f("src/a.ts", ws("w2"))], f("srcs/a.ts"), f("src/a.ts"));
    // The active item hands over as when its tab is closed.
    expect(dropFileItems(s, ws(), "/r", "src")).toEqual(of([a("p1"), f("srcs/a.ts"), f("src/a.ts", ws("w2"))], f("srcs/a.ts"), f("srcs/a.ts")));
  });

  it("lists the keys a close would remove", () => {
    let s = NO_ITEMS;
    for (const rel of ["a", "b", "c"]) s = openItem(s, f(rel), pin);
    const key = (rel: string) => k(f(rel));
    expect(closingKeys(s, "one", key("b"))).toEqual([key("b")]);
    expect(closingKeys(s, "others", key("b"))).toEqual([key("a"), key("c")]);
    expect(closingKeys(s, "right", key("a"))).toEqual([key("b"), key("c")]);
    expect(closingKeys(s, "all", key("a"))).toEqual([key("a"), key("b"), key("c")]);
    expect(closingKeys(s, "one", "nope")).toEqual([]);
  });
});

describe("diff items", () => {
  const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
  const d = (scope: DiffScope) => ({ kind: "diff" as const, ws, root: "/r", repo: "/r", prefix: "", path: "a.txt", origPath: null, scope, untracked: false });

  it("keys a file's working-tree, staged and commit diffs apart", () => {
    const keys = [d({ kind: "worktree" }), d({ kind: "staged" }), d({ kind: "commit", sha: "abc1234", short: "abc1234" })].map(itemKey);
    expect(keys).toEqual(["diff:local/default/w1|/r|worktree|a.txt", "diff:local/default/w1|/r|staged|a.txt", "diff:local/default/w1|/r|abc1234|a.txt"]);
    let s = openItem(NO_ITEMS, d({ kind: "worktree" }), { pin: false });
    s = openItem(s, d({ kind: "staged" }), { pin: true });
    expect(s.items.length).toBe(2);
  });

  it("re-opening a diff replaces the stored item, keeping its place", () => {
    let s = openItem(NO_ITEMS, { ...d({ kind: "worktree" }), untracked: true }, peek);
    s = openItem(s, { ...d({ kind: "worktree" }), untracked: false }, peek);
    expect(s.items.length).toBe(1);
    expect((s.items[0] as DiffItem).untracked).toBe(false);
  });

  it("a diff of a workspace that is gone is dropped like a file", () => {
    const s = openItem(NO_ITEMS, d({ kind: "worktree" }), { pin: true });
    expect(dropItems(s, (i) => i.kind !== "agent" && i.ws.workspace_id === "w1").items).toEqual([]);
  });
});
