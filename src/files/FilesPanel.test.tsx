import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const channels = vi.hoisted(() => [] as { onmessage?: (e: unknown) => void }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "files_list_all") return { paths: [], capped: false, refused: false };
    if (cmd === "files_watch") return 1;
    if (cmd === "files_read") {
      return { kind: "text", text: "x", truncated: false, size: 1, mtime: 1 };
    }
    return [];
  }),
  Channel: class {
    onmessage?: (e: unknown) => void;
    constructor() {
      channels.push(this);
    }
  },
}));
import { useApp, viewedItems } from "../store/app";
import { setFolder } from "../workspaces/folder";
import { FilesPanel } from "./FilesPanel";
import { useFilesPanel } from "./panelStore";
import { useFilesBus } from "./bus";
import { useFiles } from "./store";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };

const selected = { machine_id: "local", session: "default", pane_id: "p1" };

describe("FilesPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    channels.length = 0;
    useFiles.setState(useFiles.getInitialState(), true);
    useFilesBus.setState(useFilesBus.getInitialState(), true);
    useFilesPanel.setState(useFilesPanel.getInitialState(), true);
    useApp.setState({
      machines: { local: { id: "local", label: "local", kind: "local", state: "connected", error: null, version: null, status: "idle", sessions: [{ name: "default", running: true, status: "idle", error: null, workspaces: [
        { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [{ tab_id: "t1", label: "t", panes: [{ pane_id: "p1", cwd: "/r" }] }] },
        { workspace_id: "w2", label: "other", number: 2, status: "idle", tabs: [{ tab_id: "t2", label: "t", panes: [{ pane_id: "p2", cwd: "/o" }] }] },
      ] }] } } as never,
      selected,
      tabs: {}, viewed: null,
    });
  });

  it("shows the root from the pane and offers to save it as the workspace folder", () => {
    render(<FilesPanel />);
    expect(screen.getByText(/FILES/).textContent).toBe("FILES · app");
    expect(screen.getByTitle("/r")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set as workspace folder" })).toBeTruthy();
  });

  it("hides the panel in the agents view but keeps it mounted", () => {
    useFilesPanel.setState({ view: "agents" });
    const { container } = render(<FilesPanel />);
    expect((container.querySelector("section.files-panel") as HTMLElement).hidden).toBe(true);
    expect(container.querySelector(".files-split")).toBeNull();
    expect(container.querySelector(".files-panel-body")).toBeTruthy();
  });

  it("fills the column in the files view, with no divider or collapse", () => {
    useFilesPanel.setState({ view: "files", collapsed: true });
    const { container } = render(<FilesPanel />);
    const section = screen.getByRole("region", { name: "Files" });
    expect(section.classList.contains("full")).toBe(true);
    expect(container.querySelector(".files-split")).toBeNull();
    expect(screen.queryByRole("button", { name: /Collapse files|Expand files/ })).toBeNull();
    expect((container.querySelector(".files-panel-body") as HTMLElement).hidden).toBe(false);
    fireEvent.click(screen.getByText(/FILES/));
    expect((container.querySelector(".files-panel-body") as HTMLElement).hidden).toBe(false);
  });

  it("toggles heavy folders in the tree, hidden by default", async () => {
    render(<FilesPanel />);
    const btn = screen.getByRole("button", { name: "Show heavy folders" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("files_list_dir", { machineId: "local", root: "/r", rel: "", hidden: [] }),
    );
  });

  it("shows Machine offline when the machine is not connected", () => {
    useApp.setState((s) => ({ machines: { local: { ...s.machines.local, state: "disconnected" } } as never }));
    render(<FilesPanel />);
    expect(screen.getByText("Machine offline")).toBeTruthy();
  });

  it("shows the machine label for an ssh machine", () => {
    useApp.setState((s) => ({ machines: { local: { ...s.machines.local, kind: "ssh", label: "devbox" } } as never }));
    render(<FilesPanel />);
    expect(screen.getByText("devbox")).toBeTruthy();
  });

  it("shows nothing to browse with no selection and no open file", () => {
    useApp.setState({ selected: null, tabs: {}, viewed: null });
    render(<FilesPanel />);
    expect(screen.getByText("Select an agent to browse its files")).toBeTruthy();
  });

  it("follows the active file item's workspace and root, not the selected pane's", async () => {
    useApp.getState().openFile({ machine_id: "local", session: "default", workspace_id: "w2" }, "/o", "a.md", { pin: true });
    render(<FilesPanel />);
    expect(screen.getByText(/FILES/).textContent).toContain("other");
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("files_list_all", expect.objectContaining({ root: "/o" })));
    expect(useApp.getState().selected?.pane_id).toBe("p1");
  });

  it("clicking a file opens it as the active preview item", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) =>
      cmd === "files_list_dir" ? [{ name: "a.md", kind: "file" }] : cmd === "files_watch" ? 1 : { paths: [], capped: false, refused: false }) as never);
    render(<FilesPanel />);
    fireEvent.click(await screen.findByText("a.md"));
    expect(viewedItems(useApp.getState()).active).toBe("file:local/default/w1|/r|a.md");
    expect(viewedItems(useApp.getState()).preview).toBe("file:local/default/w1|/r|a.md");
  });

  it("collapse hides the tree; focusTree expands it and focuses the tree", async () => {
    render(<FilesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse files" }));
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand files" })).toBeTruthy();
    act(() => useFilesPanel.getState().focusTree());
    await waitFor(() => expect(document.activeElement?.closest("[role=tree]")).toBeTruthy());
  });

  it("clicking the header toggles the panel; its buttons keep their own action", async () => {
    render(<FilesPanel />);
    fireEvent.click(screen.getByText("FILES · app"));
    expect(useFilesPanel.getState().collapsed).toBe(true);
    fireEvent.click(screen.getByText("FILES · app"));
    expect(useFilesPanel.getState().collapsed).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(useFilesPanel.getState().collapsed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Collapse files" }));
    expect(useFilesPanel.getState().collapsed).toBe(true);
  });

  it("focusGoto expands the panel and focuses Go to file", async () => {
    useFilesPanel.getState().setCollapsed(true);
    render(<FilesPanel />);
    act(() => useFilesPanel.getState().focusGoto());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
  });

  it("a focus request that also switches the Workspace focuses the tree of the new one", async () => {
    render(<FilesPanel />);
    expect(screen.getByText(/FILES/).textContent).toBe("FILES · app");
    act(() => {
      useApp.getState().select({ machine_id: "local", session: "default", pane_id: "p2" });
      useFilesPanel.getState().focusTree();
    });
    expect(screen.getByText(/FILES/).textContent).toBe("FILES · other");
    await waitFor(() => expect(document.activeElement?.closest("[role=tree]")).toBeTruthy());
    expect(useFilesPanel.getState().focusHandled).toBe(useFilesPanel.getState().focusTick);
  });

  it("a request made with no Workspace shown does not fire when one appears later", async () => {
    useApp.setState({ selected: null });
    render(<FilesPanel />);
    act(() => useFilesPanel.getState().focusTree());
    act(() => useApp.getState().select({ machine_id: "local", session: "default", pane_id: "p1" }));
    await screen.findByRole("tree");
    expect(document.activeElement?.closest("[role=tree]")).toBeNull();
  });

  it("dragging the splitter sets a height clamped to keep both halves", () => {
    render(
      <div style={{ height: 600 }}>
        <FilesPanel />
      </div>,
    );
    const sep = screen.getByRole("separator");
    expect(sep.getAttribute("aria-orientation")).toBe("horizontal");
    fireEvent.mouseDown(sep, { clientY: 300 });
    fireEvent.mouseMove(window, { clientY: 290 });
    fireEvent.mouseUp(window);
    expect(useFilesPanel.getState().height).not.toBeNull();
    expect(useFilesPanel.getState().height!).toBeGreaterThanOrEqual(120);
  });

  it("offers Change folder… when the root does not exist", async () => {
    const prev = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "files_list_all") throw { code: "not_found", message: "no such folder" };
      return [];
    }) as never);
    render(<FilesPanel />);
    expect(await screen.findByRole("button", { name: "Change folder…" })).toBeTruthy();
    vi.mocked(invoke).mockImplementation(prev!);
  });

  it("does not call the root missing when the machine is disconnected", async () => {
    useApp.setState((s) => ({ machines: { local: { ...s.machines.local, state: "disconnected" } } as never }));
    const prev = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "files_list_all") throw { code: "not_found", message: "machine local is not connected" };
      return [];
    }) as never);
    render(<FilesPanel />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Change folder…" })).toBeNull();
    expect(screen.getByText("Machine offline")).toBeTruthy();
    vi.mocked(invoke).mockImplementation(prev!);
  });

  it("clears the missing state on reload once the root lists again", async () => {
    const prev = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "files_list_all") throw { code: "not_found", message: "gone" };
      return [];
    }) as never);
    render(<FilesPanel />);
    expect(await screen.findByRole("button", { name: "Change folder…" })).toBeTruthy();
    vi.mocked(invoke).mockImplementation(prev!);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(await screen.findByRole("combobox")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change folder…" })).toBeNull();
  });

  it("keeps the root it opened with; setting a folder re-resolves it", async () => {
    render(<FilesPanel />);
    expect(screen.getByTitle("/r")).toBeTruthy();
    // A cd in the pane does not move the open panel.
    act(() =>
      useApp.setState((s) => ({
        machines: { local: { ...s.machines.local, sessions: [{ ...s.machines.local.sessions[0], workspaces: [{ ...s.machines.local.sessions[0].workspaces[0], tabs: [{ tab_id: "t1", label: "t", panes: [{ pane_id: "p1", cwd: "/x" }] }] }, s.machines.local.sessions[0].workspaces[1]] }] } } as never,
      })),
    );
    expect(screen.getByTitle("/r")).toBeTruthy();
    // Saving the same path as the workspace folder keeps the root.
    fireEvent.click(screen.getByRole("button", { name: "Set as workspace folder" }));
    expect(screen.queryByRole("button", { name: "Set as workspace folder" })).toBeNull();
    expect(screen.getByTitle("/r")).toBeTruthy();
    // Another folder is another root.
    act(() => setFolder(ref, "/new"));
    expect(screen.getByTitle("/new")).toBeTruthy();
  });

  describe("keys", () => {
    const press = (extra: Partial<KeyboardEventInit> = {}) =>
      act(() => {
        fireEvent.keyDown(window, { key: "r", metaKey: true, ...extra });
      });
    const listAlls = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_list_all").length;

    it("⌘R with focus in the panel reloads the lists once", async () => {
      render(<FilesPanel />);
      await waitFor(() => expect(listAlls()).toBe(1));
      screen.getByRole("combobox").focus();
      press();
      await waitFor(() => expect(listAlls()).toBe(2));
    });

    it("⌘R with focus elsewhere does nothing", async () => {
      render(<FilesPanel />);
      await waitFor(() => expect(listAlls()).toBe(1));
      (document.activeElement as HTMLElement | null)?.blur();
      press();
      await new Promise((r) => setTimeout(r, 20));
      expect(listAlls()).toBe(1);
    });

    it("leaves ⌘R to the file viewer when a file of this root is active", async () => {
      useApp.getState().openFile(ref, "/r", "a.md", { pin: true });
      render(<FilesPanel />);
      await waitFor(() => expect(listAlls()).toBe(1));
      screen.getByRole("combobox").focus();
      press();
      await new Promise((r) => setTimeout(r, 20));
      expect(listAlls()).toBe(1);
    });
  });

  describe("read errors and the watch", () => {
    let prev: ReturnType<ReturnType<typeof vi.mocked<typeof invoke>>["getMockImplementation"]>;
    beforeEach(() => {
      prev = vi.mocked(invoke).getMockImplementation();
    });
    afterEach(() => {
      vi.mocked(invoke).mockImplementation(prev!);
      vi.useRealTimers();
    });

    const watch = () => channels[channels.length - 1];

    it("shows the folder missing when the watch reports the root removed", async () => {
      render(<FilesPanel />);
      await waitFor(() => expect(watch()).toBeTruthy());
      act(() => watch().onmessage!({ type: "changes", changes: [{ path: "", isDir: true, removed: true }] }));
      expect(await screen.findByText("This folder no longer exists.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Change folder…" })).toBeTruthy();
    });

    const listAlls = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_list_all").length;

    it("the first resync after opening does not list everything again", async () => {
      render(<FilesPanel />);
      await waitFor(() => expect(watch()).toBeTruthy());
      await waitFor(() => expect(listAlls()).toBe(1));
      act(() => watch().onmessage!({ type: "resync" }));
      await new Promise((r) => setTimeout(r, 20));
      expect(listAlls()).toBe(1);
    });

    it("a resync after the watch failed reloads, even the first one", async () => {
      render(<FilesPanel />);
      await waitFor(() => expect(watch()).toBeTruthy());
      await waitFor(() => expect(listAlls()).toBe(1));
      act(() => watch().onmessage!({ type: "error", message: "ssh: connect failed" }));
      act(() => watch().onmessage!({ type: "resync" }));
      await waitFor(() => expect(listAlls()).toBe(2));
    });

    it("the first resync after coming back online reloads", async () => {
      render(<FilesPanel />);
      await waitFor(() => expect(watch()).toBeTruthy());
      act(() => watch().onmessage!({ type: "resync" }));
      const setState = (state: string) =>
        act(() => useApp.setState((s) => ({ machines: { local: { ...s.machines.local, state } } as never })));
      setState("disconnected");
      const before = channels.length;
      setState("connected");
      await waitFor(() => expect(channels.length).toBe(before + 1));
      vi.mocked(invoke).mockClear();
      act(() => watch().onmessage!({ type: "resync" }));
      await waitFor(() => expect(listAlls()).toBe(1));
    });

    it("a later resync reloads the lists and the open folders", async () => {
      render(<FilesPanel />);
      await waitFor(() => expect(watch()).toBeTruthy());
      act(() => watch().onmessage!({ type: "resync" }));
      vi.mocked(invoke).mockClear();
      act(() => watch().onmessage!({ type: "resync" }));
      await waitFor(() => {
        const cmds = vi.mocked(invoke).mock.calls.map((c) => c[0]);
        expect(cmds).toContain("files_list_all");
        expect(cmds).toContain("files_list_dir");
      });
    });

    it("keeps watching while collapsed and hands the changes to the open file", async () => {
      useFilesPanel.getState().setCollapsed(true);
      render(<FilesPanel />);
      await waitFor(() => expect(watch()).toBeTruthy());
      expect(screen.queryByRole("tree")).toBeNull();
      expect(screen.queryByRole("combobox")).toBeNull();
      act(() => watch().onmessage!({ type: "changes", changes: [{ path: "a.md", isDir: false, removed: false }] }));
      expect(useFilesBus.getState().batches["local/default/w1|/r"]?.changes).toEqual([{ path: "a.md", isDir: false, removed: false }]);
    });

    it("shows and clears the auto-refresh error", async () => {
      render(<FilesPanel />);
      await waitFor(() => expect(watch()).toBeTruthy());
      act(() => watch().onmessage!({ type: "error", message: "upper limit on inotify watches reached!" }));
      expect(screen.getByRole("status").textContent).toBe("Auto-refresh stopped: upper limit on inotify watches reached!");
      act(() => watch().onmessage!({ type: "resync" }));
      expect(screen.queryByRole("status")).toBeNull();
    });
  });
});
