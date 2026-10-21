import { BACKOFF_MAX_MS, BACKOFF_START_MS } from "./config";
import { webKey, type Frame, type WebPane } from "./types";

export type Conn = "connecting" | "open" | "down" | "unpaired";

export interface WebSocketLike {
  onopen: ((e?: unknown) => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface SocketDeps {
  open(url: string): WebSocketLike;
  /** HTTP status of GET /api/me. */
  me(): Promise<number>;
  setTimeout(fn: () => void, ms: number): unknown;
}

const CLOSE_REVOKED = 4401;

const realDeps: SocketDeps = {
  open: (url) => new WebSocket(url) as unknown as WebSocketLike,
  me: async () => (await fetch("/api/me", { credentials: "same-origin" })).status,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
};

export class Socket {
  private deps: SocketDeps;
  private ws: WebSocketLike | null = null;
  private subs = new Map<string, WebPane>();
  private backoff = BACKOFF_START_MS;
  private stopped = true;
  private opened = false;

  constructor(
    private url: string,
    private on: { frame(f: Frame): void; conn(c: Conn): void },
    deps: Partial<SocketDeps> = {},
  ) {
    this.deps = { ...realDeps, ...deps };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
  }

  subscribe(p: WebPane): void {
    this.subs.set(webKey(p), p);
    this.send({ type: "subscribe", pane: p });
  }

  unsubscribe(p: WebPane): void {
    this.subs.delete(webKey(p));
    this.send({ type: "unsubscribe", pane: p });
  }

  private send(msg: unknown): void {
    if (this.ws && this.opened) this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    if (this.stopped) return;
    this.opened = false;
    this.on.conn("connecting");
    const ws = this.deps.open(this.url);
    this.ws = ws;
    let dead = false;
    ws.onopen = () => {
      this.opened = true;
      this.backoff = BACKOFF_START_MS;
      this.on.conn("open");
      for (const pane of this.subs.values()) ws.send(JSON.stringify({ type: "subscribe", pane }));
    };
    ws.onmessage = (e) => {
      try {
        this.on.frame(JSON.parse(e.data) as Frame);
      } catch {
        // a malformed frame is dropped; the next one carries on
      }
    };
    const lost = (code?: number) => {
      if (dead) return;
      dead = true;
      this.opened = false;
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      if (code === CLOSE_REVOKED) {
        this.on.conn("unpaired");
        return;
      }
      this.on.conn("down");
      void this.deps.me().then(
        (status) => (status === 401 ? this.on.conn("unpaired") : this.retry()),
        () => this.retry(),
      );
    };
    ws.onclose = (e) => lost(e.code);
    ws.onerror = () => lost();
  }

  private retry(): void {
    if (this.stopped) return;
    const ms = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.deps.setTimeout(() => this.connect(), ms);
  }
}
