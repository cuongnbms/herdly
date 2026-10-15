import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent, MachineView } from "../lib/types";

const ipc = vi.hoisted(() => ({ piModelsList: vi.fn(), filesRead: vi.fn(), filesWrite: vi.fn() }));
vi.mock("../lib/ipc", () => ipc);
import { useApp } from "../store/app";
import { PiSettings } from "./PiSettings";

export const text = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const machine = (id: string, label: string, extra: Partial<MachineView> = {}): MachineView => ({
  id, label, kind: id === "local" ? "local" : "ssh", state: "connected", error: null, version: "0.9.3", status: "idle", sessions: [],
  pi_agent_dir: `/home/${id}/.pi/agent`, has_pi: true, ...extra,
});
const content = (t: string): FileContent => ({ kind: "text", text: t, truncated: false, size: t.length, mtime: 1, cksum: 42, editable: true });
let disk: Record<string, Record<string, string>>;

beforeEach(() => {
  vi.clearAllMocks();
  disk = {
    "/home/local/.pi/agent": { "settings.json": text({ theme: "slop", enabledModels: ["xai/grok-4.6", "anthropic/*"], packages: ["npm:pi-web-access"] }) },
    "/home/box/.pi/agent": { "settings.json": text({ enabledModels: ["box/model"] }) },
  };
  ipc.piModelsList.mockResolvedValue([{ provider: "openai-codex", id: "gpt-6.1-sol" }, { provider: "xai", id: "grok-4.6" }]);
  ipc.filesRead.mockImplementation(async (_m: string, dir: string, rel: string) => {
    const t = disk[dir]?.[rel];
    if (t === undefined) throw { code: "not_found", message: "no such file" };
    return content(t);
  });
  ipc.filesWrite.mockImplementation(async (_m: string, dir: string, rel: string, t: string) => {
    disk[dir][rel] = t;
    return { size: t.length, mtime: 2, cksum: 43 };
  });
  useApp.setState({ machines: { local: machine("local", "This Mac") }, order: ["local"], selected: null });
});

const order = () => within(screen.getByRole("list", { name: "Ctrl+P order" })).getAllByRole("listitem");
const entries = () => order().map((r) => r.querySelector(".reorder-text")!.textContent);
const settingsOnDisk = () => JSON.parse(disk["/home/local/.pi/agent"]["settings.json"]);
async function ready() {
  render(<PiSettings />);
  await screen.findByRole("checkbox", { name: "openai-codex/gpt-6.1-sol" });
}

describe("pi settings: Enabled models", () => {
  it("shows the Ctrl+P order with patterns marked, and checks matching models", async () => {
    await ready();
    expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*"]);
    expect(within(order()[0]).queryByText("pattern")).toBeNull();
    expect(within(order()[1]).getByText("pattern")).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "xai/grok-4.6" }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "openai-codex/gpt-6.1-sol" }).checked).toBe(false);
  });

  it("appends a checked model and removes an unchecked one", async () => {
    await ready();
    fireEvent.click(screen.getByRole("checkbox", { name: "openai-codex/gpt-6.1-sol" }));
    expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*", "openai-codex/gpt-6.1-sol"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "xai/grok-4.6" }));
    expect(entries()).toEqual(["anthropic/*", "openai-codex/gpt-6.1-sol"]);
  });

  it("filters the catalog", async () => {
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter models" }), { target: { value: "GROK" } });
    expect(screen.queryByRole("checkbox", { name: "openai-codex/gpt-6.1-sol" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "xai/grok-4.6" })).toBeTruthy();
  });

  it("adds a pattern on Enter", async () => {
    await ready();
    const input = screen.getByRole("textbox", { name: "Add pattern" });
    fireEvent.change(input, { target: { value: "  *sonnet*  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*", "*sonnet*"]);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("saves the merged file, then reminds about /reload", async () => {
    await ready();
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save enabled models" });
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "openai-codex/gpt-6.1-sol" }));
    expect(screen.getByTitle("Unsaved changes")).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Machine" }).disabled).toBe(true);
    fireEvent.click(save);
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect(settingsOnDisk()).toEqual({ theme: "slop", enabledModels: ["xai/grok-4.6", "anthropic/*", "openai-codex/gpt-6.1-sol"], packages: ["npm:pi-web-access"] });
    expect(save.disabled).toBe(true);
    expect(screen.queryByTitle("Unsaved changes")).toBeNull();
  });

  it("empties the list by deleting the key", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Remove xai/grok-4.6" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove anthropic/*" }));
    expect(screen.getByText("Empty: Ctrl+P cycles through every model")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save enabled models" }));
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect("enabledModels" in settingsOnDisk()).toBe(false);
  });

  it("shows the conflict bar when enabledModels changed on disk; Reload and Overwrite", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Remove anthropic/*" }));
    disk["/home/local/.pi/agent"]["settings.json"] = text({ enabledModels: ["z/z"] });
    fireEvent.click(screen.getByRole("button", { name: "Save enabled models" }));
    const bar = await screen.findByRole("alert");
    expect(bar.textContent).toContain("Changed on disk");
    fireEvent.click(within(bar).getByRole("button", { name: "Overwrite" }));
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect(settingsOnDisk().enabledModels).toEqual(["xai/grok-4.6"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove xai/grok-4.6" }));
    disk["/home/local/.pi/agent"]["settings.json"] = text({ enabledModels: ["q/q"] });
    fireEvent.click(screen.getByRole("button", { name: "Save enabled models" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(entries()).toEqual(["q/q"]));
  });

  it("lists models from the Machine picked, defaulting to the selected pane's", async () => {
    useApp.setState({
      machines: { local: machine("local", "This Mac"), box: machine("box", "devtuf") },
      order: ["local", "box"],
      selected: { machine_id: "box", session: "default", pane_id: "p" },
    });
    render(<PiSettings />);
    await waitFor(() => expect(entries()).toEqual(["box/model"]));
    expect(ipc.piModelsList).toHaveBeenCalledWith("box");
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "local" } });
    await waitFor(() => expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*"]));
  });

  it("shows pi not found, and no connected machine", async () => {
    useApp.setState({ machines: { local: machine("local", "This Mac", { has_pi: false }) } });
    const { unmount } = render(<PiSettings />);
    expect(screen.getByText("pi not found on This Mac")).toBeTruthy();
    unmount();
    useApp.setState({ machines: { local: machine("local", "This Mac", { state: "disconnected" }) } });
    render(<PiSettings />);
    expect(screen.getByText("No connected machine")).toBeTruthy();
  });

  it("keeps the order list usable when listing models fails", async () => {
    ipc.piModelsList.mockRejectedValueOnce({ code: "io", message: "models.json broken" });
    render(<PiSettings />);
    expect((await screen.findByText("Cannot list models: models.json broken")).getAttribute("role")).toBe("alert");
    expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*"]);
    expect(within(order()[0]).getByText("pattern")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("checkbox", { name: "xai/grok-4.6" });
  });

  it("never saves a file it cannot parse", async () => {
    disk["/home/local/.pi/agent"]["settings.json"] = text({ enabledModels: "anthropic/*" });
    render(<PiSettings />);
    expect(await screen.findByText("enabledModels in settings.json is not a list")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save enabled models" })).toBeNull();
    expect(ipc.filesWrite).not.toHaveBeenCalled();
  });

  it("stays on the Machine in use when others connect, or the picked one reconnects", async () => {
    const box = machine("box", "devtuf");
    useApp.setState({
      machines: { local: machine("local", "This Mac"), box },
      order: ["local", "box"],
      selected: null,
    });
    render(<PiSettings />);
    await waitFor(() => expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*"]));
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "box" } });
    await waitFor(() => expect(entries()).toEqual(["box/model"]));
    act(() => useApp.setState({ machines: { local: machine("local", "This Mac"), box: { ...box, state: "disconnected" } } }));
    await waitFor(() => expect(entries()).toEqual(["xai/grok-4.6", "anthropic/*"]));
    fireEvent.click(screen.getByRole("button", { name: "Remove anthropic/*" }));
    act(() => useApp.setState({ machines: { local: machine("local", "This Mac"), box }, selected: { machine_id: "box", session: "default", pane_id: "p" } }));
    expect(entries()).toEqual(["xai/grok-4.6"]);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Machine" }).value).toBe("local");
  });
});
