import { useEffect, useRef } from "react";
import type { AgentStatus } from "@desktop/lib/types";
import { VIBRATE_MS } from "./config";
import { useWeb } from "./store";
import { webKey, type MachineView } from "./types";

function paneStatuses(machines: MachineView[]): Map<string, AgentStatus> {
  const out = new Map<string, AgentStatus>();
  for (const m of machines)
    for (const s of m.sessions)
      for (const w of s.workspaces)
        for (const t of w.tabs)
          for (const p of t.panes) out.set(webKey({ session: s.name, pane_id: p.pane_id }), p.status);
  return out;
}

/** Keys of every blocked Pane, whatever its agent. */
export function blockedPanes(machines: MachineView[]): string[] {
  return [...paneStatuses(machines)].filter(([, status]) => status === "blocked").map(([key]) => key);
}

/** Tab title shows how many Panes are blocked; the phone buzzes when a known Pane turns blocked. */
export function useAttention(): void {
  const machines = useWeb((s) => s.machines);
  const seen = useRef<Map<string, AgentStatus>>(new Map());
  useEffect(() => {
    const now = paneStatuses(machines);
    const n = blockedPanes(machines).length;
    document.title = n > 0 ? `(${n}) Herdly` : "Herdly";
    const turned = [...now].some(([key, status]) => {
      const before = seen.current.get(key);
      return before !== undefined && before !== "blocked" && status === "blocked";
    });
    if (turned) {
      try {
        navigator.vibrate?.(VIBRATE_MS);
      } catch {
        // vibration is a nicety
      }
    }
    seen.current = now;
  }, [machines]);
}
