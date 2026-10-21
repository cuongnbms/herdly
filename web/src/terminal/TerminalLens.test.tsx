import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWeb } from "../store";
import type { WebPane } from "../types";
import { TerminalLens, type LensHandlers, type LensTransport } from "./TerminalLens";

const pane: WebPane = { session: "s", pane_id: "p1" };

/** One machine view with a single Pane; `patch` varies the part a test cares about. */
function machine(patch: { running?: boolean; state?: string; terminalId?: string; paneId?: string } = {}) {
  return {
    id: "local",
    label: "local",
    kind: "local",
    state: patch.state ?? "connected",
    error: null,
    version: null,
    pi_agent_dir: null,
    has_pi: false,
    status: "idle",
    sessions: [
      {
        name: "s",
        running: patch.running ?? true,
        status: "idle",
        error: null,
        workspaces: [
          {
            workspace_id: "w",
            label: "w",
            number: 1,
            status: "idle",
            tabs: [
              {
                tab_id: "t",
                label: "t",
                number: 1,
                status: "idle",
                panes: [
                  {
                    pane_id: patch.paneId ?? "p1",
                    terminal_id: patch.terminalId ?? "tid-1",
                    title: "alpha",
                    cwd: null,
                    agent: null,
                    status: "idle",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** A transport double: it records calls and lets a test push server frames. */
class Transport implements LensTransport {
  starts: { cols: number; rows: number; takeover: boolean }[] = [];
  /** Every text frame in send order, tagged by the API the lens used. */
  log: { kind: "input" | "reply"; text: string }[] = [];
  resizes: { cols: number; rows: number }[] = [];
  stopped = 0;
  constructor(
    readonly pane: WebPane,
    readonly handlers: LensHandlers,
  ) {}
  get inputs() {
    return this.log.filter((e) => e.kind === "input").map((e) => e.text);
  }
  get replies() {
    return this.log.filter((e) => e.kind === "reply").map((e) => e.text);
  }
  start(size: { cols: number; rows: number }, takeover = false) {
    this.starts.push({ ...size, takeover });
    this.handlers.reset();
    this.handlers.event({ type: "connecting" });
  }
  stop() {
    this.stopped++;
  }
  input(text: string) {
    this.log.push({ kind: "input", text });
  }
  reply(text: string) {
    this.log.push({ kind: "reply", text });
  }
  resize(size: { cols: number; rows: number }) {
    this.resizes.push(size);
  }
  /** Attached on this attempt. */
  attach() {
    this.handlers.event({ type: "attached" });
  }
  /** Raw server output for this attempt. */
  out(bytes: number[] | string, parsed: () => void = () => {}) {
    this.handlers.output(typeof bytes === "string" ? new TextEncoder().encode(bytes) : Uint8Array.from(bytes), parsed);
  }
}

function rig() {
  const transports: Transport[] = [];
  const factory = (p: WebPane, on: LensHandlers): LensTransport => {
    const t = new Transport(p, on);
    transports.push(t);
    return t;
  };
  return { transports, factory, get last() { return transports[transports.length - 1]; } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Lets xterm parse what it was written (its write buffer schedules on setTimeout). */
const settle = () => act(async () => { await sleep(40); });

const textarea = () => document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
const xtermEl = () => document.querySelector<HTMLElement>(".xterm");

/** Types a printable character the way a browser does: keypress follows only an unprevented keydown. */
async function typeChar(ch: string) {
  const code = ch.toUpperCase().charCodeAt(0);
  await act(async () => {
    const down = new KeyboardEvent("keydown", { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: code, bubbles: true, cancelable: true });
    textarea().dispatchEvent(down);
    if (!down.defaultPrevented) {
      textarea().dispatchEvent(new KeyboardEvent("keypress", { key: ch, keyCode: code, charCode: ch.charCodeAt(0), bubbles: true, cancelable: true }));
    }
    // A browser always reports the release, even for a key whose default was prevented.
    textarea().dispatchEvent(new KeyboardEvent("keyup", { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: code, bubbles: true }));
  });
  await settle();
}


/** A mobile keyboard that enters text through insertText only: no printable keydown reaches us. */
async function insertText(data: string) {
  await act(async () => {
    textarea().dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data, bubbles: true, cancelable: true }));
    textarea().dispatchEvent(new InputEvent("input", { inputType: "insertText", data, bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  useWeb.setState({ conn: "open", authLost: false, lost: false, machines: [machine()] as never, chats: {}, open: null });
});

afterEach(() => cleanup());

async function mounted(p: WebPane = pane) {
  const r = rig();
  const view = render(<TerminalLens pane={p} transport={r.factory} />);
  await settle();
  return { ...r, view };
}

describe("TerminalLens attempt", () => {
  it("opens once with the measured grid, normal takeover only, and shows Connecting", async () => {
    const r = await mounted();
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    expect(r.transports).toHaveLength(1);
    expect(r.last.starts).toHaveLength(1);
    expect(r.last.starts[0]).toMatchObject({ takeover: false });
    expect(r.last.starts[0].cols).toBeGreaterThan(0);
    expect(r.last.starts[0].rows).toBeGreaterThan(0);
  });

  it("does not focus the terminal on entry", async () => {
    await mounted();
    expect(textarea()).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("TerminalLens input before Attached", () => {
  it("blocks user typing but still sends xterm's protocol reply", async () => {
    const r = await mounted();
    // Settling: a terminal query must still be answered.
    await act(async () => { r.last.out("\x1b[c"); await sleep(40); });
    expect(r.last.replies).toEqual(["\x1b[?1;2c"]);
    // ...while typed characters are captured and never leave.
    await typeChar("a");
    expect(r.last.inputs).toEqual([]);
    // Ctrl cannot smuggle input through either: the key bar stays disabled until Attached.
    expect(screen.getByRole("button", { name: "Esc" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(r.last.inputs).toEqual([]);

    // The paired positive case: after Attached the same keystroke does go out.
    await act(async () => { r.last.attach(); });
    await typeChar("a");
    expect(r.last.inputs).toEqual(["a"]);
  });

  it("captures paste and composition while settling, then sends each once after Attached", async () => {
    const r = await mounted();
    const paste = () => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: () => "echo hi" } });
      textarea().dispatchEvent(event);
    };
    await act(async () => paste());
    await settle();
    expect(r.last.inputs).toEqual([]);

    const compose = async (text: string) => {
      await act(async () => {
        textarea().dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        textarea().value = text;
        textarea().dispatchEvent(new CompositionEvent("compositionupdate", { data: text }));
        textarea().dispatchEvent(new CompositionEvent("compositionend", { data: text }));
        await sleep(20);
      });
      await settle();
    };
    await compose("ướ");
    expect(r.last.inputs).toEqual([]);

    await act(async () => { r.last.attach(); });
    await act(async () => paste());
    await settle();
    // Standard paste semantics once, with the terminal's line-ending normalization, no submit.
    expect(r.last.inputs).toEqual(["echo hi"]);
    await compose("ướ");
    // The composed run arrives once, not once per composition event.
    expect(r.last.inputs).toEqual(["echo hi", "ướ"]);
  });

  it("does not auto-focus after Attached either", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    await settle();
    expect(textarea()).not.toHaveFocus();
  });
});

describe("TerminalLens Ctrl", () => {
  it("maps the next typed character once and never rewrites a query reply", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
    // A query reply arriving while Ctrl is armed is protocol data, not user entry: it reaches
    // the wire byte-for-byte and does not spend the modifier.
    await act(async () => { r.last.out("\x1b[c"); await sleep(40); });
    expect(r.last.log).toEqual([{ kind: "input", text: "\x1b[?1;2c" }]);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
    // The next typed character spends the modifier.
    await typeChar("c");
    expect(r.last.log.slice(1)).toEqual([{ kind: "input", text: "\x03" }]);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
    await typeChar("c");
    expect(r.last.log.slice(2)).toEqual([{ kind: "input", text: "c" }]);
  });

  it("sends unsupported input unchanged and clears Ctrl", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    await act(async () => {
      textarea().dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      textarea().value = "ướ";
      textarea().dispatchEvent(new CompositionEvent("compositionend", { data: "ướ" }));
      await sleep(20);
    });
    await settle();
    expect(r.last.inputs).toEqual(["ướ"]);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps Ctrl armed through keyups and modifier keydowns", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    // Ctrl is one-shot for the next *character*, not for the release of the Control key.
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keyup", { key: "Control", keyCode: 17, bubbles: true }));
    });
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
    // Shift is a modifier, not a character: typing C afterwards still has to become ^C.
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
    expect(r.last.inputs).toEqual([]);
    await typeChar("C");
    expect(r.last.inputs).toEqual(["\x03"]);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  });

  it("spends Ctrl on a character even when it has no accelerator", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    await typeChar("é");
    expect(r.last.inputs).toEqual(["é"]);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  });

  it("does not send an unchanged grid again when the layout settles", async () => {
    // jsdom has no layout, so stand in a measurable host: the grid is fixed at 80x24 and any
    // reported resize is therefore an *unchanged* one.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("term-host") ? 320 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("term-host") ? 480 : 0;
      },
    });
    try {
      const r = await mounted();
      // The open frame already carried this grid, so two settles must produce no resize at all.
      for (const event of ["resize", "orientationchange", "resize"]) {
        await act(async () => {
          window.dispatchEvent(new Event(event));
          await sleep(400);
        });
      }
      expect(r.last.resizes).toEqual([]);
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
      if (height) Object.defineProperty(HTMLElement.prototype, "clientHeight", height);
    }
  });

  it("clears Ctrl on blur and on disconnect", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    await act(async () => {
      textarea().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    await act(async () => { r.last.handlers.event({ type: "disconnected" }); });
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
    await typeChar("c");
    expect(r.last.inputs).toEqual([]);
  });

  it("encodes arrows for the current cursor-key mode", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    await act(async () => { r.last.out("\x1b[?1h"); await sleep(40); });
    fireEvent.click(screen.getByRole("button", { name: "Arrow up" }));
    fireEvent.click(screen.getByRole("button", { name: "Arrow left" }));
    expect(r.last.inputs).toEqual(["\x1bOA", "\x1bOD"]);
    await act(async () => { r.last.out("\x1b[?1l"); await sleep(40); });
    fireEvent.click(screen.getByRole("button", { name: "Arrow down" }));
    expect(r.last.inputs.at(-1)).toBe("\x1b[B");
  });

  it("sends Esc and Tab from the key bar once Attached", async () => {
    const r = await mounted();
    fireEvent.click(screen.getByRole("button", { name: "Tab" }));
    expect(r.last.inputs).toEqual([]);
    await act(async () => { r.last.attach(); });
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    fireEvent.click(screen.getByRole("button", { name: "Tab" }));
    expect(r.last.inputs).toEqual(["\x1b", "\t"]);
  });
});

describe("TerminalLens Ctrl at the real text-entry boundary", () => {
  it("maps c to U+0003 once when the mobile keyboard only emits insertText", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    const ctrl = screen.getByRole("button", { name: "Ctrl" });
    ctrl.click();
    await insertText("c");
    expect(r.last.inputs).toEqual(["\x03"]);
    expect(ctrl).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps a query reply byte-exact while Ctrl is armed", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    screen.getByRole("button", { name: "Ctrl" }).click();
    await act(async () => { r.last.out("\x1b[c"); await sleep(40); });
    expect(r.last.log).toEqual([{ kind: "input", text: "\x1b[?1;2c" }]);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
    // The modifier survived the reply: the next character still becomes ^C.
    await insertText("c");
    expect(r.last.inputs).toEqual(["\x1b[?1;2c", "\x03"]);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  });

  it("still maps Ctrl for a character that was typed once before", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    // A plain mobile "c" first: the same text must not be mistaken for a duplicate later.
    await insertText("c");
    expect(r.last.inputs).toEqual(["c"]);
    screen.getByRole("button", { name: "Ctrl" }).click();
    await insertText("c");
    expect(r.last.inputs).toEqual(["c", "\x03"]);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps accepting entry after a mapped insertText that has no keyup", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    screen.getByRole("button", { name: "Ctrl" }).click();
    await insertText("c");
    expect(r.last.inputs).toEqual(["\x03"]);
    // An insert-only path never emits the keyup that would end a swallowed key sequence.
    await insertText("d");
    expect(r.last.inputs).toEqual(["\x03", "d"]);
  });

  it("sends exactly once when a desktop keydown is followed by its insertion tail", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    screen.getByRole("button", { name: "Ctrl" }).click();
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", keyCode: 67, bubbles: true, cancelable: true }));
      // A real browser still reports the insertion for the key it just delivered.
      textarea().dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "c", bubbles: true, cancelable: true }));
      textarea().dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "c", bubbles: true }));
      textarea().dispatchEvent(new KeyboardEvent("keyup", { key: "c", code: "KeyC", keyCode: 67, bubbles: true }));
    });
    await settle();
    expect(r.last.inputs).toEqual(["\x03"]);
  });

  it("does not spend Ctrl on a modifier keydown before C", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    screen.getByRole("button", { name: "Ctrl" }).click();
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
    expect(r.last.inputs).toEqual([]);
  });

  it("sends an unsupported non-ASCII insertText unchanged and clears Ctrl", async () => {
    const r = await mounted();
    await act(async () => { r.last.attach(); });
    screen.getByRole("button", { name: "Ctrl" }).click();
    await insertText("ß");
    expect(r.last.inputs).toEqual(["ß"]);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
    // The spent modifier must not leak into the next character.
    await insertText("c");
    expect(r.last.inputs).toEqual(["ß", "c"]);
  });
});

describe("TerminalLens banners", () => {
  it("shows Held and takes over only when asked", async () => {
    const r = await mounted();
    await act(async () => { r.last.handlers.event({ type: "held" }); });
    expect(screen.getByText("Another device is attached to this terminal.")).toBeInTheDocument();
    expect(r.last.starts).toHaveLength(1);
    expect(r.last.starts.filter((s) => s.takeover)).toEqual([]);
    // User entry is off while Held.
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(r.last.inputs).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(r.transports).toHaveLength(1);
    expect(r.last.starts.map((s) => s.takeover)).toEqual([false, true]);
    // Reattaching after a takeover is normal again: the transport decides, the UI never reuses it.
    expect(screen.getAllByRole("button", { name: "Esc" })[0]).toBeDisabled();
  });

  it("shows the exit code and reattaches normally", async () => {
    const r = await mounted();
    await act(async () => { r.last.handlers.event({ type: "attached" }); });
    await act(async () => { r.last.handlers.event({ type: "exited", code: 3 }); });
    expect(screen.getByText("Terminal exited (code 3)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reattach" }));
    expect(r.last.starts.map((s) => s.takeover)).toEqual([false, false]);
    expect(r.last.starts).toHaveLength(2);
  });

  it("shows an application error message and reattaches", async () => {
    const r = await mounted();
    await act(async () => {
      r.last.handlers.event({ type: "error", error: { code: "not_found", message: "terminal is gone" } });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("terminal is gone");
    fireEvent.click(screen.getByRole("button", { name: "Reattach" }));
    expect(r.last.starts).toHaveLength(2);
  });

  it("shows Detached with a Reattach action", async () => {
    const r = await mounted();
    await act(async () => { r.last.handlers.event({ type: "detached" }); });
    expect(screen.getByText("Detached from this terminal.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reattach" })).toBeInTheDocument();
  });
});

describe("TerminalLens attempts and terminal identity", () => {
  it("replaces the terminal on a retry instead of clearing the old one", async () => {
    const r = await mounted();
    const first = xtermEl();
    await act(async () => { r.last.handlers.reset(); });
    const second = xtermEl();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(first!.isConnected).toBe(false);
    // One live terminal, never a cache of two.
    expect(document.querySelectorAll(".xterm")).toHaveLength(1);
  });

  it("refuses to acknowledge output whose terminal was replaced before parsing", async () => {
    const r = await mounted();
    const parsed = vi.fn();
    // Off the user-input path xterm parses on a timer, so a reset can land before the callback.
    r.last.out("late chunk", parsed);
    await act(async () => { r.last.handlers.reset(); });
    await settle();
    expect(parsed).not.toHaveBeenCalled();
  });

  it("still renders output after Held or Exited on the same attempt", async () => {
    const r = await mounted();
    const parsed = vi.fn();
    await act(async () => { r.last.handlers.event({ type: "exited", code: 0 }); });
    r.last.out("trailing", parsed);
    await settle();
    expect(parsed).toHaveBeenCalledTimes(1);
  });

  it("disposes the terminal when the Lens unmounts", async () => {
    const r = await mounted();
    const el = xtermEl();
    r.view.unmount();
    expect(el!.isConnected).toBe(false);
    expect(document.querySelector(".xterm")).toBeNull();
    expect(r.last.stopped).toBe(1);
  });

  it("stops the attempt while the document is hidden and reopens normally", async () => {
    const r = await mounted();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(r.last.stopped).toBeGreaterThanOrEqual(1);
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(r.transports).toHaveLength(2);
    expect(r.last.starts[0].takeover).toBe(false);
    hidden.mockRestore();
  });

  it("does not attach without a live target", async () => {
    useWeb.setState({ machines: [machine({ paneId: "other" })] as never });
    const r = rig();
    render(<TerminalLens pane={pane} transport={r.factory} />);
    await settle();
    expect(r.transports).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent("This Pane is no longer here");
    expect(screen.getByRole("button", { name: "Esc" })).toBeDisabled();
  });

  it("shows a stopped Session and an offline Machine as unavailable", async () => {
    useWeb.setState({ machines: [machine({ running: false })] as never });
    const stopped = rig();
    const view = render(<TerminalLens pane={pane} transport={stopped.factory} />);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("This Session is stopped");
    view.unmount();
    useWeb.setState({ machines: [machine({ state: "disconnected" })] as never });
    const offline = rig();
    render(<TerminalLens pane={pane} transport={offline.factory} />);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("This Machine is not connected");
    expect(offline.transports).toEqual([]);
  });

  it("starts a new attempt when the Pane's terminal_id changes", async () => {
    const r = await mounted();
    expect(r.transports).toHaveLength(1);
    await act(async () => {
      useWeb.setState({ machines: [machine({ terminalId: "tid-2" })] as never });
    });
    await settle();
    expect(r.transports).toHaveLength(2);
    expect(r.transports[0].stopped).toBe(1);
    expect(r.last.starts[0].takeover).toBe(false);
  });
});

describe("TerminalLens pairing", () => {
  it("puts the app in Not paired and no later frame or socket restores it", async () => {
    const r = await mounted();
    await act(async () => { r.last.handlers.event({ type: "unpaired" }); });
    expect(useWeb.getState().conn).toBe("unpaired");
    expect(useWeb.getState().authLost).toBe(true);
    // A still-live, healthy Machine frame and the Chat socket's own reconnects are not fresh
    // authentication: they cannot bring the paired UI back.
    await act(async () => {
      useWeb.getState().apply({ type: "machine", view: machine() as never });
      useWeb.getState().setConn("down");
      useWeb.getState().setConn("connecting");
    });
    expect(useWeb.getState().conn).toBe("unpaired");
    // Only a socket that opens again proves pairing.
    await act(async () => { useWeb.getState().setConn("open"); });
    await waitFor(() => expect(useWeb.getState().conn).toBe("open"));
    expect(useWeb.getState().authLost).toBe(false);
  });
});
