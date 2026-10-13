import { Channel } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useReducer, useRef } from "react";
import "../fonts/fonts.css";
import { attachKeyString, imageSaveTemp, termAck, termOpen, termRelease, termResize, termWrite } from "../lib/ipc";
import type { AttachEvent, PaneRef } from "../lib/types";
import { useApp } from "../store/app";
import { dismissToast, showToast } from "../ui/Toast";
import { Banner } from "./Banner";
import { StartingOverlay } from "./StartingOverlay";
import { ensureTermFont, useSettings, watchTermFont } from "../settings/store";
import { watchTermTheme } from "../settings/theme";
import { applyCopyOnSelect } from "./copyOnSelect";
import { applyHoldSelection } from "./holdSelection";
import { createAckBatcher, createInputQueue } from "./ipcBatch";
import { createImagePaste } from "./imagePaste";
import { createKeyHandler } from "./keyHandler";
import { disposesOnEvent, endsOpen, initialLensState, lensReducer } from "./lensState";
import { applyOsc52 } from "./osc52";
import { createOutputBuffer } from "./outputBuffer";
import { claim, disposeIf, getOrCreate } from "./termCache";
import { applyUnicode11 } from "./unicode";
import { forgetWebgl, showWebgl } from "./webgl";
import { applyWheelScroll } from "./wheel";

const RESIZE_SETTLE_MS = 150;

interface Props {
  pane: PaneRef;
  terminalId: string;
}

let copiedToast: number | null = null;

/** Says a selection reached the clipboard; a new copy replaces the last notice instead of stacking. */
function showCopied() {
  if (copiedToast !== null) dismissToast(copiedToast);
  copiedToast = showToast("Copied", { alert: false });
}

function createEntry(key: string) {
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    // No smooth scroll: at 100ms trackpad scrolling lagged behind the fingers and felt rubbery.
    smoothScrollDuration: 0,
    allowProposedApi: true,
    // herdr turns on mouse reporting, so a plain drag never selects; Option+drag selects and copies.
    macOptionClickForcesSelection: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  applyUnicode11(term);
  applyOsc52(term, (text) => void writeText(text).catch((e) => console.error("OSC 52 copy failed", e)));
  const stopCopyOnSelect = applyCopyOnSelect(term, (text) =>
    void writeText(text).then(showCopied, (e) => console.error("selection copy failed", e)),
  );
  const stopHoldSelection = applyHoldSelection(term);
  term.attachCustomKeyEventHandler(createKeyHandler((text) => term.input(text)));
  applyWheelScroll(term);
  const unwatchFont = watchTermFont(term, fit);
  const unwatchTheme = watchTermTheme(term);
  const output = createOutputBuffer((data, onParsed) => term.write(data, onParsed));
  return {
    term,
    fit,
    output,
    cleanup: () => {
      output.dispose();
      stopCopyOnSelect();
      stopHoldSelection();
      forgetWebgl(key);
      unwatchFont();
      unwatchTheme();
    },
  };
}

/** True when the user is typing somewhere else (a dialog, the palette, a composer): showing a terminal must not take that focus. */
function typingElsewhere(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el.classList.contains("xterm-helper-textarea")) return false;
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

function toBytes(buf: unknown): Uint8Array | null {
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (buf instanceof Uint8Array) return buf;
  if (Array.isArray(buf)) return Uint8Array.from(buf as number[]);
  return null;
}

export function TerminalLens({ pane, terminalId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const takeoverRef = useRef<(() => void) | null>(null);
  const [lens, dispatch] = useReducer(lensReducer, initialLensState);
  const machineState = useApp((s) => s.machines[pane.machine_id]?.state);
  const machineRef = useRef(machineState);
  machineRef.current = machineState;

  const cacheKey = attachKeyString({ machine_id: pane.machine_id, session: pane.session, terminal_id: terminalId });

  useEffect(() => {
    dispatch({ type: "machine", machine: machineState });
  }, [machineState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const key = { machine_id: pane.machine_id, session: pane.session, terminal_id: terminalId };
    let live = true;
    const { term, fit, output } = getOrCreate(cacheKey, () => createEntry(cacheKey));
    const revealed = !!term.element;
    if (revealed) container.appendChild(term.element!);
    else term.open(container);
    try {
      fit.fit();
    } catch {
      /* container not measurable yet */
    }
    // A shown terminal takes the keyboard, so a new agent's prompt is ready to type into.
    if (!typingElsewhere()) term.focus();
    // Only the mounted terminal writes straight through; cached ones batch until shown again.
    output.setVisible(true);
    let frame = 0;
    // The WebGL atlas rasterizes ASCII up front, so the font must be a web font first
    // (see ensureTermFont); the DOM renderer covers the wait.
    void ensureTermFont(useSettings.getState().terminalFontFamily).then(() => {
      if (!live) return;
      showWebgl(cacheKey, term);
      if (!revealed) return;
      // Cells parsed while hidden, or under the other renderer's metrics, can composite stale
      // pixels; redraw once layout has settled.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (!live) return;
          term.clearTextureAtlas();
          term.refresh(0, term.rows - 1);
          try {
            fit.fit();
          } catch {
            /* ignore */
          }
        });
      });
    });

    // The latest open: only its end decides whether the xterm is freed on cleanup.
    let latest = { ended: false, token: 0 };
    const open = (takeover: boolean) => {
      // Data and event handling deliberately ignore `live`: the cached xterm must keep
      // streaming (and acking) while hidden, and a hidden pane must still be freed when its
      // open ends. The backend sends no `detached` after an exit or a held attach, so waiting
      // for it alone would leak the xterm.
      const self = { ended: false, token: claim(cacheKey) };
      latest = self;
      // Only a detach drops output: `held` arrives just before the chunk that carries it.
      let detached = false;
      const acks = createAckBatcher((n) => termAck(key, n));
      const data = new Channel<ArrayBuffer>();
      data.onmessage = (buf) => {
        const bytes = toBytes(buf);
        if (!bytes || detached) return;
        output.write(bytes, () => acks.add(bytes.byteLength));
      };
      const events = new Channel<AttachEvent>();
      events.onmessage = (ev) => {
        if (ev.type === "detached") detached = true;
        if (endsOpen(ev)) self.ended = true;
        if (disposesOnEvent(ev, live)) disposeIf(cacheKey, self.token);
        if (live) dispatch({ type: "event", event: ev, machine: machineRef.current });
      };
      termOpen(key, term.cols, term.rows, takeover, data, events).catch((e) => {
        console.error("term_open failed", e);
        if (live) dispatch({ type: "open_failed", machine: machineRef.current });
      });
    };
    takeoverRef.current = () => open(true);
    open(false);

    const inputQueue = createInputQueue((d) => termWrite(key, d));
    const input = term.onData((d) => inputQueue.push(d));
    const resize = term.onResize(({ cols, rows }) => void termResize(key, cols, rows).catch(() => {}));

    // Refit once a split or window drag settles: each grid change reflows the scrollback and
    // makes herdr redraw the whole screen. fit() itself skips unchanged grids.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }, RESIZE_SETTLE_MS);
    });
    ro.observe(container);

    // Capture phase: ahead of xterm's own paste handler on its textarea.
    const onPaste = createImagePaste(
      (bytes, ext) => imageSaveTemp(pane.machine_id, bytes, ext),
      (text) => term.paste(text),
      (message) => {
        console.error(message);
        showToast(message);
      },
    );
    container.addEventListener("paste", onPaste, true);

    return () => {
      container.removeEventListener("paste", onPaste, true);
      live = false;
      output.setVisible(false);
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      inputQueue.dispose();
      ro.disconnect();
      input.dispose();
      resize.dispose();
      takeoverRef.current = null;
      void termRelease(key).catch(() => {});
      // A hidden or unmounted pane frees the xterm its ended open left behind. Deferred
      // because a Reattach also runs this cleanup: its new effect claims the key in the same
      // flush, which turns this into a no-op and keeps the scrollback.
      const { ended, token } = latest;
      if (ended) setTimeout(() => disposeIf(cacheKey, token), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, lens.generation]);

  return (
    <div className="term-lens">
      {lens.banner && (
        <Banner
          kind={lens.banner.kind}
          code={lens.banner.code}
          onTakeOver={() => takeoverRef.current?.()}
          onReattach={() => dispatch({ type: "reattach" })}
        />
      )}
      <div className="term-host" ref={containerRef} />
      <StartingOverlay pane={pane} />
    </div>
  );
}
