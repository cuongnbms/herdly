import { useEffect, useId, useRef, useState } from "react";
import { MoreIcon } from "../ui/icons";

/** A tab action stays next to the row it acts on, without a permanent close button. */
export function TabMenu({ label, disabled, onClose }: { label: string; disabled: boolean; onClose(): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  const id = useId();
  const shown = open && !disabled;
  useEffect(() => {
    if (!shown) return;
    item.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [shown]);
  const dismiss = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return <div ref={root} className="sidebar-tab-actions"
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && shown) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    }}>
    <button ref={trigger} type="button" className="icon-btn sidebar-tab-more" aria-label={`Tab actions for ${label}`}
      aria-haspopup="menu" aria-expanded={shown} aria-controls={shown ? id : undefined} disabled={disabled}
      onClick={() => setOpen(!open)} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}><MoreIcon /></button>
    {shown && <div id={id} className="sidebar-tab-menu" role="menu" aria-label={`Tab actions for ${label}`}>
      <button ref={item} type="button" role="menuitem" onClick={() => { dismiss(); onClose(); }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); item.current?.focus(); }
        }}>Close tab</button>
    </div>}
  </div>;
}
