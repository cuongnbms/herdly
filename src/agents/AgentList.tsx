import { memo, useEffect, useState, type CSSProperties } from "react";
import { herdrCall } from "../lib/ipc";
import { paneKey } from "../lib/types";
import type { AgentStatus, PaneView, SessionView, TabView, WorkspaceView } from "../lib/types";
import { useFilesPanel, type SidebarView } from "../files/panelStore";
import { useApp } from "../store/app";
import { itemKey } from "../store/openItems";
import type { MenuItem } from "../sidebar/ContextMenu";
import { ActionsProvider, useActions } from "../sidebar/actions";
import { Chevron } from "../sidebar/Sidebar";
import { StatusDot } from "../sidebar/StatusDot";
import { BotIcon, CloseIcon, FolderIcon, FolderOpenIcon, PencilIcon, PlusIcon, SplitDownIcon, SplitRightIcon, TabPlusIcon, TerminalIcon } from "../ui/icons";
import { folderName, setFolder, suggestFolder, useFolder } from "../workspaces/folder";
import { AgentIcon } from "./AgentIcon";
import { AGENTS, openAgentTab, type Agent } from "./openAgentTab";
import { useTabReorder } from "./tabDnd";

export interface PaneEntry {
  pane: PaneView;
  workspace: WorkspaceView;
  tab: TabView;
  /** The tab label when the workspace has several tabs, else "". */
  sub: string;
}

/** A session's workspaces in order, each with its panes (empty workspaces included). */
export function workspaceGroups(session: SessionView): { workspace: WorkspaceView; entries: PaneEntry[] }[] {
  return session.workspaces.map((workspace) => ({
    workspace,
    entries: workspace.tabs.flatMap((tab) =>
      tab.panes.map((pane) => ({ pane, workspace, tab, sub: workspace.tabs.length > 1 ? tab.label : "" })),
    ),
  }));
}

/** Splits a workspace's entries into consecutive runs sharing a tab. */
function tabRuns(entries: PaneEntry[]): PaneEntry[][] {
  const runs: PaneEntry[][] = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    if (last && last[0].tab.tab_id === e.tab.tab_id) last.push(e);
    else runs.push([e]);
  }
  return runs;
}

const BADGE:Record<AgentStatus, string> = {
  blocked: "BLOCKED",
  working: "WORKING",
  done: "DONE",
  idle: "IDLE",
  unknown: "—",
};

type Reorder = ReturnType<typeof useTabReorder>;

/** `tabRow` when this card is its Tab's whole row (a single-pane Tab), so it is also the drop target. */
function AgentCard({ machineId, session, entry, reorder, close, tabRow }: { machineId: string; session: string; entry: PaneEntry; reorder: Reorder; close: () => void; tabRow?: boolean }) {
  const { pane, workspace: ws, tab } = entry;
  const ref = { machine_id: machineId, session, pane_id: pane.pane_id };
  const active = useApp((s) => s.selected !== null && paneKey(s.selected) === paneKey(ref));
  const select = useApp((s) => s.select);
  const pin = useApp((s) => s.pinItem);
  const a = useActions();
  const call = (method: string, params: unknown) => () => herdrCall(machineId, session, method, params);
  const items: MenuItem[] = a
    ? [
        { label: "Rename…", icon: PencilIcon, onSelect: () => a.rename("Rename pane", pane.title, (label) => call("pane.rename", { pane_id: pane.pane_id, label })()) },
        { label: "Split right", icon: SplitRightIcon, onSelect: () => a.guard(call("pane.split", { target_pane_id: pane.pane_id, direction: "right" })) },
        { label: "Split down", icon: SplitDownIcon, onSelect: () => a.guard(call("pane.split", { target_pane_id: pane.pane_id, direction: "down" })) },
        { label: "Close pane", icon: CloseIcon, onSelect: close },
        { label: "New tab", icon: TabPlusIcon, onSelect: () => a.guard(call("tab.create", { workspace_id: ws.workspace_id })) },
        { label: "Rename tab…", icon: PencilIcon, onSelect: () => a.rename("Rename tab", tab.label, (label) => call("tab.rename", { tab_id: tab.tab_id, label })()) },
        { label: "Close tab", icon: CloseIcon, onSelect: () => a.confirm("Close tab", `Close tab "${tab.label}" and all its panes?`, "Close", call("tab.close", { tab_id: tab.tab_id })) },
      ]
    : [];
  return (
    <li
      className={"agent-card-item" + (tabRow ? reorder.indicatorClass(tab.tab_id) : "")}
      {...(tabRow ? reorder.target(tab.tab_id) : {})}
    >
      <button
        {...reorder.source(tab.tab_id)}
        className={"agent-card" + (active ? " active" : "") + (pane.status === "blocked" ? " blocked" : "")}
        onClick={() => select(ref)}
        onDoubleClick={() => pin(itemKey({ kind: "agent", ref }))}
        onContextMenu={(e) => a?.menu(e, items)}
        title={pane.cwd ?? undefined}
      >
        <AgentIcon agent={pane.agent} />
        <span className="agent-card-body">
          <span className="agent-card-title">{pane.title}</span>
          <span className="agent-card-meta">
            <span className={`badge badge-${pane.status}`}>{BADGE[pane.status]}</span>
            {entry.sub && <span className="agent-card-sub">{entry.sub}</span>}
          </span>
        </span>
      </button>
      <button className="agent-card-close" aria-label={`Close ${pane.title}`} title="Close pane" onClick={close}>
        <CloseIcon />
      </button>
    </li>
  );
}

/** What a collapsed workspace still shows: a pane waiting for input outranks one working. */
function urgentStatus(entries: PaneEntry[]): AgentStatus | null {
  for (const status of ["blocked", "working"] as const) if (entries.some((e) => e.pane.status === status)) return status;
  return null;
}

function WorkspaceGroup({ machineId, session, workspace: ws, entries: all }: { machineId: string; session: string; workspace: WorkspaceView; entries: PaneEntry[] }) {
  const a = useActions();
  // A closing pane leaves the list at once: herdr can take a while to end its process.
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const entries = all.filter((e) => !closing.has(e.pane.pane_id));
  const gone = [...closing].filter((id) => !all.some((e) => e.pane.pane_id === id));
  useEffect(() => {
    if (gone.length) setClosing((s) => new Set([...s].filter((id) => !gone.includes(id))));
  });
  const unhide = (pane_id: string) => setClosing((s) => new Set([...s].filter((id) => id !== pane_id)));
  const ref = { machine_id: machineId, session, workspace_id: ws.workspace_id };
  const openKey = `ws:${machineId}/${session}/${ws.workspace_id}`;
  const open = useApp((s) => s.expanded[openKey] ?? true);
  const toggle = useApp((s) => s.toggle);
  // Collapsed, the header stands in for its panes, so it carries the selection.
  const holdsSelected = useApp((s) => s.selected !== null && entries.some((e) => paneKey(s.selected!) === paneKey({ machine_id: machineId, session, pane_id: e.pane.pane_id })));
  const urgent = open ? null : urgentStatus(entries);
  const folder = useFolder(ref);
  // A folder named like the Workspace only repeats the label; its path stays in the tooltip.
  const folderText = folder ? folderName(folder) : "no folder";
  const call = (method: string, params: unknown) => () => herdrCall(machineId, session, method, params);
  const closePane = (pane_id: string) => () => {
    if (!a) return;
    setClosing((s) => new Set(s).add(pane_id));
    a.guard(() => call("pane.close", { pane_id })().catch((e: unknown) => {
      unhide(pane_id);
      throw e;
    }));
  };
  const reorder = useTabReorder(
    ws.tabs.map((t) => t.tab_id),
    (tab_id, insert_index) => a?.guard(call("tab.move", { tab_id, insert_index })),
  );
  // Starts straight away in the workspace folder, else a pane's cwd, which then becomes the folder.
  const cwd = folder ?? suggestFolder(ws);
  const start = (agent: Agent) => {
    if (folder === null && cwd) setFolder(ref, cwd);
    a?.guard(() => openAgentTab(machineId, session, ws.workspace_id, agent, cwd));
  };
  const agentItem = (agent: Agent, label: string): MenuItem => ({ label, icon: agent === "shell" ? TerminalIcon : BotIcon, onSelect: () => start(agent) });
  // Without a folder to start in, the dialog asks for one.
  const quick = (agent: Agent) => {
    if (!a) return;
    if (!cwd) return a.newAgent(machineId, session, ws);
    start(agent);
  };
  // The panel follows the active item, else the selected Pane: browsing a Workspace selects its selected
  // pane again (or its first), which also leaves a file item of another Workspace.
  const browse = () => {
    const panes = ws.tabs.flatMap((t) => t.panes);
    const sel = useApp.getState().selected;
    const inWs = sel && sel.machine_id === machineId && sel.session === session && panes.some((p) => p.pane_id === sel.pane_id);
    if (!inWs && !panes[0]) return;
    useApp.getState().select(inWs ? sel : { machine_id: machineId, session, pane_id: panes[0].pane_id });
    useFilesPanel.getState().focusTree();
  };
  const items: MenuItem[] = a
    ? [
        ...AGENTS.map((agent) => agentItem(agent, `New ${agent}`)),
        { label: "Browse files", icon: FolderOpenIcon, onSelect: browse },
        { label: "Change folder…", icon: FolderOpenIcon, onSelect: () => a.changeFolder(ref, folder ?? suggestFolder(ws)) },
        { label: "Rename workspace…", icon: PencilIcon, onSelect: () => a.rename("Rename workspace", ws.label, (label) => call("workspace.rename", { workspace_id: ws.workspace_id, label })()) },
        { label: "Close workspace", icon: CloseIcon, onSelect: () => a.confirm("Close workspace", `Close workspace "${ws.label}" and all its panes?`, "Close", call("workspace.close", { workspace_id: ws.workspace_id })) },
      ]
    : [];
  return (
    <section role="group" aria-label={ws.label} className="ws-group">
      <div className={"ws-head" + (!open && holdsSelected ? " has-active" : "")} title={folder ?? "no folder"} onContextMenu={(e) => a?.menu(e, items)}>
        <button className="ws-toggle" aria-label={ws.label} aria-expanded={open} onClick={() => toggle(openKey, open)}>
          <Chevron open={open} />
          <FolderIcon className="ws-icon" />
          <span className="ws-label">{ws.label}</span>
          {folderText !== ws.label && <span className="ws-folder">{folderText}</span>}
          {!open && (
            <span className="ws-sum">
              {urgent && <StatusDot status={urgent} />}
              <span className="ws-count">{entries.length}</span>
            </span>
          )}
        </button>
        <div role="group" aria-label={`Start in ${ws.label}`} className="ws-quick">
          {AGENTS.map((agent) => (
            <button key={agent} aria-label={`New ${agent} in ${ws.label}`} title={`New ${agent}`} onClick={() => quick(agent)}>
              <AgentIcon agent={agent === "shell" ? null : agent} />
            </button>
          ))}
        </div>
      </div>
      {open && entries.length > 0 && (
        <ul className="agent-cards">
          {tabRuns(entries).map((run) =>
            run.length > 1 ? (
              <li
                key={run[0].tab.tab_id}
                role="group"
                aria-label={`Tab ${run[0].tab.label}`}
                className={"tab-group" + reorder.indicatorClass(run[0].tab.tab_id)}
                {...reorder.target(run[0].tab.tab_id)}
              >
                <ul className="agent-cards">
                  {run.map((e) => (
                    <AgentCard key={e.pane.pane_id} machineId={machineId} session={session} entry={e} reorder={reorder} close={closePane(e.pane.pane_id)} />
                  ))}
                </ul>
              </li>
            ) : (
              <AgentCard key={run[0].pane.pane_id} machineId={machineId} session={session} entry={run[0]} reorder={reorder} close={closePane(run[0].pane.pane_id)} tabRow />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/** Closes the list: a row of its own, so it does not read as one more workspace's New agent. */
function NewWorkspaceButton({ machineId, session }: { machineId: string; session: string }) {
  const a = useActions();
  return (
    <button className="ws-new" aria-label="New workspace" onClick={() => a?.newWorkspace(machineId, session)}>
      <PlusIcon />
      <span>New workspace</span>
    </button>
  );
}

const VIEWS: { view: SidebarView; label: string; Icon: typeof BotIcon }[] = [
  { view: "agents", label: "Agents", Icon: BotIcon },
  { view: "files", label: "Files", Icon: FolderIcon },
  { view: "split", label: "Split", Icon: SplitDownIcon },
];

/** What the column shows: the agent list, the Files panel, or both. */
function ViewSwitch() {
  const view = useFilesPanel((s) => s.view);
  return (
    <div
      className="seg seg-n view-switch"
      role="group"
      aria-label="Sidebar view"
      style={{ "--n": VIEWS.length, "--i": VIEWS.findIndex((v) => v.view === view) } as CSSProperties}
    >
      <span className="seg-thumb" />
      {VIEWS.map(({ view: v, label, Icon }) => (
        <button key={v} aria-label={label} title={label} aria-pressed={v === view} onClick={() => useFilesPanel.getState().setView(v)}>
          <Icon />
        </button>
      ))}
    </div>
  );
}

// Takes no props: memo keeps it out of App's re-renders; it reads the store itself.
export const AgentList = memo(function AgentList() {
  const viewed = useApp((s) => s.viewed);
  const listHidden = useFilesPanel((s) => s.view === "files");
  const machineLabel = useApp((s) => (s.viewed ? s.machines[s.viewed.machine_id]?.label : undefined));
  const session = useApp((s) =>
    s.viewed ? s.machines[s.viewed.machine_id]?.sessions.find((x) => x.name === s.viewed!.session) : undefined,
  );
  if (!viewed || !session)
    return (
      <>
        <div className="agents-head" data-tauri-drag-region>
          <ViewSwitch />
        </div>
        {!listHidden && <p className="agents-empty">Select a session</p>}
      </>
    );
  const groups = workspaceGroups(session);
  return (
    <ActionsProvider>
      <div className="agents-head" data-tauri-drag-region>
        <ViewSwitch />
      </div>
      {/* Only the list scrolls, so the head needs no background of its own: a second layer of the
          translucent chrome would darken it against the column. */}
      {/* Hidden rather than unmounted in the files view, so the list keeps its scroll. */}
      {!listHidden && (
        <header className="panes-head">
          <span className="files-title">{`PANES · ${machineLabel}:${session.name}`}</span>
        </header>
      )}
      <div className="agents-list" hidden={listHidden}>
        {groups.length === 0 ? (
          <p className="agents-empty">{session.running ? "No panes" : "Session stopped"}</p>
        ) : (
          groups.map((g) => (
            <WorkspaceGroup key={g.workspace.workspace_id} machineId={viewed.machine_id} session={session.name} workspace={g.workspace} entries={g.entries} />
          ))
        )}
        {session.running && <NewWorkspaceButton machineId={viewed.machine_id} session={session.name} />}
      </div>
    </ActionsProvider>
  );
});
