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
