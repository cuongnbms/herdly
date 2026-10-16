# 0010: The Git view is read-only

> Status: Accepted · Date: 2026-10-16

## Context

The Git view shows a Workspace's repository: its uncommitted changes, its commits, and the diff
of each file. VS Code's Source Control view, which it is modelled on, also stages, discards and
commits. Agents work in the same repositories at the same time and run git themselves; a
discard from the app removes work that exists nowhere else, and a commit or stage from the app
changes the index under an Agent that is about to commit.

Source: [design spec](../superpowers/specs/2026-10-16-git-view-design.md).

## Decision

- The Git view and the Diff viewer run only git commands that read: `rev-parse`, `status`,
  `log`, `diff`, `diff-tree`. No `add`, `restore`, `checkout`, `reset`, `commit`, `stash`,
  `fetch`, `pull` or `push`, from any button or menu.
- Every read passes `--no-optional-locks`, so even `git status` never takes the index lock an
  Agent's git may need.
- Changing the repository stays with the Agent or the Terminal.

## Consequences

- The user cannot stage a hunk or discard a file from the app; they ask the Agent or use a
  Terminal.
- Reads can race an Agent's commit and show a state one step old; the next refresh corrects it.
- Adding a write action later means a new ADR that says how it avoids an Agent's concurrent git.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| Stage / unstage / discard like VS Code | Discard is irreversible, and both race an Agent's own `git add` and `git commit`. |
| Commit from the app | Agents write the commits in these Workspaces; a second author in the same index invites half-staged commits. |
| `fetch` to keep ahead/behind current | Writes refs and talks to the remote on every refresh, over ssh Machines too. |
