import { describe, expect, it } from "vitest";
import { isStale, settle } from "./pending";

describe("pending messages", () => {
  it("settles the first pending whose text a user item carries", () => {
    const ps = [{ id: 1, text: "hi ", sentAt: 0 }, { id: 2, text: "hi", sentAt: 1 }, { id: 3, text: "other", sentAt: 2 }];
    expect(settle(ps, [{ kind: "user", text: "hi" }, { kind: "assistant_text", markdown: "hi" }]).map((p) => p.id)).toEqual([2, 3]);
  });
  it("is stale after 30 s", () => {
    expect(isStale({ id: 1, text: "x", sentAt: 0 }, 29_999)).toBe(false);
    expect(isStale({ id: 1, text: "x", sentAt: 0 }, 30_000)).toBe(true);
  });
});
