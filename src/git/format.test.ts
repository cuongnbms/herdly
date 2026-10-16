import { describe, expect, it } from "vitest";
import { timeAgo } from "./format";

const now = 1_800_000_000_000;
const ago = (s: number) => timeAgo(now / 1000 - s, now);

describe("timeAgo", () => {
  it("is compact, like a commit list", () => {
    expect(ago(30)).toBe("just now");
    expect(ago(5 * 60)).toBe("5m ago");
    expect(ago(3 * 3600)).toBe("3h ago");
    expect(ago(2 * 86400)).toBe("2d ago");
    expect(ago(15 * 86400)).toBe("2w ago");
    expect(ago(200 * 86400)).toBe("6mo ago");
    expect(ago(800 * 86400)).toBe("2y ago");
  });
});
