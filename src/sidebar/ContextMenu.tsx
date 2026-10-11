import { useEffect, useId, useRef, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import { InfoTip } from "../ui/InfoTip";
import { PathInput } from "../ui/PathInput";

export interface MenuItem {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  onSelect: () => void;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="overlay clear" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <ul className="ctx-menu" role="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
        {items.map((it) => (
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
          </li>
        ))}
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
