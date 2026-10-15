/**
 * Chat lens rows. Adapted from herdr-web-ui's `workBlocks.ts`: everything an Agent did on the
 * way through a turn (tool calls, thinking and the narration between them) folds under one
 * "Worked for 7s · 1 edit" block, and only what it said after its last action stays open as
 * the answer.
 */
import type { ChatItem } from "../lib/types";
import { checklist } from "./checklist";

export type ToolCall = Extract<ChatItem, { kind: "tool_call" }>;
export type ToolResult = Extract<ChatItem, { kind: "tool_result" }>;

export interface WorkBlock {
  /** The turn's opener ts, else the first call's id: open/closed must survive new and older items. */
  id: string;
  /** In order, without the results that render inside their call. */
  items: ChatItem[];
  start: string | null;
  end: string | null;
}

export type ChatRow =
  | { kind: "item"; key: string; /** absolute index of the row's first item */ at: number; item: ChatItem }
  | { kind: "work"; key: string; at: number; block: WorkBlock; /** in the newest turn */ last: boolean };

function blockId(items: ChatItem[]): string {
  for (const it of items) {
    if (it.kind === "tool_call") return it.id;
    if (it.kind === "tool_result") return it.call_id;
  }
  const first = items[0];
  return `${first.kind}:${first.ts ?? ""}:${first.kind === "thinking" ? first.text.slice(0, 64) : ""}`;
}

/** What the user or the CLI put in the chat rather than the Agent: each opens a turn. */
function opensTurn(it: ChatItem): boolean {
  return it.kind === "user" || it.kind === "system" || it.kind === "shell_command" || it.kind === "shell_output";
}

/** Splits loaded items into rows; a user, system or shell item opens a turn. `offset` is the absolute index of `items[0]`, so item keys survive prepends and trims. */
export function buildRows(items: ChatItem[], offset = 0): { rows: ChatRow[]; results: Map<string, ToolResult> } {
  const calls = new Set<string>();
  const results = new Map<string, ToolResult>();
  for (const it of items) {
    if (it.kind === "tool_call") calls.add(it.id);
    else if (it.kind === "tool_result") results.set(it.call_id, it);
  }

  const rows: ChatRow[] = [];
  let lastBlock = -1;
  let opener: ChatItem | null = null;
  let body: ChatItem[] = [];
  let bodyAt: number[] = [];
  const flush = () => {
    let lastAction = -1;
    body.forEach((it, i) => {
      if (it.kind !== "assistant_text") lastAction = i;
    });
    const work = body.slice(0, lastAction + 1);
    const shown = work.filter((it) => it.kind !== "tool_result" || !calls.has(it.call_id));
    if (shown.length > 0) {
      const end = [...work].reverse().find((it) => it.ts)?.ts ?? null;
      const start = opener?.ts ?? work.find((it) => it.ts)?.ts ?? null;
      // By turn when its opener is loaded, so a live block keeps its id as its first call lands.
      const id = opener?.ts ? `turn:${opener.ts}` : blockId(shown);
      lastBlock = rows.length;
      rows.push({ kind: "work", key: `w:${id}`, at: bodyAt[body.indexOf(shown[0])], block: { id, items: shown, start, end }, last: false });
    }
    for (let i = lastAction + 1; i < body.length; i++) rows.push({ kind: "item", key: `i:${bodyAt[i]}`, at: bodyAt[i], item: body[i] });
    body = [];
    bodyAt = [];
  };
  items.forEach((it, index) => {
    if (opensTurn(it)) {
      flush();
      lastBlock = -1;
      opener = it;
      rows.push({ kind: "item", key: `i:${offset + index}`, at: offset + index, item: it });
    } else {
      body.push(it);
      bodyAt.push(offset + index);
    }
  });
  flush();
  const tail = rows[lastBlock];
  if (tail?.kind === "work") rows[lastBlock] = { ...tail, last: true };
  return { rows, results };
}

/** An open block's rows: narration, thinking and lone calls as they are, runs of calls folded. */
export type WorkSegment = { kind: "item"; item: ChatItem } | { kind: "calls"; calls: ToolCall[] };

/**
 * Folds each run of two or more calls into one "4 commands" line, so the narration between
 * them reads as the turn's spine. A todo list is the plan and stays out; in a live block the
 * run still arriving stays open until narration or thinking follows it.
 */
export function groupCalls(items: ChatItem[], live: boolean): WorkSegment[] {
  const segments: WorkSegment[] = [];
  let run: ToolCall[] = [];
  const close = (trailing: boolean) => {
    if (run.length >= 2 && !(trailing && live)) segments.push({ kind: "calls", calls: run });
    else for (const call of run) segments.push({ kind: "item", item: call });
    run = [];
  };
  for (const it of items) {
    if (it.kind === "tool_call" && checklist(it.input) === null) {
      run.push(it);
      continue;
    }
    close(false);
    segments.push({ kind: "item", item: it });
  }
  close(true);
  return segments;
}

type Category = "edit" | "read" | "command" | "other";
const LABELS: Record<Category, [string, string]> = {
  edit: ["edit", "edits"],
  read: ["file read", "file reads"],
  command: ["command", "commands"],
  other: ["other tool", "other tools"],
};

function categorize(name: string): Category {
  const lower = name.toLowerCase();
  if (/edit|write|patch|create_file/.test(lower)) return "edit";
  if (/^(read|glob|grep|ls|list|search|find|cat)/.test(lower)) return "read";
  if (/bash|command|shell|exec|eval|run/.test(lower)) return "command";
  return "other";
}

/** "1 edit · 2 file reads · 1 command · 1 failed": the block header after its title. */
export function workSummary(items: ChatItem[], results: Map<string, ToolResult>): string {
  const counts: Record<Category, number> = { edit: 0, read: 0, command: 0, other: 0 };
  let failed = 0;
  for (const it of items) {
    if (it.kind === "tool_result" && it.is_error) failed++;
    if (it.kind !== "tool_call") continue;
    const call: ToolCall = it;
    // A todo list is the plan, not an edit, though TodoWrite matches /write/.
    if (checklist(call.input) === null) counts[categorize(call.name)]++;
    if (results.get(call.id)?.is_error) failed++;
  }
  const parts = (Object.keys(counts) as Category[])
    .filter((c) => counts[c] > 0)
    .map((c) => `${counts[c]} ${LABELS[c][counts[c] === 1 ? 0 : 1]}`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/** "7s" / "1m 12s" / "1h 5m"; null when either time is unknown or the span is nonsense. */
export function formatWorkDuration(start: string | null, end: string | null): string | null {
  if (start === null || end === null) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
