import { highlightLines, type Seg } from "../files/highlightLines";
import { HIGHLIGHT_LIMIT } from "../files/limits";
import type { DiffLine, FileDiff } from "../lib/types";

export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "context" | "add" | "del" | "combined"; oldNo: number | null; newNo: number | null; mark: string; segs: Seg[] }
  | { kind: "note"; text: string };

const MARKS = { context: " ", add: "+", del: "-" } as const;

/** Segments of one side, one entry per line; a line whose segments do not add back up to it is plain. */
function highlightSide(lines: string[], path: string, plain: boolean): Seg[][] {
  const segs = plain || lines.length === 0 ? [] : highlightLines(lines.join("\n"), path);
  return lines.map((l, i) => {
    const s = segs[i];
    return s && s.map((x) => x.text).join("") === l ? s : [{ text: l, cls: "" }];
  });
}

/** Display rows of a diff. Each hunk side is highlighted as one text, so tokens spanning lines survive. */
export function diffRows(diff: FileDiff, path: string): DiffRow[] {
  let total = 0;
  for (const h of diff.hunks) for (const l of h.lines) total += l.text.length;
  const plain = total > HIGHLIGHT_LIMIT;

  const rows: DiffRow[] = [];
  for (const hunk of diff.hunks) {
    rows.push({ kind: "hunk", text: hunk.header });
    const oldSide = hunk.lines.filter((l) => l.kind === "context" || l.kind === "del");
    const newSide = hunk.lines.filter((l) => l.kind === "context" || l.kind === "add");
    const oldSegs = new Map<DiffLine, Seg[]>();
    const newSegs = new Map<DiffLine, Seg[]>();
    const oldHl = highlightSide(oldSide.map((l) => l.text), path, plain);
    const newHl = highlightSide(newSide.map((l) => l.text), path, plain);
    oldSide.forEach((l, i) => oldSegs.set(l, oldHl[i]));
    newSide.forEach((l, i) => newSegs.set(l, newHl[i]));

    for (const l of hunk.lines) {
      if (l.kind === "combined") {
        rows.push({ kind: "combined", oldNo: l.old_no, newNo: l.new_no, mark: l.text.slice(0, 2), segs: [{ text: l.text.slice(2), cls: "" }] });
      } else {
        const segs = (l.kind === "del" ? oldSegs : newSegs).get(l) ?? [{ text: l.text, cls: "" }];
        rows.push({ kind: l.kind, oldNo: l.old_no, newNo: l.new_no, mark: MARKS[l.kind], segs });
      }
      if (l.no_newline) rows.push({ kind: "note", text: "No newline at end of file" });
    }
  }
  return rows;
}
