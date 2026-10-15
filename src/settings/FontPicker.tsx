import { useEffect, useId, useRef, useState } from "react";
import { filterFonts, loadFontFamilies } from "./store";

/** Searchable combobox over the installed monospace fonts; each option previews in its own face. */
export function FontPicker({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc?: string;
  value: string;
  onChange: (f: string) => void;
}) {
  const [all, setAll] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let live = true;
    void loadFontFamilies().then((f) => live && setAll(f));
    return () => {
      live = false;
    };
  }, []);

  const shown = filterFonts(all, query);

  useEffect(() => {
    listRef.current?.children[hi]?.scrollIntoView?.({ block: "nearest" });
  }, [hi, open]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const pick = (f: string) => {
    onChange(f);
    close();
  };

  return (
    <div className="setting-row">
      <div className="setting-label">
        <span id={`${listId}-label`}>{label}</span>
        {desc && <p className="setting-desc">{desc}</p>}
      </div>
      <div className="font-picker">
        <input
          role="combobox"
          aria-labelledby={`${listId}-label`}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[hi] ? `${listId}-${hi}` : undefined}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={open ? query : value}
          placeholder={value}
          style={{ fontFamily: open ? undefined : `"${value}", monospace` }}
          onFocus={() => {
            setOpen(true);
            setHi(Math.max(0, all.indexOf(value)));
          }}
          onBlur={close}
          onChange={(e) => {
            setOpen(true);
            setQuery(e.target.value);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (!open) {
              if (e.key === "ArrowDown" || e.key === "Enter") setOpen(true);
              return;
            }
            if (e.key === "ArrowDown") setHi((i) => Math.min(i + 1, shown.length - 1));
            else if (e.key === "ArrowUp") setHi((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && shown[hi]) pick(shown[hi]);
            else if (e.key === "Escape") {
              // Close just the list; the dialog closes on the next Escape.
              e.stopPropagation();
              close();
            } else return;
            e.preventDefault();
          }}
        />
        {open && (
          <ul className="font-list" role="listbox" id={listId} ref={listRef} aria-label={label}>
            {shown.length === 0 && <li className="font-empty" role="presentation">No matching fonts</li>}
            {shown.map((f, i) => (
              <li
                key={f}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={f === value}
                className={i === hi ? "hi" : undefined}
                style={{ fontFamily: `"${f}", monospace` }}
                onMouseEnter={() => setHi(i)}
                // mousedown keeps focus in the input, so blur does not close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(f);
                }}
              >
                {f}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
