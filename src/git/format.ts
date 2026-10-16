/** A commit's age as a compact label: "just now", "5m ago", "3h ago", "2d ago", "4w ago", "6mo ago", "2y ago". */
export function timeAgo(unixSecs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - unixSecs));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
