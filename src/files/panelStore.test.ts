import { beforeEach, describe, expect, it, vi } from "vitest";

const VIEW_KEY = "herdly:sidebar-view";

const VIEWS_KEY = "herdly:sidebar-views";

async function fresh() {
  vi.resetModules();
  return (await import("./panelStore")).useFilesPanel;
}

async function freshWithApp() {
  vi.resetModules();
  const { useFilesPanel } = await import("./panelStore");
  const { useApp } = await import("../store/app");
  const view = (machine_id: string, session: string) => useApp.setState({ viewed: { machine_id, session } });
  return { panel: useFilesPanel, view };
}

describe("useFilesPanel view", () => {
  beforeEach(() => localStorage.clear());

  it("starts split when nothing is stored, and on a stored value it does not know", async () => {
    expect((await fresh()).getState().view).toBe("split");
    localStorage.setItem(VIEW_KEY, "sideways");
    expect((await fresh()).getState().view).toBe("split");
  });

  it("remembers the chosen view across launches", async () => {
    (await fresh()).getState().setView("files");
    expect(localStorage.getItem(VIEW_KEY)).toBe("files");
    expect((await fresh()).getState().view).toBe("files");
  });

  it("brings the files into view when focus is asked for from the agents view", async () => {
    const panel = await fresh();
    panel.getState().setView("agents");
    panel.getState().focusTree();
    expect(panel.getState().view).toBe("split");
    panel.getState().setView("agents");
    panel.getState().focusGoto();
    expect(panel.getState().view).toBe("split");
  });

  it("keeps the files view when focus is asked for", async () => {
    const panel = await fresh();
    panel.getState().setView("files");
    panel.getState().focusTree();
    expect(panel.getState().view).toBe("files");
  });
});

describe("useFilesPanel view per session", () => {
  beforeEach(() => localStorage.clear());

  it("remembers each session's view and shows it when that session is viewed", async () => {
    const { panel, view } = await freshWithApp();
    view("local", "a");
    panel.getState().setView("files");
    view("local", "b");
    panel.getState().setView("agents");
    view("local", "a");
    expect(panel.getState().view).toBe("files");
    view("local", "b");
    expect(panel.getState().view).toBe("agents");
  });

  it("shows the last chosen view in a session that never chose one", async () => {
    const { panel, view } = await freshWithApp();
    view("local", "a");
    panel.getState().setView("files");
    view("local", "new");
    expect(panel.getState().view).toBe("files");
  });

  it("keeps each session's view across launches", async () => {
    let { panel, view } = await freshWithApp();
    view("local", "a");
    panel.getState().setView("files");
    view("devbox", "b");
    panel.getState().setView("agents");
    expect(JSON.parse(localStorage.getItem(VIEWS_KEY)!)).toEqual({ "local/a": "files", "devbox/b": "agents" });
    ({ panel, view } = await freshWithApp());
    view("local", "a");
    expect(panel.getState().view).toBe("files");
  });

  it("keeps a view asked for by focus while the same session is viewed again", async () => {
    const { panel, view } = await freshWithApp();
    view("local", "a");
    panel.getState().setView("agents");
    panel.getState().focusTree();
    view("local", "a");
    expect(panel.getState().view).toBe("split");
  });

  it("ignores stored views it does not know", async () => {
    localStorage.setItem(VIEWS_KEY, JSON.stringify({ "local/a": "sideways", "local/b": "files" }));
    const { panel, view } = await freshWithApp();
    view("local", "a");
    expect(panel.getState().view).toBe("split");
    view("local", "b");
    expect(panel.getState().view).toBe("files");
  });
});

describe("useFilesPanel pinned workspaces", () => {
  beforeEach(() => localStorage.clear());
  const w2 = { machine_id: "local", session: "default", workspace_id: "w2" };

  it("pins one workspace per session and remembers it across launches", async () => {
    const panel = await fresh();
    panel.getState().pinWorkspace(w2);
    panel.getState().pinWorkspace({ machine_id: "devbox", session: "s", workspace_id: "w9" });
    expect((await fresh()).getState().pinned).toEqual({ "local/default": "w2", "devbox/s": "w9" });
  });

  it("unpins a session with null", async () => {
    const panel = await fresh();
    panel.getState().pinWorkspace(w2);
    panel.getState().pinWorkspace({ machine_id: "local", session: "default", workspace_id: null });
    expect((await fresh()).getState().pinned).toEqual({});
  });

  it("starts with none pinned on a stored value it does not read", async () => {
    localStorage.setItem("herdly:files-pinned", "[1]");
    expect((await fresh()).getState().pinned).toEqual({});
    localStorage.setItem("herdly:files-pinned", "{");
    expect((await fresh()).getState().pinned).toEqual({});
  });
});
