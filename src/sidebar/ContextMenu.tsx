import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import { InfoTip } from "../ui/InfoTip";
import { PathInput } from "../ui/PathInput";

export interface MenuItem {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  onSelect: () => void;
  /** Starts a new group: a line is drawn above it. */
  group?: boolean;
}

type Size = { w: number; h: number };
const EDGE = 4;

/** Opens down-right of the pointer, flipping up or left where the window has no room, and never past its edges. */
export function placeMenu(x: number, y: number, menu: Size, view: Size) {
  const up = y + menu.h > view.h - EDGE && y - menu.h >= EDGE;
  const leftward = x + menu.w > view.w - EDGE && x - menu.w >= EDGE;
  const clamp = (v: number, size: number, max: number) => Math.max(EDGE, Math.min(v, max - size - EDGE));
  return {
    left: clamp(leftward ? x - menu.w : x, menu.w, view.w),
    top: clamp(up ? y - menu.h : y, menu.h, view.h),
    up,
    leftward,
  };
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<ReturnType<typeof placeMenu> | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  // Measured before paint, so a menu near the bottom never shows cut off first.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPlace(placeMenu(x, y, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }));
  }, [x, y, items]);
  const style = place
    ? { left: place.left, top: place.top, transformOrigin: `${place.up ? "bottom" : "top"} ${place.leftward ? "right" : "left"}` }
    : { left: x, top: y };
  return (
    <div className="overlay clear" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <ul ref={ref} className="ctx-menu" role="menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
        {items.map((it, i) => [
          it.group && i > 0 && <li key={`${it.label}-sep`} role="separator" className="ctx-menu-sep" />,
          <li key={it.label} role="none">
            <button
              role="menuitem"
              onClick={() => {
                onClose();
                it.onSelect();
              }}
            >
              <it.icon />
              {it.label}
            </button>
          </li>,
        ])}
      </ul>
    </div>
  );
}

export function Modal({ title, titleExtra, children, onClose }: {
  title: string;
  /** Shown after the title, outside the dialog's name. */
  titleExtra?: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}{titleExtra}</h3>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p>{message}</p>
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-danger"
          autoFocus
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function TextDialog({
  title,
  initial,
  submitLabel,
  folderOn,
  hint,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  submitLabel: string;
  /** Machine whose folders the field suggests, for a folder path. */
  folderOn?: string;
  /** What the value is for, behind an ⓘ next to the title. */
  hint?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const describedBy = hint ? hintId : undefined;
  useEffect(() => ref.current?.select(), []);
  const submit = () => {
    onClose();
    onSubmit(value);
  };
  return (
    <Modal title={title} titleExtra={hint && <InfoTip id={hintId} text={hint} />} onClose={onClose}>
      {folderOn ? (
        <PathInput
          machineId={folderOn}
          inputRef={ref}
          autoFocus
          value={value}
          aria-label={title}
          aria-describedby={describedBy}
          onChange={setValue}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      ) : (
        <input
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          ref={ref}
          autoFocus
          value={value}
          aria-label={title}
          aria-describedby={describedBy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      )}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit}>{submitLabel}</button>
      </div>
    </Modal>
  );
}
