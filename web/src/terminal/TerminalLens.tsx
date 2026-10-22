import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWeb } from "../store";
import type { MachineView, WebPane } from "../types";
import { KeyBar, type LogicalKey } from "./KeyBar";
import { controlCharacter, cursorKey, UserEntry } from "./input";
import { TerminalSocket } from "./socket";
import type { TerminalEvent, TerminalSize } from "./types";
import "./terminal.css";

/** Refit after a layout change settles: a grid change reflows scrollback and redraws it. */
const RESIZE_SETTLE_MS = 150;
/** A finger that moved less than this, and lifted quickly, was a tap rather than a scroll. */
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;
/** Self-hosted face, so cells measure the same on every device. */
const FONT_FAMILY = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';

export interface LensHandlers {
  output(bytes: Uint8Array, parsed: () => void): void;
  event(e: TerminalEvent): void;
  reset(): void;
}

/** The transport the lens drives: Task 5's TerminalSocket, or a test double. */
export interface LensTransport {
  start(size: TerminalSize, takeover?: boolean): void;
  stop(): void;
  input(text: string): void;
  reply(text: string): void;
  resize(size: TerminalSize): void;
}

export type TransportFactory = (pane: WebPane, on: LensHandlers) => LensTransport;

type Phase = "connecting" | "attached" | "held" | "exited" | "detached" | "error" | "disconnected" | "retrying" | "closed";

interface Attempt {
  phase: Phase;
  code: number | null;
  message: string | null;
}

const INITIAL: Attempt = { phase: "connecting", code: null, message: null };

type Target = { ok: true; terminalId: string } | { ok: false; why: "missing" | "stopped" | "offline" };

/** The store's view of this Pane: no attach without a live, running target. */
function targetOf(machines: MachineView[], pane: WebPane): Target | null {
  if (machines.length === 0) return null; // views not loaded yet: nothing says this Pane is gone
  for (const machine of machines) {
    for (const session of machine.sessions) {
      if (session.name !== pane.session) continue;
      for (const workspace of session.workspaces) {
        for (const tab of workspace.tabs) {
          const view = tab.panes.find((p) => p.pane_id === pane.pane_id);
          if (!view) continue;
          if (!session.running) return { ok: false, why: "stopped" };
          if (machine.state !== "connected") return { ok: false, why: "offline" };
          return { ok: true, terminalId: view.terminal_id };
        }
      }
    }
  }
  return { ok: false, why: "missing" };
}

function defaultFactory(pane: WebPane, on: LensHandlers): LensTransport {
  return new TerminalSocket(`ws://${location.host}/ws/terminal`, pane, on);
}

/**
 * A live terminal for one Pane.
 *
 * Every fresh attempt (mount, Reattach, Take over, automatic retry, foreground return) gets a
 * brand-new xterm: the transport's `reset` disposes the previous one before that attempt can
 * deliver output, so two attempts never concatenate and no scrollback leaks between Panes.
 * User entry is gated at the DOM boundary while an attempt settles, while xterm's own protocol
 * replies stay live.
 */
export function TerminalLens({ pane, transport = defaultFactory }: { pane: WebPane; transport?: TransportFactory }) {
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<LensTransport | null>(null);
  const entry = useRef(new UserEntry());
  const term = useRef<Terminal | null>(null);
  /** Attached on this attempt: user entry may reach the wire. */
  const typing = useRef(false);
  const [attempt, setAttempt] = useState<Attempt>(INITIAL);
  const [ctrl, setCtrl] = useState(false);
  const setConn = useWeb((s) => s.setConn);
  const machines = useWeb((s) => s.machines);
  const target = useMemo(() => targetOf(machines, pane), [machines, pane]);
  const visible = useVisibility();
  /** The current terminal grid, or the size a fresh attempt starts from. */
  const currentSize = (): TerminalSize =>
    term.current ? { cols: term.current.cols, rows: term.current.rows } : { cols: 80, rows: 24 };

  const attachable = target === null || target.ok;
  const terminalId = target?.ok ? target.terminalId : null;

  const syncCtrl = useCallback((on: boolean) => {
    if (on) entry.current.arm();
    else entry.current.clear();
    setCtrl(on);
  }, []);

  useEffect(() => {
    const box = host.current;
    if (!box || !visible || !attachable) return;

    let live = true;
    let fit: FitAddon | null = null;
    let disposables: { dispose(): void }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** A mapped control key was sent here; the rest of its event sequence must not reach xterm. */
    let swallowed = false;
    /**
     * A non-cancelable `beforeinput` cannot be stopped, so the browser's own `input` for that same
     * insertion always follows. It is recorded once and consumed when it arrives — never guessed
     * by comparing later text or by a timer.
     */
    let owedInput = "";
    /** The grid last reported to the transport, so an unchanged size never leaves again. */
    let sent: TerminalSize | null = null;

    const send = (text: string) => {
      if (text) socket.current?.input(text);
    };

    /** Stops an event here: no xterm listener, no browser default (no echo, no page scroll). */
    const charge = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    /** Fits against the current container, or null while it cannot be measured. */
    const fitNow = (): TerminalSize | null => {
      const t = term.current;
      if (!t || !fit) return null;
      if (t.element?.parentElement !== box || box.clientWidth === 0 || box.clientHeight === 0) return null;
      try {
        fit.fit();
      } catch {
        return null;
      }
      return { cols: t.cols, rows: t.rows };
    };

    /** Reports a changed grid only: a repeated resize reflows scrollback for nothing. */
    const reportSize = (next: TerminalSize | null) => {
      if (!next) return;
      if (sent && sent.cols === next.cols && sent.rows === next.rows) return;
      sent = next;
      socket.current?.resize(next);
    };

    /**
     * Everything xterm reports as data. Once Attached it is user text; while settling it is a
     * protocol reply (DA, DSR, focus, mouse, colour) that must still reach the wire.
     */
    const onData = (text: string) => {
      if (!live) return;
      if (typing.current) send(text);
      else socket.current?.reply(text);
    };

    /** A fresh terminal for the current attempt. The previous one is disposed, never reused. */
    const newTerminal = () => {
      for (const d of disposables) d.dispose();
      disposables = [];
      const old = term.current;
      term.current = null;
      fit = null;
      typing.current = false;
      syncCtrl(false);
      if (old) {
        try {
          old.dispose();
        } catch {
          // a disposed terminal must not take the next attempt down with it
        }
      }
      box.replaceChildren();

      const t = new Terminal({
        cursorBlink: true,
        scrollback: 5000,
        // No smooth scrolling: on a phone it lags behind the finger.
        smoothScrollDuration: 0,
        allowProposedApi: true,
        fontFamily: FONT_FAMILY,
        fontSize: 13,
        // No linkHandler and no OSC 52 wiring: nothing may open a link or write the clipboard.
      });
      const f = new FitAddon();
      t.loadAddon(f);
      t.loadAddon(new Unicode11Addon());
      t.unicode.activeVersion = "11";
      t.open(box);
      term.current = t;
      fit = f;
      disposables.push(t.onData(onData));
      fitNow();
    };

    const reset = () => {
      if (!live) return;
      // A fresh attempt starts with no input state from the previous one.
      owedInput = "";
      swallowed = false;
      newTerminal();
      setAttempt(INITIAL);
    };
    const event = (e: TerminalEvent) => {
      if (!live) return;
      switch (e.type) {
        case "connecting":
          typing.current = false;
          setAttempt({ phase: "connecting", code: null, message: null });
          return;
        case "attached":
          typing.current = true;
          setAttempt({ phase: "attached", code: null, message: null });
          return;
        case "unpaired":
          // Sticky: no later Chat frame or live Machine view may restore the paired UI.
          typing.current = false;
          syncCtrl(false);
          setConn("unpaired");
          return;
        case "disconnected":
        case "retrying":
          typing.current = false;
          syncCtrl(false);
          setAttempt({ phase: e.type, code: null, message: null });
          return;
        default:
          // Held, Exited, Detached and application errors end user entry for this attempt while
          // its output keeps rendering until the socket closes.
          typing.current = false;
          syncCtrl(false);
          setAttempt({
            phase: e.type,
            code: e.type === "exited" || e.type === "closed" ? e.code : null,
            message: e.type === "error" ? e.error.message : null,
          });
      }
    };

    const output = (bytes: Uint8Array, parsed: () => void) => {
      const t = term.current;
      if (!t) return;
      try {
        t.write(bytes, () => {
          // Only the attempt whose own terminal parsed these bytes acknowledges them.
          if (term.current === t) parsed();
        });
      } catch {
        // a replaced terminal consumes nothing and ACKs nothing
      }
    };

    const entryText = (e: Event): string | null => {
      if (e instanceof CompositionEvent || e instanceof InputEvent) return e.data ?? "";
      if (e instanceof KeyboardEvent) return textKey(e);
      if (typeof ClipboardEvent !== "undefined" && e instanceof ClipboardEvent) return e.clipboardData?.getData("text/plain") ?? null;
      return null;
    };

    /**
     * The gate: capture phase on the host, ahead of the terminal's own textarea listeners, so a
     * settling attempt sees none of the user's keyboard, composition or paste while output
     * parsing still answers terminal queries.
     *
     * Ctrl is spent at the boundary that actually inserts text, never by a mere modifier or
     * action key: a desktop keydown carries the character, but a mobile keyboard enters text
     * through `beforeinput`/`input` insertText with no printable keydown at all.
     *
     * No synthetic "tail" state exists for the normal case. Measured in Chromium
     * (153.0.8010.12): a trusted key is `keydown → keypress → beforeinput → input → keyup`; a
     * prevented `beforeinput` emits no `input` at all and leaves the textarea empty;
     * `Input.insertText` (the mobile path) emits `beforeinput → input`. Because this gate cancels
     * the `beforeinput` it handles, the browser never follows it with an `input`.
     *
     * The one exception is a `beforeinput` the page cannot cancel (`cancelable === false`): the
     * browser's own `input` for that same insertion always follows, in the same task, and cannot
     * be stopped — so it is recorded once and consumed when it arrives, never guessed by timeout.
     */
    const gate = (e: Event) => {
      if (!live) return;
      if (swallowed) {
        if (e.type === "keyup") swallowed = false;
        charge(e);
        return;
      }
      if (!typing.current) {
        // A settling or ended attempt owns no entry state at all: nothing may be carried out.
        owedInput = "";
        swallowed = false;
        charge(e);
        return;
      }
      const isInsert =
        e instanceof InputEvent && (e.inputType === "insertText" || e.inputType === "insertCompositionText");
      // The unavoidable follow-up of a non-cancelable insertion already sent: swallow exactly
      // that event, then forget it. A lone `input`, or one after a canceled beforeinput, never
      // sets this, so the next same-character entry always reaches the wire.
      if (e.type === "input" && owedInput !== "" && isInsert && ((e as InputEvent).data ?? "") === owedInput) {
        owedInput = "";
        charge(e);
        return;
      }
      if (!entry.current.ctrl) return;
      switch (e.type) {
        case "keyup":
          owedInput = "";
          return;
        case "keydown": {
          const text = entryText(e);
          if (text === null) return; // a modifier or an action key: not a character, Ctrl stays armed
          const mapped = controlCharacter(text);
          // Ctrl is one-shot: the next character spends it, accelerator or not.
          syncCtrl(false);
          owedInput = "";
          if (mapped === null) return; // unsupported text goes out unchanged through xterm
          charge(e);
          // Preventing the keydown is enough: Chromium cancels the whole chain, so no keypress,
          // beforeinput or input follows and the raw character cannot leak out later.
          swallowed = true;
          send(mapped);
          return;
        }
        case "beforeinput":
        case "input": {
          const data = (e as InputEvent).data ?? "";
          if (!isInsert) {
            // Composition and paste deliver a whole run: it goes out unchanged and spends Ctrl.
            syncCtrl(false);
            owedInput = "";
            return;
          }
          const mapped = controlCharacter(data);
          // Ctrl is spent by this insertion, accelerator or not.
          syncCtrl(false);
          if (!mapped) {
            // Unsupported text is not swallowed by anyone: it reaches xterm, which sends it once.
            // No debt is created, because nothing of ours was emitted for a tail to follow.
            owedInput = "";
            return;
          }
          // A debt exists only to swallow the follow-up of a non-cancelable insertion whose
          // mapped byte we already sent. Canceling the beforeinput cancels its `input` too.
          owedInput = e.type === "beforeinput" && !(e as InputEvent).cancelable ? data : "";
          charge(e);
          send(mapped);
          return;
        }
        default:
          // Composition and paste deliver a whole run, never a control key: they go out unchanged
          // and spend the modifier.
          syncCtrl(false);
          owedInput = "";
          return;
      }
    };
    const GATE_TYPES = [
      "keydown",
      "keypress",
      "keyup",
      "beforeinput",
      "input",
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "paste",
    ];
    for (const type of GATE_TYPES) box.addEventListener(type, gate, true);

    /** One key-bar key: the same entry boundary as typing, with no intermediate DOM event. */
    const keyEntry = (text: string) => {
      if (!typing.current) return;
      const mapped = entry.current.apply(text);
      syncCtrl(entry.current.ctrl);
      send(mapped);
    };

    const refit = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (live) reportSize(fitNow());
      }, RESIZE_SETTLE_MS);
    };

    // Touch: a swipe scrolls scrollback with no pointer reports, a tap only focuses. Without
    // this, a mouse-reporting app turns each touch into a click at the touch point.
    let touch: { x: number; y: number; at: number; lastY: number; moved: boolean } | null = null;
    const cellHeight = (): number => {
      const screen = box.querySelector<HTMLElement>(".xterm-screen");
      const t = term.current;
      if (!screen || !t) return 0;
      const height = screen.getBoundingClientRect().height;
      return height > 0 ? height / t.rows : 0;
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        touch = null;
        return;
      }
      const point = e.touches[0];
      touch = { x: point.clientX, y: point.clientY, at: Date.now(), lastY: point.clientY, moved: false };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touch || e.touches.length !== 1) return;
      const point = e.touches[0];
      if (Math.abs(point.clientX - touch.x) > TAP_SLOP_PX || Math.abs(point.clientY - touch.y) > TAP_SLOP_PX) touch.moved = true;
      const cell = cellHeight();
      if (cell > 0) {
        const lines = Math.trunc((point.clientY - touch.lastY) / cell);
        if (lines !== 0) {
          term.current?.scrollLines(lines);
          touch.lastY += lines * cell;
        }
      }
      // Keep the page and the compat-mouse path out of the gesture.
      e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      const started = touch;
      touch = null;
      if (!started) return;
      // Suppress the synthesized mousedown/click: a tap focuses, it does not click a TUI target.
      e.preventDefault();
      if (!started.moved && Date.now() - started.at < TAP_MAX_MS) term.current?.focus();
    };
    box.addEventListener("touchstart", onTouchStart, { passive: true });
    box.addEventListener("touchmove", onTouchMove, { passive: false });
    box.addEventListener("touchend", onTouchEnd, { passive: false });

    // Blur spends a pending Ctrl so it cannot fire on a later, unrelated keystroke.
    const onFocusOut = () => {
      if (entry.current.ctrl) syncCtrl(false);
    };
    box.addEventListener("focusout", onFocusOut);

    // The keyboard may shrink only the visual viewport (layout viewport / 100dvh unchanged).
    // Constrain the entire Pane, including its header and key bar, not just xterm's host.
    const viewport = window.visualViewport;
    const frame = box.closest<HTMLElement>(".pane-screen") ?? box.parentElement!;
    let viewportShift = 0;
    const updateViewport = () => {
      if (viewport) {
        // Undo our previous relative offset before measuring the natural layout origin. The
        // visible bounds are layout-viewport coordinates, so offsetTop must not be ignored.
        const naturalTop = frame.getBoundingClientRect().top - viewportShift;
        viewportShift = Math.max(0, viewport.offsetTop - naturalTop);
        const height = Math.max(0, viewport.height - Math.max(0, naturalTop - viewport.offsetTop));
        frame.dataset.terminalViewport = "";
        frame.style.setProperty("--terminal-viewport-height", `${height}px`);
        frame.style.setProperty("--terminal-viewport-top", `${viewportShift}px`);
      }
      refit();
    };
    updateViewport();

    newTerminal();
    const wire = transport(pane, { output, event, reset });
    socket.current = wire;
    keyBar.current = keyEntry;
    // The open frame carries the initial grid; later changes come from the settled refit.
    sent = fitNow();
    wire.start(currentSize());

    // Refit once layout settles (rotation, virtual keyboard, split); a repeated size never leaves.
    const ro = new ResizeObserver(refit);
    ro.observe(box);
    window.addEventListener("resize", updateViewport);
    window.addEventListener("orientationchange", updateViewport);
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);

    return () => {
      live = false;
      typing.current = false;
      wire.stop();
      if (socket.current === wire) socket.current = null;
      if (keyBar.current === keyEntry) keyBar.current = null;
      if (timer !== undefined) clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("orientationchange", updateViewport);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      frame.style.removeProperty("--terminal-viewport-height");
      frame.style.removeProperty("--terminal-viewport-top");
      delete frame.dataset.terminalViewport;
      box.removeEventListener("focusout", onFocusOut);
      box.removeEventListener("touchstart", onTouchStart);
      box.removeEventListener("touchmove", onTouchMove);
      box.removeEventListener("touchend", onTouchEnd);
      for (const type of GATE_TYPES) box.removeEventListener(type, gate, true);
      for (const d of disposables) d.dispose();
      const t = term.current;
      term.current = null;
      fit = null;
      try {
        t?.dispose();
      } catch {
        // idempotent teardown
      }
      box.replaceChildren();
    };
    // A changed terminal_id, a hidden document or an invalid target starts or stops attempts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.session, pane.pane_id, terminalId, visible, attachable, syncCtrl, setConn, transport]);

  // The key bar shares the effect's per-attempt entry point.
  const keyBar = useRef<((text: string) => void) | null>(null);

  const onKey = (key: LogicalKey) => {
    const application = term.current?.modes.applicationCursorKeysMode ?? false;
    const text = key === "escape" ? "\x1b" : key === "tab" ? "\t" : cursorKey(key, application);
    keyBar.current?.(text);
  };

  const onCtrl = () => syncCtrl(!entry.current.ctrl);

  return (
    <div className="term-lens">
      <Banner
        attempt={attempt}
        target={target}
        enabled={visible && attachable}
        onReattach={() => socket.current?.start(currentSize(), false)}
        onTakeOver={() => socket.current?.start(currentSize(), true)}
      />
      <div className="term-host" ref={host} data-testid="terminal-host" />
      <KeyBar disabled={!canType(attempt, target, visible)} ctrl={ctrl} onCtrl={onCtrl} onKey={onKey} />
    </div>
  );
}

/**
 * The character a key event types, or null for an action key (Enter, Backspace, an arrow) and for
 * pure modifiers, which are never Ctrl accelerators.
 */
function textKey(e: KeyboardEvent): string | null {
  if (e.key.length !== 1) return null;
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  return e.key;
}

/** User entry needs Attached, a visible document and a live target. */
function canType(attempt: Attempt, target: Target | null, visible: boolean): boolean {
  return visible && attempt.phase === "attached" && (target === null || target.ok);
}

function Banner({
  attempt,
  target,
  enabled,
  onReattach,
  onTakeOver,
}: {
  attempt: Attempt;
  target: Target | null;
  enabled: boolean;
  onReattach(): void;
  onTakeOver(): void;
}) {
  if (!enabled) {
    return (
      <div role="alert" className="banner banner-err term-banner">
        <span>
          {target && !target.ok
            ? target.why === "stopped"
              ? "This Session is stopped"
              : target.why === "offline"
                ? "This Machine is not connected"
                : "This Pane is no longer here"
            : "The terminal is paused while the page is hidden"}
        </span>
      </div>
    );
  }
  switch (attempt.phase) {
    case "attached":
      return null;
    case "connecting":
      return (
        <div role="status" className="banner banner-info term-banner">
          Connecting…
        </div>
      );
    case "disconnected":
      return (
        <div role="status" className="banner banner-warn term-banner">
          <span>Disconnected, checking pairing…</span>
        </div>
      );
    case "retrying":
      return (
        <div role="status" className="banner banner-warn term-banner">
          <span>Disconnected, reconnecting…</span>
        </div>
      );
    case "closed":
      return (
        <div role="status" className="banner banner-warn term-banner">
          <span>Connection closed (code {attempt.code}). Reattach to try again.</span>
          <button type="button" className="btn" onClick={onReattach}>
            Reattach
          </button>
        </div>
      );
    case "held":
      return (
        <div role="alert" className="banner banner-warn term-banner">
          <span>Another device is attached to this terminal.</span>
          <button type="button" className="btn" onClick={onTakeOver}>
            Take over
          </button>
        </div>
      );
    case "exited":
      return (
        <div role="status" className="banner banner-warn term-banner">
          <span>Terminal exited{attempt.code === null ? "" : ` (code ${attempt.code})`}</span>
          <button type="button" className="btn" onClick={onReattach}>
            Reattach
          </button>
        </div>
      );
    case "detached":
      return (
        <div role="status" className="banner banner-warn term-banner">
          <span>Detached from this terminal.</span>
          <button type="button" className="btn" onClick={onReattach}>
            Reattach
          </button>
        </div>
      );
    case "error":
      return (
        <div role="alert" className="banner banner-err term-banner">
          <span>{attempt.message || "The terminal could not be opened."}</span>
          <button type="button" className="btn" onClick={onReattach}>
            Reattach
          </button>
        </div>
      );
  }
}

/** A hidden document releases its Attach; returning to it opens a normal attempt. */
function useVisibility(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
