import { useEffect, useId, useRef, useState } from "react";
import { tabClose, tabCreate } from "../api";
import { useWeb } from "../store";
import { webKey, type WebPane } from "../types";
import type { TabView, WorkspaceView } from "@desktop/lib/types";
import { AgentMark } from "../list/PaneCard";
import { markSeen } from "../list/seen";
import { ChevronIcon } from "../ui/icons";
import { TabMenu } from "./TabMenu";

export function WorkspaceTabs({ session, running, workspace, current, onOpen, expanded, onToggle }: {
  session: string;
  running: boolean;
  workspace: WorkspaceView;
  current: WebPane | null;
  onOpen(p: WebPane): void;
  expanded: boolean;
  onToggle(): void;
}) {
  const id = useId();
  const count = workspace.tabs.reduce((n, tab) => n + tab.panes.length, 0);
  const connected = useWeb((s) => s.conn === "open");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const create = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await tabCreate(session, workspace.workspace_id);
      if (mounted.current) onOpen({ session, pane_id: result.root_pane.pane_id });
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const close = async (tab: TabView) => {
    if (!window.confirm(`Close tab "${tab.label}" and all its panes?`)) return;
    setPending(true);
    setError(null);
    try {
      await tabClose(session, tab.tab_id);
      // The view can arrive before the HTTP reply. Use the requested tab's Pane ids,
      // but read the latest selection so a later Pane switch is not undone.
      const state = useWeb.getState();
      for (const pane of tab.panes) state.clearChat(webKey({ session, pane_id: pane.pane_id }));
      if (state.open?.session === session && tab.panes.some((pane) => pane.pane_id === state.open?.pane_id)) state.closeChat();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  return <div className="sidebar-branch" role="group" aria-label={`Workspace ${workspace.label}`}>
    <div className="sidebar-workspace-header">
      <button type="button" className="sidebar-branch-toggle" aria-label={`Workspace ${workspace.label}`} aria-expanded={expanded} aria-controls={id} onClick={onToggle}>
        <ChevronIcon className="chev" /><span className="sidebar-workspace-label">{workspace.label}</span>
        <span className="sidebar-pane-count">{count} {count === 1 ? "pane" : "panes"}</span>
      </button>
      <button type="button" className="icon-btn sidebar-new-tab" aria-label={`New tab in ${workspace.label}`}
        title="New tab" disabled={!running || !connected || pending} onClick={() => void create()}>＋</button>
    </div>
    {error && <p role="alert" className="sidebar-tab-error">{error}</p>}
    <div id={id} hidden={!expanded} className="sidebar-children">
      {expanded && workspace.tabs.map((tab) => {
        const single = tab.panes.length === 1;
        const actions = <TabMenu label={tab.label}
          disabled={!running || !connected || pending} onClose={() => void close(tab)} />;
        return <div key={tab.tab_id} role={single ? undefined : "group"}
          aria-label={single ? undefined : `Tab ${tab.label}`} className={single ? "sidebar-pane-row" : "sidebar-tab"}>
          {!single && <div className="sidebar-tab-header">
            <span className="sidebar-tab-label" title={tab.label}>{tab.label}</span>
            {actions}
          </div>}
          {tab.panes.map((pane) => {
            const target = { session, pane_id: pane.pane_id };
            return (
              <button type="button" key={pane.pane_id} className="sidebar-pane"
                aria-current={current && webKey(current) === webKey(target) ? "true" : undefined}
                disabled={!running}
                onClick={() => { if (pane.status === "done") markSeen(webKey(target)); onOpen(target); }}>
                <AgentMark agent={pane.agent} /><span className="sidebar-pane-title" title={pane.title}>{pane.title}</span>
                <span className="status" data-status={pane.status} title={`Status: ${pane.status}`}>{pane.status}</span>
              </button>
            );
          })}
          {single && actions}
        </div>;
      })}
    </div>
  </div>;
}
