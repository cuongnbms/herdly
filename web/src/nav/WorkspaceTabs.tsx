import { useEffect, useRef, useState } from "react";
import { tabClose, tabCreate } from "../api";
import { useWeb } from "../store";
import { webKey, type WebPane } from "../types";
import type { TabView, WorkspaceView } from "@desktop/lib/types";
import { AgentMark } from "../list/PaneCard";
import { markSeen } from "../list/seen";

export function WorkspaceTabs({ session, running, workspace, current, onOpen }: {
  session: string;
  running: boolean;
  workspace: WorkspaceView;
  current: WebPane | null;
  onOpen(p: WebPane): void;
}) {
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
  return <>
    <button type="button" className="sidebar-new-tab" disabled={!running || !connected || pending} onClick={() => void create()}>
      <span aria-hidden="true">＋</span> New tab
    </button>
    {error && <p role="alert" className="sidebar-tab-error">{error}</p>}
    {workspace.tabs.map((tab) => <div key={tab.tab_id} role="group" aria-label={`Tab ${tab.label}`} className="sidebar-tab">
      <div className="sidebar-tab-header">
        <span className="sidebar-tab-label" title={tab.label}>{tab.label}</span>
        <button type="button" className="icon-btn sidebar-tab-close" aria-label={`Close tab ${tab.label}`}
          disabled={!running || !connected || pending} onClick={() => void close(tab)}>×</button>
      </div>
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
    </div>)}
  </>;
}
