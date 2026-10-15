// Mirrors the Rust structs in src-tauri field-for-field (snake_case). Filled in by later tasks.

export interface PaneRef {
  machine_id: string;
  session: string;
  pane_id: string;
}

export interface AppError {
  code: string;
  message: string;
}

export function paneKey(ref: PaneRef): string {
  return `${ref.machine_id}/${ref.session}/${ref.pane_id}`;
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type MachineState =
  | "disconnected"
  | "authenticating"
  | "probing"
  | "connected"
  | "incompatible"
  | "error";

export interface PaneView {
  pane_id: string;
  terminal_id: string;
  title: string;
  cwd: string | null;
  agent: string | null;
  status: AgentStatus;
}

export interface TabView {
  tab_id: string;
  label: string;
  number: number;
  status: AgentStatus;
  panes: PaneView[];
}

export interface WorkspaceView {
  workspace_id: string;
  label: string;
  number: number;
  status: AgentStatus;
  tabs: TabView[];
}

export interface SessionView {
  name: string;
  running: boolean;
  status: AgentStatus;
  error: AppError | null;
  workspaces: WorkspaceView[];
}

export interface MachineView {
  id: string;
  label: string;
  /** "local" or "ssh" */
  kind: string;
  state: MachineState;
  error: AppError | null;
  version: string | null;
  /** pi's Agent dir on this Machine; null until probed. */
  pi_agent_dir?: string | null;
  /** The probe found a `pi` binary. */
  has_pi?: boolean;
  status: AgentStatus;
  sessions: SessionView[];
}

export interface PaneStatusEvent {
  pane: PaneRef;
  status: AgentStatus;
  previous: AgentStatus;
  title: string;
}

export type AttachEvent =
  | { type: "attached" }
  | { type: "held" }
  | { type: "exited"; code: number | null }
  | { type: "detached" };

export interface ImageRef { ref: string; media_type: string }
export interface SkillUse { name: string; path: string }
/** The Model, Reasoning effort and context size (tokens) the Transcript last named. */
export interface ChatMeta { model: string | null; effort: string | null; context_tokens: number | null }

/** `ts`: when the Transcript record was written (ISO 8601), if it says. */
export type ChatItem = (
  | { kind: "user"; id?: string; text: string; images?: ImageRef[]; skills?: SkillUse[] }
  | { kind: "assistant_text"; markdown: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; id: string; name: string; input_summary: string; input: unknown }
  | { kind: "tool_result"; call_id: string; output: string; is_error: boolean; images?: ImageRef[] }
  | { kind: "system"; text: string }
  | { kind: "shell_command"; command: string }
  | { kind: "shell_output"; stdout: string; stderr: string }
) & { ts?: string };

export type ChatEvent =
  | { type: "reset"; items: ChatItem[]; total: number }
  | { type: "append"; items: ChatItem[] }
  | ({ type: "meta" } & ChatMeta)
  | { type: "error"; error: AppError };

/** The folder and git branch a Pane works in (`branch` is null outside a repository). */
export interface GitStatus {
  folder: string;
  path: string;
  branch: string | null;
  dirty: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  /** How many files have any change; `changes` lists the first few. */
  changed: number;
  changes: GitChange[];
}

/** A session forked from before a user message; all null when nothing precedes it. */
export interface Forked {
  id: string | null;
  path: string | null;
  cwd: string | null;
}

export interface Located {
  agent: string;
  path: string;
  ambiguous: boolean;
  candidates: string[];
  /** The file does not exist yet: Claude writes it on the first prompt, at `path`. */
  pending: boolean;
  /** Reopened on the Pane's running tail without locating again: check it after. */
  cached?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "user" | "project" | "skill" | "plugin";
  trigger?: "$";
}

export type QuotaProvider = "claude" | "codex" | "opencodeGo" | "grok";
export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  durationSecs: number | null;
}
export type QuotaOutcome =
  | { kind: "ok"; windows: QuotaWindow[]; fetchedAt: number }
  | { kind: "notSignedIn" }
  | { kind: "signInExpired" }
  | { kind: "noSubscription" }
  | { kind: "rateLimited"; until: number }
  | { kind: "failed"; reason: string };

export interface PiModel {
  provider: string;
  id: string;
}

export interface GitChange {
  code: string;
  path: string;
}

export interface FileEntry {
  name: string;
  /** `dirlink` is a symlink to a folder: it expands like a folder. */
  kind: "file" | "dir" | "symlink" | "dirlink";
}
export interface FileContent {
  kind: "text" | "binary" | "image";
  text: string | null;
  truncated: boolean;
  size: number;
  mtime: number;
  /** Set only for text read whole. */
  cksum: number | null;
  /** Text, read whole, valid UTF-8. */
  editable: boolean;
}
/** A file's disk version; `files_write` checks it before saving. */
export interface FileVersion {
  size: number;
  mtime: number;
  cksum: number;
}
export interface FileList {
  paths: string[];
  capped: boolean;
  refused: boolean;
}

export interface FileChange {
  path: string;
  isDir: boolean;
  removed: boolean;
}

export type WatchEvent = { type: "resync" } | { type: "changes"; changes: FileChange[] } | { type: "error"; message: string };

/** Streamed from `chat_btw_ask`; `done` always carries a non-empty fork id. */
export type BtwEvent =
  | { kind: "delta"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "started"; fork_id: string }
  | { kind: "done"; fork_id: string; cache_read: number; input: number }
  | { kind: "error"; message: string };
