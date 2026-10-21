import { describe, expect, it, vi } from "vitest";
import { Socket, type Conn } from "./socket";

class FakeWs {
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  onerror?: () => void;
  send(s: string) { this.sent.push(s); }
  close() {}
}

function rig(meStatus = 200) {
  const sockets: FakeWs[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const conns: Conn[] = [];
  const frames: unknown[] = [];
  const s = new Socket("ws://h/ws", { frame: (f) => frames.push(f), conn: (c) => conns.push(c) }, {
    open: () => { const w = new FakeWs(); sockets.push(w); return w as never; },
    me: vi.fn().mockResolvedValue(meStatus),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  });
  return { s, sockets, timers, conns, frames };
}

describe("Socket", () => {
  it("re-sends subscriptions after a reconnect", async () => {
    const r = rig();
    r.s.start();
    r.sockets[0].onopen!();
    r.s.subscribe({ session: "s", pane_id: "p1" });
    r.sockets[0].onclose!({ code: 1006 });
    await vi.waitFor(() => expect(r.timers.length).toBe(1));
    expect(r.timers[0].ms).toBe(1000);
    r.timers[0].fn();
    r.sockets[1].onopen!();
    expect(r.sockets[1].sent.map((x) => JSON.parse(x))).toEqual([{ type: "subscribe", pane: { session: "s", pane_id: "p1" } }]);
    expect(r.conns).toEqual(["connecting", "open", "down", "connecting", "open"]);
  });

  it("backs off 1s, 2s, 4s, 8s, 15s, 15s and resets after an open", async () => {
    const r = rig();
    r.s.start();
    for (let i = 0; i < 6; i++) {
      r.sockets[i].onclose!({ code: 1006 });
      await vi.waitFor(() => expect(r.timers.length).toBe(i + 1));
      r.timers[i].fn();
    }
    expect(r.timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    r.sockets[6].onopen!();
    r.sockets[6].onclose!({ code: 1006 });
    await vi.waitFor(() => expect(r.timers.length).toBe(7));
    expect(r.timers[6].ms).toBe(1000);
  });

  it("goes unpaired on close 4401 without reconnecting", async () => {
    const r = rig();
    r.s.start();
    r.sockets[0].onopen!();
    r.sockets[0].onclose!({ code: 4401 });
    expect(r.conns.at(-1)).toBe("unpaired");
    expect(r.timers).toEqual([]);
  });

  it("asks /api/me after a refused socket and goes unpaired on 401", async () => {
    const r = rig(401);
    r.s.start();
    r.sockets[0].onclose!({ code: 1006 });
    await vi.waitFor(() => expect(r.conns.at(-1)).toBe("unpaired"));
    expect(r.timers).toEqual([]);
  });

  it("passes frames through parsed", () => {
    const r = rig();
    r.s.start();
    r.sockets[0].onmessage!({ data: JSON.stringify({ type: "machines", views: [] }) });
    expect(r.frames).toEqual([{ type: "machines", views: [] }]);
  });
});
