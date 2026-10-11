# Herdly

A desktop client for [herdr](https://github.com/herdrdev/herdr) that browses and drives agent panes on the local computer and on remote computers.

## Language

**Machine**:
A computer where herdr runs: either `local` or a remote one reached by an SSH target (an alias from `~/.ssh/config` or `user@host`).
_Avoid_: host, PC, server, remote

**Session**:
A named persistent herdr session on a Machine; it owns exactly one herdr socket and is either running or stopped.
_Avoid_: server, instance

**Workspace**:
A group of Tabs inside a Session. What the user calls a "space".
_Avoid_: space, project

**Workspace folder**:
The folder the app remembers for a Workspace; Agents started from the app's UI run in a new Tab there. herdr itself does not know it.
_Avoid_: project dir, workspace cwd

**Group**:
A named, nestable set of Sessions the user arranges in the sidebar; it can hold Sessions from any Machine. herdr itself does not know it.
_Avoid_: folder, project

**Bookmark**:
A Session the user pinned to the top of the sidebar, independent of which Group it is in.
_Avoid_: favourite, pin

**Tab**:
A layout of Panes inside a Workspace.

**Pane**:
One cell of a Tab's layout, identified by `pane_id`; the unit the user selects and views.

**Terminal**:
The live terminal stream behind a Pane, identified by `terminal_id`; the thing that gets attached.
_Avoid_: pty, shell

**Attach**:
An exclusive connection to a Terminal's stream; herdr allows only one at a time per Terminal.

**Agent**:
A coding agent (Claude Code, pi, ...) that herdr detects running in a Pane, with an agent status of `working`, `blocked`, `done`, `idle` or `unknown`.

**Slash command**:
A command an Agent runs when a message starts with it (`/compact`, or `$name` for a Codex skill): a built-in, a user or project command, or a skill, including a plugin's.
_Avoid_: shortcut, macro

**Skill**:
A packaged set of instructions an Agent loads for a task, invoked by the user (as a Slash command) or by the Agent itself.
_Avoid_: plugin, extension

**Lens**:
A way of viewing a Pane: the **Terminal lens** (the raw attached terminal) or the **Chat lens** (the Agent's Transcript as a conversation).
_Avoid_: mode, view

**Files panel**:
The file tree of one Workspace under the agent list, following the active Open item, rooted at its Workspace folder (else the selected Pane's cwd). It reads files, creates, renames and deletes files and folders, and moves files in by Upload and out by Download; it never overwrites an item (editing a file's content is the File viewer's **Edit mode**).
_Avoid_: files overlay, file browser

**Open item**:
An Agent's Pane or a file the user opened, shown as a tab in the **Open strip** above the main area, across all Machines and Sessions.
_Avoid_: tab (a herdr Tab is a layout of Panes), editor

**File viewer**:
The main area's view of the active file Open item.
_Avoid_: file lens (a Lens views a Pane)

**Edit mode**:
The File viewer's editor for a text file, entered with Edit and left with Done. Save writes only when the file on disk is still the version the edit started from; otherwise the user picks Reload or Overwrite.
_Avoid_: editor view, write mode

**Draft**:
The unsaved content of one file Open item in Edit mode, based on one version of the file on disk. It survives switching Open items, and is never replaced by the Files watch while it differs from that version.
_Avoid_: buffer, unsaved file

**Files watch**:
The live feed of changes under the Files panel's root (`inotifywait`, a `find` poll loop, or FSEvents) that reloads the open file and the loaded folders of the tree. One at a time, owned by the Files panel.
_Avoid_: watcher (herdr's session watcher), polling

**Transcript**:
The Agent's own conversation file (`.jsonl`) that the Chat lens reads.
_Avoid_: history, log

**Parked tail**:
The live reading of a Transcript kept after its Chat lens closed, so reopening that Chat lens resumes it instead of reading the Transcript again.
_Avoid_: cached chat, background tail

**Frozen tail**:
What is kept of a Transcript's reading after it stopped (pushed out of the Parked tails, or cut by a dropped connection), so reopening that Chat lens reads on from where it stopped instead of from the start.
_Avoid_: dead tail, snapshot

**Reading position**:
Where the user was in a Chat lens's Transcript when it closed; reopening it returns there unless they were at the latest message.
_Avoid_: scroll position, bookmark

**Fork**:
A new Agent in a new Tab whose Transcript is a copy of another's, cut just before one of its user messages; that message's text waits in the new Agent's Composer. The original Agent is unchanged.
_Avoid_: branch, clone (pi's `/fork` and `/clone` act inside one Agent; a git fork is a repository)

**Side question**:
A question asked beside an Agent's Transcript, from the Composer's btw mode: a separate `claude -p` process answers it from a fork of the Transcript, so the Agent and its Transcript are untouched. Follow-ups continue that fork; closing the card deletes it.
_Avoid_: btw (only as the UI label), side chat, aside

**Provider**:
The service an Agent's account belongs to (Claude, Codex, OpenCode Go, Grok); it owns a Quota.
_Avoid_: vendor, model

**Model**:
The language model an Agent answers with, as its Transcript records it (`claude-opus-5-5`); one Provider offers many.
_Avoid_: provider, engine

**Reasoning effort**:
How hard the Model is set to think, as the Transcript records it (`high`, `off`); never inferred.
_Avoid_: thinking level, effort mode

**Quota**:
How much of a Provider account's usage allowance is used, read on this Mac only. It belongs to the Provider, never to a Machine or an Agent.
_Avoid_: usage, limit, credits

**Window**:
One rolling or calendar period of a Quota (`5h`, `week`, `month`) with a used percent and a Reset.

**Reset**:
The moment a Window's used percent goes back to zero.

## Relationships

- A **Machine** has zero or more **Sessions**
- A **Session** is in at most one **Group**; a **Group** has zero or more **Sessions** and **Groups**; a Session may also be a **Bookmark**
- A running **Session** has one or more **Workspaces**; a **Workspace** has one or more **Tabs**; a **Tab** has one or more **Panes**
- Each **Pane** has exactly one **Terminal**
- A **Pane** has at most one **Agent**; an **Agent** has at most one **Transcript** the app can find
- A **Terminal** has at most one **Attach** at a time
- A **Chat lens** has at most one open **Side question** thread per **Pane**
- A **Provider** has one **Quota**; a **Quota** has one or more **Windows**, each with at most one **Reset**

## Example dialogue

> **Dev:** "When the user clicks a **Pane** on devtuf, do we **Attach** right away?"
> **Domain expert:** "Only in the **Terminal lens**. If the **Agent** is Claude Code and we find its **Transcript**, the **Chat lens** opens and nothing is attached."

## Flagged ambiguities

- "space" (user's word) resolved: it is herdr's **Workspace**.
- "session" means a herdr named **Session**, never an agent's conversation; that is a **Transcript**.
