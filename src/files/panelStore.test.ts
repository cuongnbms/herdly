import { beforeEach, describe, expect, it, vi } from "vitest";

const VIEW_KEY = "herdly:sidebar-view";

async function fresh() {
  vi.resetModules();
  return (await import("./panelStore")).useFilesPanel;
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
