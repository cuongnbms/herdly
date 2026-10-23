import { undo } from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import { canEdit, createEditorState, languageFor, roundTrips } from "./editorSetup";

const text = (t: string, over: Partial<{ editable: boolean; cksum: number | null }> = {}) => ({
  kind: "text" as const, text: t, truncated: false, size: t.length, mtime: 1, cksum: 7, editable: true, ...over,
});

describe("editorSetup", () => {
  it("keeps LF and CRLF files byte for byte", () => {
    for (const t of ["", "a", "a\nb\n", "a\r\nb\r\n", "a\r\nb", "\n\n"]) {
      expect(createEditorState(t).sliceDoc()).toBe(t);
      expect(roundTrips(t)).toBe(true);
    }
  });

  it("refuses mixed line endings and a lone CR", () => {
    expect(roundTrips("a\r\nb\nc")).toBe(false);
    expect(roundTrips("a\rb")).toBe(false);
  });

  it("can edit only editable text with a cksum that round-trips", () => {
    expect(canEdit(text("a\n"))).toBe(true);
    expect(canEdit(text("a\n", { editable: false }))).toBe(false);
    expect(canEdit(text("a\n", { cksum: null }))).toBe(false);
    expect(canEdit(text("a\r\nb\n"))).toBe(false);
    expect(canEdit({ kind: "binary", text: null, truncated: false, size: 3, mtime: 1, cksum: null, editable: false })).toBe(false);
  });

  it("finds a language by file name", async () => {
    expect(await languageFor("src/a.ts")).not.toBeNull();
    expect(await languageFor("README.md")).not.toBeNull();
    expect(await languageFor("notes.zzz")).toBeNull();
  });

  it("reads env files as properties", async () => {
    for (const rel of [".env", "app/.env.production", "env/local.env"]) {
      expect((await languageFor(rel))?.language.name, rel).toBe("properties");
    }
  });

  it("keeps a CRLF document clean when LF or CR text is inserted", () => {
    for (const [ins, want] of [["x\ny", "ax\r\nyb\r\n"], ["p\rq", "ap\r\nqb\r\n"], ["m\r\nn", "am\r\nnb\r\n"]]) {
      const s = createEditorState("ab\r\n");
      const next = s.update({ changes: { from: 1, insert: ins }, selection: { anchor: 1 + ins.length } }).state;
      expect(next.sliceDoc()).toBe(want);
      expect(roundTrips(next.sliceDoc())).toBe(true);
    }
    const s = createEditorState("ab\r\n");
    const next = s.update(s.replaceSelection("P\nQ")).state;
    expect(next.sliceDoc()).toBe("P\r\nQab\r\n");
    expect(next.selection.main.head).toBe(3);
  });

  it("undoes a normalized insert", () => {
    let st = createEditorState("ab\r\n");
    st = st.update({ changes: { from: 1, insert: "x\ny" } }).state;
    undo({ state: st, dispatch: (tr) => void (st = tr.state) });
    expect(st.sliceDoc()).toBe("ab\r\n");
  });

  it("leaves LF documents alone", () => {
    const st = createEditorState("a\n").update({ changes: { from: 1, insert: "x\ny" } }).state;
    expect(st.sliceDoc()).toBe("ax\ny\n");
  });
});
