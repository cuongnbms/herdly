import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { findMatches, wrapIndex, type FindQuery, type FindStatus, type Match } from "./find";
import { highlightLines, splitLines, type Seg } from "./highlightLines";

export const DEFAULT_LINE_H = 20;

export function lineHeight(el: HTMLElement | null): number {
  if (!el) return DEFAULT_LINE_H;
  const raw = getComputedStyle(el).getPropertyValue("--files-line-h");
  const px = parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : DEFAULT_LINE_H;
}

/** Renders one line's segments, wrapping each match range in a <mark>. */
function renderLine(segs: Seg[], matches: Match[], currentStart: number | null): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  let m = 0;
  segs.forEach((seg, si) => {
    const segEnd = pos + seg.text.length;
    let at = pos;
    while (at < segEnd) {
      while (m < matches.length && matches[m].end <= at) m++;
      const match = matches[m];
      if (!match || match.start >= segEnd) {
        out.push(<span key={`${si}:${at}`} className={seg.cls || undefined}>{seg.text.slice(at - pos)}</span>);
        at = segEnd;
      } else if (match.start > at) {
        out.push(<span key={`${si}:${at}`} className={seg.cls || undefined}>{seg.text.slice(at - pos, match.start - pos)}</span>);
        at = match.start;
      } else {
        const end = Math.min(match.end, segEnd);
        const current = currentStart === match.start;
        out.push(
          <mark key={`${si}:${at}`} className={current ? "files-match current" : "files-match"}>
            <span className={seg.cls || undefined}>{seg.text.slice(at - pos, end - pos)}</span>
          </mark>,
        );
        at = end;
      }
    }
    pos = segEnd;
  });
  return out;
}

/**
 * Remembers where a scrolled view of `path` was: `onScroll` only writes a ref (scrolling
 * re-renders nothing), and the position is saved once, for the path it belongs to, when the
 * view unmounts. Mount one view per path (a `key`).
 */
export function useScrollMemory(path: string, initialScroll: number, saveScroll: (path: string, top: number) => void) {
  const last = useRef({ path, top: initialScroll });
  const save = useRef(saveScroll);
  save.current = saveScroll;
  useLayoutEffect(
    () => () => {
      const { path, top } = last.current;
      save.current(path, top);
    },
    [],
  );
  return (e: { currentTarget: HTMLElement }) => {
    last.current = { path, top: e.currentTarget.scrollTop };
  };
}

interface Props {
  text: string;
  path: string;
  initialScroll: number;
  /** A 1-based line to show instead of the remembered position (a `#L12` link). */
  initialLine?: number | null;
  /** Called once with the path and its last scroll position when the file is left. */
  saveScroll(path: string, top: number): void;
  /** `index` is the number of steps taken from the first match on screen; it wraps here. */
  find: FindQuery | null;
  /** Told the match count and the current match whenever either changes. */
  onFindStatus?(status: FindStatus): void;
}

/** One mount per file, so the virtualizer starts at the file's own offset. */
export function TextView(props: Props) {
  return <FileText key={props.path} {...props} />;
}

function FileText({ text, path, initialScroll, initialLine, saveScroll, find, onFindStatus }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => highlightLines(text, path), [text, path]);
  const plain = useMemo(() => splitLines(text), [text]);
  const query = find?.query ?? null;
  const matchCase = find?.matchCase ?? false;
  const matches = useMemo(() => (query ? findMatches(plain, query, matchCase) : []), [plain, query, matchCase]);
  const byLine = useMemo(() => {
    const map = new Map<number, Match[]>();
    for (const m of matches) {
      const list = map.get(m.line);
      if (list) list.push(m);
      else map.set(m.line, [m]);
    }
    return map;
  }, [matches]);
  const [rowH, setRowH] = useState(DEFAULT_LINE_H);
  // A new search starts at the first match whose line is wholly on screen, so it begins where
  // you are reading; the start then stays put while you scroll and step.
  const start = useRef({ key: "", base: 0 });
  const searchKey = query ? `${matchCase ? 1 : 0}${query}` : "";
  if (start.current.key !== searchKey) {
    const top = Math.ceil((scrollRef.current?.scrollTop ?? 0) / rowH);
    const at = matches.findIndex((m) => m.line >= top);
    start.current = { key: searchKey, base: at < 0 ? 0 : at };
  }
  const currentIndex = find && matches.length > 0 ? wrapIndex(start.current.base, find.index, matches.length) : 0;
  const current = find && matches.length > 0 ? matches[currentIndex] : null;
  const report = useRef(onFindStatus);
  report.current = onFindStatus;
  useEffect(() => report.current?.({ count: matches.length, index: currentIndex }), [matches.length, currentIndex]);

  // The ref is only attached after the first render, so the CSS var is read here.
  useLayoutEffect(() => setRowH(lineHeight(scrollRef.current)), []);
  const virt = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 20,
    // The first render already lays out the rows at the remembered position.
    initialOffset: initialScroll,
  });

  // estimateSize is not part of the virtualizer's measurement cache key, so re-measure on change.
  useLayoutEffect(() => virt.measure(), [rowH]);

  const onScroll = useScrollMemory(path, initialScroll, saveScroll);
  // The element itself starts at the top; move it to where the virtualizer already is.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = initialScroll;
  }, []);
  useEffect(() => {
    if (initialLine && initialLine > 0) virt.scrollToIndex(Math.min(initialLine, lines.length) - 1, { align: "start" });
  }, [rowH]);

  // `find.index` counts steps (it is not wrapped), so stepping onto the same match, as with
  // a single match, scrolls back to it. The starting match is often on screen already, and
  // then the view stays where it is.
  useEffect(() => {
    if (current) virt.scrollToIndex(current.line, { align: find?.index ? "center" : "auto" });
  }, [current?.line, current?.start, find?.index]);

  const gutter = `${String(lines.length).length + 1}ch`;

  return (
    <div ref={scrollRef} className="files-text" onScroll={onScroll}>
      <div className="files-text-body" style={{ height: virt.getTotalSize(), position: "relative" }}>
        {virt.getVirtualItems().map((row) => (
          <div
            key={row.index}
            className="files-line"
            style={{ position: "absolute", top: 0, left: 0, height: rowH, transform: `translateY(${row.start}px)` }}
          >
            <span className="files-gutter" style={{ minWidth: gutter }} data-line={row.index + 1} />
            <span className="files-code">
              {renderLine(lines[row.index], byLine.get(row.index) ?? [], current && current.line === row.index ? current.start : null)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
