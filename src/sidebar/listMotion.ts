import { useLayoutEffect, useRef, useState } from "react";

const ENTER_MS = 200;
const EXIT_MS = 160;
const MOVE_MS = 200;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

export interface MotionRow<T> {
  item: T;
  key: string;
  leaving: boolean;
}

function canAnimate(): boolean {
  return typeof Element !== "undefined" && typeof Element.prototype.animate === "function"
    && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Rows that open in when added, fold away before they are removed, and slide to a new place instead of jumping there.
 *  A removed item stays in the returned rows (`leaving`) until its exit has played; `ref(key)` goes on each row's element.
 *  `shown` is false while the list is not on screen, so reopening it does not replay every row's entrance. */
export function useListMotion<T>(items: T[], keyOf: (item: T) => string, shown: boolean) {
  const motion = canAnimate();
  const els = useRef(new Map<string, HTMLElement>());
  const anims = useRef(new Map<string, { a: Animation; move: boolean }>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const exited = useRef(new Set<string>());
  const prevRows = useRef<MotionRow<T>[]>([]);
  const wasShown = useRef(false);
  const [, rerender] = useState(0);

  // Where each row is on screen right now (mid-animation included), before this render moves anything.
  const before = new Map<string, number>();
  for (const [k, el] of els.current) before.set(k, el.getBoundingClientRect().top);

  const rows: MotionRow<T>[] = items.map((item) => ({ item, key: keyOf(item), leaving: false }));
  if (motion && shown) {
    const live = new Set(rows.map((r) => r.key));
    prevRows.current.forEach((r, i) => {
      if (live.has(r.key) || exited.current.has(r.key)) return;
      rows.splice(Math.min(i, rows.length), 0, { ...r, leaving: true });
    });
  }
  for (const k of exited.current) if (!rows.some((r) => r.key === k)) exited.current.delete(k);
  prevRows.current = rows;

  useLayoutEffect(() => {
    const animated = motion && wasShown.current;
    wasShown.current = shown;
    if (!animated) return;
    const play = (key: string, el: HTMLElement, frames: Keyframe[], ms: number, move: boolean, done?: () => void) => {
      anims.current.get(key)?.a.cancel();
      if (!move) el.style.overflow = "hidden";
      // A finished exit holds its folded frame until the rerender takes the row out, or it would flash back for a frame.
      const a = el.animate(frames, { duration: ms, easing: EASE, fill: done ? "forwards" : "none" });
      anims.current.set(key, { a, move });
      a.onfinish = () => {
        if (!move) el.style.overflow = "";
        if (anims.current.get(key)?.a === a) anims.current.delete(key);
        done?.();
      };
    };
    const open = (key: string, el: HTMLElement, from: number) => {
      const h = el.getBoundingClientRect().height;
      play(key, el, [{ height: `${from}px`, opacity: from / (h || 1) }, { height: `${h}px`, opacity: 1 }], ENTER_MS, false);
    };
    // Enter and exit first: they change the rows' heights, which the moves below are measured after.
    const moved: [string, HTMLElement][] = [];
    for (const r of rows) {
      const el = els.current.get(r.key);
      if (!el) continue;
      if (r.leaving) {
        if (el.dataset.leaving) continue;
        el.dataset.leaving = "1";
        const h = el.getBoundingClientRect().height;
        play(r.key, el, [{ height: `${h}px`, opacity: 1 }, { height: "0px", opacity: 0 }], EXIT_MS, false, () => {
          exited.current.add(r.key);
          rerender((n) => n + 1);
        });
      } else if (!before.has(r.key)) {
        open(r.key, el, 0);
      } else if (el.dataset.leaving) {
        // Came back while folding away: open it up again from wherever it had got to.
        delete el.dataset.leaving;
        const from = el.getBoundingClientRect().height;
        anims.current.get(r.key)?.a.cancel();
        open(r.key, el, from);
      } else {
        moved.push([r.key, el]);
      }
    }
    for (const [key, el] of moved) {
      // A slide still running is restarted from where the row is now; an entrance keeps going.
      const running = anims.current.get(key);
      if (running && !running.move) continue;
      running?.a.cancel();
      const dy = before.get(key)! - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 1) play(key, el, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], MOVE_MS, true);
    }
  });

  // One callback per key, so React does not detach and reattach every row's ref on each render.
  const ref = (key: string) => {
    let cb = refs.current.get(key);
    if (!cb) {
      cb = (el) => {
        if (el) return void els.current.set(key, el);
        els.current.delete(key);
        anims.current.delete(key);
        refs.current.delete(key);
      };
      refs.current.set(key, cb);
    }
    return cb;
  };
  return { rows, ref };
}
