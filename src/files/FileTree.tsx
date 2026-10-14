import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { filesListDir } from "../lib/ipc";
import { useHiddenFolders } from "../settings/hiddenFolders";
import type { FileChange, FileEntry } from "../lib/types";
import { ConfirmDialog, ContextMenu, TextDialog, type MenuItem } from "../sidebar/ContextMenu";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronIcon,
  FileIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "../ui/icons";
import { createItem, deleteItem, moveItem, renameItem } from "./edit";
import { startDownload, startUpload } from "./transfer";
import { useFiles } from "./store";
import { dirtyUnder } from "./drafts";
import { copyItems } from "./treeMenu";
import { dirsToRelist } from "./watchDirs";

interface Props {
  machineId: string;
  root: string;
  filesKey: string;
  onOpen: (rel: string, pin: boolean) => void;
  /** An item was renamed to `to`, or deleted (`to` null), from this tree. */
  onMoved?: (from: string, to: string | null) => void;
  /** Changing it refetches the root and every expanded folder. */
  reloadKey: number;
  /** Lists the folders hidden in Settings (`.git`, `node_modules`…) too; changing it refetches like `reloadKey`. */
  showHeavy?: boolean;
  /** A batch from the Files watch; each new `seq` relists the loaded folders it touched. */
  changes?: { seq: number; changes: FileChange[] } | null;
}

const NO_DIRS: string[] = [];

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const basename = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
const parentOf = (rel: string) => rel.slice(0, Math.max(rel.lastIndexOf("/"), 0));
const isFolder = (kind: string | undefined) => kind === "dir" || kind === "dirlink";
/** Whether `rel` may move into the folder `dir`: not into itself, below itself, or the folder it is already in. */
const canMoveInto = (rel: string, dir: string) => dir !== parentOf(rel) && dir !== rel && !dir.startsWith(`${rel}/`);
const ITEM_TYPE = "application/x-herdr-file";
/** How long a collapsed folder sits under a drag before it opens. */
const OPEN_DELAY_MS = 600;
/** True when the pointer is outside `e.currentTarget`; does not rely on `relatedTarget`, which WebKit may leave null. */
const leftTarget = (e: DragEvent) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};
/** A linked folder looks like a folder, named like a symlink. */
const kindClass = (kind: FileEntry["kind"]) => (kind === "dirlink" ? "files-tree-dir files-tree-symlink" : `files-tree-${kind}`);

export function FileTree({ machineId, root, filesKey, onOpen, onMoved, reloadKey, showHeavy = false, changes = null }: Props) {
  const expanded = useFiles((s) => s.byWs[filesKey]?.expanded ?? NO_DIRS);
  const toggleDir = useFiles((s) => s.toggleDir);
  const hiddenFolders = useHiddenFolders((s) => s.folders);
  const hidden = showHeavy ? NO_DIRS : hiddenFolders;
  const [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** The item Tab lands on: the last focused one, else the first. */
  const [focusRel, setFocusRel] = useState<string | null>(null);
  // A different root starts from nothing, reset while rendering so the old root's entries
  // are never committed under the new one.
  const scope = `${machineId}\0${root}`;
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setEntries({});
    setErrors({});
    setFocusRel(null);
  }
  /** The open context menu: the row it belongs to (null for the tree's empty space) and the folder an Upload goes into. */
  const [menu, setMenu] = useState<{ x: number; y: number; rel: string | null; dir: string } | null>(null);
  /** The open New, Rename or Delete dialog. */
  const [dialog, setDialog] = useState<
    { kind: "new"; dir: string; isDir: boolean } | { kind: "rename"; rel: string } | { kind: "delete"; rel: string; isDir: boolean } | null
  >(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const gen = useRef(0);
  const inflight = useRef(new Set<string>());
  /** The latest load started per folder; a load that is no longer it never writes back. */
  const tokens = useRef(new Map<string, number>());
  const lastToken = useRef(0);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const treeRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    (rel: string) => {
      const g = gen.current;
      const token = ++lastToken.current;
      tokens.current.set(rel, token);
      inflight.current.add(rel);
      filesListDir(machineId, root, rel, hidden).then(
        (list) => {
          if (g !== gen.current || tokens.current.get(rel) !== token) return;
          inflight.current.delete(rel);
          setEntries((m) => ({ ...m, [rel]: list }));
          setErrors(({ [rel]: _drop, ...rest }) => rest);
        },
        (e) => {
          if (g !== gen.current || tokens.current.get(rel) !== token) return;
          inflight.current.delete(rel);
          setErrors((m) => ({ ...m, [rel]: errMessage(e) }));
        },
      );
    },
    [machineId, root, hidden],
  );

  // Initial mount, a new root, or a reload: refetch the root and open folders. Children of
  // collapsed folders are dropped, so expanding one later lists it afresh.
  useEffect(() => {
    gen.current++;
    inflight.current.clear();
    const keep = new Set(["", ...expandedRef.current]);
    const open = <T,>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => keep.has(k)));
    setEntries(open);
    setErrors(open);
    for (const rel of keep) load(rel);
  }, [load, reloadKey]);

  // First expand of a folder loads it.
  useEffect(() => {
    for (const rel of expanded) {
      if (!(rel in entries) && !(rel in errors) && !inflight.current.has(rel)) load(rel);
    }
  }, [expanded, entries, errors, load]);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  // A batch published before this tree mounted is not its to handle.
  const handledSeq = useRef<number | null>(changes?.seq ?? null);
  // A change batch relists the folders it touched that are loaded, and forgets removed folders.
  useEffect(() => {
    if (!changes || changes.seq === handledSeq.current) return;
    handledSeq.current = changes.seq;
    const removed = changes.changes.filter((c) => c.isDir && c.removed).map((c) => c.path);
    const gone = (key: string) => removed.some((p) => key === p || key.startsWith(p + "/"));
    if (removed.length) {
      for (const key of [...inflight.current, ...tokens.current.keys()]) {
        if (!gone(key)) continue;
        inflight.current.delete(key);
        tokens.current.delete(key);
      }
      const keepLive = <T,>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => !gone(k)));
      setEntries(keepLive);
      setErrors(keepLive);
    }
    for (const dir of dirsToRelist(changes.changes)) {
      if ((dir in entriesRef.current || dir in errorsRef.current) && !gone(dir)) load(dir);
    }
  }, [changes, load]);

  const retry = (rel: string) => {
    setErrors(({ [rel]: _drop, ...rest }) => rest);
    load(rel);
  };

  const upload = async (dir: string, directory: boolean) => {
    const startedIn = scopeRef.current;
    const picked = await openDialog({ multiple: true, directory });
    if (picked === null) return;
    const paths = typeof picked === "string" ? [picked] : picked;
    // The root may have changed during the dialog or the transfer; its listing is not ours to refresh.
    if ((await startUpload(machineId, root, dir, paths)) && scopeRef.current === startedIn) load(dir);
  };

  /** Runs an edit, then relists `dir` unless the root changed meanwhile; `still` tells whether it did not. */
  const edited = async <T,>(dir: string, op: Promise<T>): Promise<{ done: T; still: boolean }> => {
    const startedIn = scopeRef.current;
    const done = await op;
    const still = scopeRef.current === startedIn;
    if (done && still) load(dir);
    return { done, still };
  };

  const create = async (dir: string, isDir: boolean, name: string) => {
    name = name.trim();
    if (!name) return;
    const rel = join(dir, name);
    const { done, still } = await edited(dir, createItem(machineId, root, rel, isDir));
    // Another root is shown now: its folds and tabs are not this file's to open.
    if (!done || !still) return;
    if (dir && !useFiles.getState().ws(filesKey).expanded.includes(dir)) toggleDir(filesKey, dir);
    if (!isDir) onOpen(rel, true);
  };

  const rename = async (rel: string, name: string) => {
    name = name.trim();
    if (!name || name === basename(rel)) return;
    // Reported even after the root changed: `onMoved` is still the one bound to this root.
    const { done: to } = await edited(parentOf(rel), renameItem(machineId, root, rel, name));
    if (to) onMoved?.(rel, to);
  };

  const remove = async (rel: string) => {
    const { done } = await edited(parentOf(rel), deleteItem(machineId, root, rel));
    if (done) onMoved?.(rel, null);
  };

  const move = async (rel: string, dir: string) => {
    const startedIn = scopeRef.current;
    const to = await moveItem(machineId, root, rel, dir);
    if (!to) return;
    // Another root is shown now: its listings and folds are not this move's to touch.
    if (scopeRef.current === startedIn) {
      load(parentOf(rel));
      load(dir);
      if (dir && !useFiles.getState().ws(filesKey).expanded.includes(dir)) toggleDir(filesKey, dir);
    }
    onMoved?.(rel, to);
  };

  /** The item being dragged, while the drag started in this tree. */
  const dragRel = useRef<string | null>(null);
  /** The folder a drop would move it into ("" for the root), highlighted. */
  const [dropDir, setDropDir] = useState<string | null>(null);
  const openTimer = useRef<{ dir: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const clearOpen = () => {
    if (openTimer.current) clearTimeout(openTimer.current.timer);
    openTimer.current = null;
  };
  useEffect(() => clearOpen, []);
  const endDrag = () => {
    dragRel.current = null;
    setDropDir(null);
    clearOpen();
  };

  /** A drag over `dir`; `closed` is the collapsed folder under the pointer, which opens after a moment. */
  const dragOver = (e: DragEvent, dir: string, closed: string | null) => {
    const from = dragRel.current;
    if (from === null) return;
    e.stopPropagation();
    if (!canMoveInto(from, dir)) {
      e.dataTransfer.dropEffect = "none";
      setDropDir(null);
      clearOpen();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropDir(dir);
    if (closed === null) clearOpen();
    else if (openTimer.current?.dir !== closed) {
      clearOpen();
      const timer = setTimeout(() => {
        openTimer.current = null;
        if (!useFiles.getState().ws(filesKey).expanded.includes(closed)) toggleDir(filesKey, closed);
      }, OPEN_DELAY_MS);
      openTimer.current = { dir: closed, timer };
    }
  };

  const drop = (e: DragEvent, dir: string) => {
    const from = dragRel.current;
    endDrag();
    if (from === null) return;
    e.stopPropagation();
    if (!canMoveInto(from, dir)) return;
    e.preventDefault();
    void move(from, dir);
  };

  const menuItems = (m: { rel: string | null; dir: string }): MenuItem[] => {
    const list: MenuItem[] = [
      { label: "New File…", icon: PlusIcon, onSelect: () => setDialog({ kind: "new", dir: m.dir, isDir: false }) },
      { label: "New Folder…", icon: FolderPlusIcon, onSelect: () => setDialog({ kind: "new", dir: m.dir, isDir: true }) },
      ...(m.rel !== null ? copyItems(root, m.rel) : []),
      { label: "Upload Files…", icon: ArrowUpIcon, group: true, onSelect: () => void upload(m.dir, false) },
      { label: "Upload Folder…", icon: FolderInputIcon, onSelect: () => void upload(m.dir, true) },
    ];
    const rel = m.rel;
    if (rel !== null) {
      // A folder's row opens its menu with the folder itself as `dir`.
      const isDir = m.dir === rel;
      list.push(
        { label: "Download", icon: ArrowDownIcon, onSelect: () => void startDownload(machineId, root, rel) },
        { label: "Rename…", icon: PencilIcon, group: true, onSelect: () => setDialog({ kind: "rename", rel }) },
        { label: "Delete…", icon: TrashIcon, onSelect: () => setDialog({ kind: "delete", rel, isDir }) },
      );
    }
    return list;
  };

  const renderDialog = () => {
    if (!dialog) return null;
    const close = () => setDialog(null);
    if (dialog.kind === "new") {
      const what = dialog.isDir ? "Folder" : "File";
      return (
        <TextDialog
          title={`New ${what}${dialog.dir ? ` in ${dialog.dir}/` : ""}`}
          initial=""
          submitLabel="Create"
          onSubmit={(name) => void create(dialog.dir, dialog.isDir, name)}
          onClose={close}
        />
      );
    }
    if (dialog.kind === "rename") {
      return (
        <TextDialog title="Rename" initial={basename(dialog.rel)} submitLabel="Rename" onSubmit={(name) => void rename(dialog.rel, name)} onClose={close} />
      );
    }
    const name = basename(dialog.rel);
    const lost = dirtyUnder(filesKey, dialog.rel).length > 0 ? " Unsaved changes will be lost." : "";
    return (
      <ConfirmDialog
        title={dialog.isDir ? "Delete Folder" : "Delete File"}
        message={dialog.isDir ? `Delete "${name}" and everything in it? This cannot be undone.${lost}` : `Delete "${name}"? This cannot be undone.${lost}`}
        confirmLabel="Delete"
        onConfirm={() => void remove(dialog.rel)}
        onClose={close}
      />
    );
  };

  const items = () => Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!el) {
      // The tree itself has focus (it was focused before its rows loaded): ArrowDown enters it.
      if (e.target === treeRef.current && e.key === "ArrowDown") {
        e.preventDefault();
        items()[0]?.focus();
      }
      return;
    }
    const all = items();
    const at = all.indexOf(el);
    const rel = el.dataset.rel ?? "";
    const isDir = isFolder(el.dataset.kind);
    const open = el.getAttribute("aria-expanded") === "true";
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        all[Math.min(at + 1, all.length - 1)]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        all[Math.max(at - 1, 0)]?.focus();
        break;
      case "ArrowRight":
        e.preventDefault();
        if (!isDir) break;
        if (!open) toggleDir(filesKey, rel);
        else if (all[at + 1] && Number(all[at + 1].getAttribute("aria-level")) > Number(el.getAttribute("aria-level"))) all[at + 1].focus();
        break;
      case "ArrowLeft": {
        e.preventDefault();
        if (isDir && open) {
          toggleDir(filesKey, rel);
          break;
        }
        const level = Number(el.getAttribute("aria-level"));
        for (let i = at - 1; i >= 0; i--) {
          if (Number(all[i].getAttribute("aria-level")) < level) {
            all[i].focus();
            break;
          }
        }
        break;
      }
      case "Enter":
        e.preventDefault();
        if (isDir) toggleDir(filesKey, rel);
        else onOpen(rel, true);
        break;
    }
  };

  // Visible items in order, for the roving tab stop.
  const visible: string[] = [];
  const walkVisible = (dir: string) => {
    if (errors[dir] !== undefined) return;
    for (const ent of entries[dir] ?? []) {
      const rel = join(dir, ent.name);
      visible.push(rel);
      if (isFolder(ent.kind) && expanded.includes(rel)) walkVisible(rel);
    }
  };
  walkVisible("");
  const tabStop = focusRel !== null && visible.includes(focusRel) ? focusRel : (visible[0] ?? null);

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    if (errors[dir] !== undefined) {
      return (
        <div className="files-tree-error" style={{ paddingLeft: 8 + depth * 14 }}>
          <span>Could not list: {errors[dir]}</span>
          <button type="button" onClick={() => retry(dir)}>
            Retry
          </button>
        </div>
      );
    }
    return (entries[dir] ?? []).map((ent) => {
      const rel = join(dir, ent.name);
      const isDir = isFolder(ent.kind);
      const open = isDir && expanded.includes(rel);
      return (
        <div key={rel} role="none">
          <div
            role="treeitem"
            tabIndex={rel === tabStop ? 0 : -1}
            onFocus={() => setFocusRel(rel)}
            aria-level={depth + 1}
            aria-expanded={isDir ? open : undefined}
            data-rel={rel}
            data-kind={ent.kind}
            className={`files-tree-row ${kindClass(ent.kind)}${open ? " open" : ""}${isDir && dropDir === rel ? " drop-into" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(ITEM_TYPE, rel);
              e.dataTransfer.effectAllowed = "move";
              dragRel.current = rel;
            }}
            onDragEnd={endDrag}
            // A folder row takes the drop into itself; a file row into the folder it is in.
            onDragEnter={(e) => dragOver(e, isDir ? rel : dir, isDir && !open ? rel : null)}
            onDragOver={(e) => dragOver(e, isDir ? rel : dir, isDir && !open ? rel : null)}
            onDrop={(e) => drop(e, isDir ? rel : dir)}
            onClick={() => {
              // Every click toggles a folder, however quick: a fast second click closes it again.
              if (isDir) toggleDir(filesKey, rel);
              else onOpen(rel, false);
            }}
            onDoubleClick={() => {
              if (!isDir) onOpen(rel, true);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, rel, dir: isDir ? rel : dir });
            }}
          >
            {/* Files keep the chevron's width, so names line up across a level. */}
            <span className="files-tree-caret">{isDir && <ChevronIcon data-icon="chevron" />}</span>
            {isDir ? (
              open ? (
                <FolderOpenIcon className="icon files-tree-icon" data-icon="folder-open" />
              ) : (
                <FolderIcon className="icon files-tree-icon" data-icon="folder" />
              )
            ) : (
              <FileIcon className="icon files-tree-icon" data-icon="file" />
            )}
            <span className="files-tree-name">{ent.name}</span>
          </div>
          {open && renderDir(rel, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      className={`files-tree${dropDir === "" ? " drop-into" : ""}`}
      role="tree"
      tabIndex={-1}
      ref={treeRef}
      onKeyDown={onKeyDown}
      // The tree's empty space moves an item to the root.
      onDragEnter={(e) => dragOver(e, "", null)}
      onDragOver={(e) => dragOver(e, "", null)}
      onDragLeave={(e) => {
        if (!leftTarget(e)) return;
        setDropDir(null);
        clearOpen();
      }}
      onDrop={(e) => drop(e, "")}
      onContextMenu={(e) => {
        // React bubbles events from the portalled menu here too; only the tree's own space counts.
        if (!treeRef.current?.contains(e.target as Node)) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, rel: null, dir: "" });
      }}
    >
      {renderDir("", 0)}
      {/* Fixed to the window rather than to an animating ancestor. */}
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />, document.body)}
      {dialog && createPortal(renderDialog(), document.body)}
    </div>
  );
}
