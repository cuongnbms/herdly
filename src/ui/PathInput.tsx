import { useEffect, useRef, useState } from "react";
import { completeDirs } from "../lib/ipc";
import { dirSuggestions, splitDirPrefix } from "../lib/pathInput";

type Props = {
  /** Machine whose folders are listed. */
  machineId: string;
  /** Visible label above the field; the dropdown stays outside it so its text is not part of the name. */
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Called for keys the dropdown does not take. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
};

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Folder field with a dropdown of the folders on the Machine: ↑/↓ highlight, Tab or Enter completes the highlighted
 * folder (and lists its children), Esc closes the dropdown. With nothing highlighted, Tab moves on and Enter submits.
 */
export function PathInput({ machineId, label, value, onChange, placeholder, autoFocus, inputRef, onKeyDown, ...rest }: Props) {
  const [items, setItems] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(-1);
  // Listings by folder, so typing more of a name does not run the listing over SSH again.
  const cache = useRef(new Map<string, string[]>());
  const listRef = useRef<HTMLUListElement>(null);
  const split = splitDirPrefix(value);
  const dir = split?.dir;
  const prefix = split?.prefix ?? "";

  useEffect(() => {
    setSelected(-1);
    if (dir === undefined) {
      setItems([]);
      setLoading(false);
      return;
    }
    const hit = cache.current.get(dir);
    if (hit) {
      setItems(dirSuggestions(hit, dir, prefix));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => completeDirs(machineId, dir))
        .then((names) => {
          cache.current.set(dir, names);
          if (!cancelled) setItems(dirSuggestions(names, dir, prefix));
        })
        .catch(() => !cancelled && setItems([]))
        .finally(() => !cancelled && setLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [machineId, dir, prefix]);

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const complete = (path: string) => {
    onChange(`${path}/`);
    setOpen(true);
  };

  const dropdown = open && dir !== undefined;

  const keyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const shown = open && items.length > 0;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (!items.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSelected((i) => (i < 0 && step < 0 ? items.length - 1 : (i + step + items.length) % items.length));
    } else if ((e.key === "Tab" || e.key === "Enter") && shown && selected >= 0 && !e.shiftKey) {
      e.preventDefault();
      complete(items[selected]);
    } else if (e.key === "Escape" && dropdown) {
      e.stopPropagation();
      setOpen(false);
    } else {
      onKeyDown?.(e);
    }
  };

  const field = (
    <input
      {...rest}
      ref={inputRef}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      role="combobox"
      aria-expanded={dropdown}
      aria-autocomplete="list"
      onChange={(e) => {
        onChange(e.target.value);
        setOpen(true);
      }}
      // Not on focus: the dialogs focus the field on open, and a dropdown then would cover their buttons.
      onMouseDown={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={keyDown}
    />
  );

  return (
    <div className="path-input">
      {label ? (
        <label>
          {label}
          {field}
        </label>
      ) : (
        field
      )}
      {dropdown && (
        <ul className="path-suggestions" role="listbox" ref={listRef}>
          {items.map((p, i) => (
            <li
              key={p}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? "selected" : ""}
              // mousedown keeps focus in the input; click completes.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSelected(i)}
              onClick={() => complete(p)}
            >
              {basename(p)}/
            </li>
          ))}
          {!items.length && <li className="muted" onMouseDown={(e) => e.preventDefault()}>{loading ? "Loading…" : "No folders"}</li>}
        </ul>
      )}
    </div>
  );
}
