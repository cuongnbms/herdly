import { useState } from "react";
import { paneKeys } from "../api";
import type { WebPane } from "../types";

export function StopBar({ pane }: { pane: WebPane }) {
  const [error, setError] = useState<string | null>(null);
  const press = async (key: string) => {
    setError(null);
    try {
      await paneKeys(pane, [key]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <button type="button" onClick={() => press("esc")} style={{ minHeight: 44, minWidth: 64 }}>Esc</button>
      <button type="button" onClick={() => press("ctrl+c")} style={{ minHeight: 44, minWidth: 64 }}>Ctrl+C</button>
      {error && <span role="alert" style={{ color: "#c0392b", fontSize: 13 }}>{error}</span>}
    </div>
  );
}
