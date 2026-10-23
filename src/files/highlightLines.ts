import { common, createLowlight } from "lowlight";
import { isEnvFile } from "./envFile";
import { HIGHLIGHT_LIMIT } from "./limits";

/** One run of text in a line; `cls` is the space-joined `hljs-*` classes, "" for plain. */
export type Seg = { text: string; cls: string };

const lowlight = createLowlight(common);

type HNode = {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HNode[];
};

function plainLines(text: string): Seg[][] {
  return splitLines(text).map((l) => [{ text: l, cls: "" }]);
}

/** `text` cut into lines as the viewer shows them: a trailing newline ends the last line. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Highlights `text` and cuts it into lines. A token that spans lines (block comment,
 * template string) keeps its classes on every line. Unknown languages and text over
 * HIGHLIGHT_LIMIT come back as one plain segment per line.
 */
export function highlightLines(text: string, path: string): Seg[][] {
  const ext = isEnvFile(path) ? "ini" : extOf(path);
  if (text.length > HIGHLIGHT_LIMIT || !ext || !lowlight.registered(ext)) return plainLines(text);

  const lines: Seg[][] = [[]];
  const walk = (node: HNode, classes: string[]) => {
    if (node.type === "text") {
      const cls = classes.join(" ");
      const parts = (node.value ?? "").split("\n");
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1].push({ text: part, cls });
      });
    } else if (node.type === "element" || node.type === "root") {
      const names = node.properties?.className;
      const next = Array.isArray(names) ? [...classes, ...names.map(String)] : classes;
      for (const child of node.children ?? []) walk(child, next);
    }
  };
  walk(lowlight.highlight(ext, text) as HNode, []);

  // A trailing newline ends the last line rather than starting an empty one.
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines.map((l) => (l.length ? l : [{ text: "", cls: "" }]));
}
