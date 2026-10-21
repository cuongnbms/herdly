import { beforeEach, describe, expect, it } from "vitest";
import { useWeb } from "./store";

const pane = { session: "s", pane_id: "p1" };
const located = { agent: "claude", path: "/t/a.jsonl", ambiguous: false, candidates: [], pending: false };

beforeEach(() => useWeb.setState({ conn: "connecting", lost: false, machines: [], chats: {} }));

describe("store", () => {
  it("applies chat frames in either order and replaces on every reset", () => {
    const { apply } = useWeb.getState();
    apply({ type: "chat", pane, event: { type: "reset", items: [{ kind: "system", text: "a" }], total: 1 } });
    apply({ type: "chat_opened", pane, located });
    apply({ type: "chat", pane, event: { type: "append", items: [{ kind: "system", text: "b" }] } });
    expect(useWeb.getState().chats["s/p1"].chat.items).toHaveLength(2);
    apply({ type: "chat", pane, event: { type: "reset", items: [{ kind: "system", text: "c" }], total: 9 } });
    const v = useWeb.getState().chats["s/p1"];
    expect(v.chat.items).toEqual([{ kind: "system", text: "c" }]);
    expect(v.chat.total).toBe(9);
    expect(v.located?.path).toBe("/t/a.jsonl");
  });

  it("records chat_error and clears it on the next chat_opened", () => {
    const { apply } = useWeb.getState();
    apply({ type: "chat_error", pane, error: { code: "not_found", message: "no transcript" } });
    expect(useWeb.getState().chats["s/p1"].error?.message).toBe("no transcript");
    apply({ type: "chat_opened", pane, located });
    expect(useWeb.getState().chats["s/p1"].error).toBeNull();
  });
});

const view = (id: string, status: "idle" | "working" = "idle") => ({
  id, label: id, kind: "local", state: "connected" as const, error: null, version: null, status,
  sessions: [{ name: "s", running: true, status, error: null, workspaces: [{ workspace_id: "w", label: "w", number: 1, status, tabs: [{ tab_id: "t", label: "t", number: 1, status, panes: [
    { pane_id: "p1", terminal_id: "t1", title: "old", cwd: null, agent: "claude", status },
    { pane_id: "p2", terminal_id: "t2", title: "other", cwd: null, agent: "claude", status },
  ] }] }] }],
});

describe("store machines", () => {
  it("machines replaces, machine replaces by id or appends", () => {
    const { apply } = useWeb.getState();
    apply({ type: "machines", views: [view("local"), view("b")] });
    apply({ type: "machine", view: { ...view("b"), label: "B2" } });
    expect(useWeb.getState().machines.map((m) => m.label)).toEqual(["local", "B2"]);
    apply({ type: "machine", view: view("c") });
    expect(useWeb.getState().machines.map((m) => m.id)).toEqual(["local", "b", "c"]);
    apply({ type: "machines", views: [view("z")] });
    expect(useWeb.getState().machines.map((m) => m.id)).toEqual(["z"]);
  });

  it("pane_status updates only that pane's status and title", () => {
    const { apply } = useWeb.getState();
    apply({ type: "machines", views: [view("local")] });
    apply({ type: "pane_status", ev: { pane: { machine_id: "local", session: "s", pane_id: "p1" }, status: "working", previous: "idle", title: "new" } });
    const panes = useWeb.getState().machines[0].sessions[0].workspaces[0].tabs[0].panes;
    expect(panes.map((p) => [p.pane_id, p.status, p.title])).toEqual([["p1", "working", "new"], ["p2", "idle", "other"]]);
  });

  it("prependOlder honours the page's before index; clearChat drops the chat", () => {
    const { apply, prependOlder, clearChat } = useWeb.getState();
    apply({ type: "chat", pane, event: { type: "reset", items: [{ kind: "system", text: "b" }], total: 3 } });
    prependOlder("s/p1", [{ kind: "system", text: "stale" }], 0);
    expect(useWeb.getState().chats["s/p1"].chat.items).toHaveLength(1);
    prependOlder("s/p1", [{ kind: "system", text: "a" }], 2);
    expect(useWeb.getState().chats["s/p1"].chat.items.map((i) => (i as { text: string }).text)).toEqual(["a", "b"]);
    clearChat("s/p1");
    expect(useWeb.getState().chats["s/p1"]).toBeUndefined();
  });
});

describe("store pairing loss", () => {
  it("keeps Not paired when the healthy Chat socket reports afterwards", () => {
    const { setConn, apply } = useWeb.getState();
    setConn("open");
    setConn("unpaired");
    setConn("connecting");
    setConn("down");
    apply({ type: "machine", view: view("local") });
    expect(useWeb.getState().conn).toBe("unpaired");
  });

  it("leaves Not paired for a fresh authenticated socket", () => {
    const { setConn } = useWeb.getState();
    setConn("open");
    setConn("unpaired");
    setConn("open");
    expect(useWeb.getState().conn).toBe("open");
    expect(useWeb.getState().authLost).toBe(false);
  });
});

describe("store unknown frames", () => {
  it("ignores a frame type it does not know", () => {
    const { apply } = useWeb.getState();
    apply({ type: "machines", views: [view("local")] });
    apply({ type: "from_the_future" } as never);
    const s = useWeb.getState();
    expect(s.conn).toBe("connecting");
    expect(s.machines.map((m) => m.id)).toEqual(["local"]);
    expect(typeof s.apply).toBe("function");
  });
});
