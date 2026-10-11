# 0005: The Files overlay writes only by Upload, and Upload never overwrites

> Status: Superseded by [0006](./0006-files-tree-creates-renames-deletes-delete-is-permanent.md) · Date: 2026-10-07

## Context

The Files overlay was designed read-only. Users now want to move files between the Mac and a
Workspace: Upload into a folder of the Workspace and Download into `~/Downloads`. Upload is the
first write the app makes into a Workspace folder, and Agents work in those same folders at the
same time. A wrong Upload that replaces a file an Agent is editing loses that work with no undo.

Two forces shaped how Upload is started:

- remora, the reference project, uploads by dropping Finder items on the tree through Tauri's
  native drag and drop, which hands the app absolute paths.
- Herdly sets `"dragDropEnabled": false` (commit 63b42d0) because native drag and drop
  swallows the HTML5 drag events that the sidebar (Sessions, groups) and Agent tabs use.

Source: [design spec](../superpowers/specs/2026-10-07-files-upload-download-design.md).

## Decision

- The only write into a Workspace is **Upload**. No edit, rename, delete, move or overwrite.
- **Upload never replaces anything.** A name already in the destination gets the first free
  Finder-style name (`report (1).md`). Items are staged in a hidden temp dir inside the
  destination and moved out one by one with `mv -n` after checking the name is free; a name
  taken in the meantime fails that item instead of replacing.
- **Download never replaces anything in `~/Downloads`**: same naming, placed with
  `renamex_np(RENAME_EXCL)`.
- Upload is started from the tree's context menu (**Upload Files…**, **Upload Folder…**)
  through the macOS open panel, not by drag and drop. Native drag and drop stays off.
- The no-overwrite move does not use GNU `mv -T`: the local Machine and ssh Machines can be
  Macs, whose `mv` lacks it. The existence check before `mv -n` covers it, with a narrow race
  (a folder of the same name created in between receives the item inside it; still nothing is
  replaced).

Losing an Agent's file is worse than an extra `(1)` copy the user tidies up, so every
collision resolves toward keeping both. The open panel beats drag and drop because it gives
real paths (so Rust can stream them with tar, as remora does) without breaking the existing
drag and drop.

## Consequences

- Uploading a newer version of a file creates `name (1).ext` beside it; replacing is the
  user's job in the terminal.
- Files and folders cannot be picked in one panel (the dialog plugin's macOS panel allows one
  kind), hence two menu items.
- A later "overwrite" or "delete" feature has to supersede this ADR, not quietly extend it.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| Overwrite on clash, or ask per clash | One mis-click destroys an Agent's work; a prompt per file is friction users click through. |
| Native drag and drop (`dragDropEnabled: true`), as remora | Breaks HTML5 drag and drop in the sidebar and Agent tabs. |
| HTML5 `drop` of Finder items | No paths; bytes go from JS through IPC memory, folders need `webkitGetAsEntry`, and the Rust side differs from remora's. Could be added later on top of this rule. |
| A custom `NSOpenPanel` that allows files and folders together | macOS-only window code for a small UX gain over two menu items. |
| `mv -n -T` as remora | GNU only; fails on Macs. |
