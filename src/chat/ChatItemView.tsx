import { memo, useContext, useState } from "react";
import Markdown from "react-markdown";
import type { ChatItem } from "../lib/types";
import { BrainIcon, ChevronIcon, ForkIcon } from "../ui/icons";
import { CopyButton } from "./CopyButton";
import { mdComponents, rehypePlugins, remarkPlugins } from "./markdown";
import { checklist, checklistSummary, type ChecklistRow } from "./checklist";
import { ChatImages, ChatPaneContext } from "./images";
import { openInFiles } from "./fileLinks";
import { SkillChips } from "./skills";
import { toolIcon } from "./toolIcon";

type ToolResult = Extract<ChatItem, { kind: "tool_result" }>;

function lines(s: string): string[] {
  return s === "" ? [] : s.split("\n");
}

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <pre className="chat-diff">
      {lines(oldText).map((l, i) => (
        <div key={`o${i}`} className="diff-del">{`- ${l}`}</div>
      ))}
      {lines(newText).map((l, i) => (
        <div key={`n${i}`} className="diff-add">{`+ ${l}`}</div>
      ))}
    </pre>
  );
}

const str = (v: unknown): v is string => typeof v === "string";

/** Edit, MultiEdit and Write inputs as diffs; null when the input is not an edit. */
function diffsFor(input: Record<string, unknown>) {
  if (str(input.old_string) && str(input.new_string)) return [{ o: input.old_string, n: input.new_string }];
  if (Array.isArray(input.edits)) {
    const d = (input.edits as Record<string, unknown>[])
      .filter((e) => e && str(e.old_string) && str(e.new_string))
      .map((e) => ({ o: e.old_string as string, n: e.new_string as string }));
    if (d.length) return d;
  }
  if (str(input.file_path) && str(input.content)) return [{ o: "", n: input.content }];
  return null;
}

const MARK: Record<ChecklistRow["status"], string> = { completed: "☑", in_progress: "◐", pending: "☐" };

function Checklist({ rows }: { rows: ChecklistRow[] }) {
  return (
    <ul className="chat-checklist" aria-label="Todos">
      {rows.map((r, i) => (
        <li key={i} className={r.status}>
          <span className="chat-checklist-mark" aria-hidden="true">{MARK[r.status]}</span>
          <span>{r.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** The call's summary; when it names the file the tool works on, ⌘-click opens that file in Files. */
function ToolSummary({ summary, input }: { summary: string; input: Record<string, unknown> }) {
  const pane = useContext(ChatPaneContext);
  const file = str(input.file_path) ? input.file_path : str(input.path) ? input.path : null;
  // The summary is the path itself, cut to 120 chars with a `…` when longer.
  const named = !!file && (summary === file || (summary.endsWith("…") && file.startsWith(summary.slice(0, -1))));
  if (!pane || !file || !named) return <span className="chat-tool-summary">{summary}</span>;
  return (
    <span
      role="link"
      className="chat-tool-summary chat-file-link"
      title="⌘-click to open in Files"
      onClick={(e) => {
        // A plain click falls through to the row and toggles it.
        if (!e.metaKey) return;
        e.stopPropagation();
        void openInFiles(pane, file);
      }}
    >
      {summary}
    </span>
  );
}

function ToolCallView({ item, result }: { item: Extract<ChatItem, { kind: "tool_call" }>; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  const input = (item.input ?? {}) as Record<string, unknown>;
  const ToolIcon = toolIcon(item.name);
  const todos = checklist(item.input);
  if (todos) {
    return (
      <div className="chat-tool">
        <button className="chat-tool-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChevronIcon className={"icon chev" + (open ? " open" : "")} />
          <ToolIcon className="icon chat-tool-icon" />
          <span className="chat-tool-name">{item.name}</span>
          <span className="chat-tool-sep"> · </span>
          <span className="chat-tool-summary">{checklistSummary(todos)}</span>
        </button>
        {open && (
          <div className="chat-tool-body">
            <Checklist rows={todos} />
            {/* The list is the input; a successful answer only says so again. */}
            {result?.is_error && <pre className="chat-result error">{result.output}</pre>}
          </div>
        )}
      </div>
    );
  }
  const diffs = diffsFor(input);
  return (
    <div className="chat-tool">
      <button className="chat-tool-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronIcon className={"icon chev" + (open ? " open" : "")} />
        <ToolIcon className="icon chat-tool-icon" />
        <span className="chat-tool-name">{item.name}</span>
        <span className="chat-tool-sep"> · </span>
        <ToolSummary summary={item.input_summary} input={input} />
      </button>
      {open && (
        <div className="chat-tool-body">
          {diffs?.map((d, i) => <Diff key={i} oldText={d.o} newText={d.n} />)}
          {result ? (
            <>
              {!!result.images?.length && <ChatImages images={result.images} />}
              <pre className={result.is_error ? "chat-result error" : "chat-result"}>{result.output}</pre>
            </>
          ) : (
            !diffs && <div className="chat-dim">No result yet</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Shell output past this many lines folds behind a "Show more" button. */
const SHELL_FOLD_LINES = 12;

function ShellText({ text, error }: { text: string; error?: boolean }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const hidden = all ? 0 : Math.max(0, lines.length - SHELL_FOLD_LINES);
  return (
    <>
      <pre className={error ? "chat-result error" : "chat-result"}>{hidden ? lines.slice(0, SHELL_FOLD_LINES).join("\n") : text}</pre>
      {hidden > 0 && (
        <button className="chat-shell-more" onClick={() => setAll(true)}>
          Show {hidden} more {hidden === 1 ? "line" : "lines"}
        </button>
      )}
    </>
  );
}

/** `copy`: offer a copy button on a user message or an answer (not on narration inside a work block). */
export const ChatItemView = memo(function ChatItemView({
  item,
  result,
  copy = false,
  onFork,
  onForkLatest,
  forking = false,
}: {
  item: ChatItem;
  result?: ToolResult;
  copy?: boolean;
  /** Fork the conversation from before this user message; the button shows only for a user item with an id. */
  onFork?: (item: { id: string; text: string }) => void;
  /** Fork the conversation from its latest entry on; the button shows only on an answer. */
  onForkLatest?: () => void;
  /** This message's fork is running: the button is disabled until it ends. */
  forking?: boolean;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="chat-row chat-user">
          {!!item.images?.length && <ChatImages images={item.images} />}
          {item.text !== "" && (
            <div className="chat-user-line">
              <div className="chat-bubble">{item.text}</div>
              {copy && <CopyButton text={item.text} />}
              {onFork && item.id && (
                <button
                  type="button"
                  className="chat-copy chat-fork"
                  aria-label="Fork from here"
                  title="Fork from here"
                  disabled={forking}
                  aria-busy={forking || undefined}
                  onClick={() => onFork({ id: item.id!, text: item.text })}
                >
                  <ForkIcon />
                </button>
              )}
            </div>
          )}
          {!!item.skills?.length && <SkillChips chips={item.skills.map((s) => ({ name: s.name, path: s.path, status: "loaded" }))} />}
        </div>
      );
    case "assistant_text":
      return (
        <div className="chat-row chat-assistant">
          <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>{item.markdown}</Markdown>
          {(copy || onForkLatest) && (
            <div className="chat-actions">
              {copy && <CopyButton text={item.markdown} />}
              {onForkLatest && (
                <button
                  type="button"
                  className="chat-copy chat-fork"
                  aria-label="Fork from latest"
                  title="Fork from latest"
                  disabled={forking}
                  aria-busy={forking || undefined}
                  onClick={onForkLatest}
                >
                  <ForkIcon />
                </button>
              )}
            </div>
          )}
        </div>
      );
    case "thinking":
      return (
        <details className="chat-row chat-thinking">
          <summary><BrainIcon className="icon chat-thinking-icon" />Thinking…</summary>
          <div className="chat-dim">{item.text}</div>
        </details>
      );
    case "tool_call":
      return (
        <div className="chat-row">
          <ToolCallView item={item} result={result} />
        </div>
      );
    case "tool_result":
      return (
        <div className="chat-row">
          {!!item.images?.length && <ChatImages images={item.images} />}
          <pre className={item.is_error ? "chat-result error" : "chat-result"}>{item.output}</pre>
        </div>
      );
    case "system":
      return <div className="chat-row chat-system">{item.text}</div>;
    case "shell_command":
      return (
        <div className="chat-row chat-user">
          <div className="chat-user-line">
            <div className="chat-bubble chat-shell-command"><span className="chat-shell-bang">!</span>{item.command}</div>
            {copy && <CopyButton text={item.command} />}
          </div>
        </div>
      );
    case "shell_output":
      return (
        <div className="chat-row chat-shell-output">
          {item.stdout !== "" && <ShellText text={item.stdout} />}
          {item.stderr !== "" && <ShellText text={item.stderr} error />}
        </div>
      );
  }
});
