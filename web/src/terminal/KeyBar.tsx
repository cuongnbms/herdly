import type { ReactNode } from "react";

export type LogicalKey = "escape" | "tab" | "up" | "down" | "left" | "right";

/**
 * The touch key bar. It reports logical keys and never encodes them: the lens resolves arrows
 * against the terminal's current cursor-key mode and routes everything through the same
 * user-entry boundary as typing. Taps leave focus where it was, so browsing the bar does not
 * open or close the mobile keyboard.
 */
export function KeyBar({
  disabled,
  ctrl,
  onCtrl,
  onKey,
  actions,
}: {
  disabled: boolean;
  ctrl: boolean;
  onCtrl(): void;
  onKey(key: LogicalKey): void;
  actions?: ReactNode;
}) {
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const keys: { key: LogicalKey; label: string; text: string }[] = [
    { key: "escape", label: "Esc", text: "Esc" },
    { key: "tab", label: "Tab", text: "Tab" },
    { key: "up", label: "Arrow up", text: "↑" },
    { key: "down", label: "Arrow down", text: "↓" },
    { key: "left", label: "Arrow left", text: "←" },
    { key: "right", label: "Arrow right", text: "→" },
  ];
  return (
    <div className="term-keys" role="toolbar" aria-label="Terminal keys">
      <div className="term-keys-scroll">
        {keys.slice(0, 2).map((k) => (
          <button
            key={k.key}
            type="button"
            className="term-key"
            aria-label={k.label}
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={() => onKey(k.key)}
          >
            {k.text}
          </button>
        ))}
        <button
          type="button"
          className="term-key term-key-ctrl"
          aria-label="Ctrl"
          aria-pressed={ctrl}
          disabled={disabled}
          onMouseDown={keepFocus}
          onClick={onCtrl}
        >
          Ctrl
        </button>
        {keys.slice(2).map((k) => (
          <button
            key={k.key}
            type="button"
            className="term-key"
            aria-label={k.label}
            disabled={disabled}
            onMouseDown={keepFocus}
            onClick={() => onKey(k.key)}
          >
            {k.text}
          </button>
        ))}
      </div>
      {actions}
    </div>
  );
}
