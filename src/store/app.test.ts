import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeItem, chosenLens, useApp, selectedPane, viewedItems } from "./app";
import { itemKey, NO_ITEMS } from "./openItems";
import { filesKey, useFiles } from "../files/store";
import { paneKey } from "../lib/types";
import type { MachineView } from "../lib/types";
import { getFolder, setFolder } from "../workspaces/folder";
import { EMPTY_LAYOUT, sessionKey, useLayout } from "../sidebar/groups";
import { useLensSettings } from "../settings/lens";
import { draftKey, useDrafts } from "../files/drafts";
import { showToast } from "../ui/Toast";

vi.mock("../ui/Toast", async (importOriginal) => ({ ...(await importOriginal<typeof import("../ui/Toast")>()), showToast: vi.fn() }));

const machine: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "blocked",
  sessions: [{ name: "default", running: true, status: "blocked", error: null, workspaces: [
    { workspace_id: "w1", label: "herdr-app", number: 1, status: "blocked", tabs: [
      { tab_id: "w1:t1", label: "1", number: 1, status: "blocked", panes: [
        { pane_id: "w1:p1", terminal_id: "term_a", title: "Rewrite", cwd: "/x", agent: "claude", status: "working" },
        { pane_id: "w1:p2", terminal_id: "term_b", title: "pi", cwd: "/x", agent: "pi", status: "blocked" },
      ] },
    ] },
  ] }],
};

describe("app store", () => {
  beforeEach(() => useApp.setState({ machines: {}, order: [], selected: null }));
  it("keeps the store untouched by an identical view", () => {
    useApp.getState().upsertMachine(machine);
    const before = useApp.getState();
    useApp.getState().upsertMachine(structuredClone(machine));
    const after = useApp.getState();
    expect(after.machines).toBe(before.machines);
    expect(after.doneSeen).toBe(before.doneSeen);
    expect(after.lensOverride).toBe(before.lensOverride);
  });
  it("reuses the unchanged parts of a changed view", () => {
    const two = structuredClone(machine);
    two.sessions[0].workspaces.push({ ...structuredClone(machine.sessions[0].workspaces[0]), workspace_id: "w2" });
    useApp.getState().upsertMachine(two);
    const prev = useApp.getState().machines.local;
    const next = structuredClone(two);
    next.sessions[0].workspaces[0].tabs[0].panes[1].status = "idle";
    useApp.getState().upsertMachine(next);
    const cur = useApp.getState().machines.local;
    expect(cur).not.toBe(prev);
    expect(cur.sessions[0].workspaces[0].tabs[0].panes[1].status).toBe("idle");
    expect(cur.sessions[0].workspaces[0].tabs[0].panes[0]).toBe(prev.sessions[0].workspaces[0].tabs[0].panes[0]);
    expect(cur.sessions[0].workspaces[1]).toBe(prev.sessions[0].workspaces[1]);
  });
  it("drops folders of workspaces that left a running session", () => {
    setFolder({ machine_id: "local", session: "default", workspace_id: "w1" }, "/x");
    setFolder({ machine_id: "local", session: "default", workspace_id: "w7" }, "/gone");
    useApp.getState().upsertMachine(machine);
    expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w1" })).toBe("/x");
    expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w7" })).toBeNull();
  });
  it("keeps the folder of a just-created workspace the snapshot does not list yet", () => {
    localStorage.clear();
    const w1 = { machine_id: "local", session: "default", workspace_id: "w1" };
    const w5 = { machine_id: "local", session: "default", workspace_id: "w5" };
    setFolder(w1, "/x");
    useApp.getState().upsertMachine(machine);
    setFolder(w5, "/srv/new");
    useApp.getState().upsertMachine({ ...machine, status: "idle" });
    expect(getFolder(w5)).toBe("/srv/new");
    expect(getFolder(w1)).toBe("/x");
    const s = machine.sessions[0];
    const w5View = { ...s.workspaces[0], workspace_id: "w5", tabs: [] };
    useApp.getState().upsertMachine({ ...machine, sessions: [{ ...s, workspaces: [w5View] }] });
    expect(getFolder(w1)).toBeNull();
    expect(getFolder(w5)).toBe("/srv/new");
  });
  it("upserts machines keeping order", () => {
    useApp.getState().upsertMachine(machine);
    useApp.getState().upsertMachine({ ...machine, id: "devtuf", label: "devtuf", kind: "ssh" });
    useApp.getState().upsertMachine({ ...machine, status: "idle" });
    expect(useApp.getState().order).toEqual(["local", "devtuf"]);
    expect(useApp.getState().machines.local.status).toBe("idle");
  });
  it("resolves the selected pane path", () => {
    useApp.getState().upsertMachine(machine);
    useApp.getState().select({ machine_id: "local", session: "default", pane_id: "w1:p2" });
    const sel = selectedPane(useApp.getState());
    expect(sel?.workspace.label).toBe("herdr-app");
    expect(sel?.pane.title).toBe("pi");
  });
  it("an automatic lens override is not persisted and an explicit choice clears it", () => {
    useApp.setState({ lens: {}, lensOverride: {} });
    useApp.getState().setLensOverride("k", "terminal");
    expect(chosenLens(useApp.getState(), "k")).toBe("terminal");
    expect(localStorage.getItem("herdly:ui") ?? "").not.toContain('"k"');
    useApp.getState().setLens("k", "chat");
    expect(useApp.getState().lensOverride).toEqual({});
    expect(chosenLens(useApp.getState(), "k")).toBe("chat");
    // The override wins over a remembered choice while it lasts.
    useApp.getState().setLensOverride("k", "terminal");
    expect(chosenLens(useApp.getState(), "k")).toBe("terminal");
  });
  it("returns null when the selected pane disappeared", () => {
    useApp.getState().upsertMachine(machine);
    useApp.getState().select({ machine_id: "local", session: "default", pane_id: "w9:p9" });
    expect(selectedPane(useApp.getState())).toBeNull();
  });
});

describe("done-seen tracking", () => {
  const withStatus = (p2: "done" | "working" | "blocked"): MachineView => {
    const s = machine.sessions[0];
    const ws = s.workspaces[0];
    const tab = ws.tabs[0];
    return { ...machine, sessions: [{ ...s, workspaces: [{ ...ws, tabs: [{ ...tab, panes: [tab.panes[0], { ...tab.panes[1], status: p2 }] }] }] }] };
  };
  const p2 = { machine_id: "local", session: "default", pane_id: "w1:p2" };
  beforeEach(() => useApp.setState({ machines: {}, order: [], selected: null, doneSeen: {}, dashboardOpen: false }));

  it("marks a done pane seen when it is selected", () => {
    useApp.getState().upsertMachine(withStatus("done"));
    expect(useApp.getState().doneSeen).toEqual({});
    useApp.getState().select(p2);
    expect(useApp.getState().doneSeen).toEqual({ "local/default/w1:p2": true });
  });
  it("marks the selected pane seen when it becomes done", () => {
    useApp.getState().upsertMachine(withStatus("working"));
    useApp.getState().select(p2);
    useApp.getState().upsertMachine(withStatus("done"));
    expect(useApp.getState().doneSeen).toEqual({ "local/default/w1:p2": true });
  });
  it("forgets the seen mark once the pane leaves done", () => {
    useApp.getState().upsertMachine(withStatus("done"));
    useApp.getState().select(p2);
    useApp.getState().select(null);
    useApp.getState().upsertMachine(withStatus("working"));
    expect(useApp.getState().doneSeen).toEqual({});
    useApp.getState().upsertMachine(withStatus("done"));
    expect(useApp.getState().doneSeen).toEqual({});
  });
  it("keeps other machines' seen marks", () => {
    useApp.setState({ doneSeen: { "devtuf/default/w1:p1": true } });
    useApp.getState().upsertMachine(withStatus("working"));
    expect(useApp.getState().doneSeen).toEqual({ "devtuf/default/w1:p1": true });
  });
  it("does not mark the selected pane seen while the dashboard hides it, only once it closes", () => {
    useApp.getState().upsertMachine(withStatus("working"));
    useApp.getState().select(p2);
    useApp.getState().setDashboardOpen(true);
    useApp.getState().upsertMachine(withStatus("done"));
    expect(useApp.getState().doneSeen).toEqual({});
    useApp.getState().setDashboardOpen(false);
    expect(useApp.getState().doneSeen).toEqual({ "local/default/w1:p2": true });
  });
  it("selecting a pane closes the dashboard", () => {
    useApp.getState().setDashboardOpen(true);
    useApp.getState().select(p2);
    expect(useApp.getState().dashboardOpen).toBe(false);
  });
  it("toggles the dashboard", () => {
    useApp.getState().setDashboardOpen(true);
    expect(useApp.getState().dashboardOpen).toBe(true);
    useApp.getState().setDashboardOpen(false);
    expect(useApp.getState().dashboardOpen).toBe(false);
  });
});

describe("status-change times", () => {
  const withStatus = (p2: "idle" | "done" | "working"): MachineView => {
    const s = machine.sessions[0];
    const ws = s.workspaces[0];
    const tab = ws.tabs[0];
    return { ...machine, sessions: [{ ...s, workspaces: [{ ...ws, tabs: [{ ...tab, panes: [tab.panes[0], { ...tab.panes[1], status: p2 }] }] }] }] };
  };
  beforeEach(() => {
    useApp.setState({ machines: {}, order: [], selected: null, statusSince: {} });
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("has no time for panes in a machine's first snapshot", () => {
    useApp.getState().upsertMachine(withStatus("working"));
    expect(useApp.getState().statusSince).toEqual({});
  });
  it("records when a pane's status changes, and keeps it while it stays", () => {
    useApp.getState().upsertMachine(withStatus("working"));
    vi.setSystemTime(1000);
    useApp.getState().upsertMachine(withStatus("idle"));
    expect(useApp.getState().statusSince).toEqual({ "local/default/w1:p2": 1000 });
    vi.setSystemTime(2000);
    useApp.getState().upsertMachine(withStatus("idle"));
    expect(useApp.getState().statusSince).toEqual({ "local/default/w1:p2": 1000 });
  });
  it("records a pane that appears after the first snapshot", () => {
    const one = withStatus("idle");
    const tab = one.sessions[0].workspaces[0].tabs[0];
    const first = { ...one, sessions: [{ ...one.sessions[0], workspaces: [{ ...one.sessions[0].workspaces[0], tabs: [{ ...tab, panes: [tab.panes[0]] }] }] }] };
    useApp.getState().upsertMachine(first);
    vi.setSystemTime(5000);
    useApp.getState().upsertMachine(one);
    expect(useApp.getState().statusSince).toEqual({ "local/default/w1:p2": 5000 });
  });
  it("forgets panes that are gone and keeps other machines' times", () => {
    useApp.setState({ statusSince: { "devtuf/default/w1:p1": 7, "local/default/gone": 8 } });
    useApp.getState().upsertMachine(withStatus("working"));
    expect(useApp.getState().statusSince).toEqual({ "devtuf/default/w1:p1": 7 });
  });
});

describe("layout pruning", () => {
  const sess = (name: string) => ({ name, running: false, status: "unknown" as const, error: null, workspaces: [] });
  const box = (state: MachineView["state"], ...names: string[]): MachineView => ({
    id: "box", label: "box", kind: "ssh", state, error: null, version: "0.9.3", status: "unknown", sessions: names.map(sess),
  });
  const placed = (...keys: string[]) => ({ tree: keys.map((key) => ({ kind: "session" as const, key })), bookmarks: [...keys] });
  const kept = () => useLayout.getState().layout.bookmarks;
  beforeEach(() => {
    useApp.setState({ machines: {}, order: [], selected: null });
    useLayout.setState({ layout: EMPTY_LAYOUT });
  });

  it("forgets sessions that left a connected machine since its previous view", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a"), sessionKey("box", "b")) });
    useApp.getState().upsertMachine(box("connected", "a", "b"));
    useApp.getState().upsertMachine(box("connected", "a"));
    expect(kept()).toEqual([sessionKey("box", "a")]);
    expect(useLayout.getState().layout.tree).toEqual([{ kind: "session", key: sessionKey("box", "a") }]);
  });
  it("keeps everything on a first snapshot, even an empty one", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a")) });
    useApp.getState().upsertMachine(box("connected"));
    expect(kept()).toEqual([sessionKey("box", "a")]);
  });
  it("does not prune for a machine that is not connected", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a")) });
    useApp.getState().upsertMachine(box("connected", "a"));
    useApp.getState().upsertMachine(box("disconnected"));
    useApp.getState().upsertMachine(box("error"));
    expect(kept()).toEqual([sessionKey("box", "a")]);
  });
  it("forgets every session of a removed machine", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a"), sessionKey("local", "x")) });
    useApp.getState().upsertMachine(box("connected", "a"));
    useApp.getState().removeMachine("box");
    expect(kept()).toEqual([sessionKey("local", "x")]);
  });
});

describe("switching session", () => {
  const s = machine.sessions[0];
  const other = { ...s, name: "other", workspaces: [{ ...s.workspaces[0], workspace_id: "w2", tabs: [
    { ...s.workspaces[0].tabs[0], tab_id: "w2:t1", panes: [
      { ...s.workspaces[0].tabs[0].panes[0], pane_id: "w2:p1" },
      { ...s.workspaces[0].tabs[0].panes[1], pane_id: "w2:p2" },
    ] },
  ] }] };
  const empty = { ...s, name: "empty", workspaces: [] };
  const two: MachineView = { ...machine, sessions: [s, other, empty] };
  const pane = (session: string, pane_id: string) => ({ machine_id: "local", session, pane_id });
  beforeEach(() => useApp.setState({ machines: { local: two }, order: ["local"], selected: null, viewed: null, lastPane: {}, tabs: {} }));

  it("opens the pane last selected in that session", () => {
    useApp.getState().select(pane("other", "w2:p2"));
    useApp.getState().select(pane("default", "w1:p1"));
    useApp.getState().view({ machine_id: "local", session: "other" });
    expect(useApp.getState().selected).toEqual(pane("other", "w2:p2"));
  });

  it("opens the session's first pane when none was selected there", () => {
    useApp.getState().select(pane("default", "w1:p2"));
    useApp.getState().view({ machine_id: "local", session: "other" });
    expect(useApp.getState().selected).toEqual(pane("other", "w2:p1"));
  });

  it("opens the first pane when the remembered one is gone", () => {
    useApp.setState({ lastPane: { "local/other": pane("other", "w2:p9") } });
    useApp.getState().view({ machine_id: "local", session: "other" });
    expect(useApp.getState().selected).toEqual(pane("other", "w2:p1"));
  });

  it("keeps the selection for a session without panes", () => {
    useApp.getState().select(pane("default", "w1:p1"));
    useApp.getState().view({ machine_id: "local", session: "empty" });
    expect(useApp.getState().selected).toEqual(pane("default", "w1:p1"));
    expect(useApp.getState().viewed).toEqual({ machine_id: "local", session: "empty" });
  });

  it("keeps the selection when viewing its own session", () => {
    useApp.getState().select(pane("default", "w1:p2"));
    useApp.getState().view({ machine_id: "local", session: "default" });
    expect(useApp.getState().selected).toEqual(pane("default", "w1:p2"));
  });

  it("closes the dashboard when viewing the selected pane's own session", () => {
    useApp.getState().select(pane("default", "w1:p2"));
    useApp.getState().setDashboardOpen(true);
    useApp.getState().view({ machine_id: "local", session: "default" });
    expect(useApp.getState().dashboardOpen).toBe(false);
    expect(useApp.getState().selected).toEqual(pane("default", "w1:p2"));
  });
});

describe("an agent showing up in the selected pane", () => {
  const s = machine.sessions[0];
  const withAgent = (agent: string | null): MachineView => ({
    ...machine,
    sessions: [{ ...s, workspaces: [{ ...s.workspaces[0], tabs: [{ ...s.workspaces[0].tabs[0], panes: [
      { ...s.workspaces[0].tabs[0].panes[0], agent },
    ] }] }] }],
  });
  const ref = { machine_id: "local", session: "default", pane_id: "w1:p1" };
  const key = paneKey(ref);
  beforeEach(() => {
    useApp.setState({ machines: {}, order: [], selected: null, lens: {}, lensOverride: {} });
    useLensSettings.setState({ newAgentLens: "terminal" });
    useApp.getState().upsertMachine(withAgent(null));
    useApp.getState().select(ref);
  });

  it("keeps a shell pane on the Terminal lens when Claude starts in it", () => {
    useApp.getState().upsertMachine(withAgent("claude"));
    expect(chosenLens(useApp.getState(), key)).toBe("terminal");
  });

  it.each(["pi", "codex"])("keeps it on the Terminal lens when %s starts in it", (agent) => {
    useApp.getState().upsertMachine(withAgent(agent));
    expect(chosenLens(useApp.getState(), key)).toBe("terminal");
  });

  it("leaves it to open on Chat when new agents open on Chat", () => {
    useLensSettings.setState({ newAgentLens: "chat" });
    useApp.getState().upsertMachine(withAgent("claude"));
    expect(chosenLens(useApp.getState(), key)).toBeUndefined();
  });

  it("leaves a lens the user picked", () => {
    useApp.getState().setLens(key, "chat");
    useApp.getState().upsertMachine(withAgent("claude"));
    expect(chosenLens(useApp.getState(), key)).toBe("chat");
  });

  it("does not touch panes that are not selected", () => {
    useApp.getState().select(null);
    useApp.getState().upsertMachine(withAgent("claude"));
    expect(chosenLens(useApp.getState(), key)).toBeUndefined();
  });
});

describe("open items", () => {
  const ref = (pane_id: string, session = "default") => ({ machine_id: "local", session, pane_id });
  const key = (pane_id: string, session = "default") => itemKey({ kind: "agent", ref: ref(pane_id, session) });
  const ws = { machine_id: "local", session: "default", workspace_id: "w2" };
  const fileItem = { kind: "file" as const, ws, root: "/r", rel: "a.md" };
  const withW2 = (): MachineView => {
    const m = structuredClone(machine);
    m.sessions[0].workspaces.push({
      workspace_id: "w2", label: "other", number: 2, status: "idle",
      tabs: [{ tab_id: "w2:t1", label: "1", number: 1, status: "idle", panes: [
        { pane_id: "w2:p2", terminal_id: "term_d", title: "A", cwd: "/x", agent: "claude", status: "idle" },
        { pane_id: "w2:p3", terminal_id: "term_e", title: "B", cwd: "/x", agent: "pi", status: "idle" },
        { pane_id: "w2:p4", terminal_id: "term_f", title: "zsh", cwd: "/x", agent: null, status: "idle" },
      ] }],
    });
    return m;
  };
  beforeEach(() => {
    useApp.setState({ machines: {}, order: [], selected: null, tabs: {}, viewed: null });
    useApp.getState().upsertMachine(withW2());
  });

  it("selecting an agent opens its item as the active preview", () => {
    useApp.getState().select(ref("w2:p2"));
    const s = viewedItems(useApp.getState());
    expect(s.items).toEqual([{ kind: "agent", ref: ref("w2:p2") }]);
    expect(s.active).toBe(key("w2:p2"));
    expect(s.preview).toBe(key("w2:p2"));
  });

  it("selecting a shell pane opens its item as the active preview", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().select(ref("w2:p4"));
    const s = viewedItems(useApp.getState());
    expect(s.items).toEqual([{ kind: "agent", ref: ref("w2:p4") }]);
    expect(s.active).toBe(key("w2:p4"));
    expect(s.preview).toBe(key("w2:p4"));
  });

  it("opening a file keeps the selected pane and makes the file active, and records it as recent", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().openFile(ws, "/r", "a.md", { pin: true });
    expect(useApp.getState().selected).toEqual(ref("w2:p2"));
    expect(activeItem(useApp.getState())).toEqual(fileItem);
    expect(useFiles.getState().ws(filesKey(ws, "/r")).recent).toEqual(["a.md"]);
  });

  it("activating an agent item selects its pane", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().pinItem(key("w2:p2"));
    useApp.getState().openFile(ws, "/r", "a.md", { pin: true });
    useApp.getState().activateItem(key("w2:p2"));
    expect(activeItem(useApp.getState())).toEqual({ kind: "agent", ref: ref("w2:p2") });
  });

  it("activating a file item leaves the selected pane", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().openFile(ws, "/r", "a.md", { pin: true });
    useApp.getState().activateItem(key("w2:p2"));
    useApp.getState().activateItem(itemKey(fileItem));
    expect(viewedItems(useApp.getState()).active).toBe(itemKey(fileItem));
    expect(useApp.getState().selected).toEqual(ref("w2:p2"));
  });

  it("cycling selects the agent it lands on", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().pinItem(key("w2:p2"));
    useApp.getState().openFile(ws, "/r", "a.md", { pin: true });
    useApp.getState().cycleItems(1);
    expect(viewedItems(useApp.getState()).active).toBe(key("w2:p2"));
    expect(useApp.getState().selected).toEqual(ref("w2:p2"));
  });

  it("closing the active file hands over to the agent and keeps the selection", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().pinItem(key("w2:p2"));
    useApp.getState().openFile(ws, "/r", "a.md", { pin: false });
    useApp.getState().closeItems(itemKey(fileItem), "one");
    expect(activeItem(useApp.getState())).toEqual({ kind: "agent", ref: ref("w2:p2") });
    expect(useApp.getState().selected).toEqual(ref("w2:p2"));
  });

  it("closing the only file leaves no active item and the selected pane stays", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().closeItems(key("w2:p2"), "one");
    useApp.getState().openFile(ws, "/r", "a.md", { pin: false });
    useApp.getState().closeItems(itemKey(fileItem), "one");
    expect(viewedItems(useApp.getState()).active).toBeNull();
    expect(useApp.getState().selected).toEqual(ref("w2:p2"));
  });

  it("closing the active agent selects the next agent item", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().pinItem(key("w2:p2"));
    useApp.getState().select(ref("w2:p3"));
    useApp.getState().closeItems(key("w2:p3"), "one");
    expect(useApp.getState().selected).toEqual(ref("w2:p2"));
  });

  it("an agent started in the selected pane opens its item", () => {
    useApp.getState().select(ref("w2:p4"));
    useApp.getState().closeItems(key("w2:p4"), "one");
    const m = withW2();
    m.sessions[0].workspaces[1].tabs[0].panes[2].agent = "claude";
    useApp.getState().upsertMachine(m);
    expect(viewedItems(useApp.getState()).items).toEqual([{ kind: "agent", ref: ref("w2:p4") }]);
  });

  it("an agent started in a shell pane keeps its one item", () => {
    useApp.getState().select(ref("w2:p4"));
    useApp.getState().pinItem(key("w2:p4"));
    const m = withW2();
    m.sessions[0].workspaces[1].tabs[0].panes[2].agent = "claude";
    useApp.getState().upsertMachine(m);
    const s = viewedItems(useApp.getState());
    expect(s.items).toEqual([{ kind: "agent", ref: ref("w2:p4") }]);
    expect(s.active).toBe(key("w2:p4"));
    expect(s.preview).toBeNull();
  });

  it("an open agent item activates after its agent exits", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().pinItem(key("w2:p2"));
    useApp.getState().openFile(ws, "/r", "a.md", { pin: true });
    const m = withW2();
    m.sessions[0].workspaces[1].tabs[0].panes[0].agent = null;
    useApp.getState().upsertMachine(m);
    useApp.getState().activateItem(key("w2:p2"));
    expect(viewedItems(useApp.getState()).active).toBe(key("w2:p2"));
  });

  it("a snapshot does not reopen a closed item or steal the active file", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().pinItem(key("w2:p2"));
    useApp.getState().openFile(ws, "/r", "a.md", { pin: true });
    useApp.getState().upsertMachine(withW2());
    expect(viewedItems(useApp.getState()).active).toBe(itemKey(fileItem));
  });

  it("a connected snapshot without the workspace drops its files; removing the machine drops all", () => {
    useApp.getState().openFile(ws, "/r", "a.md", { pin: true });
    useApp.getState().upsertMachine({ ...withW2(), state: "disconnected", sessions: [] });
    expect(viewedItems(useApp.getState()).items).toHaveLength(1);
    useApp.getState().upsertMachine(machine);
    expect(viewedItems(useApp.getState()).items).toEqual([]);
    useApp.getState().openFile({ ...ws, workspace_id: "w1" }, "/r", "b.md", { pin: true });
    useApp.getState().removeMachine("local");
    expect(viewedItems(useApp.getState())).toEqual(NO_ITEMS);
  });

  it("a renamed file's item follows it, and so does its recent entry", () => {
    useApp.getState().openFile(ws, "/r", "a.md", { pin: true });
    useApp.getState().filesMoved(ws, "/r", "a.md", "b.md");
    expect(activeItem(useApp.getState())).toEqual({ ...fileItem, rel: "b.md" });
    expect(useFiles.getState().ws(filesKey(ws, "/r")).recent[0]).toBe("b.md");
    expect(useFiles.getState().ws(filesKey(ws, "/r")).recent).not.toContain("a.md");
  });

  it("moves Drafts with a renamed folder and drops them with a deleted one", () => {
    const fk = filesKey(ws, "/r");
    useDrafts.getState().open({ fk, machineId: "local", root: "/r", rel: "src/a.txt" }, { text: "t", size: 1, mtime: 1, cksum: 1 });
    useApp.getState().filesMoved(ws, "/r", "src", "lib");
    expect(Object.keys(useDrafts.getState().drafts)).toEqual([draftKey(fk, "lib/a.txt")]);
    expect(useDrafts.getState().drafts[draftKey(fk, "lib/a.txt")].rel).toBe("lib/a.txt");
    useApp.getState().filesMoved(ws, "/r", "lib", null);
    expect(useDrafts.getState().drafts).toEqual({});
  });

  it("a pruned file tab takes its Draft along, and a dirty one is reported", () => {
    useDrafts.setState(useDrafts.getInitialState(), true);
    vi.mocked(showToast).mockClear();
    const w1 = { ...ws, workspace_id: "w1" };
    const draft = (w: typeof ws, rel: string, dirty: boolean) => {
      const fk = filesKey(w, "/r");
      useApp.getState().openFile(w, "/r", rel, { pin: true });
      useDrafts.getState().open({ fk, machineId: "local", root: "/r", rel }, { text: "t", size: 1, mtime: 1, cksum: 1 });
      const k = draftKey(fk, rel);
      if (dirty) useDrafts.getState().update(k, useDrafts.getState().drafts[k].state.update({ changes: { from: 0, insert: "!" } }).state);
      return k;
    };
    useApp.getState().upsertMachine(withW2());
    draft(ws, "dir/a.md", true);
    draft(ws, "b.md", false);
    const kept = draft(w1, "c.md", true);
    // A snapshot without w2 closes its tabs.
    useApp.getState().upsertMachine(machine);
    expect(Object.keys(useDrafts.getState().drafts)).toEqual([kept]);
    expect(vi.mocked(showToast).mock.calls).toEqual([["Unsaved changes to a.md were discarded"]]);
    // A snapshot that closes nothing reports nothing.
    useApp.getState().upsertMachine(machine);
    expect(vi.mocked(showToast)).toHaveBeenCalledTimes(1);
    draft(w1, "d.md", true);
    useApp.getState().removeMachine("local");
    expect(useDrafts.getState().drafts).toEqual({});
    expect(vi.mocked(showToast).mock.calls[1]).toEqual(["Unsaved changes to 2 files were discarded"]);
  });

  it("a deleted file's item closes and an agent beside it becomes active", () => {
    useApp.getState().select(ref("w2:p2"));
    useApp.getState().pinItem(key("w2:p2"));
    useApp.getState().openFile(ws, "/r", "a.md", { pin: true });
    useApp.getState().filesMoved(ws, "/r", "a.md", null);
    expect(viewedItems(useApp.getState()).items).toEqual([{ kind: "agent", ref: ref("w2:p2") }]);
    expect(viewedItems(useApp.getState()).active).toBe(key("w2:p2"));
    expect(useFiles.getState().ws(filesKey(ws, "/r")).recent).not.toContain("a.md");
  });
});

describe("tabs per session", () => {
  const ref = (session: string, pane_id: string) => ({ machine_id: "local", session, pane_id });
  const key = (session: string, pane_id: string) => itemKey({ kind: "agent", ref: ref(session, pane_id) });
  const view = (session: string) => useApp.getState().view({ machine_id: "local", session });
  const twoSessions = (): MachineView => {
    const m = structuredClone(machine);
    const other = structuredClone(m.sessions[0]);
    other.name = "work";
    m.sessions.push(other);
    return m;
  };
  beforeEach(() => {
    useApp.setState({ machines: {}, order: [], selected: null, viewed: null, lastPane: {}, tabs: {} });
    useApp.getState().upsertMachine(twoSessions());
  });

  it("each session keeps its own tabs; the strip shows the viewed session's", () => {
    useApp.getState().pinAgent(ref("default", "w1:p1"));
    useApp.getState().select(ref("default", "w1:p1"));
    useApp.getState().select(ref("work", "w1:p2"));
    expect(viewedItems(useApp.getState()).items).toEqual([{ kind: "agent", ref: ref("work", "w1:p2") }]);
    view("default");
    expect(viewedItems(useApp.getState()).items).toEqual([{ kind: "agent", ref: ref("default", "w1:p1") }]);
    expect(useApp.getState().selected).toEqual(ref("default", "w1:p1"));
  });

  it("viewing a session brings back its active file in front of its pane", () => {
    const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
    useApp.getState().select(ref("default", "w1:p1"));
    useApp.getState().openFile(ws, "/r", "a.md", { pin: true });
    useApp.getState().select(ref("work", "w1:p2"));
    view("default");
    expect(activeItem(useApp.getState())).toEqual({ kind: "file", ws, root: "/r", rel: "a.md" });
    expect(useApp.getState().selected).toEqual(ref("default", "w1:p1"));
  });

  it("viewing a session brings back its active pane rather than its last selected one", () => {
    useApp.getState().select(ref("default", "w1:p1"));
    useApp.getState().pinAgent(ref("default", "w1:p2"));
    useApp.getState().select(ref("work", "w1:p1"));
    view("default");
    expect(useApp.getState().selected).toEqual(ref("default", "w1:p2"));
  });

  it("cycling and closing all stay within the viewed session", () => {
    useApp.getState().pinAgent(ref("default", "w1:p1"));
    useApp.getState().pinAgent(ref("work", "w1:p1"));
    useApp.getState().pinAgent(ref("work", "w1:p2"));
    useApp.getState().cycleItems(1);
    expect(useApp.getState().selected).toEqual(ref("work", "w1:p1"));
    useApp.getState().closeItems(key("work", "w1:p1"), "all");
    expect(viewedItems(useApp.getState()).items).toEqual([]);
    view("default");
    expect(viewedItems(useApp.getState()).items).toEqual([{ kind: "agent", ref: ref("default", "w1:p1") }]);
  });

  it("closing a hidden session's tab does not switch to that session", () => {
    useApp.getState().pinAgent(ref("default", "w1:p1"));
    useApp.getState().pinAgent(ref("default", "w1:p2"));
    useApp.getState().select(ref("work", "w1:p1"));
    useApp.getState().closeItems(key("default", "w1:p2"), "one");
    expect(useApp.getState().selected).toEqual(ref("work", "w1:p1"));
    expect(useApp.getState().viewed).toEqual({ machine_id: "local", session: "work" });
  });

  it("a session gone from a connected snapshot takes its tabs along", () => {
    useApp.getState().pinAgent(ref("work", "w1:p1"));
    useApp.getState().upsertMachine(machine);
    expect(useApp.getState().tabs).toEqual({});
  });
});
