# 0006: The Files tree creates, renames and deletes items; only Delete destroys, permanently and after a confirm

> Status: Accepted; "Editing a file's content stays out" superseded by [0007](./0007-file-viewer-edits-save-never-silently-overwrites.md) · Date: 2026-10-08

## Context

[0005](./0005-files-write-only-by-upload-never-overwrite.md) made Upload the only write into a
Workspace and said a delete feature must supersede it. Users now want to tidy a Workspace from
the tree: make a file or folder, rename one, delete one. Agents still work in the same folders,
so the reason 0005 never replaces anything still holds. A delete can't avoid destroying something
though, and ssh Machines have no Trash to send items to.

## Decision

- The tree's context menu gains **New File…**, **New Folder…**, **Rename…** and **Delete…**.
  Editing a file's content stays out.
- **New and Rename never replace anything**, the same rule as Upload. A name that is already
  taken (a dangling link included) fails with "already exists" instead of picking a free name,
  because the user typed that name on purpose. Rename stays inside the item's folder and uses
  0005's `mv -n` plus check-before and check-after, without `-T`.
- **Dragging an item onto a folder moves it there** (onto a file: into that file's folder; onto
  the tree's empty space: to the root), keeping its name and following Rename's rules. A folder
  never moves into itself or below itself. There is no confirm, as for Rename. (Added 2026-10-14.)
- **Delete removes the item permanently (`rm -rf`) after a confirm dialog** that names the item
  and says when a folder's contents go too. It works the same on the local Machine and on ssh
  Machines. The root itself, and paths with empty, `.` or `..` segments, are refused. That also
  means a path never ends in `/`, so deleting a linked folder removes only the link.
- Upload and Download keep every rule from 0005.

A confirmed permanent delete beats a Trash because the behaviour is the same on every Machine.
The alternatives would either behave differently local vs remote, or leave a hidden trash folder
in the user's home that nobody empties.

## Consequences

- A deleted item cannot be recovered from the app. The confirm dialog is the only safety net.
- Open file tabs follow a rename or move and close on a delete, and the tree's folds and recent files
  follow too, so nothing points at a path that no longer exists.
- Delete runs with Upload's long timeout, not the 30 s exec timeout, so a large tree can finish.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| macOS Trash on the local Machine, `rm -rf` on ssh Machines | One menu item that is undoable on one Machine and not on another; users learn the undoable one and lose work on the other. |
| Move to a `~/.herdr-trash/<time>/` folder on the Machine | Recoverable everywhere, but it fills the disk unless the app also cleans it up, which is more design than the feature warrants. |
| Pick a free name (`name (1)`) on New/Rename clashes, as Upload does | The user typed the name; silently changing it is surprising. Failing with "already exists" lets them choose again. |
