import { describe, expect, it } from "vitest";
import { controlCharacter, cursorKey, UserEntry } from "./input";

// Control characters are the C0 range: @ (0x40) maps to NUL and _ (0x5f) to US,
// case-insensitive letters map to 1..26, and ? maps to DEL (0x7f).
describe("controlCharacter", () => {
  it.each([
    ["c", "\x03"],
    ["C", "\x03"],
    ["@", "\x00"],
    ["[", "\x1b"],
    ["_", "\x1f"],
    ["?", "\x7f"],
    ["é", null],
    ["你好", null],
    ["", null],
  ])("maps only supported Ctrl input %s", (text, expected) => {
    expect(controlCharacter(text!)).toBe(expected);
  });

  it("keeps the accelerator range closed at both ends", () => {
    // 0x3f '?' and 0x60 '`' sit just outside the @.._ window; 0x40 '@' and 0x5f '_' just inside.
    expect(controlCharacter("`")).toBeNull();
    expect(controlCharacter("a")).toBe("\x01");
    expect(controlCharacter("Z")).toBe("\x1a");
  });

  it("rejects multi-character and spaced input", () => {
    expect(controlCharacter("ab")).toBeNull();
    expect(controlCharacter(" ")).toBeNull();
  });

  it("never folds a non-ASCII character into a control byte", () => {
    // "ß" upper-cases to "SS": checking the range after case folding would yield U+0013.
    expect(controlCharacter("ß")).toBeNull();
    // Dotless "ı" upper-cases to "I", which would yield Tab.
    expect(controlCharacter("ı")).toBeNull();
    // Long "ſ" upper-cases to "S", which would yield control-S.
    expect(controlCharacter("ſ")).toBeNull();
  });
});

describe("cursorKey", () => {
  it("uses the current cursor application encoding", () => {
    expect(cursorKey("up", false)).toBe("\x1b[A");
    expect(cursorKey("left", true)).toBe("\x1bOD");
  });

  it("encodes all four directions in both modes", () => {
    expect(["up", "down", "right"].map((d) => cursorKey(d as "up", true))).toEqual(["\x1bOA", "\x1bOB", "\x1bOC"]);
    expect(["down", "left", "right"].map((d) => cursorKey(d as "up", false))).toEqual(["\x1b[B", "\x1b[D", "\x1b[C"]);
  });
});

describe("UserEntry", () => {
  it("applies the one-shot Ctrl to the next user boundary and clears it", () => {
    const entry = new UserEntry();
    expect(entry.ctrl).toBe(false);
    expect(entry.apply("c")).toBe("c");
    entry.arm();
    expect(entry.ctrl).toBe(true);
    expect(entry.apply("c")).toBe("\x03");
    expect(entry.ctrl).toBe(false);
    expect(entry.apply("c")).toBe("c");
  });

  it("sends unsupported input unchanged and still clears Ctrl", () => {
    const entry = new UserEntry();
    entry.arm();
    expect(entry.apply("ướ")).toBe("ướ");
    expect(entry.ctrl).toBe(false);
  });

  it("keeps non-ASCII text unchanged and still clears Ctrl", () => {
    for (const text of ["ß", "ı", "ſ"]) {
      const entry = new UserEntry();
      entry.arm();
      // Sent as typed, not as a control byte, and the one-shot modifier is spent either way.
      expect(entry.apply(text)).toBe(text);
      expect(entry.ctrl).toBe(false);
    }
  });

  it("clears Ctrl without sending anything", () => {
    const entry = new UserEntry();
    entry.arm();
    entry.clear();
    expect(entry.ctrl).toBe(false);
    expect(entry.apply("c")).toBe("c");
  });
});
