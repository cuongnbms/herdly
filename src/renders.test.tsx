import { act, render, waitFor } from "@testing-library/react";
import { memo, type ComponentType } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Render counts for one scripted sequence of machine views (the PR 4 measurement).
// RENDER_TABLE=1 prints the table.
const counts: Record<string, number> = {};
const bump = (name: string) => (counts[name] = (counts[name] ?? 0) + 1);

// Wrap a component so it counts its renders and keeps the original's `memo`.
function counted<P extends object>(name: string, C: unknown): ComponentType<P> {
  const m = C as { $$typeof?: symbol; type?: (p: P) => unknown; compare?: unknown };
  const inner = (m.$$typeof === Symbol.for("react.memo") ? m.type : C) as (p: P) => React.ReactNode;
  const Counted = (p: P) => {
    bump(name);
    return inner(p);
  };
  return m.$$typeof === Symbol.for("react.memo") ? (memo(Counted) as unknown as ComponentType<P>) : Counted;
}

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string) => (cmd === "files_list_all" ? { paths: [], capped: false, refused: false } : [])), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: vi.fn().mockResolvedValue(() => {}), destroy: vi.fn(), setTheme: vi.fn(), setBadgeCount: vi.fn().mockResolvedValue(undefined) }),
}));
// Called exactly once per App render.
vi.mock("./chat/transcriptProbe", () => ({ useTranscriptProbe: () => bump("App") }));
vi.mock("./sidebar/Sidebar", async (orig) => {
  const m = await orig<typeof import("./sidebar/Sidebar")>();
  return { ...m, Sidebar: counted("Sidebar", m.Sidebar) };
});
vi.mock("./agents/AgentList", async (orig) => {
  const m = await orig<typeof import("./agents/AgentList")>();
  return { ...m, AgentList: counted("AgentList", m.AgentList) };
});
vi.mock("./chat/ChatLens", async (orig) => {
  const m = await orig<typeof import("./chat/ChatLens")>();
  return { ...m, ChatLens: counted("ChatLens", m.ChatLens) };
});

import App from "./App";
import type { MachineView, PaneView } from "./lib/types";
import { useApp } from "./store/app";

const pane = (pane_id: string, agent: string | null, status: PaneView["status"] = "idle"): PaneView => ({
  pane_id,
  terminal_id: `t-${pane_id}`,
  title: pane_id,
  cwd: "/x",
  agent,
  status,
});

// A fresh object every call, like a deserialized emit.
function view({ other = "idle", selected = "idle", extraTab = false }: { other?: PaneView["status"]; selected?: PaneView["status"]; extraTab?: boolean } = {}): MachineView {
  return {
    id: "local",
    label: "local",
    kind: "local",
    state: "connected",
    error: null,
    version: "0.9.3",
    status: "idle",
    sessions: [
      {
        name: "default",
        running: true,
        status: "idle",
        error: null,
        workspaces: [
          {
            workspace_id: "w1",
            label: "one",
            number: 1,
            status: "idle",
            tabs: [
              { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes: [pane("w1:p1", "claude", selected)] },
              ...(extraTab ? [{ tab_id: "w1:t2", label: "2", number: 2, status: "idle" as const, panes: [pane("w1:p3", null)] }] : []),
            ],
          },
          {
            workspace_id: "w2",
            label: "two",
            number: 2,
            status: "idle",
            tabs: [{ tab_id: "w2:t1", label: "1", number: 1, status: "idle", panes: [pane("w2:p1", "pi", other)] }],
          },
        ],
      },
    ],
  };
}

describe("render counts per machine view", () => {
  const results: Record<string, Record<string, number>> = {};
  const run = async (label: string, f: () => void) => {
    for (const k of Object.keys(counts)) counts[k] = 0;
    await act(async () => f());
    results[label] = { ...counts };
  };
  const step = (label: string, v: MachineView) => run(label, () => useApp.getState().upsertMachine(v));

  beforeAll(async () => {
    useApp.setState({ machines: {}, order: [], selected: null, dashboardOpen: false });
    render(<App />);
    await act(async () => {
      useApp.getState().upsertMachine(view());
      useApp.getState().select({ machine_id: "local", session: "default", pane_id: "w1:p1" });
    });
    // Let the lazy ChatLens load and its own effects settle.
    await waitFor(() => expect(counts.ChatLens ?? 0).toBeGreaterThan(0), { timeout: 5000 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    await step("identical #1", view());
    await step("identical #2", view());
    await step("identical #3", view());
    await step("other pane status", view({ other: "working" }));
    await step("selected pane status", view({ other: "working", selected: "working" }));
    await step("new tab", view({ other: "working", selected: "working", extraTab: true }));
    // No view at all: only the selection moves, which the prop-less panels' memo must absorb.
    await run("select another pane", () => useApp.getState().select({ machine_id: "local", session: "default", pane_id: "w2:p1" }));
  });

  afterAll(() => {
    if (import.meta.env.RENDER_TABLE) console.table(results);
  });

  const zero = { App: 0, Sidebar: 0, AgentList: 0, ChatLens: 0 };
  const of = (label: string) => ({ ...zero, ...results[label] });

  it("an identical view renders nothing", () => {
    for (const l of ["identical #1", "identical #2", "identical #3"]) expect(of(l)).toEqual(zero);
  });

  it("another pane's status leaves App and ChatLens alone", () => {
    expect(of("other pane status")).toMatchObject({ App: 0, ChatLens: 0 });
  });

  it("the selected pane's status re-renders App and ChatLens once", () => {
    expect(of("selected pane status")).toMatchObject({ App: 1, ChatLens: 1 });
  });

  it("a new tab elsewhere leaves App and ChatLens alone", () => {
    expect(of("new tab")).toMatchObject({ App: 0, ChatLens: 0 });
  });

  it("selecting another pane re-renders App but not the Sidebar", () => {
    expect(of("select another pane")).toMatchObject({ App: 1, Sidebar: 0 });
  });
});
