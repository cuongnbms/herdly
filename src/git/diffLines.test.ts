import { describe, expect, it } from "vitest";
import { HIGHLIGHT_LIMIT } from "../files/limits";
import type { FileDiff } from "../lib/types";
import { diffRows } from "./diffLines";

const line = (kind: "context" | "add" | "del" | "combined", text: string, old_no: number | null, new_no: number | null, no_newline = false) => ({ kind, text, old_no, new_no, no_newline });
const diff = (lines: ReturnType<typeof line>[]): FileDiff => ({ binary: false, old_mode: null, new_mode: null, rename: null, added: 0, removed: 0, truncated: false, hunks: [{ header: "@@ -1,3 +1,3 @@", old_start: 1, new_start: 1, lines }] });
const text = (r: { segs?: { text: string }[] }) => (r.segs ?? []).map((s) => s.text).join("");
const classes = (r: { segs?: { cls: string }[] }) => (r.segs ?? []).map((s) => s.cls).join(" ");

describe("diffRows", () => {
  it("emits a hunk header then numbered, marked lines", () => {
    const rows = diffRows(diff([line("context", "a", 1, 1), line("del", "b", 2, null), line("add", "B", null, 2)]), "x.txt");
    expect(rows[0]).toEqual({ kind: "hunk", text: "@@ -1,3 +1,3 @@" });
    expect(rows.slice(1).map((r) => r.kind !== "hunk" && r.kind !== "note" && [r.kind, r.oldNo, r.newNo, r.mark, text(r)])).toEqual([
      ["context", 1, 1, " ", "a"],
      ["del", 2, null, "-", "b"],
      ["add", null, 2, "+", "B"],
    ]);
  });

  it("highlights each side as one text, so a comment opened on a deleted line stays a comment", () => {
    const rows = diffRows(diff([line("del", "/* start", 1, null), line("del", "still comment */", 2, null), line("add", "const x = 1;", null, 1)]), "a.ts");
    expect(classes(rows[2] as never)).toContain("hljs-comment");
    expect(classes(rows[3] as never)).not.toContain("hljs-comment");
    expect(classes(rows[3] as never)).toContain("hljs-keyword");
  });

  it("adds a note after a line with no newline, and keeps combined markers apart from the text", () => {
    const rows = diffRows(diff([line("add", "end", null, 1, true), line("combined", "++<<<<<<< HEAD", null, 2)]), "a.txt");
    expect(rows[2]).toEqual({ kind: "note", text: "No newline at end of file" });
    expect(rows[3]).toMatchObject({ kind: "combined", mark: "++" });
    expect(text(rows[3] as never)).toBe("<<<<<<< HEAD");
  });

  it("stays plain past the highlight limit", () => {
    const big = "x".repeat(HIGHLIGHT_LIMIT + 1);
    const rows = diffRows(diff([line("add", "const " + big, null, 1)]), "a.ts");
    expect(classes(rows[1] as never).trim()).toBe("");
  });

  it("keeps each row's segments on its own line with CRLF and empty lines", () => {
    const rows = diffRows(diff([line("context", "const a = 1;\r", 1, 1), line("context", "", 2, 2), line("add", "const b = 2;\r", null, 3), line("context", "", 3, 4)]), "a.ts");
    expect(rows.slice(1).map((r) => text(r as never))).toEqual(["const a = 1;\r", "", "const b = 2;\r", ""]);
    expect(classes(rows[1] as never)).toContain("hljs-keyword");
  });
});
