import { useEffect, useRef, useState } from "react";
import { COPIED_MS } from "../config";
import { copyText } from "./copy";

type Label = "Copy" | "Copied" | "Copy failed";

export function CopyButton({ text, className }: { text: string | (() => string); className?: string }) {
  const [label, setLabel] = useState<Label>("Copy");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = () => {
    const ok = copyText(typeof text === "function" ? text() : text);
    setLabel(ok ? "Copied" : "Copy failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLabel("Copy"), COPIED_MS);
  };

  return (
    <button
      type="button"
      className={className ? `copy-btn ${className}` : "copy-btn"}
      data-state={label === "Copied" ? "success" : label === "Copy failed" ? "error" : "idle"}
      onClick={onClick}
    >
      <span className="copy-btn-content">
        <svg className="copy-btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {label === "Copied" ? <path d="m5 12 4 4L19 6" /> : label === "Copy failed" ? <path d="m7 7 10 10M17 7 7 17" /> : <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>}
        </svg>
        <span role="status" aria-live="polite" aria-atomic="true">{label}</span>
      </span>
    </button>
  );
}
