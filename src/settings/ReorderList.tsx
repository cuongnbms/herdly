import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { dropZone } from "../sidebar/dnd";
import { CloseIcon, GripIcon } from "../ui/icons";
import { moveReply } from "./quickReplies";

/** What a row drag carries; WebKit starts a drag only when it carries data. */
const REORDER_TYPE = "application/x-herdr-reorder";

type Side = "before" | "after";
const sideOf = (e: DragEvent) => dropZone(e.currentTarget.getBoundingClientRect(), e.clientY, "session") as Side;

/** A list of strings the user can reorder by dragging a grip or with ⌥↑ / ⌥↓, and remove from. */
export function ReorderList({
  label,
  items,
  onChange,
  render,
}: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  render?: (item: string, i: number) => ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<{ i: number; side: Side } | null>(null);
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };
  /** True when the item moved. */
  const move = (from: number, target: number, side: Side) => {
    const next = moveReply(items, from, target, side);
    if (next) onChange(next);
    return next !== null;
  };
  return (
    <div role="list" aria-label={label} className="reorder-list" ref={list}>
      {items.map((item, i) => {
        const onDragOver = (e: DragEvent) => {
          if (dragging === null) return;
          const side = sideOf(e);
          if (!moveReply(items, dragging, i, side)) {
            e.dataTransfer.dropEffect = "none";
            setOver((p) => (p?.i === i ? null : p));
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setOver((p) => (p?.i === i && p.side === side ? p : { i, side }));
        };
        const drop = over?.i === i ? ` drop-${over.side}` : "";
        return (
          <div
            key={i}
            role="listitem"
            className={`reorder-row${dragging === i ? " dragging" : ""}${drop}`}
            onDragEnter={onDragOver}
            onDragOver={onDragOver}
            onDragLeave={(e) => {
              // By the pointer, not `relatedTarget`, which WebKit may leave null.
              const b = e.currentTarget.getBoundingClientRect();
              if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) return;
              setOver((p) => (p?.i === i ? null : p));
            }}
            onDrop={(e) => {
              const from = dragging;
              endDrag();
              if (from === null) return;
              e.preventDefault();
              move(from, i, sideOf(e));
            }}
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
              e.preventDefault();
              const up = e.key === "ArrowUp";
              const to = up ? i - 1 : i + 1;
              // Rows are keyed by index, so the moved item now shows in the row at `to`.
              if (move(i, to, up ? "before" : "after")) list.current?.querySelectorAll<HTMLElement>(".reorder-row .icon-btn")[to]?.focus();
            }}
          >
            <span
              className="reorder-grip"
              title="Drag to reorder"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(REORDER_TYPE, String(i));
                e.dataTransfer.effectAllowed = "move";
                const rowEl = e.currentTarget.closest<HTMLElement>(".reorder-row");
                if (rowEl) {
                  const b = rowEl.getBoundingClientRect();
                  e.dataTransfer.setDragImage(rowEl, e.clientX - b.left, e.clientY - b.top);
                }
                setDragging(i);
              }}
              onDragEnd={endDrag}
            >
              <GripIcon />
            </span>
            {render?.(item, i) ?? <span className="reorder-text">{item}</span>}
            <button className="icon-btn" aria-label={`Remove ${item}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
