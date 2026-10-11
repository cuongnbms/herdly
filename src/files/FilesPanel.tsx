import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { filesListAll } from "../lib/ipc";
import { useHiddenFolders } from "../settings/hiddenFolders";
import type { FileList } from "../lib/types";
import { activeItem, useApp } from "../store/app";
import { ActionsProvider, useActions } from "../sidebar/actions";
import { ChevronIcon, EyeIcon, EyeOffIcon, RefreshIcon } from "../ui/icons";
import { FOLDER_HINT, setFolder, suggestFolder, useFolder } from "../workspaces/folder";
import type { WorkspaceRef } from "../workspaces/folder";
import { useFilesBus } from "./bus";
import { FileTree } from "./FileTree";
import { GoToFile } from "./GoToFile";
import { filesHidden, useFilesPanel } from "./panelStore";
import { panelRoot, panelWorkspace, type Root } from "./root";
import { filesKey, useFiles, wsKey } from "./store";
import { useWatch } from "./useWatch";

/** Each half of the agents column keeps at least this many pixels. */
const HALF_MIN = 120;

/** The file tree of the active item's Workspace (else the selected Pane's), under the agent list. */
export function FilesPanel() {
  const ws = useApp(useShallow(panelWorkspace));
  const view = useFilesPanel((s) => s.view);
  const collapsed = useFilesPanel(filesHidden);
  const height = useFilesPanel((s) => s.height);
  const section = useRef<HTMLElement>(null);
  const focusTick = useFilesPanel((s) => s.focusTick);
  const gotoTick = useFilesPanel((s) => s.gotoTick);
  // With no Workspace to show there is nothing to focus, and the request must not wait for a later one.
  useEffect(() => {
    if (!ws) useFilesPanel.getState().handled("both");
  }, [ws, focusTick, gotoTick]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const column = section.current?.parentElement;
    if (!column) return;
    const y0 = e.clientY;
    const h0 = section.current!.getBoundingClientRect().height;
    const max = Math.max(HALF_MIN, column.getBoundingClientRect().height - HALF_MIN);
    const move = (ev: MouseEvent) => useFilesPanel.getState().setHeight(Math.min(max, Math.max(HALF_MIN, h0 - (ev.clientY - y0))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <>
      {view === "split" && !collapsed && <div className="files-split" role="separator" aria-orientation="horizontal" onMouseDown={startDrag} />}
      {/* Kept mounted in the agents view: its watch is what reloads the open file. */}
      <section
        ref={section}
        className={"files-panel" + (view === "files" ? " full" : collapsed ? " collapsed" : "")}
        aria-label="Files"
        hidden={view === "agents"}
        style={view === "split" && !collapsed ? { flexBasis: height === null ? "50%" : `${height}px` } : undefined}
      >
        {ws ? (
          <ActionsProvider>
            <WorkspacePanel key={wsKey(ws)} wsRef={ws} section={section} />
          </ActionsProvider>
        ) : (
          <>
            <header className="files-panel-head" onClick={toggleFromHead}>
              <span className="files-title">FILES</span>
              <span className="files-head-spacer" />
              <CollapseButton />
            </header>
            {!collapsed && <div className="files-empty">Select an agent to browse its files</div>}
          </>
        )}
      </section>
    </>
  );
}

/** In the split view a click on the header toggles the panel, except on the header's own buttons. */
function toggleFromHead(e: React.MouseEvent) {
  if ((e.target as Element).closest("button")) return;
  const panel = useFilesPanel.getState();
  if (panel.view === "split") panel.setCollapsed(!panel.collapsed);
}

/** Only the split view collapses: the files view is the panel alone. */
function CollapseButton() {
  const collapsed = useFilesPanel((s) => s.collapsed);
  const split = useFilesPanel((s) => s.view === "split");
  if (!split) return null;
  return (
    <button
      type="button"
      className={"icon-btn files-collapse" + (collapsed ? " collapsed" : "")}
      aria-label={collapsed ? "Expand files" : "Collapse files"}
      aria-expanded={!collapsed}
      onClick={() => useFilesPanel.getState().setCollapsed(!collapsed)}
    >
      <ChevronIcon />
    </button>
  );
}

function WorkspacePanel({ wsRef: ref, section }: { wsRef: WorkspaceRef; section: React.RefObject<HTMLElement | null> }) {
  const [reloadKey, setReloadKey] = useState(0);
  const collapsed = useFilesPanel(filesHidden);
  const machine = useApp((s) => s.machines[ref.machine_id]);
  const actions = useActions();
  const folder = useFolder(ref);
  const ws = machine?.sessions.find((s) => s.name === ref.session)?.workspaces.find((w) => w.workspace_id === ref.workspace_id);
  // The root of the active file item, when it belongs to this Workspace: its tree is what the file sits in.
  const itemRoot = useApp((s) => {
    const item = activeItem(s);
    return item?.kind === "file" && wsKey(item.ws) === wsKey(ref) ? item.root : null;
  });

  // Resolved when the Workspace is first shown, and again only when its folder is set: a cd in
  // the pane must not move the root under the open files.
  const resolve = () => panelRoot(ref, useApp.getState());
  const [resolved, setResolved] = useState<Root | null>(resolve);
  const folderSeen = useRef(folder);
  useEffect(() => {
    if (folderSeen.current === folder) return;
    folderSeen.current = folder;
    setResolved(resolve());
  }, [folder]);
  const root: Root | null = itemRoot !== null ? { path: itemRoot, source: resolved?.path === itemRoot ? resolved.source : "folder" } : resolved;

  const [showHeavy, setShowHeavy] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const rootMissing = root !== null && missing === root.path;
  const online = machine?.state === "connected";
  const onlineRef = useRef(online);
  onlineRef.current = online;
  // Reload and a change of connection re-check the root: the body remounts and lists it again.
  useEffect(() => setMissing(null), [reloadKey, online]);

  const key = root ? filesKey(ref, root.path) : null;
  const reload = () => {
    setReloadKey((k) => k + 1);
    if (key) useFilesBus.getState().reload(key);
  };

  const goto = useRef<HTMLInputElement>(null);
  const focusTick = useFilesPanel((s) => s.focusTick);
  const gotoTick = useFilesPanel((s) => s.gotoTick);
  // Compared with the store's handled ticks, not the tick at mount: a request made in the same
  // update that switched the Workspace is for the panel that mounts with it.
  useEffect(() => {
    const st = useFilesPanel.getState();
    if (st.focusTick === st.focusHandled) return;
    st.handled("tree");
    const tree = section.current?.querySelector<HTMLElement>('[role="tree"]');
    (tree?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? tree)?.focus();
  }, [focusTick]);
  useEffect(() => {
    const st = useFilesPanel.getState();
    if (st.gotoTick === st.gotoHandled) return;
    st.handled("goto");
    goto.current?.focus();
    goto.current?.select();
  }, [gotoTick]);

  const keys = (e: KeyboardEvent) => {
    if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== "r") return;
    if (!section.current?.contains(document.activeElement)) return;
    // A dialog over the panel (Change folder…) keeps its keys.
    if (document.querySelector(".overlay")) return;
    // An active file of this root has its viewer take ⌘R, which reloads the same key.
    const item = activeItem(useApp.getState());
    if (item?.kind === "file" && key !== null && filesKey(item.ws, item.root) === key) return;
    e.preventDefault();
    reload();
  };
  const keysRef = useRef(keys);
  keysRef.current = keys;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener("keydown", h, false);
    return () => window.removeEventListener("keydown", h, false);
  }, []);

  const label = ws?.label ?? ref.workspace_id;
  return (
    <>
      <header className="files-panel-head" onClick={toggleFromHead}>
        <span className="files-title" title={root?.path}>
          {`FILES · ${label}`}
        </span>
        {machine?.kind === "ssh" && <span className="files-machine">{machine.label}</span>}
        <span className="files-head-spacer" />
        {root && !rootMissing && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Show heavy folders"
            aria-pressed={showHeavy}
            title={showHeavy ? "Hide the folders listed in Settings › Files" : "Show the folders hidden in Settings › Files"}
            onClick={() => setShowHeavy((on) => !on)}
          >
            {showHeavy ? <EyeIcon /> : <EyeOffIcon />}
          </button>
        )}
        {root && (
          <button type="button" className="icon-btn" aria-label="Reload" title="Reload  ⌘R" onClick={reload}>
            <RefreshIcon />
          </button>
        )}
        <CollapseButton />
      </header>
      {!collapsed && root?.source === "pane" && !rootMissing && (
        <div className="files-set-folder-row">
          <button type="button" className="btn btn-xs files-set-folder" title={FOLDER_HINT} onClick={() => setFolder(ref, root.path)}>
            Set as workspace folder
          </button>
        </div>
      )}
      {!collapsed && !online && <div className="files-banner files-banner-offline">Machine offline</div>}
      {root && !rootMissing ? (
        // Kept mounted while collapsed or hidden: its watch is what reloads the open file.
        <PanelBody
          key={filesKey(ref, root.path)}
          wsRef={ref}
          root={root.path}
          online={online}
          showHeavy={showHeavy}
          hidden={collapsed}
          gotoRef={goto}
          onMissing={() => onlineRef.current && setMissing(root.path)}
        />
      ) : (
        !collapsed && (
          <div className="files-empty">
            <p>{root ? "This folder no longer exists." : "This workspace has no folder."}</p>
            <button type="button" className="btn" title={FOLDER_HINT} onClick={() => actions?.changeFolder(ref, folder ?? (ws ? suggestFolder(ws) : ""))}>
              Change folder…
            </button>
          </div>
        )
      )}
    </>
  );
}

interface BodyProps {
  wsRef: WorkspaceRef;
  root: string;
  online: boolean;
  showHeavy: boolean;
  /** The panel is collapsed: nothing shows, but the listing and the watch go on. */
  hidden: boolean;
  gotoRef: React.RefObject<HTMLInputElement | null>;
  onMissing(): void;
}

function PanelBody({ wsRef, root, online, showHeavy, hidden, gotoRef, onMissing }: BodyProps) {
  const machineId = wsRef.machine_id;
  const key = filesKey(wsRef, root);
  const recent = useFiles((s) => s.ws(key).recent);
  const [list, setList] = useState<FileList | null>(null);
  const batch = useFilesBus((s) => s.batches[key] ?? null);
  const reloadKey = useFilesBus((s) => s.reloads[key] ?? 0);
  // Go to File always leaves these out; the eye button only shows them in the tree.
  const hiddenFolders = useHiddenFolders((s) => s.folders);
  const [watchError, setWatchError] = useState<string | null>(null);
  const reload = useCallback(() => useFilesBus.getState().reload(key), [key]);

  useEffect(() => {
    let gone = false;
    filesListAll(machineId, root, hiddenFolders).then(
      (l) => !gone && setList(l),
      (e) => {
        if (gone) return;
        setList(null);
        if ((e as { code?: string } | null)?.code === "not_found") onMissing();
      },
    );
    return () => {
      gone = true;
    };
  }, [machineId, root, reloadKey, hiddenFolders]);

  // The mount just listed everything, so the first Resync of a watch that started with it is
  // skipped; a watch started later (back online) or restarted after an error reloads.
  const skipResync = useRef(online);
  useEffect(() => {
    if (!online) skipResync.current = false;
  }, [online]);
  useWatch({
    enabled: online,
    machineId,
    root,
    onResync: () => {
      setWatchError(null);
      if (skipResync.current) skipResync.current = false;
      else reload();
    },
    onChanges: (changes) => {
      setWatchError(null);
      if (changes.some((c) => c.path === "" && c.removed)) {
        onMissing();
        return;
      }
      useFilesBus.getState().publish(key, changes);
    },
    onError: (message) => {
      // Changes made while the watch was down are only caught by reloading on its next Resync.
      skipResync.current = false;
      setWatchError(message);
    },
  });

  const onOpen = useCallback((rel: string, pin: boolean) => useApp.getState().openFile(wsRef, root, rel, { pin }), [wsRef, root]);
  const onMoved = useCallback((from: string, to: string | null) => useApp.getState().filesMoved(wsRef, root, from, to), [wsRef, root]);

  return (
    <div className="files-panel-body" hidden={hidden}>
      {online && watchError && (
        <div className="files-banner files-banner-error" role="status">
          Auto-refresh stopped: {watchError}
        </div>
      )}
      <GoToFile list={list} recent={recent} onOpen={onOpen} inputRef={gotoRef} />
      <div className="files-side-scroll">
        <FileTree machineId={machineId} root={root} filesKey={key} onOpen={onOpen} onMoved={onMoved} reloadKey={reloadKey} showHeavy={showHeavy} changes={batch} />
      </div>
    </div>
  );
}
