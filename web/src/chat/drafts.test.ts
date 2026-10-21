import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDraft, saveDraft } from "./drafts";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("drafts", () => {
  it("keeps a draft per Pane", () => {
    saveDraft("s/p1", "half a thought");
    saveDraft("s/p2", "other");
    expect(loadDraft("s/p1")).toBe("half a thought");
    expect(localStorage.getItem("herdly-web:draft:s/p1")).toBe("half a thought");
    expect(loadDraft("s/p3")).toBe("");
  });

  it("removes a blank draft", () => {
    saveDraft("s/p1", "x");
    saveDraft("s/p1", "  \n");
    expect(localStorage.getItem("herdly-web:draft:s/p1")).toBeNull();
  });

  it("never throws when storage does", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => saveDraft("s/p1", "x")).not.toThrow();
    expect(() => saveDraft("s/p1", "")).not.toThrow();
    expect(loadDraft("s/p1")).toBe("");
  });
});
