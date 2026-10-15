// Reads an agent's interactive prompt (Claude Code's AskUserQuestion, tool approvals, plan
// approval, unnumbered menus; pi's /model picker) off a pane's visible screen, and turns an
// answer into the keys that pick it. Adapted from herdr-web-ui's server/prompt.ts (MIT, © 2026
// devswha): only Claude's readers, pi's model picker and the fallback card are kept.

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SELECTED_RE = /^[❯›>]\s*/;
const DIVIDER_RE = /^[\s╭╮╰╯├┤┬┴┼─━═╌▔]+$/;
// several questions navigate between tabs: "Tab/Arrow keys to navigate"
const CLAUDE_ASK_HINT_RE = /enter to select.*(?:↑\/↓|tab\/arrow keys) to navigate.*esc to cancel/i;
// question tabs, whole (`←  ☒ Route  ☐ Author  ✔ Submit  →`) or cut off by a narrow pane
const CLAUDE_TABS_RE = /^←\s+[☐☒☑✔]/;
// Claude Code's unnumbered menus (the folder-trust check on a new folder, among others):
// plain rows, `❯` on the selected one, under this hint
const CLAUDE_CONFIRM_HINT_RE = /enter to confirm.*esc to (?:cancel|exit|go back)/i;
const SOLID_RULE_RE = /^[─━]{8,}$/;
const NUMBERED_OPTION_RE = /^\s*([›>❯])?\s*(\d+)\.\s+(.+)$/;

const KEY = {
  up: "up",
  down: "down",
  enter: "enter",
  escape: "esc",
  right: "right",
  backtab: "shift+tab",
} as const;

export type PromptKind = "question" | "approval" | "plan" | "menu";

export interface PromptOption {
  label: string;
  description: string | null;
}

/** A prompt as the card shows it. `id` changes whenever its content does, not when only the cursor moves. */
export interface ScreenPrompt {
  id: string;
  agent: string;
  kind: PromptKind;
  title: string;
  question: string;
  body: string | null;
  options: PromptOption[];
  multi_select: boolean;
  /** The menu row that takes typed text; it is not among `options`. */
  custom_option_index: number | null;
  /** Read by the fallback reader: a guess at the keys, not a known menu. */
  fallback?: true;
  /** Claude's "Chat about this" row: it dismisses the question for the user to talk it over. */
  chat?: true;
  /** Notes (`n` on Claude's question with previews) can ride along with an option. */
  notes?: true;
  /** The preview Claude boxes beside the cursor's option. Not part of `id`: it follows the cursor. */
  preview?: { index: number; text: string };
}

export type AnswerStep = { keys?: string[]; text?: string };
export type PromptAnswer = { option_index?: number; option_indices?: number[]; custom_text?: string; chat?: true; notes?: string };

type Responder =
  | "claude-question"
  | "claude-submit"
  | "claude-approval"
  | "claude-plan"
  | "claude-confirm"
  | "pi-model"
  | "fallback-menu"
  | "fallback-keys";

type ParsedPrompt = ScreenPrompt & {
  responder: Responder;
  selectedIndex: number;
  checkedOptionIndices: number[];
  customMenuIndex: number | null;
  /** the menu row of "Chat about this", when `chat` is offered */
  chatMenuIndex?: number;
  /** each option's own steps, for a card whose options are not rows of a menu */
  optionSteps?: AnswerStep[][];
};

type MenuRow = { label: string; selected: boolean; checked: boolean; description?: string; lineIndex: number };
type NumberedRow = MenuRow & { number: number };

const parsedByPrompt = new WeakMap<ScreenPrompt, ParsedPrompt>();

function cleanLine(rawLine: string): string {
  let line = rawLine.replace(ANSI_RE, "").trim();
  if (line.startsWith("│")) line = line.slice(1).trimStart();
  if (line.endsWith("│")) line = line.slice(0, -1).trimEnd();
  return line.trim();
}

function isDivider(line: string): boolean {
  const value = cleanLine(line);
  return Boolean(value) && DIVIDER_RE.test(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const lastOf = <T,>(list: T[]): T | undefined => list[list.length - 1];

function findLastIndex(lines: string[], predicate: (line: string, index: number) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index]!, index)) return index;
  }
  return -1;
}

/**
 * A line and the two after it, as one: a narrow pane wraps a hint line
 * (`Enter to select · ↑/↓ to navigate · Esc to` / `cancel`), so hints are matched
 * across the wrap. The last line a window matches from is where the hint begins.
 */
function wrapped(lines: string[], index: number, span = 3): string {
  return lines.slice(index, index + span).map(cleanLine).filter((line) => line && !isDivider(line)).join(" ");
}

function nearestQuestion(lines: string[], beforeIndex: number): string | null {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 14); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (!line || isDivider(line) || /^Planning:/i.test(line) || /^[←→].*Submit/i.test(line)
      || /^[☐☑✔]\s+\S/.test(line) || /^Question \d+\/\d+/i.test(line)) continue;
    return line.replace(/^\(\d+\s+selected\)\s*/i, "").trim();
  }
  return null;
}

function parseNumberedRows(lines: string[], start: number, end: number): NumberedRow[] {
  const rows: NumberedRow[] = [];
  for (let index = start; index < end; index += 1) {
    const match = lines[index]!.replace(ANSI_RE, "").trim().match(NUMBERED_OPTION_RE);
    if (!match) continue;
    let label = match[3]!.trim();
    const checked = /^\[[xX✓]\]/.test(label);
    label = label.replace(/^\[[ xX✓]\]\s*/, "").trim();
    rows.push({ number: Number.parseInt(match[2]!, 10), label, selected: Boolean(match[1]), checked, lineIndex: index });
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const nextLineIndex = rows[index + 1]?.lineIndex ?? end;
    for (let lineIndex = row.lineIndex + 1; lineIndex < nextLineIndex; lineIndex += 1) {
      const description = cleanLine(lines[lineIndex]!);
      if (!description || isDivider(description)) continue;
      row.description = description;
      break;
    }
  }
  return rows;
}

function sequentialRows(rows: NumberedRow[]): boolean {
  return rows.length > 0 && rows.every((row, index) => row.number === index + 1);
}

/** 64-bit FNV-1a as hex: a stable id for a card's content, not a security boundary. */
function hashId(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of text) {
    h ^= BigInt(ch.codePointAt(0)!);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0").slice(0, 12);
}

function finishPrompt(
  agent: string,
  input: Omit<ScreenPrompt, "id" | "agent" | "preview">,
  internal: Omit<ParsedPrompt, keyof ScreenPrompt>,
  preview?: ScreenPrompt["preview"],
): ParsedPrompt {
  // Hash all details before applying the display cap. Cursor movement is excluded (and with it
  // the preview, which follows the cursor), but a different command, plan or option description is stale.
  const id = hashId(JSON.stringify({ agent, ...input }));
  return { id, agent, ...input, body: input.body?.slice(0, 12_000) ?? null, ...(preview ? { preview } : {}), ...internal };
}

function publicPrompt(parsed: ParsedPrompt): ScreenPrompt {
  const prompt: ScreenPrompt = {
    id: parsed.id,
    agent: parsed.agent,
    kind: parsed.kind,
    title: parsed.title,
    question: parsed.question,
    body: parsed.body,
    options: parsed.options,
    multi_select: parsed.multi_select,
    custom_option_index: parsed.custom_option_index,
    ...(parsed.fallback ? { fallback: true as const } : {}),
    ...(parsed.chat ? { chat: true as const } : {}),
    ...(parsed.notes ? { notes: true as const } : {}),
    ...(parsed.preview ? { preview: parsed.preview } : {}),
  };
  parsedByPrompt.set(prompt, parsed);
  return prompt;
}

function parseClaudeQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CLAUDE_ASK_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const found = parseNumberedRows(lines, Math.max(0, hintIndex - 64), hintIndex);
  // the menu is the last run from a `1.`: a numbered list Claude printed above it is not
  const rows = found.slice(Math.max(0, found.map((row) => row.number).lastIndexOf(1)));
  if (!sequentialRows(rows) || rows.filter((row) => row.selected).length !== 1) return null;
  const chatIndex = rows.findIndex((row) => row.label === "Chat about this");
  const customIndex = rows.findIndex((row) => /^Type something\.?$/i.test(row.label));
  if (chatIndex !== rows.length - 1 || customIndex !== chatIndex - 1 || customIndex < 1) return null;
  const tabs = claudeTabs(lines, rows[0]!.lineIndex);
  const question = claudeQuestionText(lines, tabs?.index ?? -1, rows[0]!.lineIndex) ?? nearestQuestion(lines, rows[0]!.lineIndex);
  const chip = tabs === null ? claudeChip(lines, rows[0]!.lineIndex) : null;
  if (!question) return null;
  const optionRows = rows.slice(0, customIndex);
  const multiSelect = optionRows.some((row) => /^\s*(?:[›>❯]\s*)?\d+\.\s+\[[ xX✓]\]/.test(lines[row.lineIndex]!));
  return finishPrompt("claude", {
    kind: "question", title: claudeQuestionTitle(tabs, chip, multiSelect), question, body: null,
    options: optionRows.map((row) => ({ label: row.label, description: row.description ?? null })),
    multi_select: multiSelect, custom_option_index: multiSelect ? null : customIndex,
    // a multiple choice has an unnumbered Submit row on the way to it, so its row is not counted
    ...(multiSelect ? {} : { chat: true as const }),
  }, {
    responder: "claude-question",
    selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: customIndex,
    ...(multiSelect ? {} : { chatMenuIndex: chatIndex }),
  });
}

type ClaudeTabs = ReturnType<typeof claudeTabs>;

function claudeQuestionTitle(tabs: ClaudeTabs, chip: string | null, multiSelect: boolean): string {
  const current = tabs?.tabs.findIndex((tab) => !tab.answered) ?? -1;
  // a bar cut off by a narrow pane does not show how many questions there are
  return tabs && current >= 0 ? `${tabs.tabs[current]!.label}${tabs.whole && tabs.tabs.length > 1 ? ` · ${current + 1} of ${tabs.tabs.length}` : ""}`
    : chip ?? (multiSelect ? "Multiple choice" : "Question");
}

const BOX_EDGE_RE = /[┌│└]/;
const NOTES_RE = /^Notes:\s*(.*)$/;

/**
 * Claude's question whose options carry previews (Claude Code 2.1.289):
 *
 *   ❯ 1. Timeline (Recommended)       ┌────────────────┐
 *     2. Card / pill                  │ +------------+ │
 *     3. Minimal                      │ | o 09:00    | │
 *                                     └────────────────┘
 *
 *                                     Notes: press n to add notes
 *   ────────────────────
 *     Chat about this
 *   Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
 *
 * The box shows the preview of the option the cursor is on, wrapped by the pane's width; its
 * left edge is the first box character on each line, since a label takes no such character and
 * the preview's own text sits right of the edge. "Chat about this" is the menu's last row, and
 * once the cursor is there the last option it left keeps its ❯ (and its preview). While notes are
 * being typed (a note on the line, or Claude's editor hint) keys land in the note: no card.
 */
function parseClaudePreviewQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CLAUDE_ASK_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0 || !/n to add notes/i.test(wrapped(lines, hintIndex))) return null;
  if (/ctrl\+g to edit/i.test(wrapped(lines, hintIndex))) return null;
  const chatLine = findLastIndex(lines.slice(0, hintIndex), (line) => /^(?:[›>❯]\s*)?Chat about this$/.test(cleanLine(line)));
  if (chatLine < 0) return null;
  const top = Math.max(0, chatLine - 80);
  const boxTop = lines.findIndex((line, index) => index >= top && index < chatLine && NUMBERED_OPTION_RE.test(line) && line.includes("┌"));
  if (boxTop < 0) return null;
  const boxBottom = lines.findIndex((line, index) => index > boxTop && index < chatLine && /^[^│┌]*└/.test(line));
  if (boxBottom < 0) return null;
  const edge = (line: string) => line.search(BOX_EDGE_RE);
  const box = lines.slice(boxTop, boxBottom + 1);
  if (box.some((line) => edge(line) < 0)) return null;
  const notesLine = lines.slice(boxBottom + 1, chatLine).map(cleanLine).find((line) => NOTES_RE.test(line));
  if (notesLine === undefined || !/^press n to add notes$/i.test(NOTES_RE.exec(notesLine)![1]!)) return null;
  // the left column: options, and the lines a label wraps onto, with the box cut away
  const left = lines.map((line, index) => (index >= boxTop && index <= boxBottom ? line.slice(0, edge(line)) : line));
  const rowsEnd = findLastIndex(left.slice(0, chatLine), (line) => cleanLine(line) !== "" && !isDivider(line) && !NOTES_RE.test(cleanLine(line))) + 1;
  const rows = parseNumberedRows(left, boxTop, Math.max(rowsEnd, boxTop + 1));
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length > 1) return null;
  const onChat = SELECTED_RE.test(cleanLine(lines[chatLine]!));
  const cursor = rows.findIndex((row) => row.selected);
  if (cursor < 0 && !onChat) return null;
  const tabs = claudeTabs(lines, boxTop);
  const question = claudeQuestionText(lines, tabs?.index ?? -1, boxTop) ?? nearestQuestion(lines, boxTop);
  if (!question) return null;
  const content = box.slice(1, -1).map((line) => line.slice(edge(line) + 1).replace(/\s*│?\s*$/, "").replace(/^ /, ""));
  const preview = cursor < 0 ? undefined : { index: cursor, text: content.join("\n") };
  return finishPrompt("claude", {
    kind: "question", title: claudeQuestionTitle(tabs, tabs === null ? claudeChip(lines, boxTop) : null, false), question, body: null,
    // labels only: the lines under a row are the label wrapped, never a description
    options: rows.map((row) => ({
      label: normalizeText([row.label, ...left.slice(row.lineIndex + 1, rows[rows.indexOf(row) + 1]?.lineIndex ?? rowsEnd).map(cleanLine).filter(Boolean)].join(" ")),
      description: null,
    })),
    multi_select: false, custom_option_index: null, chat: true, notes: true,
  }, {
    responder: "claude-question",
    selectedIndex: onChat ? rows.length : cursor,
    checkedOptionIndices: [], customMenuIndex: null, chatMenuIndex: rows.length,
  }, preview);
}

/** A single question's header chip (`☐ Dataset`), the question's own short name; null when there is none. */
function claudeChip(lines: string[], firstRow: number): string | null {
  for (let index = firstRow - 1; index >= Math.max(0, firstRow - 40); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (isDivider(line) || CLAUDE_TABS_RE.test(line)) return null;
    const chip = /^[☐☒☑✔]\s+(\S.*)$/.exec(line);
    if (chip !== null) return chip[1]!.trim();
  }
  return null;
}

/**
 * Claude's question tabs above several questions, `←  ☒ Route  ☐ Author  ✔ Submit  →`,
 * looked for up the panel however far a long question wraps; a narrow pane can cut
 * the bar off at its right edge. ☐ is unanswered, ☒ answered, ✔ the Submit step.
 */
function claudeTabs(lines: string[], beforeIndex: number): { index: number; whole: boolean; tabs: { label: string; answered: boolean }[] } | null {
  for (let index = beforeIndex - 1; index >= Math.max(0, beforeIndex - 60); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (SOLID_RULE_RE.test(line)) return null;
    if (!CLAUDE_TABS_RE.test(line)) continue;
    const tabs = [...line.replace(/^←/, "").replace(/→$/, "").matchAll(/([☐☒☑✔])\s+(.+?)(?=\s{2,}|\s*$)/g)]
      .filter((match) => match[1] !== "✔")
      .map((match) => ({ label: match[2]!.trim(), answered: match[1] !== "☐" }));
    return { index, whole: /→$/.test(line), tabs };
  }
  return null;
}

/** The question over Claude's options, joined back when a narrow pane wraps it over several lines. */
function claudeQuestionText(lines: string[], tabsIndex: number, firstRow: number): string | null {
  const text: string[] = [];
  for (let index = firstRow - 1; index > Math.max(tabsIndex, firstRow - 30); index -= 1) {
    const line = cleanLine(lines[index]!);
    if (!line) { if (text.length > 0) break; continue; }
    // the single question's header chip (`☐ Dataset`) or the panel's top rule ends the question
    if (/^[☐☒☑✔]\s+\S/.test(line) || isDivider(line) || CLAUDE_TABS_RE.test(line)) break;
    text.unshift(line);
  }
  return text.length > 0 ? normalizeText(text.join(" ")) : null;
}

/** After several questions Claude shows the answers and asks before sending them. */
function parseClaudeSubmit(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const questionIndex = findLastIndex(lines, (line) => /^Ready to submit your answers\?$/i.test(cleanLine(line)));
  if (questionIndex < 0) return null;
  const tabsIndex = findLastIndex(lines.slice(0, questionIndex), (line) => CLAUDE_TABS_RE.test(cleanLine(line)));
  if (tabsIndex < 0 || questionIndex - tabsIndex > 40) return null;
  const rows = parseNumberedRows(lines, questionIndex + 1, lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  const body = lines.slice(tabsIndex + 1, questionIndex).map(cleanLine)
    .filter((line) => line && !isDivider(line) && !/^Review your answers$/i.test(line)).join("\n");
  return finishPrompt("claude", {
    kind: "menu", title: "Review your answers", question: cleanLine(lines[questionIndex]!), body: body || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-submit", selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null,
  });
}

function parseClaudeApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const planIndex = findLastIndex(lines, (_, index) => /Claude has written up a plan and is ready to execute\. Would you like to proceed\?/i.test(wrapped(lines, index)));
  if (planIndex >= 0) {
    const rows = parseNumberedRows(lines, planIndex + 1, lines.length);
    if (!sequentialRows(rows) || rows.length < 3 || rows.filter((row) => row.selected).length !== 1) return null;
    const customIndex = rows.findIndex((row) => /^Tell Claude what to change$/i.test(row.label));
    const bodyStart = Math.max(0, findLastIndex(lines.slice(0, planIndex), (line) => /Ready to code\?/i.test(cleanLine(line))));
    return finishPrompt("claude", {
      kind: "plan", title: "Ready to code?", question: cleanLine(lines[planIndex]!),
      body: lines.slice(bodyStart, planIndex).map(cleanLine).filter((line) => !isDivider(line)).join("\n") || null,
      options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false,
      custom_option_index: customIndex >= 0 ? customIndex : null,
    }, {
      responder: "claude-plan", selectedIndex: rows.findIndex((row) => row.selected),
      checkedOptionIndices: [], customMenuIndex: customIndex >= 0 ? customIndex : null,
    });
  }

  const requiredIndex = findLastIndex(lines, (line) => /This command requires approval/i.test(cleanLine(line)));
  const dangerousRmIndex = findLastIndex(lines, (line) => /^Dangerous rm operation\b/i.test(cleanLine(line)));
  const approvalIndex = Math.max(requiredIndex, dangerousRmIndex);
  // "Do you want to proceed?", "Do you want to create hello.txt?", "Do you want to make this edit to a.ts?"
  const questionIndex = findLastIndex(lines, (line) => /^Do you want to .+\?$/i.test(cleanLine(line)));
  if (questionIndex < 0) return null;
  // options end at the key hint: a line under the last one is then only its wrapped label
  const hintIndex = findLastIndex(lines, (_, index) => /esc to cancel/i.test(wrapped(lines, index)));
  const rows = parseNumberedRows(lines, questionIndex + 1, hintIndex > questionIndex ? hintIndex : lines.length);
  if (!sequentialRows(rows) || rows.length < 2 || rows.filter((row) => row.selected).length !== 1) return null;
  let title: string;
  let body: string;
  if (approvalIndex >= 0 && approvalIndex < questionIndex) {
    title = nearestQuestion(lines, approvalIndex) ?? "Command approval";
    const bodyEnd = dangerousRmIndex > requiredIndex ? questionIndex : approvalIndex;
    body = lines.slice(Math.max(0, approvalIndex - 8), bodyEnd).map(cleanLine).filter((line) => line && !isDivider(line)).join("\n");
  } else {
    // Claude Code 2.1 has neither marker: the panel under a solid rule opens with the
    // tool ("Bash command", "Create file"), then the command or file and its description.
    // The panel's rule is the first one under the tool call (`● Write(a.ts)`): rules further
    // down belong to a file preview; with the call scrolled away, the nearest rule.
    // Claude's own text opens with ● too ("● Results table follows:"): a call is a tool name
    // and "(" (an MCP call reads "● server - tool (MCP)(…)").
    const callIndex = findLastIndex(lines.slice(0, questionIndex), (line) => /^●\s+[\w.:-]+(?:\s[\w.:-]+)*(?:\s\(MCP\))?\(/.test(cleanLine(line)));
    const rules = lines.slice(0, questionIndex).flatMap((line, index) => index > callIndex && SOLID_RULE_RE.test(cleanLine(line)) ? [index] : []);
    const ruleIndex = callIndex >= 0 ? rules[0] ?? -1 : lastOf(rules) ?? -1;
    if (ruleIndex < 0 || questionIndex - ruleIndex > 60) return null;
    // an unattended session's auto-deny countdown ticks every second: in the id, it would make
    // every answer to the card stale
    const panel = lines.slice(ruleIndex + 1, questionIndex).map(cleanLine)
      .filter((line) => line && !isDivider(line) && !/^Tip:/i.test(line) && !/will automatically deny this request in\b/i.test(line));
    if (panel.length === 0) return null;
    title = panel[0]!;
    body = panel.slice(1).join("\n");
  }
  const rowsEnd = hintIndex > questionIndex ? hintIndex : lines.length;
  return finishPrompt("claude", {
    kind: "approval", title, question: cleanLine(lines[questionIndex]!),
    body: body || null,
    // an approval's options have no descriptions: lines under one are its label wrapped by a narrow pane
    options: rows.map((row, index) => ({
      label: normalizeText([row.label, ...lines.slice(row.lineIndex + 1, rows[index + 1]?.lineIndex ?? rowsEnd)
        .map(cleanLine).filter((line) => line && !isDivider(line))].join(" ")),
      description: null,
    })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-approval", selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null,
  });
}

/**
 * Claude Code's unnumbered menus, live in 2.1.285 on a folder it has not seen:
 *
 *   Accessing workspace:
 *   /home/user/project
 *   Quick safety check: Is this a project you created or one you trust? (Like your own code,
 *   …
 *   ❯ No, exit
 *     Yes, I trust this folder
 *   Enter to confirm · Esc to cancel
 *
 * The rows are the lines right above the hint, up to a blank line or a rule, exactly one of
 * them `❯`; numbered rows are left to the menus above.
 */
function parseClaudeConfirm(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => CLAUDE_CONFIRM_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  let end = hintIndex - 1;
  while (end >= 0 && !cleanLine(lines[end]!)) end -= 1;
  let start = end;
  while (start > 0 && cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!)) start -= 1;
  if (end < 0 || start < 0) return null;
  // A narrow pane wraps a long label onto the next line, at the label's own indent, so the
  // indent cannot tell a wrapped label from the next row. Words wrap only when the next one no
  // longer fits: a line under a row (without its own ❯) continues that row when its first word
  // would not have fitted after it. The widest line off the rows stands for the pane's width; a
  // row wider than all of them says nothing of it, and the line under it could be either, so a
  // screen like that gets no card rather than one that answers a row it does not show.
  const width = Math.max(0, ...lines.filter((_, index) => index < start || index > end).map((line) => line.trimEnd().length));
  let unsure = false;
  const wrappedFrom = (above: string, line: string): boolean => {
    if (above.trimEnd().length + 1 + (line.split(/\s+/)[0]?.length ?? 0) <= width) return false;
    if (above.trimEnd().length > width) unsure = true;
    return true;
  };
  const rows: { label: string; selected: boolean; lineIndex: number }[] = [];
  for (let index = start; index <= end; index += 1) {
    const line = cleanLine(lines[index]!);
    const selected = SELECTED_RE.test(line);
    const previous = lastOf(rows);
    if (previous && !selected && wrappedFrom(lines[index - 1]!, line)) {
      previous.label = normalizeText(`${previous.label} ${line}`);
      continue;
    }
    rows.push({ label: line.replace(SELECTED_RE, "").trim(), selected, lineIndex: index });
  }
  if (unsure) return null;
  if (rows.length < 2 || rows.length > 9 || rows.filter((row) => row.selected).length !== 1) return null;
  if (rows.some((row) => !row.label || NUMBERED_OPTION_RE.test(row.label))) return null;
  // the panel above the rows: its first line names it, a sentence ending in "?" asks
  let top = start - 1;
  while (top >= 0 && !isDivider(lines[top]!) && start - top <= 30) top -= 1;
  const panel = lines.slice(top + 1, start).map(cleanLine).filter(Boolean);
  const title = (panel[0] ?? "Choose an option").replace(/:$/, "");
  const prose = normalizeText(panel.slice(1).join(" "));
  const asked = /(?:^|[.:!]\s+)([^.:!?]*\?)/.exec(prose)?.[1]?.trim();
  return finishPrompt("claude", {
    kind: "menu", title, question: asked ?? title,
    body: panel.slice(1).join("\n") || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "claude-confirm", selectedIndex: rows.findIndex((row) => row.selected),
    checkedOptionIndices: [], customMenuIndex: null,
  });
}

/**
 * pi's `/model` picker: a filter line (`>`), the provider catalogue under it (every row names
 * its provider in brackets, `→` on the cursor's row, `✓` on the model in use), and the hint
 * `Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel`. The cursor starts on
 * the model in use, so its position is read rather than assumed.
 */
const PI_MODEL_HINT_RE = /enter to select\s*·\s*ctrl\+s to set as default\s*·\s*escape\/ctrl\+c to cancel/i;
/** The same hint told from the end, so lines that follow it cannot complete a match of their own. */
const PI_MODEL_HINT_AT_END_RE = new RegExp(`${PI_MODEL_HINT_RE.source}$`, "i");
/** pi's footer under the picker: the pane's folder, then its context meter. */
const PI_FOOTER_LINES = 2;
/** `/model` types a filter into this line, then lists what is left under it */
const PI_MODEL_FILTER_RE = /^[\u203a>\u276f]\s*$/;
/** pi ticks the model answering now, and marks the one it starts on with `· default` */
const PI_MODEL_CURRENT_RE = /[\u2713\u2714]/;
const PI_MODEL_DEFAULT_RE = /\s*\u00b7\s*default$/;
/** a row: pi's cursor, an optional tick, then the label */
const PI_ROW_RE = /^([\u2192\u276f\u279c])?\s*(?:[\u2713\u2714]\s+)?(\S.*)$/;
/** a catalogue row names the provider serving the model, in brackets */
const PI_MODEL_PROVIDER_RE = /\[[^\]]+\]/;
/** the tail of a model's name a narrow pane wrapped onto its own line: only the provider's bracket */
const PI_MODEL_TAIL_RE = /^\[[^\]]+\](\s*\u00b7\s*default)?$/;

/**
 * Whether a hint is the last thing before the agent's footer, allowing for a narrow pane
 * wrapping it over two or three lines. Anchored to the end of the joined window, so a hint
 * buried under later output no longer counts.
 */
function hintAtEnd(shown: string[], atEnd: RegExp, footerLines: number, span = 3): boolean {
  for (let end = shown.length - 1; end >= Math.max(0, shown.length - 1 - footerLines); end -= 1) {
    for (let size = 1; size <= span; size += 1) {
      const from = end - size + 1;
      if (from < 0) break;
      if (atEnd.test(shown.slice(from, end + 1).join(" "))) return true;
    }
  }
  return false;
}

/**
 * The catalogue under the filter line. pi's own notes (`Model Name: …`, `Could not refresh …`)
 * carry no bracket and end the list. A narrow pane wraps a long name and drops its bracket onto
 * the next line at column zero: that tail is joined back first. A row cut inside its bracket is
 * a list pi has not finished drawing, and voids the reading rather than invent a model.
 */
function piModelRows(lines: string[], startIndex: number): { label: string; cursor: boolean; current: boolean }[] | null {
  const rows: { label: string; cursor: boolean; current: boolean }[] = [];
  let start = startIndex;
  while (start < lines.length && !cleanLine(lines[start]!)) start += 1;
  const block: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index]!.replace(ANSI_RE, "");
    const line = cleanLine(raw);
    const previous = lastOf(block);
    if (previous !== undefined && cleanLine(previous) && !PI_MODEL_PROVIDER_RE.test(cleanLine(previous))
      && /^ {0,1}\S/.test(raw) && PI_MODEL_TAIL_RE.test(line)) {
      block[block.length - 1] = `${previous} ${line}`;
      continue;
    }
    block.push(raw);
  }
  const cutMidBracket = (line: string) => line.includes("[") && !PI_MODEL_PROVIDER_RE.test(line);
  for (const raw of block) {
    const line = cleanLine(raw);
    if (!line || isDivider(line) || PI_MODEL_HINT_RE.test(line)) break;
    const cursor = /^[\u2192\u276f\u279c]\s*\S/.test(line);
    if (!cursor && !/^ {2,}/.test(raw)) break;
    const label = line.match(PI_ROW_RE)?.[2]?.trim();
    if (!label || !PI_MODEL_PROVIDER_RE.test(label) || /\s{2,}/.test(label)) {
      if (cutMidBracket(line)) return null;
      break;
    }
    rows.push({ label, cursor, current: PI_MODEL_CURRENT_RE.test(raw) });
  }
  return rows.length >= 2 && rows.some((row) => row.cursor) ? rows : null;
}

function parsePiModel(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => PI_MODEL_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  // the filter line is the anchor: anything above it is what the pane showed before /model
  const filterIndex = findLastIndex(lines.slice(0, hintIndex), (line) => PI_MODEL_FILTER_RE.test(cleanLine(line)));
  if (filterIndex < 0) return null;
  const rows = piModelRows(lines, filterIndex + 1);
  if (rows === null) return null;
  const current = rows.find((row) => row.current);
  return finishPrompt("pi", {
    kind: "question",
    title: "Select model",
    question: current ? `Select model (currently ${current.label.replace(PI_MODEL_DEFAULT_RE, "")})` : "Select model",
    body: null,
    options: rows.map((row) => ({ label: row.label, description: null })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "pi-model", selectedIndex: rows.findIndex((row) => row.cursor),
    checkedOptionIndices: [], customMenuIndex: null,
  });
}

function promptTailIsActive(prompt: ParsedPrompt, screen: string): boolean {
  const cleanLines = screen.replace(ANSI_RE, "").split(/\r?\n/).map(cleanLine);
  const shown = cleanLines.filter((line) => line && !isDivider(line));
  const last = lastOf(shown) ?? "";
  // The menu is still at the bottom. A narrow pane wraps its hint, so the last line alone can
  // be the hint's tail (`cancel`): the lines before it count only when the match runs into
  // the last one, never for a hint that ended above later output (an answered, stale menu).
  const ends = (re: RegExp): boolean => [1, 2, 3].some((span) =>
    re.test(shown.slice(-span).join(" ")) && (span === 1 || !re.test(shown.slice(-span, -1).join(" "))));
  switch (prompt.responder) {
    case "claude-question": return ends(CLAUDE_ASK_HINT_RE);
    case "claude-submit": return /^(?:[›>❯]\s*)?\d+\.\s+Cancel$/i.test(last);
    case "claude-approval": return ends(/esc to cancel.*(?:tab|ctrl\+e)|ctrl\+e to explain/i);
    case "claude-confirm": return ends(CLAUDE_CONFIRM_HINT_RE);
    case "pi-model": return hintAtEnd(shown, PI_MODEL_HINT_AT_END_RE, PI_FOOTER_LINES);
    default: return ends(/ctrl\+g to edit|shift\+tab to approve with this feedback/i);
  }
}

// Claude's background agents panel: `⏺ main` (● off macOS), then a row per agent
const CLAUDE_AGENTS_HEAD_RE = /^[⏺●]\s+main$/;
const CLAUDE_AGENTS_ROW_RE = /^[◯◉○●⏺]\s+\S/;

/**
 * The screen without the panel Claude draws under everything while background agents run
 * (`⏺ main` and a row per agent, their counters ticking), so a prompt over it still ends the
 * screen. Only a panel that ends the screen goes.
 */
function withoutClaudeAgents(screen: string): string {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const head = findLastIndex(lines, (line) => CLAUDE_AGENTS_HEAD_RE.test(cleanLine(line)));
  if (head < 0) return screen;
  const rows = lines.slice(head + 1).map(cleanLine).filter(Boolean);
  if (rows.length === 0 || !rows.every((line) => CLAUDE_AGENTS_ROW_RE.test(line))) return screen;
  return lines.slice(0, head).join("\n");
}

function parsePrompt(agent: string, raw: string): ParsedPrompt | null {
  const screen = agent === "claude" ? withoutClaudeAgents(raw) : raw;
  const candidates = agent === "claude"
    ? [parseClaudeQuestion(screen), parseClaudePreviewQuestion(screen), parseClaudeSubmit(screen), parseClaudeApproval(screen), parseClaudeConfirm(screen)]
    : agent === "pi" ? [parsePiModel(screen)] : [];
  return candidates.find((candidate): candidate is ParsedPrompt => candidate !== null && promptTailIsActive(candidate, screen)) ?? null;
}

/** The prompt a known reader finds at the end of `screen`; null when none does. */
export function parseInteractivePrompt(agent: string, screen: string): ScreenPrompt | null {
  const parsed = parsePrompt(agent, screen);
  return parsed ? publicPrompt(parsed) : null;
}

export class InvalidAnswer extends Error {}

/**
 * The row the cursor must be on before the last key of `answer` (its Enter), or null when the
 * keys need no check. pi's model picker has no numbers to aim at and scrolls its catalogue under
 * the cursor, so a key typed in the terminal meanwhile would switch to the wrong model: what must
 * hold is the model under the cursor, by name.
 */
export function cursorTarget(prompt: ScreenPrompt, answer: PromptAnswer): string | null {
  if (parsedByPrompt.get(prompt)?.responder !== "pi-model" || answer.option_index === undefined) return null;
  return prompt.options[answer.option_index]?.label ?? null;
}

/** The label under the cursor of a prompt `cursorTarget` checks; null for any other. */
export function cursorLabel(prompt: ScreenPrompt | null): string | null {
  const parsed = prompt ? parsedByPrompt.get(prompt) : undefined;
  return parsed?.responder === "pi-model" ? (parsed.options[parsed.selectedIndex]?.label ?? null) : null;
}

/**
 * The keys that move the terminal's cursor onto option `index` of Claude's question whose
 * preview follows the cursor, so the screen shows that option's preview; null for any other prompt.
 */
export function cursorKeys(prompt: ScreenPrompt, index: number): string[] | null {
  const parsed = parsedByPrompt.get(prompt);
  if (!parsed?.notes || parsed.responder !== "claude-question" || !(index >= 0 && index < parsed.options.length)) return null;
  return navigationKeys(index - parsed.selectedIndex);
}

function navigationKeys(delta: number): string[] {
  return Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? KEY.down : KEY.up));
}

function keySteps(keys: string[]): AnswerStep[] {
  return keys.map((key) => ({ keys: [key] }));
}

/** The keys (and typed text) that give `answer` to `prompt`, moving from the row the screen's cursor is on. */
export function answerKeys(prompt: ScreenPrompt, answer: PromptAnswer): AnswerStep[] {
  const parsed = parsedByPrompt.get(prompt);
  if (!parsed) throw new InvalidAnswer("The prompt was not produced by this reader.");
  const supplied = [answer.option_index !== undefined, answer.option_indices !== undefined, answer.custom_text !== undefined, answer.chat !== undefined].filter(Boolean).length;
  if (supplied !== 1) throw new InvalidAnswer("Exactly one answer is required.");
  // notes ride along with an option, typed into the note `n` opens on the cursor's row; its Enter answers
  const notes = answer.notes === undefined ? "" : normalizeText(answer.notes);
  if (notes && (!parsed.notes || answer.option_index === undefined)) throw new InvalidAnswer("This prompt does not take notes.");

  if (answer.chat) {
    if (!parsed.chat || parsed.chatMenuIndex === undefined) throw new InvalidAnswer("This prompt has no Chat about this.");
    return keySteps([...navigationKeys(parsed.chatMenuIndex - parsed.selectedIndex), KEY.enter]);
  }

  if (answer.custom_text !== undefined) {
    const text = answer.custom_text.trim();
    if (!text || parsed.customMenuIndex === null || parsed.multi_select) throw new InvalidAnswer("This prompt does not accept a custom answer.");
    // Claude's question and plan menus type into their custom row once it is selected: no enter first
    const navigation = navigationKeys(parsed.customMenuIndex - parsed.selectedIndex);
    if (!["claude-question", "claude-plan"].includes(parsed.responder)) navigation.push(KEY.enter);
    return [
      ...keySteps(navigation),
      { text },
      ...(parsed.responder === "claude-plan" ? keySteps([KEY.backtab]) : keySteps([KEY.enter])),
    ];
  }

  if (answer.option_indices !== undefined) {
    if (!parsed.multi_select || answer.option_indices.length === 0) throw new InvalidAnswer("This prompt requires one or more selections.");
    const choices = [...new Set(answer.option_indices)];
    if (choices.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= parsed.options.length)) {
      throw new InvalidAnswer("An option index is outside the displayed range.");
    }
    const desired = new Set(choices);
    const checked = new Set(parsed.checkedOptionIndices);
    const toggles = parsed.options.flatMap((_, index) => (desired.has(index) !== checked.has(index) ? [index] : []));
    let cursor = parsed.selectedIndex;
    const keys: string[] = [];
    for (const optionIndex of toggles) {
      keys.push(...navigationKeys(optionIndex - cursor), KEY.enter);
      cursor = optionIndex;
    }
    // → leaves the choice for the next question or the review of the answers, never an
    // enter: on the next question it would pick that question's first option
    if (parsed.responder === "claude-question") keys.push(KEY.right);
    else throw new InvalidAnswer("This agent does not support multiple selections.");
    return keySteps(keys);
  }

  const index = answer.option_index!;
  if (!Number.isInteger(index) || index < 0 || index >= parsed.options.length || index === parsed.custom_option_index || parsed.multi_select) {
    throw new InvalidAnswer("A valid option index is required.");
  }
  if (parsed.optionSteps) return parsed.optionSteps[index]!;
  if (notes) return [...keySteps(navigationKeys(index - parsed.selectedIndex)), { keys: ["n"] }, { text: notes }, ...keySteps([KEY.enter])];
  return keySteps([...navigationKeys(index - parsed.selectedIndex), KEY.enter]);
}

/**
 * The last resort, for a pane herdr reports blocked that none of the readers above know (a
 * menu a new agent version draws differently, an agent without a reader): the chat must never
 * leave the user without a way to answer. It guesses as little as it can. Only a numbered menu
 * that still owns the screen's end becomes options, each answered by typing its number, so no
 * cursor position is guessed, plus Enter and Esc. Anything else shows the screen's last lines
 * with the keys its hint lines name, plus Enter and Esc.
 */
/** a question, allowing a trailing choice hint such as "(y/n)" */
const ASKED_RE = /\?\s*(?:[([][^)\]]*[)\]])?\s*$/;
/** a (y/n) hint ending its line, as a prompt does; a mention mid-sentence or quoted does not */
const YES_NO_RE = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]\s*[:?]?\s*$/i;
const ARROWS_RE = /[↑↓]|\barrow keys\b/i;
/**
 * what a menu's hint line says to do with it: a way to choose ("Enter to select", "↵ choose",
 * "Enter a number", "Type 1-3", "↑/↓ to move"). A plain Enter or Press asks for something else
 * ("Enter recovery code", "Enter your phone number", "Press any key").
 */
const MENU_HINT_RE = /\b(?:select|choose|pick|confirm|navigate|move|esc|cancel)\b|[↑↓↵⏎]|\b(?:enter|type)\s+(?:(?:a|an|the)\s+)?number\b|\b\d\s*[-–]\s*\d\b/i;
/** an input field waiting at a line's end ("Password:", "Choice: 2") */
const INPUT_FIELD_RE = /:\s*\S{0,3}$/;
/** a line that reads as a hint of its own, not a label's wrapped words ("…the selected number", "choose one") */
const HINT_LINE_RE = /^(?:[↵⏎]|(?:Press|Enter|Select|Choose|Pick|Type|Esc|ESC)\b)/;
/** how many lines the last row of a menu wraps onto, at most: more reads as output under it */
const MENU_WRAP_LINES = 2;
/** a line that is an input box or quoted output rather than a prompt's own text */
const NOT_PROMPT_TEXT_RE = /^(?:[❯›>"'“]|\$ )/;

export function parseFallbackPrompt(agent: string, screen: string): ScreenPrompt {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const shown = lines.flatMap((line, index) => (cleanLine(line) && !isDivider(line) ? [index] : []));
  const menu = fallbackMenu(lines, shown);
  if (menu) {
    const above = shown.filter((index) => index < menu.start).map((index) => cleanLine(lines[index]!));
    const question = [...above].reverse().find((line) => ASKED_RE.test(line)) ?? lastOf(above);
    // a row's number is typed alone, as a menu reading keys takes it; a program reading a whole
    // line ("Enter a number >") still waits for the Enter after it, and Esc backs out
    const choices: { label: string; steps: AnswerStep[] }[] = [
      ...menu.rows.map((row) => ({ label: row.label, steps: [{ text: String(row.number) }] })),
      { label: "Enter", steps: keySteps([KEY.enter]) },
      { label: "Esc", steps: keySteps([KEY.escape]) },
    ];
    return screenCard(lines, shown, finishPrompt(agent, {
      // the body is every other line above the rows, so a changed command above a same-looking
      // menu is another card; the display cap applies after the hash
      kind: "menu", fallback: true, title: "Waiting for your answer", question: question ?? "The agent is waiting for your answer.",
      body: withoutLine(above, question),
      options: choices.map(({ label }) => ({ label, description: null })),
      multi_select: false, custom_option_index: null,
    }, {
      responder: "fallback-menu", selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null,
      optionSteps: choices.map(({ steps }) => steps),
    }));
  }
  const last = shown.slice(-16).map((index) => cleanLine(lines[index]!));
  // letters and arrows only for the prompt's own last lines, never while an input box ends the
  // screen (the agent's composer owns the keys then) or for a line of quoted output
  const hints = NOT_PROMPT_TEXT_RE.test(lastOf(last) ?? "") ? [] : last.slice(-2).filter((line) => !NOT_PROMPT_TEXT_RE.test(line));
  const question = [...last].reverse().find((line) => ASKED_RE.test(line)) ?? lastOf(last);
  // a (y/n) letter is offered only for the prompt at the screen's end, never for a mention
  // above it; it is typed without an Enter: a program reading a whole line still waits for
  // one, and the card that follows offers it
  const choices: { label: string; steps: AnswerStep[] }[] = [
    ...(hints.some((line) => YES_NO_RE.test(line)) ? [{ label: "Yes (y)", steps: [{ text: "y" }] }, { label: "No (n)", steps: [{ text: "n" }] }] : []),
    ...(hints.some((line) => ARROWS_RE.test(line)) ? [{ label: "↑", steps: keySteps([KEY.up]) }, { label: "↓", steps: keySteps([KEY.down]) }] : []),
    { label: "Enter", steps: keySteps([KEY.enter]) },
    { label: "Esc", steps: keySteps([KEY.escape]) },
  ];
  return screenCard(lines, shown, finishPrompt(agent, {
    kind: "menu", fallback: true, title: "Waiting for input", question: question ?? "The agent is waiting for input.",
    body: withoutLine(last, question),
    options: choices.map(({ label }) => ({ label, description: null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "fallback-keys", selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null,
    optionSteps: choices.map(({ steps }) => steps),
  }));
}

/**
 * A fallback card's id covers the whole visible screen, not just the lines it shows: a changed
 * command, footer or wrapped label anywhere on it makes an answer to the old card stale.
 */
function screenCard(lines: string[], shown: number[], parsed: ParsedPrompt): ScreenPrompt {
  const screen = shown.map((index) => cleanLine(lines[index]!)).join("\n");
  parsed.id = hashId(JSON.stringify({ card: parsed.id, screen }));
  return publicPrompt(parsed);
}

/** the screen lines shown under the card's question, without the question itself */
function withoutLine(lines: string[], question: string | undefined): string | null {
  const at = question === undefined ? -1 : lines.lastIndexOf(question);
  return lines.filter((_, index) => index !== at).join("\n") || null;
}

/**
 * A numbered menu (`1.` … `n.`, 2 to 9 rows, at most one marked) that still owns the screen's
 * end: its hint, a line that says to choose, is the screen's last, and between the last row and
 * it are only the lines that row wraps onto (right under it, indented past its number). Anything
 * else there (another hint, a new prompt, an input box) may be what takes the keys now, so it is
 * no menu. A wrapped label is no guess here, since every row starts with its own number.
 */
function fallbackMenu(lines: string[], shown: number[]): { start: number; rows: NumberedRow[] } | null {
  const lastRow = [...shown].reverse().find((index) => NUMBERED_OPTION_RE.test(cleanLine(lines[index]!)));
  const hintIndex = lastOf(shown);
  if (lastRow === undefined || hintIndex === undefined || hintIndex === lastRow) return null;
  const hint = cleanLine(lines[hintIndex]!);
  // a hint that says to choose, and no input field ("Password:", "Choice: 2"): a numbered
  // list in the agent's output is not a menu
  if (!MENU_HINT_RE.test(hint) || SELECTED_RE.test(hint) || NOT_PROMPT_TEXT_RE.test(hint) || INPUT_FIELD_RE.test(hint)) return null;
  let end = lastRow + 1;
  const numberAt = lines[lastRow]!.search(/\d/);
  while (end < hintIndex && cleanLine(lines[end]!) && !isDivider(lines[end]!) && lines[end]!.search(/\S/) > numberAt) end += 1;
  if (shown.some((index) => index >= end && index < hintIndex) || end - lastRow - 1 > MENU_WRAP_LINES) return null;
  // up from the last row, through rows and the lines they wrap onto, to a blank line or a rule
  let start = lastRow;
  while (start > 0 && cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!)) start -= 1;
  while (start < lastRow && !NUMBERED_OPTION_RE.test(cleanLine(lines[start]!))) start += 1;
  const rows = parseNumberedRows(lines, start, end);
  if (!sequentialRows(rows) || rows.length < 2 || rows.length > 9 || rows.filter((row) => row.selected).length > 1) return null;
  // the lines a row wraps onto belong to its label; an input box or quote between rows, or a
  // row with its own letter key ("Read only (r)"), means the number may not be the key
  for (const [at, row] of rows.entries()) {
    const wrappedLines = lines.slice(row.lineIndex + 1, rows[at + 1]?.lineIndex ?? end).map(cleanLine).filter(Boolean);
    // a hint or an input field inside the last row's wrap may be an older prompt, with a new one under it
    if (wrappedLines.some((line) => NOT_PROMPT_TEXT_RE.test(line) || (at === rows.length - 1 && (HINT_LINE_RE.test(line) || /:\s*$/.test(line))))) return null;
    // the key may end the row's first line, with a description wrapped under it
    if ([row.label, ...wrappedLines].some((line) => /\(\w\)$/.test(line))) return null;
    row.label = [row.label, ...wrappedLines].join(" ");
  }
  return { start, rows };
}

/** The card for a blocked pane: a known reader's, else the fallback's. */
export function readPrompt(agent: string | null, screen: string): ScreenPrompt {
  return parseInteractivePrompt(agent ?? "", screen) ?? parseFallbackPrompt(agent ?? "", screen);
}
