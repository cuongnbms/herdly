import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { COLUMNS, useSidebarWidths, type Column } from "../settings/sidebarWidths";

const KEY_STEP = 16;

/** A strip on a column's right edge: drag to resize, double-click for the default width, arrows to step. */
export function ResizeHandle({ column, label }: { column: Column; label: string }) {
  const width = useSidebarWidths((s) => s[column]);
  const setWidth = useSidebarWidths((s) => s.setWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const { min, max, def } = COLUMNS[column];

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.body.classList.add("col-resizing");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(column, drag.current.w + e.clientX - drag.current.x);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.body.classList.remove("col-resizing");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? KEY_STEP : e.key === "ArrowLeft" ? -KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    setWidth(column, width + step);
  };

  return (
    <div
      className="col-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => setWidth(column, def)}
      onKeyDown={onKeyDown}
    />
  );
}
