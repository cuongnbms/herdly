import { beforeEach, describe, expect, it } from "vitest";
import { clampOutlineWidth, loadOutlineWidth, OUTLINE_DEFAULT, OUTLINE_MAX, OUTLINE_MIN, saveOutlineWidth } from "./outlineWidth";

beforeEach(() => localStorage.clear());

describe("outline width", () => {
  it("clamps to the rail's range", () => {
    expect(clampOutlineWidth(50)).toBe(OUTLINE_MIN);
    expect(clampOutlineWidth(9999)).toBe(OUTLINE_MAX);
    expect(clampOutlineWidth(300.6)).toBe(301);
  });

  it("defaults until one is saved, then keeps it beside the other settings", () => {
    localStorage.setItem("herdly:settings", JSON.stringify({ theme: "dark" }));
    expect(loadOutlineWidth()).toBe(OUTLINE_DEFAULT);
    saveOutlineWidth(333);
    expect(loadOutlineWidth()).toBe(333);
    expect(JSON.parse(localStorage.getItem("herdly:settings")!)).toEqual({ theme: "dark", outlineWidth: 333 });
  });

  it("ignores a stored width that is not a number and clamps one out of range", () => {
    localStorage.setItem("herdly:settings", JSON.stringify({ outlineWidth: "wide" }));
    expect(loadOutlineWidth()).toBe(OUTLINE_DEFAULT);
    localStorage.setItem("herdly:settings", JSON.stringify({ outlineWidth: 5000 }));
    expect(loadOutlineWidth()).toBe(OUTLINE_MAX);
  });
});
