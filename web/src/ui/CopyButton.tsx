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
    <button type="button" className={className ? `copy-btn ${className}` : "copy-btn"} onClick={onClick}>
      {label}
    </button>
  );
}
