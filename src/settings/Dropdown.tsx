import { type CSSProperties, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronIcon } from "../ui/icons";

/** Matches `.pick-list` max-height in styles.css. */
const LIST_MAX = 240;
/** Suggestions shown at once; typing narrows the rest. */
const SUGGEST_MAX = 50;

/**
 * Where the popup list sits: fixed under its field, so the scrolling pane does not clip it, or above the field
 * when the window has no room below.
 */
function usePlace(anchor: RefObject<HTMLElement | null>, open: boolean): CSSProperties | undefined {
  const [place, setPlace] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!open || !r) return setPlace(undefined);
    const below = window.innerHeight - r.bottom;
    const up = below < LIST_MAX + 8 && r.top > below;
    setPlace({ left: r.left, width: r.width, ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  }, [anchor, open]);
  return place;
}

/** Closes the popup when anything but the list scrolls, since a fixed list would stay behind. */
function useCloseOnScroll(open: boolean, list: RefObject<HTMLElement | null>, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => e.target !== list.current && latest.current();
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open, list]);
}

function PickList({
  id,
  label,
  items,
  hi,
  selected,
  place,
  listRef,
  empty,
  render,
  onHover,
  onPick,
}: {
  id: string;
  label: string;
  items: string[];
  hi: number;
  selected?: string;
  place: CSSProperties | undefined;
  listRef: RefObject<HTMLUListElement | null>;
  empty?: string;
  render: (item: string) => ReactNode;
  onHover: (i: number) => void;
  onPick: (item: string) => void;
}) {
  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView?.({ block: "nearest" });
  }, [hi, listRef]);
  return (
    <ul className="pick-list" role="listbox" id={id} aria-label={label} ref={listRef} style={place}>
      {items.length === 0 && empty && (
        <li className="pick-empty" role="presentation">
          {empty}
        </li>
      )}
      {items.map((item, i) => (
        <li
          key={item}
          id={`${id}-${i}`}
          role="option"
          aria-selected={item === selected}
          className={i === hi ? "hi" : undefined}
          onMouseEnter={() => onHover(i)}
          // mousedown keeps focus in the field, so blur does not close the list first.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
        >
          {render(item)}
        </li>
      ))}
    </ul>
  );
}

/** A select-only combobox with the app's own list instead of the native menu. */
export function SelectMenu({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const field = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const place = usePlace(field, open);
  useCloseOnScroll(open, list, () => setOpen(false));
  const values = options.map((o) => o.value);
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const show = () => {
    setHi(Math.max(0, values.indexOf(value)));
    setOpen(true);
  };
  const pick = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };
  return (
    <>
      <button
        ref={field}
        type="button"
        className="select-menu"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={open ? `${id}-${hi}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              show();
            }
            return;
          }
          if (e.key === "ArrowDown") setHi((i) => Math.min(i + 1, values.length - 1));
          else if (e.key === "ArrowUp") setHi((i) => Math.max(i - 1, 0));
          else if ((e.key === "Enter" || e.key === " ") && values[hi] !== undefined) pick(values[hi]);
          else if (e.key === "Escape") {
            // Close just the list; the dialog closes on the next Escape.
            e.stopPropagation();
            setOpen(false);
          } else return;
          e.preventDefault();
        }}
      >
        <span className="select-menu-value">{labelOf(value)}</span>
        <ChevronIcon />
      </button>
      {open && (
        <PickList id={id} label={label} items={values} hi={hi} selected={value} place={place} listRef={list} render={labelOf} onHover={setHi} onPick={pick} />
      )}
    </>
  );
}

/**
 * A text field with the app's own suggestion list instead of `<datalist>`. ↑/↓ highlight a suggestion and Enter
 * submits it; with none highlighted, Enter submits the typed text. Esc closes just the list.
 */
export function SuggestInput({
  value,
  onChange,
  onSubmit,
  suggestions,
  render = (s) => s,
  placeholder,
  "aria-label": label,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void;
  suggestions: string[];
  render?: (s: string) => ReactNode;
  placeholder?: string;
  "aria-label": string;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const place = usePlace(field, open);
  useCloseOnScroll(open, list, () => setOpen(false));
  const q = value.trim().toLowerCase();
  const items = suggestions.filter((s) => s.toLowerCase().includes(q)).slice(0, SUGGEST_MAX);
  const shown = open && items.length > 0;
  const submit = (text: string) => {
    setOpen(false);
    setHi(-1);
    onSubmit(text);
  };
  return (
    <>
      <input
        ref={field}
        className="input"
        role="combobox"
        aria-label={label}
        aria-expanded={shown}
        aria-controls={id}
        aria-autocomplete="list"
        aria-activedescendant={shown && hi >= 0 ? `${id}-${hi}` : undefined}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setHi(-1);
          setOpen(true);
        }}
        onMouseDown={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            if (!items.length) return;
            const step = e.key === "ArrowDown" ? 1 : -1;
            setHi((i) => (i < 0 && step < 0 ? items.length - 1 : (i + step + items.length) % items.length));
          } else if (e.key === "Enter") {
            e.preventDefault();
            submit(shown && hi >= 0 ? items[hi] : value);
          } else if (e.key === "Escape" && shown) {
            // Close just the list; the dialog closes on the next Escape.
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {shown && <PickList id={id} label={label} items={items} hi={hi} place={place} listRef={list} render={render} onHover={setHi} onPick={submit} />}
    </>
  );
}
