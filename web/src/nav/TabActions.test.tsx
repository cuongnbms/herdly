import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { useWeb } from "../store";
import type { MachineView } from "../types";

const pane = (id: string) => ({ pane_id: id, terminal_id: `term-${id}`, title: id, cwd: null, agent: null, status: "idle" });
const machine = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "dev", running: true, status: "idle", error: null, workspaces: [
    { workspace_id: "w1", label: "Project", number: 1, status: "idle", tabs: [
      { tab_id: "t1", label: "Build", number: 1, status: "idle", panes: [pane("p1"), pane("p2")] },
      { tab_id: "t2", label: "Logs", number: 2, status: "idle", panes: [pane("p3")] },
    ] },
    { workspace_id: "w2", label: "Empty", number: 2, status: "idle", tabs: [] },
  ] }],
} as MachineView;

beforeEach(() => {
  localStorage.clear();
  useWeb.setState({ conn: "open", authLost: false, lost: false, machines: [machine], open: null, chats: {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function openSidebar() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
  return within(screen.getByRole("dialog", { name: "Sessions and Workspaces" }));
}

it("confirms closing all tab Panes and returns the current Pane to the list", async () => {
  useWeb.setState({ open: { session: "dev", pane_id: "p2" } });
  useWeb.getState().apply({ type: "chat_opened", pane: { session: "dev", pane_id: "p2" }, located: { agent: "claude", path: "/chat", ambiguous: false, candidates: [], pending: false } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe("/api/tab/close");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ session: "dev", tab_id: "t1" });
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetch);
  const drawer = openSidebar();
  const tab = within(drawer.getByRole("group", { name: "Tab Build" }));
  expect(tab.getByRole("button", { name: /p1/ })).toBeInTheDocument();
  expect(tab.getByRole("button", { name: /p2/ })).toBeInTheDocument();
  fireEvent.click(tab.getByRole("button", { name: "Close tab Build" }));
  expect(confirm).toHaveBeenCalledWith('Close tab "Build" and all its panes?');
  await waitFor(() => expect(useWeb.getState().open).toBeNull());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(useWeb.getState().chats["dev/p2"]).toBeUndefined();
  fireEvent.click(drawer.getByRole("button", { name: "Close sidebar" }));
  expect(screen.getByRole("heading", { name: "Herdly" })).toBeInTheDocument();
});

it("keeps the selected Pane on a failed close, reports the error, and allows retry", async () => {
  const current = { session: "dev", pane_id: "p2" };
  useWeb.setState({ open: current });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  let finish!: (r: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const drawer = openSidebar();
  const close = drawer.getByRole("button", { name: "Close tab Build" });
  fireEvent.click(close);
  expect(close).toBeDisabled();
  expect(within(drawer.getByRole("group", { name: "Workspace Project" })).getByRole("button", { name: "New tab" })).toBeDisabled();
  fireEvent.click(close);
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { finish(new Response(JSON.stringify({ code: "herdr_error", message: "Session unavailable" }), { status: 502 })); });
  expect(drawer.getByRole("alert")).toHaveTextContent("Session unavailable");
  expect(useWeb.getState().open).toEqual(current);
  expect(close).toBeEnabled();
});

it("does not call the server when closing is cancelled", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(window, "confirm").mockReturnValue(false);
  const drawer = openSidebar();
  fireEvent.click(drawer.getByRole("button", { name: "Close tab Logs" }));
  expect(fetch).not.toHaveBeenCalled();
  expect(drawer.getByRole("group", { name: "Tab Logs" })).toBeInTheDocument();
});

it.each(["stopped", "disconnected"])("disables tab mutations while %s", (condition) => {
  if (condition === "stopped") useWeb.setState({ machines: [{ ...machine, sessions: [{ ...machine.sessions[0], running: false }] }] });
  else useWeb.setState({ conn: "down" });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const drawer = openSidebar();
  expect(drawer.getByRole("button", { name: "New tab" })).toBeDisabled();
  expect(drawer.getByRole("button", { name: "Close tab Build" })).toBeDisabled();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not reopen a Pane if the sidebar was dismissed during creation", async () => {
  let finish!: (r: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const drawer = openSidebar();
  fireEvent.click(drawer.getByRole("button", { name: "New tab" }));
  fireEvent.click(drawer.getByRole("button", { name: "Close sidebar" }));
  expect(screen.queryByRole("dialog", { name: "Sessions and Workspaces" })).not.toBeInTheDocument();
  await act(async () => { finish(new Response(JSON.stringify({ root_pane: { pane_id: "p-new" } }))); });
  expect(useWeb.getState().open).toBeNull();
  expect(screen.getByRole("heading", { name: "Herdly" })).toBeInTheDocument();
});

it("preserves a different selection when a close reply arrives after a live view", async () => {
  const current = { session: "dev", pane_id: "p2" };
  useWeb.setState({ open: current });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  let finish!: (r: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const drawer = openSidebar();
  fireEvent.click(drawer.getByRole("button", { name: "Close tab Build" }));
  fireEvent.click(drawer.getByRole("button", { name: /p3/ }));
  const updated = { ...machine, sessions: [{ ...machine.sessions[0], workspaces: [{ ...machine.sessions[0].workspaces[0], tabs: [machine.sessions[0].workspaces[0].tabs[1]] }] }] };
  act(() => useWeb.getState().apply({ type: "machine", view: updated }));
  await act(async () => { finish(new Response("{}")); });
  expect(useWeb.getState().open).toEqual({ session: "dev", pane_id: "p3" });
});

it("creates a tab in an empty workspace and opens its root Pane", async () => {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe("/api/tab/create");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(JSON.parse(init?.body as string)).toEqual({ session: "dev", workspace_id: "w2" });
    return new Response(JSON.stringify({ tab_id: "t-new", root_pane: { pane_id: "p-new" } }));
  });
  vi.stubGlobal("fetch", fetch);
  const drawer = openSidebar();
  fireEvent.click(drawer.getByRole("button", { name: "Workspace Empty" }));
  fireEvent.click(within(drawer.getByRole("group", { name: "Workspace Empty" })).getByRole("button", { name: "New tab" }));
  await waitFor(() => expect(useWeb.getState().open).toEqual({ session: "dev", pane_id: "p-new" }));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: "Sessions and Workspaces" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
});
