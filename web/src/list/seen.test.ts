import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSeen, markSeen, shownStatus } from "./seen";

beforeEach(() => localStorage.clear());

describe("seen done", () => {
  it("shows a seen done pane as idle until its status changes", () => {
    expect(shownStatus("s/p1", "done")).toBe("done");
    markSeen("s/p1");
    expect(shownStatus("s/p1", "done")).toBe("idle");
    expect(shownStatus("s/p1", "blocked")).toBe("blocked");
    clearSeen("s/p1");
    expect(shownStatus("s/p1", "done")).toBe("done");
  });

  it("acts as nothing stored when localStorage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(shownStatus("s/p1", "done")).toBe("done");
    spy.mockRestore();
  });
});
