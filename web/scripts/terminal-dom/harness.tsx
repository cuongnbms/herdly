/**
 * Browser fixture for the terminal lens.
 *
 * jsdom cannot prove xterm's real DOM behaviour (it renders into a canvas-backed screen, measures
 * cells with a canvas, and routes IME/composition/paste through its own textarea), so this harness
 * mounts the real `TerminalLens` with the real `@xterm/xterm` in Chromium and exposes a scripted
 * transport on `window`.
 *
 * It is standalone: no Rust server, no pairing cookie, no user Session. Run it through
 * `scripts/terminal-dom/run.mjs`, which serves this directory on a free loopback port.
 */

import { createRoot } from "react-dom/client";
import { StrictMode, useState } from "react";
import { type LensHandlers, type LensTransport } from "../../src/terminal/TerminalLens";
import type { WebPane } from "../../src/types";
import { useWeb } from "../../src/store";
import { PaneScreen } from "../../src/pane/PaneScreen";
import { saveLens } from "../../src/pane/lens";
import "../../src/styles.css";

export interface Wire {
  /** Frames the lens sent, in order, tagged with the API it used. */
  log: { kind: "input" | "reply" | "resize" | "start" | "stop" | "ack"; text: string }[];
  handlers: LensHandlers | null;
  starts: { cols: number; rows: number; takeover: boolean }[];
}

declare global {
  interface Window {
    wire: Wire;
    /** Push server output for the current attempt. */
    feed(text: string): Promise<void>;
    attach(): void;
    visible: (on: boolean) => void;
    pane: WebPane;
  }
}

const pane: WebPane = { session: "s", pane_id: "p1" };
window.pane = pane;
window.wire = { log: [], handlers: null, starts: [] };

function machineFor(): unknown {
  return {
    id: "local",
    label: "local",
    kind: "local",
    state: "connected",
    error: null,
    version: null,
    pi_agent_dir: null,
    has_pi: false,
    status: "idle",
    sessions: [
      {
        name: "s",
        running: true,
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
                panes: [{ pane_id: "p1", terminal_id: "tid", title: "alpha", cwd: null, agent: "claude", status: "idle" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

useWeb.setState({ conn: "open", authLost: false, lost: false, machines: [machineFor()] as never, chats: {}, open: null });

const factory = (_p: WebPane, on: LensHandlers): LensTransport => {
  window.wire.handlers = on;
  return {
    start(size, takeover = false) {
      window.wire.starts.push({ ...size, takeover });
      window.wire.log.push({ kind: "start", text: JSON.stringify({ ...size, takeover }) });
      on.reset();
      on.event({ type: "connecting" });
    },
    stop() {
      window.wire.log.push({ kind: "stop", text: "" });
    },
    input(text) {
      window.wire.log.push({ kind: "input", text });
    },
    reply(text) {
      window.wire.log.push({ kind: "reply", text });
    },
    resize(size) {
      window.wire.log.push({ kind: "resize", text: JSON.stringify(size) });
    },
  };
};

window.attach = () => window.wire.handlers?.event({ type: "attached" });
window.feed = (text: string) =>
  new Promise<void>((resolve) => {
    const handlers = window.wire.handlers;
    if (!handlers) return resolve();
    handlers.output(new TextEncoder().encode(text), () => {
      window.wire.log.push({ kind: "ack", text: String(new TextEncoder().encode(text).byteLength) });
      resolve();
    });
  });

/** Forces the visibility the lens observes; the harness remounts to re-run the effect. */
function App() {
  const [generation, setGeneration] = useState(0);
  window.visible = () => setGeneration((g) => g + 1);
  return <PaneScreen key={generation} pane={pane} transport={factory} onBack={() => {}} onSwitch={() => {}} onMenu={() => {}} />;
}

saveLens(pane, "terminal");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
