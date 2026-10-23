import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  LanguageDescription,
  type LanguageSupport,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { search, searchKeymap } from "@codemirror/search";
import { ChangeSet, Compartment, EditorSelection, EditorState, type Extension, type Transaction } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import type { FileContent } from "../lib/types";
import { isEnvFile } from "./envFile";

/** FileEditor fills this once the file's language has loaded. */
export const languageSlot = new Compartment();

/** Token colours come from the app's --hl-* variables, as the viewer's highlight.js classes do. */
const appHighlight = HighlightStyle.define([
  { tag: [t.comment, t.docComment], color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.null, t.bool, t.atom, t.self], color: "var(--hl-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted], color: "var(--hl-string)" },
  { tag: [t.number, t.integer, t.float, t.character, t.escape], color: "var(--hl-number)" },
  { tag: [t.heading, t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName), t.labelName, t.tagName], color: "var(--hl-title)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: "var(--hl-type)" },
  { tag: [t.propertyName, t.attributeName, t.variableName, t.special(t.variableName), t.macroName], color: "var(--hl-attr)" },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: "var(--hl-meta)" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, textDecoration: "underline" },
]);

/** The view-side extensions; they are facets, so they work on a state without a view. */
export function editorExtensions(): Extension {
  return [
    lineNumbers(),
    bracketMatching(),
    highlightActiveLine(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    syntaxHighlighting(appHighlight, { fallback: true }),
  ];
}

const BREAK = /\r\n|\r|\n/g;

/**
 * In a CRLF document inserted text is split on CRLF only, so a pasted LF or CR would stay inside a
 * line and mix endings on save. This turns every inserted LF / CR into a real line break.
 */
function crlfOnly(tr: Transaction): Transaction | { changes: ChangeSet; selection?: EditorSelection; effects: Transaction["effects"]; scrollIntoView: boolean } {
  if (!tr.docChanged) return tr;
  const state = tr.startState, sep = "\r\n";
  let dirty = false;
  const edits: { from: number; to: number; fromB: number; toB: number; insert: string }[] = [];
  tr.changes.iterChanges((from, to, fromB, toB, inserted) => {
    const raw = inserted.sliceString(0, inserted.length, "\n");
    for (let n = 1; n <= inserted.lines && !dirty; n++) if (/[\r\n]/.test(inserted.line(n).text)) dirty = true;
    edits.push({ from, to, fromB, toB, insert: raw.replace(BREAK, sep) });
  });
  if (!dirty) return tr;
  const changes = ChangeSet.of(
    edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
    tr.startState.doc.length,
    sep,
  );
  const mapPos = (p: number) => {
    let delta = 0;
    for (const e of edits) {
      const len = state.toText(e.insert).length;
      if (p >= e.toB) delta += len - (e.toB - e.fromB);
      else {
        if (p > e.fromB) {
          const prefix = tr.state.doc.sliceString(e.fromB, p, "\n").replace(BREAK, sep);
          delta += state.toText(prefix).length - (p - e.fromB);
        }
        break;
      }
    }
    return p + delta;
  };
  const selection = tr.selection
    ? EditorSelection.create(
        tr.selection.ranges.map((r) => EditorSelection.range(mapPos(r.anchor), mapPos(r.head))),
        tr.selection.mainIndex,
      )
    : undefined;
  return { changes, selection, effects: tr.effects, scrollIntoView: tr.scrollIntoView };
}

/** The only place an `EditorState` is made. Its line separator is CRLF iff the text has one. */
export function createEditorState(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      text.includes("\r\n") ? [EditorState.lineSeparator.of("\r\n"), EditorState.transactionFilter.of(crlfOnly)] : [],
      history(),
      languageSlot.of([]),
      editorExtensions(),
    ],
  });
}

/** True when the editor gives back exactly `text`: LF or CRLF throughout, no lone CR, no mix. */
export function roundTrips(text: string): boolean {
  const state = createEditorState(text);
  if (state.sliceDoc() !== text) return false;
  // With a CRLF separator a bare LF stays inside a line and would still round-trip, yet it is a mix.
  for (let n = 1; n <= state.doc.lines; n++) if (/[\r\n]/.test(state.doc.line(n).text)) return false;
  return true;
}

export function canEdit(c: FileContent): boolean {
  return c.editable && c.cksum !== null && c.text !== null && roundTrips(c.text);
}

export async function languageFor(rel: string): Promise<LanguageSupport | null> {
  const description = isEnvFile(rel)
    ? LanguageDescription.matchLanguageName(languages, "properties")
    : LanguageDescription.matchFilename(languages, rel.slice(rel.lastIndexOf("/") + 1));
  return description ? description.load() : null;
}
