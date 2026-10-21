import { BACKOFF_MAX_MS, BACKOFF_START_MS } from "../config";
import type { WebPane } from "../types";
import type { TerminalEvent, TerminalSize } from "./types";

/** The peer revoked this device's pairing: only re-pairing can open another attempt. */
const CLOSE_REVOKED = 4401;
/** The server could not drain this attempt: transient, so a retry is expected. */
const CLOSE_LAGGED = 4000;

/** The parts of a browser `WebSocket` this transport uses: the OS boundary, faked in tests. */
export interface TerminalWebSocket {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string | ArrayBufferView): void;
  close(): void;
}

export interface TerminalSocketDeps {
  open(url: string): TerminalWebSocket;
  /** HTTP status of `GET /api/me`. */
  me(): Promise<number>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realDeps: TerminalSocketDeps = {
  open: (url) => new WebSocket(url) as unknown as TerminalWebSocket,
  me: async () => (await fetch("/api/me", { credentials: "same-origin" })).status,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as number),
};

/**
 * One terminal attempt at a time, over `/ws/terminal`.
 *
 * Every socket callback, timer and output parse callback is scoped to the attempt's
 * generation, so nothing from a replaced or stopped attempt can reach the wire, and a
 * restart begins with a fresh terminal screen.
 */
export class TerminalSocket {
  private deps: TerminalSocketDeps;
  /** The size every attempt asks for, and the one a retry reuses. */
  private size: TerminalSize = { cols: 80, rows: 24 };
  /** Scopes every callback, timer and parse callback to its own attempt. */
  private gen = 0;
  private ws: TerminalWebSocket | null = null;
  /** The open frame went out on this attempt: terminal replies may be sent. */
  private opened = false;
  /** The server confirmed Attached on this attempt: user input may be sent. */
  private attached = false;
  /** The grid last put on this attempt's wire, so a repeated size stays off it. */
  private sent: TerminalSize | null = null;
  /** A terminal state or application error ended this attempt: no input, no retry. */
  private ended = false;
  /** This attempt's socket is gone: nothing leaves through it again. */
  private dead = true;
  /** Delay before the next automatic attempt, doubling up to the shared ceiling. */
  private backoff = BACKOFF_START_MS;
  /** The pending reconnect timer of this attempt, if one is armed. */
  private timer: unknown = undefined;

  constructor(
    private url: string,
    private pane: WebPane,
    private on: {
      output(bytes: Uint8Array, parsed: () => void): void;
      event(e: TerminalEvent): void;
      reset(): void;
    },
    deps: Partial<TerminalSocketDeps> = {},
  ) {
    this.deps = { ...realDeps, ...deps };
  }

  start(size: TerminalSize, takeover = false): void {
    this.size = size;
    this.invalidate();
    this.on.reset();
    this.connect(takeover);
  }

  stop(): void {
    this.invalidate();
  }

  input(text: string): void {
    if (!this.attached || this.ended) return;
    this.send(new TextEncoder().encode(text));
  }

  reply(text: string): void {
    if (this.ended) return;
    this.send(new TextEncoder().encode(text));
  }

  resize(size: TerminalSize): void {
    this.size = size;
    if (!this.opened || this.ended) return;
    if (this.sent && this.sent.cols === size.cols && this.sent.rows === size.rows) return;
    this.sent = size;
    this.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
  }

  /** Ends the current attempt: its callbacks, timers and open socket all go stale. */
  private invalidate(): void {
    this.gen++;
    this.disarm();
    const ws = this.ws;
    this.ws = null;
    this.opened = false;
    this.attached = false;
    this.ended = false;
    this.dead = true;
    this.sent = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
  }

  private connect(takeover: boolean): void {
    const gen = ++this.gen;
    this.dead = false;
    this.on.event({ type: "connecting" });
    const ws = this.deps.open(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.opened = true;
      this.backoff = BACKOFF_START_MS;
      this.sent = this.size;
      ws.send(
        JSON.stringify({
          type: "open",
          pane: this.pane,
          cols: this.size.cols,
          rows: this.size.rows,
          takeover,
        }),
      );
    };
    ws.onmessage = (e) => {
      if (gen !== this.gen) return;
      if (typeof e.data === "string") this.event(e.data);
      else this.output(gen, ws, e.data);
    };
    const lost = (code?: number) => {
      if (gen !== this.gen || this.dead) return;
      this.dead = true;
      this.opened = false;
      this.attached = false;
      this.sent = null;
      if (this.ws === ws) this.ws = null;
      // A terminal state already ended this attempt: its socket closing is not news.
      if (this.ended) return;
      if (code === CLOSE_REVOKED) {
        this.unpair(ws);
        return;
      }
      this.on.event({ type: "disconnected" });
      if (code !== CLOSE_LAGGED && code !== undefined && code !== 1006) return;
      void this.deps.me().then(
        (status) => {
          if (gen !== this.gen) return;
          if (status === 401) {
            this.unpair(ws);
            return;
          }
          this.schedule();
        },
        () => {
          if (gen !== this.gen) return;
          this.schedule();
        },
      );
    };
    ws.onclose = (e) => lost(e.code);
    ws.onerror = () => lost();
  }

  /** Stops for good and hands the app the Not paired state: only re-pairing opens again. */
  private unpair(ws: TerminalWebSocket): void {
    this.gen++;
    this.disarm();
    if (this.ws === ws) this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    ws.close();
    this.on.event({ type: "unpaired" });
  }

  /** Arms the next automatic attempt, always as a normal open. */
  private schedule(): void {
    if (this.ended) return;
    const ms = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    const gen = this.gen;
    this.timer = this.deps.setTimeout(() => {
      this.timer = undefined;
      if (gen !== this.gen) return;
      this.connect(false);
    }, ms);
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    this.deps.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Terminal output: raw bytes, never decoded, acknowledged only once parsed. */
  private output(gen: number, ws: TerminalWebSocket, data: ArrayBuffer): void {
    const bytes = new Uint8Array(data);
    this.on.output(bytes, () => {
      // Only the attempt that is still on the wire may ACK: a replacement, a stopped or a
      // lost attempt owes nothing, and a stale ACK could spend another attempt's credit.
      if (gen !== this.gen || this.ws !== ws || !this.opened) return;
      ws.send(JSON.stringify({ type: "ack", bytes: bytes.byteLength }));
    });
  }

  /** A server text frame: a state event or an application error. */
  private event(data: string): void {
    let frame: { type?: unknown };
    try {
      frame = JSON.parse(data) as { type?: unknown };
    } catch {
      return;
    }
    switch (frame.type) {
      case "attached":
        if (this.ended) return;
        this.attached = true;
        this.on.event({ type: "attached" });
        return;
      case "held":
        this.ended = true;
        this.on.event({ type: "held" });
        return;
      case "exited": {
        const code = (frame as { code?: unknown }).code;
        this.ended = true;
        this.on.event({ type: "exited", code: typeof code === "number" ? code : null });
        return;
      }
      case "detached":
        this.ended = true;
        this.on.event({ type: "detached" });
        return;
      case "error": {
        const error = (frame as { error?: unknown }).error;
        this.ended = true;
        this.on.event({
          type: "error",
          error: {
            code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unknown",
            message:
              typeof (error as { message?: unknown })?.message === "string"
                ? (error as { message: string }).message
                : "",
          },
        });
        return;
      }
      default:
        return;
    }
  }

  private send(data: string | ArrayBufferView): void {
    const ws = this.ws;
    if (!ws || !this.opened) return;
    ws.send(data);
  }
}
