import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "../lib/types";

const ipc = vi.hoisted(() => ({ filesRead: vi.fn(), filesWrite: vi.fn(), piModelsList: vi.fn() }));
vi.mock("../lib/ipc", () => ipc);
import { loadAliases, loadSettings, saveAliases, saveEnabled } from "./piFiles";

const text = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const content = (t: string, over: Partial<FileContent> = {}): FileContent =>
  ({ kind: "text", text: t, truncated: false, size: t.length, mtime: 1, cksum: 42, editable: true, ...over });
const DIR = "/home/u/.pi/agent";
let disk: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  disk = { "settings.json": text({ theme: "slop", enabledModels: ["a/b"] }) };
  ipc.filesRead.mockImplementation(async (_m: string, _d: string, rel: string) => {
    if (!(rel in disk)) throw { code: "not_found", message: "no such file" };
    return content(disk[rel]);
  });
  ipc.filesWrite.mockImplementation(async (_m: string, _d: string, rel: string, t: string) => {
    disk[rel] = t;
    return { size: t.length, mtime: 2, cksum: 7 };
  });
});

describe("loadSettings", () => {
  it("returns the parsed file and its version", async () => {
    expect(await loadSettings("local", DIR)).toEqual({
      kind: "ok", value: { json: { theme: "slop", enabledModels: ["a/b"] }, enabled: ["a/b"] }, version: { size: disk["settings.json"].length, mtime: 1, cksum: 42 },
    });
    expect(ipc.filesRead).toHaveBeenCalledWith("local", DIR, "settings.json");
  });
  it("treats a missing file as empty with no version", async () => {
    delete disk["settings.json"];
    expect(await loadSettings("local", DIR)).toEqual({ kind: "ok", value: { json: {}, enabled: [] }, version: null });
  });
  it("reports read and parse errors", async () => {
    ipc.filesRead.mockRejectedValueOnce({ code: "io", message: "boom" });
    expect(await loadSettings("local", DIR)).toEqual({ kind: "error", error: "Cannot read settings.json: boom" });
    disk["settings.json"] = "{";
    expect(await loadSettings("local", DIR)).toEqual({ kind: "error", error: "settings.json is not valid JSON" });
    ipc.filesRead.mockResolvedValueOnce(content("x", { editable: false, cksum: null }));
    expect(await loadSettings("local", DIR)).toEqual({ kind: "error", error: "Cannot read settings.json: not a text file" });
  });
});

describe("saveEnabled", () => {
  it("merges onto pi's newer write", async () => {
    disk["settings.json"] = text({ theme: "slop", enabledModels: ["a/b"], defaultModel: "x/y" });
    const r = await saveEnabled("local", DIR, ["a/b"], ["c/d", "a/b"], false);
    expect(r.kind).toBe("saved");
    expect(JSON.parse(disk["settings.json"])).toEqual({ theme: "slop", enabledModels: ["c/d", "a/b"], defaultModel: "x/y" });
    expect(ipc.filesWrite).toHaveBeenCalledWith("local", DIR, "settings.json", expect.any(String), { size: expect.any(Number), mtime: 1, cksum: 42 });
  });
  it("reports a conflict when enabledModels changed on disk, unless forced", async () => {
    disk["settings.json"] = text({ enabledModels: ["z/z"] });
    expect(await saveEnabled("local", DIR, ["a/b"], ["c/d"], false)).toEqual({ kind: "conflict" });
    expect(ipc.filesWrite).not.toHaveBeenCalled();
    expect((await saveEnabled("local", DIR, ["a/b"], ["c/d"], true)).kind).toBe("saved");
    expect(JSON.parse(disk["settings.json"]).enabledModels).toEqual(["c/d"]);
  });
  it("retries once when the write races, then gives up", async () => {
    ipc.filesWrite.mockRejectedValueOnce({ code: "conflict", message: "changed" });
    expect((await saveEnabled("local", DIR, ["a/b"], ["c/d"], false)).kind).toBe("saved");
    expect(ipc.filesWrite).toHaveBeenCalledTimes(2);
    ipc.filesWrite.mockReset();
    ipc.filesWrite.mockRejectedValue({ code: "conflict", message: "changed" });
    disk["settings.json"] = text({ enabledModels: ["c/d"] });
    expect(await saveEnabled("local", DIR, ["c/d"], ["e/f"], false)).toEqual({ kind: "conflict" });
    expect(ipc.filesWrite).toHaveBeenCalledTimes(2);
  });
  it("creates a missing settings.json", async () => {
    delete disk["settings.json"];
    expect((await saveEnabled("local", DIR, [], ["a/b"], false)).kind).toBe("saved");
    expect(ipc.filesWrite).toHaveBeenCalledWith("local", DIR, "settings.json", text({ enabledModels: ["a/b"] }), null);
  });
  it("never writes over a file it cannot parse", async () => {
    disk["settings.json"] = text({ enabledModels: "a/*" });
    expect(await saveEnabled("local", DIR, [], ["a/b"], true)).toEqual({ kind: "error", error: "enabledModels in settings.json is not a list" });
    expect(ipc.filesWrite).not.toHaveBeenCalled();
  });
  it("reports other write errors", async () => {
    ipc.filesWrite.mockRejectedValueOnce({ code: "io", message: "Permission denied" });
    expect(await saveEnabled("local", DIR, ["a/b"], [], false)).toEqual({ kind: "error", error: "Cannot save: Permission denied" });
  });
});

describe("aliases", () => {
  it("loads a missing file as empty and creates it on save", async () => {
    const r = await loadAliases("local", DIR);
    expect(r).toEqual({ kind: "ok", value: { raw: {}, aliases: [] }, version: null });
    const s = await saveAliases("local", DIR, {}, [{ name: "fast", orig: null, form: "array", targets: ["x/y"] }], null, false);
    expect(s).toMatchObject({ kind: "saved", value: { aliases: [{ name: "fast", orig: "fast", form: "array", targets: ["x/y"] }] } });
    expect(ipc.filesWrite).toHaveBeenCalledWith("local", DIR, "model-alias.json", text({ fast: ["x/y"] }), null);
  });
  it("checks the whole file's version and reports conflicts", async () => {
    const v = { size: 1, mtime: 1, cksum: 1 };
    ipc.filesWrite.mockRejectedValueOnce({ code: "conflict", message: "changed" });
    expect(await saveAliases("local", DIR, {}, [], v, false)).toEqual({ kind: "conflict" });
    expect(ipc.filesWrite).toHaveBeenLastCalledWith("local", DIR, "model-alias.json", "{}\n", v);
    await saveAliases("local", DIR, {}, [], v, true);
    expect(ipc.filesWrite).toHaveBeenLastCalledWith("local", DIR, "model-alias.json", "{}\n", null);
  });
});
