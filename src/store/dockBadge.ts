import { bucketCounts, dashboardCards } from "../dashboard/buckets";
import { setDockBadge } from "../lib/ipc";
import { useApp, type AppState } from "./app";

type SetBadge = (count: number | undefined) => Promise<void>;

/** Keeps the Dock icon's badge at the number of Agents that need the user: Blocked plus unseen
 *  Done, counted as the Agent Dashboard counts them. No badge at zero. Returns the unsubscribe. */
export function syncDockBadge(set: SetBadge = setDockBadge): () => void {
  let shown: number | null = null;
  const sync = (s: AppState) => {
    const counts = bucketCounts(dashboardCards(s.machines, s.order, s.doneSeen));
    const n = counts.blocked + counts.done;
    if (n === shown) return;
    shown = n;
    set(n > 0 ? n : undefined).catch((e: unknown) => console.warn("dock badge failed", e));
  };
  sync(useApp.getState());
  return useApp.subscribe(sync);
}
