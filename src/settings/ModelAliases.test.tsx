import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent, MachineView } from "../lib/types";

const ipc = vi.hoisted(() => ({ piModelsList: vi.fn(), filesRead: vi.fn(), filesWrite: vi.fn() }));
vi.mock("../lib/ipc", () => ipc);
import { useApp } from "../store/app";
import { PiSettings } from "./PiSettings";

const text = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const DIR = "/home/local/.pi/agent";
const local: MachineView = {
  id: "local", label: "This Mac", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle", sessions: [],
  pi_agent_dir: DIR, has_pi: true,
};
const ALIASES = {
  $settings: { statusRefreshMs: 2000 },
  mid: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"],
  high: { targets: ["openai-codex/gpt-5.6-sol"], timeouts: { stallMs: 5 } },
  top: "alias/mid",
};
let disk: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  disk = {
    "settings.json": text({ packages: ["git:github.com/cuongnbms/pi-model-fallback-alias"] }),
    "model-alias.json": text(ALIASES),
  };
  ipc.piModelsList.mockResolvedValue([{ provider: "xai", id: "grok-4.6" }]);
  ipc.filesRead.mockImplementation(async (_m: string, _d: string, rel: string) => {
    if (!(rel in disk)) throw { code: "not_found", message: "no such file" };
    const t = disk[rel];
    return { kind: "text", text: t, truncated: false, size: t.length, mtime: 1, cksum: 42, editable: true } satisfies FileContent;
  });
  ipc.filesWrite.mockImplementation(async (_m: string, _d: string, rel: string, t: string) => {
    disk[rel] = t;
    return { size: t.length, mtime: 2, cksum: 43 };
  });
  useApp.setState({ machines: { local }, order: ["local"], selected: null });
});

const card = (n: number) => screen.getByRole("region", { name: `Alias ${n}` });
const targets = (n: number) =>
  within(screen.getByRole("list", { name: `Alias ${n} targets` })).getAllByRole("listitem").map((r) => r.querySelector(".reorder-text")!.textContent);
const nameBox = (n: number) => screen.getByRole<HTMLInputElement>("textbox", { name: `Alias ${n} name` });
const aliasesOnDisk = () => JSON.parse(disk["model-alias.json"]);
async function ready() {
  render(<PiSettings />);
  await screen.findByRole("textbox", { name: "Alias 1 name" });
}

describe("pi settings: Model aliases", () => {
  it("is hidden without the alias package", async () => {
    disk["settings.json"] = text({ packages: ["npm:pi-web-access"] });
    render(<PiSettings />);
    await screen.findByRole("list", { name: "Ctrl+P order" });
    expect(screen.queryByText("Model aliases")).toBeNull();
  });

  it("lists aliases and their numbered targets", async () => {
    await ready();
    expect([1, 2, 3].map((n) => nameBox(n).value)).toEqual(["mid", "high", "top"]);
    expect(targets(1)).toEqual(["1. opencode-go/deepseek-v4.1-flash", "2. openai-codex/gpt-5.6-luna"]);
    expect(targets(3)).toEqual(["1. alias/mid"]);
  });

  it("renames on commit only, cascading into other aliases, and saves", async () => {
    await ready();
    fireEvent.change(nameBox(1), { target: { value: "hig" } });
    expect(targets(3)).toEqual(["1. alias/mid"]);
    fireEvent.change(nameBox(1), { target: { value: "high" } });
    expect(within(card(1)).getByText("Name already used")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save model aliases" }).disabled).toBe(true);
    fireEvent.blur(nameBox(1));
    expect(targets(3)).toEqual(["1. alias/mid"]);
    fireEvent.change(nameBox(1), { target: { value: "middle" } });
    fireEvent.keyDown(nameBox(1), { key: "Enter" });
    expect(targets(3)).toEqual(["1. alias/middle"]);
    fireEvent.click(screen.getByRole("button", { name: "Save model aliases" }));
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect(aliasesOnDisk()).toEqual({
      $settings: { statusRefreshMs: 2000 },
      middle: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"],
      high: { targets: ["openai-codex/gpt-5.6-sol"], timeouts: { stallMs: 5 } },
      top: ["alias/middle"],
    });
    expect(ipc.filesWrite).toHaveBeenCalledWith("local", DIR, "model-alias.json", expect.any(String), { size: expect.any(Number), mtime: 1, cksum: 42 });
  });

  it("warns about a deleted alias that another one targets", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Delete alias 1" }));
    expect(within(card(2)).getByText("alias/mid does not exist")).toBeTruthy();
  });

  it("adds an alias with a target", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New alias" }));
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save model aliases" });
    expect(within(card(4)).getByText("Add at least one target")).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(nameBox(4), { target: { value: "fast" } });
    fireEvent.blur(nameBox(4));
    const add = screen.getByRole("combobox", { name: "Add target to alias 4" });
    fireEvent.change(add, { target: { value: "xai/grok-4.6" } });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(targets(4)).toEqual(["1. xai/grok-4.6"]);
    fireEvent.click(save);
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect(aliasesOnDisk().fast).toEqual(["xai/grok-4.6"]);
  });

  it("creates model-alias.json when missing", async () => {
    delete disk["model-alias.json"];
    render(<PiSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "New alias" }));
    fireEvent.change(nameBox(1), { target: { value: "fast" } });
    fireEvent.blur(nameBox(1));
    const add = screen.getByRole("combobox", { name: "Add target to alias 1" });
    fireEvent.change(add, { target: { value: "xai/grok-4.6" } });
    fireEvent.keyDown(add, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Save model aliases" }));
    await screen.findByText("New pi agents use this; running ones need /reload.");
    expect(ipc.filesWrite).toHaveBeenCalledWith("local", DIR, "model-alias.json", text({ fast: ["xai/grok-4.6"] }), null);
  });

  it("shows the conflict bar when the file changed; Reload reads it again", async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Delete alias 3" }));
    ipc.filesWrite.mockRejectedValueOnce({ code: "conflict", message: "changed" });
    disk["model-alias.json"] = text({ other: ["a/b"] });
    fireEvent.click(screen.getByRole("button", { name: "Save model aliases" }));
    const bar = await screen.findByRole("alert");
    expect(bar.textContent).toContain("Changed on disk");
    fireEvent.click(within(bar).getByRole("button", { name: "Reload" }));
    await screen.findByDisplayValue("other");
  });
});
