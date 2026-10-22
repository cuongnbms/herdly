import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronIcon } from "../ui/icons";

export function SessionSelect({ value, options, onChange }: {
  value: string;
  options: string[];
  onChange(value: string): void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(value);
  const activeIndex = Math.max(0, options.indexOf(active));

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, id]);

  function choose(name: string) {
    onChange(name);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = !open ? Math.max(0, options.indexOf(value)) : activeIndex;
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : !open ? index : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      setActive(options[next]);
      setOpen(true);
    } else if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      choose(options[activeIndex]);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  return <div ref={root} className="session-select" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <label id={`${id}-label`} htmlFor={id}>Session</label>
    <button id={id} type="button" role="combobox" className="session-select-trigger"
      aria-labelledby={`${id}-label`} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={`${id}-list`} aria-activedescendant={open ? `${id}-option-${activeIndex}` : undefined}
      onKeyDown={onKeyDown} onClick={() => { setActive(value); setOpen(!open); }}>
      <span className="session-select-name" title={value}>{value}</span><ChevronIcon />
    </button>
    {open && <div id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} className="session-select-menu">
      {options.map((name, index) => <div key={name} id={`${id}-option-${index}`} role="option"
        aria-selected={name === value} className="session-select-option" data-active={index === activeIndex}
        onPointerMove={() => setActive(name)} onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(name)}>
        <span className="session-select-name" title={name}>{name}</span>
        <span className="session-select-check" aria-hidden="true">{name === value ? "✓" : ""}</span>
      </div>)}
    </div>}
  </div>;
}
