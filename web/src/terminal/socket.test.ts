import { describe, expect, it } from "vitest";
import { TerminalSocket, type TerminalWebSocket } from "./socket";
import type { TerminalEvent } from "./types";

class Wire implements TerminalWebSocket {
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: (string | ArrayBufferView)[] = [];
  closed = false;
  send(d: string | ArrayBufferView) { this.sent.push(d); }
  close() { this.closed = true; }
}

/** The panes' text frames, parsed. */
const texts = (w: Wire) => w.sent.filter((x): x is string => typeof x === "string").map((x) => JSON.parse(x) as unknown);
/** The panes' binary frames, decoded for comparison with the text the user typed. */
const binaries = (w: Wire) =>
  w.sent.filter((x): x is ArrayBufferView => typeof x !== "string").map((x) => [...new Uint8Array(x.buffer, x.byteOffset, x.byteLength)]);

/**
 * Time as the OS reports it: a record of what was asked for. `run` fires a callback even
 * after it was cleared, so a generation guard is what keeps stale work off the wire.
 */
function clock() {
  const timers: { id: number; fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers,
    deps: {
      setTimeout(fn: () => void, ms: number) {
        const id = timers.length + 1;
        timers.push({ id, fn, ms, cleared: false });
        return id;
      },
      clearTimeout(id: unknown) {
        const t = timers.find((x) => x.id === id);
        if (t) t.cleared = true;
      },
    },
    run(i: number) { timers[i].fn(); },
    delays: () => timers.map((t) => t.ms),
  };
}

function rig(meStatus = 200) {
  const wires: Wire[] = [];
  const events: TerminalEvent[] = [];
  const output: { bytes: number[]; parsed: () => void }[] = [];
  const time = clock();
  const meCalls: number[] = [];
  let resets = 0;
  const s = new TerminalSocket(
    "ws://h/ws/terminal",
    { session: "s", pane_id: "p1" },
    {
      reset() { resets++; },
      event(e) { events.push(e); },
      output(bytes, parsed) { output.push({ bytes: [...bytes], parsed }); },
    },
    {
      ...time.deps,
      open(url) { expect(url).toBe("ws://h/ws/terminal"); const w = new Wire(); wires.push(w); return w; },
      me() { meCalls.push(meStatus); return Promise.resolve(meStatus); },
    },
  );
  return { s, wires, events, output, time, meCalls, resets: () => resets };
}

describe("TerminalSocket", () => {
  it("ACKs only after parse and never through a replacement socket", () => {
    const wires: Wire[] = [];
    const parsed: (() => void)[] = [];
    const output: number[][] = [];
    const s = new TerminalSocket("ws://h/ws/terminal", { session: "s", pane_id: "p1" }, {
      reset() {},
      event() {},
      output(bytes, done) { output.push([...bytes]); parsed.push(done); },
    }, { open(url) { expect(url).toBe("ws://h/ws/terminal"); const w = new Wire(); wires.push(w); return w; } });
    s.start({ cols: 80, rows: 24 });
    const first = wires[0];
    first.onopen!();
    expect(JSON.parse(first.sent[0] as string)).toEqual({ type: "open", pane: { session: "s", pane_id: "p1" }, cols: 80, rows: 24, takeover: false });
    first.onmessage!({ data: new Uint8Array([0xe2, 0x82, 0xac]).buffer });
    expect(output).toEqual([[0xe2, 0x82, 0xac]]);
    expect(first.sent).toHaveLength(1);
    parsed[0]();
    expect(JSON.parse(first.sent[1] as string)).toEqual({ type: "ack", bytes: 3 });
    first.onmessage!({ data: new Uint8Array([0x41]).buffer });
    s.start({ cols: 100, rows: 30 });
    wires[1].onopen!();
    parsed[1]();
    expect(wires[1].sent).toHaveLength(1);
    expect(first.closed).toBe(true);
    s.stop();
  });

  it("forwards a terminal reply while settling but drops user input until Attached", () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const w = r.wires[0];
    w.onopen!();
    r.s.reply("\x1b[1;1R");
    r.s.input("ls\n");
    expect(binaries(w)).toEqual([[0x1b, 0x5b, 0x31, 0x3b, 0x31, 0x52]]);
    w.onmessage!({ data: JSON.stringify({ type: "attached" }) });
    r.s.input("ls\n");
    expect(binaries(w)).toEqual([
      [0x1b, 0x5b, 0x31, 0x3b, 0x31, 0x52],
      [0x6c, 0x73, 0x0a],
    ]);
  });

  it("keeps a UTF-8 character split across chunks as two raw byte runs", () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const w = r.wires[0];
    w.onopen!();
    w.onmessage!({ data: new Uint8Array([0xe2, 0x82]).buffer });
    w.onmessage!({ data: new Uint8Array([0xac]).buffer });
    expect(r.output.map((o) => o.bytes)).toEqual([
      [0xe2, 0x82],
      [0xac],
    ]);
    r.output.forEach((o) => o.parsed());
    expect(texts(w).slice(1)).toEqual([
      { type: "ack", bytes: 2 },
      { type: "ack", bytes: 1 },
    ]);
  });

  it("sends a resize once and drops a repeat of the same grid", () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const w = r.wires[0];
    w.onopen!();
    r.s.resize({ cols: 100, rows: 30 });
    r.s.resize({ cols: 100, rows: 30 });
    r.s.resize({ cols: 100, rows: 31 });
    expect(texts(w)).toEqual([
      { type: "open", pane: { session: "s", pane_id: "p1" }, cols: 80, rows: 24, takeover: false },
      { type: "resize", cols: 100, rows: 30 },
      { type: "resize", cols: 100, rows: 31 },
    ]);
  });

  it("keeps rendering trailing output after Exited but takes no more input", () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const w = r.wires[0];
    w.onopen!();
    w.onmessage!({ data: JSON.stringify({ type: "attached" }) });
    w.onmessage!({ data: JSON.stringify({ type: "exited", code: 3 }) });
    expect(r.events).toEqual([{ type: "connecting" }, { type: "attached" }, { type: "exited", code: 3 }]);
    r.s.input("after\n");
    r.s.reply("\x1b[1;1R");
    w.onmessage!({ data: new Uint8Array([0x6f, 0x6b]).buffer });
    expect(r.output.map((o) => o.bytes)).toEqual([[0x6f, 0x6b]]);
    expect(binaries(w)).toEqual([]);
  });

  it("retries a transient close with the web backoff and the same grid", async () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    r.wires[0].onclose!({ code: 1006 });
    await Promise.resolve();
    await Promise.resolve();
    expect(r.time.delays()).toEqual([1000]);
    r.time.run(0);
    expect(r.wires).toHaveLength(2);
    r.wires[1].onopen!();
    expect(JSON.parse(r.wires[1].sent[0] as string)).toEqual({
      type: "open",
      pane: { session: "s", pane_id: "p1" },
      cols: 80,
      rows: 24,
      takeover: false,
    });
    expect(r.events).toEqual([{ type: "connecting" }, { type: "disconnected" }, { type: "connecting" }]);
    // A retry keeps the screen: only an explicit start begins a fresh terminal.
    expect(r.resets()).toBe(1);
  });

  it("ignores the second of onerror and onclose on one attempt", async () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    r.wires[0].onerror!();
    r.wires[0].onclose!({ code: 1006 });
    await Promise.resolve();
    await Promise.resolve();
    expect(r.time.delays()).toEqual([1000]);
    expect(r.events).toEqual([{ type: "connecting" }, { type: "disconnected" }]);
  });

  it("backs off 1s, 2s, 4s, 8s, 15s, 15s and starts again after an open", async () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    for (let i = 0; i < 6; i++) {
      r.wires[i].onclose!({ code: 1006 });
      await Promise.resolve();
      await Promise.resolve();
      r.time.run(i);
    }
    expect(r.time.delays()).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    r.wires[6].onopen!();
    r.wires[6].onclose!({ code: 1006 });
    await Promise.resolve();
    await Promise.resolve();
    expect(r.time.delays()[6]).toBe(1000);
  });

  it("asks for Take over only on the attempt that requested it", async () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 }, true);
    r.wires[0].onopen!();
    expect(texts(r.wires[0])[0]).toEqual({
      type: "open",
      pane: { session: "s", pane_id: "p1" },
      cols: 80,
      rows: 24,
      takeover: true,
    });
    r.wires[0].onclose!({ code: 4000 });
    await Promise.resolve();
    await Promise.resolve();
    r.time.run(0);
    r.wires[1].onopen!();
    expect(texts(r.wires[1])[0]).toEqual({
      type: "open",
      pane: { session: "s", pane_id: "p1" },
      cols: 80,
      rows: 24,
      takeover: false,
    });
  });

  it.each([[1000], [1008], [1009]])("does not retry the terminal close code %i", async (code) => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    r.wires[0].onopen!();
    r.wires[0].onclose!({ code });
    await Promise.resolve();
    await Promise.resolve();
    expect(r.meCalls).toEqual([]);
    expect(r.time.delays()).toEqual([]);
    expect(r.events).toEqual([{ type: "connecting" }, { type: "disconnected" }]);
  });

  it("does not retry after an application error, and takes no more input", async () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const w = r.wires[0];
    w.onopen!();
    w.onmessage!({ data: JSON.stringify({ type: "attached" }) });
    w.onmessage!({ data: JSON.stringify({ type: "error", error: { code: "io", message: "cannot open a pty" } }) });
    w.onclose!({ code: 1008 });
    await Promise.resolve();
    await Promise.resolve();
    expect(r.events).toEqual([
      { type: "connecting" },
      { type: "attached" },
      { type: "error", error: { code: "io", message: "cannot open a pty" } },
    ]);
    r.s.input("ls\n");
    expect(binaries(w)).toEqual([]);
    expect(r.time.delays()).toEqual([]);
  });

  it("reports unpaired on close 4401 and stops for good", async () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    r.wires[0].onopen!();
    r.wires[0].onclose!({ code: 4401 });
    await Promise.resolve();
    await Promise.resolve();
    expect(r.events).toEqual([{ type: "connecting" }, { type: "unpaired" }]);
    expect(r.meCalls).toEqual([]);
    expect(r.time.delays()).toEqual([]);
    expect(r.wires[0].closed).toBe(true);
  });

  it("reports unpaired when the pairing check answers 401", async () => {
    const r = rig(401);
    r.s.start({ cols: 80, rows: 24 });
    r.wires[0].onclose!({ code: 1006 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.meCalls).toEqual([401]);
    expect(r.events).toEqual([{ type: "connecting" }, { type: "disconnected" }, { type: "unpaired" }]);
    expect(r.time.delays()).toEqual([]);
  });

  it("ignores a stale timer, message and parse callback from a replaced attempt", async () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const first = r.wires[0];
    // Held past the replacement, the way a browser may still invoke a detached handler.
    const firstOpen = first.onopen!;
    const firstMessage = first.onmessage!;
    const firstClose = first.onclose!;
    firstOpen();
    firstMessage({ data: new Uint8Array([0x41]).buffer });
    firstClose({ code: 1006 });
    await Promise.resolve();
    await Promise.resolve();
    expect(r.time.delays()).toEqual([1000]);
    r.s.start({ cols: 100, rows: 30 });
    const second = r.wires[1];
    second.onopen!();
    // The cleared timer's callback still fires: it must not open a third socket.
    r.time.run(0);
    expect(r.wires).toHaveLength(2);
    // The replaced attempt's callbacks still arrive: nothing reaches the wire or the screen.
    firstMessage({ data: new Uint8Array([0x42]).buffer });
    firstClose({ code: 1006 });
    r.output.at(-1)!.parsed();
    expect(r.output.map((o) => o.bytes)).toEqual([[0x41]]);
    expect(texts(second).slice(1)).toEqual([]);
    expect(r.time.delays()).toEqual([1000]);
  });

  it("cancels the retry when stop lands while the pairing check is pending", async () => {
    const wires: Wire[] = [];
    const events: TerminalEvent[] = [];
    const time = clock();
    let answer: (status: number) => void = () => {};
    const s = new TerminalSocket(
      "ws://h/ws/terminal",
      { session: "s", pane_id: "p1" },
      { reset() {}, event(e) { events.push(e); }, output() {} },
      {
        ...time.deps,
        open() { const w = new Wire(); wires.push(w); return w; },
        me: () => new Promise<number>((resolve) => { answer = resolve; }),
      },
    );
    s.start({ cols: 80, rows: 24 });
    wires[0].onopen!();
    wires[0].onclose!({ code: 1006 });
    s.stop();
    answer(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(time.delays()).toEqual([]);
    expect(wires).toHaveLength(1);
    expect(events).toEqual([{ type: "connecting" }, { type: "disconnected" }]);
  });

  it("drops input typed while disconnected instead of replaying it after a retry", async () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const first = r.wires[0];
    first.onopen!();
    first.onmessage!({ data: JSON.stringify({ type: "attached" }) });
    first.onclose!({ code: 1006 });
    r.s.input("secret\n");
    r.s.reply("\x1b[1;1R");
    await Promise.resolve();
    await Promise.resolve();
    r.time.run(0);
    const second = r.wires[1];
    second.onopen!();
    second.onmessage!({ data: JSON.stringify({ type: "attached" }) });
    expect(binaries(second)).toEqual([]);
    expect(texts(second)).toHaveLength(1);
  });

  it("drops input typed before the first Attached", () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    r.wires[0].onopen!();
    r.s.input("typed early\n");
    r.wires[0].onmessage!({ data: JSON.stringify({ type: "attached" }) });
    expect(binaries(r.wires[0])).toEqual([]);
  });

  it.each([["held"], ["detached"]])("stops retrying once the server reports %s", async (type) => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const w = r.wires[0];
    w.onopen!();
    w.onmessage!({ data: JSON.stringify({ type }) });
    w.onclose!({ code: 1000 });
    await Promise.resolve();
    await Promise.resolve();
    r.s.input("nope\n");
    expect(r.events).toEqual([{ type: "connecting" }, { type }]);
    expect(binaries(w)).toEqual([]);
    expect(r.meCalls).toEqual([]);
    expect(r.time.delays()).toEqual([]);
  });

  it("reports an Exited code of null when the server omits one", () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    r.wires[0].onopen!();
    r.wires[0].onmessage!({ data: JSON.stringify({ type: "exited", code: null }) });
    expect(r.events.at(-1)).toEqual({ type: "exited", code: null });
  });

  it("resets the terminal before a restart's output and never reconnects after stop", async () => {
    const r = rig();
    const order: string[] = [];
    const s = new TerminalSocket(
      "ws://h/ws/terminal",
      { session: "s", pane_id: "p1" },
      {
        reset() { order.push("reset"); },
        event() { order.push("event"); },
        output() { order.push("output"); },
      },
      {
        ...r.time.deps,
        open() { const w = new Wire(); r.wires.push(w); return w; },
        me: () => Promise.resolve(200),
      },
    );
    s.start({ cols: 80, rows: 24 });
    r.wires[0].onopen!();
    r.wires[0].onmessage!({ data: new Uint8Array([0x41]).buffer });
    s.stop();
    order.length = 0;
    s.start({ cols: 90, rows: 25 });
    r.wires[1].onopen!();
    r.wires[1].onmessage!({ data: new Uint8Array([0x42]).buffer });
    expect(order).toEqual(["reset", "event", "output"]);
    expect(r.wires[0].closed).toBe(true);
    s.stop();
    expect(r.wires[1].closed).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.time.delays()).toEqual([]);
    expect(r.wires).toHaveLength(2);
  });

  it("sends user text as UTF-8 bytes once Attached", () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const w = r.wires[0];
    expect(w.binaryType).toBe("arraybuffer");
    w.onopen!();
    w.onmessage!({ data: JSON.stringify({ type: "attached" }) });
    r.s.input("é");
    expect(binaries(w)).toEqual([[0xc3, 0xa9]]);
  });

  it("keeps a resize off the wire once the attempt has ended, and caches it for the retry", async () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const w = r.wires[0];
    w.onopen!();
    w.onmessage!({ data: JSON.stringify({ type: "exited", code: 0 }) });
    r.s.resize({ cols: 120, rows: 40 });
    expect(texts(w)).toHaveLength(1);
    r.s.start({ cols: 120, rows: 40 });
    r.wires[1].onopen!();
    expect(texts(r.wires[1])[0]).toEqual({
      type: "open",
      pane: { session: "s", pane_id: "p1" },
      cols: 120,
      rows: 40,
      takeover: false,
    });
  });

  it("does not ACK through a socket that has already been lost", () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const w = r.wires[0];
    w.onopen!();
    w.onmessage!({ data: new Uint8Array([0x41, 0x42]).buffer });
    w.onclose!({ code: 1006 });
    r.output[0].parsed();
    expect(texts(w)).toEqual([{ type: "open", pane: { session: "s", pane_id: "p1" }, cols: 80, rows: 24, takeover: false }]);
  });

  it("retries a close that carries no code, and ignores frames that are not the protocol", async () => {
    const r = rig();
    r.s.start({ cols: 80, rows: 24 });
    const w = r.wires[0];
    w.onopen!();
    w.onmessage!({ data: "not json" });
    w.onmessage!({ data: JSON.stringify({ type: "something_else" }) });
    expect(r.events).toEqual([{ type: "connecting" }]);
    w.onclose!({ code: undefined as unknown as number });
    await Promise.resolve();
    await Promise.resolve();
    expect(r.time.delays()).toEqual([1000]);
  });
});
