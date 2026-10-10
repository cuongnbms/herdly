import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HIDDEN_FOLDERS, loadHiddenFolders, normalizeFolders, useHiddenFolders } from "./hiddenFolders";

const KEY = "herdr-app:settings";

beforeEach(() => {
  localStorage.clear();
  useHiddenFolders.setState({ folders: loadHiddenFolders() });
});

describe("hidden folders", () => {
  it("defaults to the heavy folders", () => {
    expect(loadHiddenFolders()).toEqual(DEFAULT_HIDDEN_FOLDERS);
    expect(DEFAULT_HIDDEN_FOLDERS).toContain(".git");
    expect(DEFAULT_HIDDEN_FOLDERS).toContain("node_modules");
  });

  it("trims names and drops blanks, duplicates, dot names and paths", () => {
    expect(normalizeFolders([" logs ", "", "  ", "logs", ".", "..", "a/b", ".cache", 3])).toEqual(["logs", ".cache"]);
    expect(normalizeFolders("logs")).toEqual(DEFAULT_HIDDEN_FOLDERS);
    expect(normalizeFolders([])).toEqual([]);
  });

  it("saves next to the other settings and resets to the defaults", () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "dark" }));
    useHiddenFolders.getState().setFolders(["tmp", "logs"]);
    expect(useHiddenFolders.getState().folders).toEqual(["tmp", "logs"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ theme: "dark", hiddenFolders: ["tmp", "logs"] });
    expect(loadHiddenFolders()).toEqual(["tmp", "logs"]);
    useHiddenFolders.getState().reset();
    expect(useHiddenFolders.getState().folders).toEqual(DEFAULT_HIDDEN_FOLDERS);
    expect(loadHiddenFolders()).toEqual(DEFAULT_HIDDEN_FOLDERS);
  });

  it("keeps the list's identity when nothing changes", () => {
    const before = useHiddenFolders.getState().folders;
    useHiddenFolders.getState().setFolders([...DEFAULT_HIDDEN_FOLDERS, " "]);
    expect(useHiddenFolders.getState().folders).toBe(before);
  });
});
