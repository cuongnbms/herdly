import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { canChat } from "../config";
import { useWeb } from "../store";
import { webKey, type WebPane } from "../types";
import { ChevronIcon } from "../ui/icons";
import { AgentMark } from "../list/PaneCard";
import { markSeen } from "../list/seen";

function Branch({ label, children }: { label: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(true);
  const id = useId();
  return (
    <div className="sidebar-branch" role="group" aria-label={label}>
      <button type="button" className="sidebar-branch-toggle" aria-label={label} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
        <ChevronIcon className="chev" /><span>{label}</span>
      </button>
      <div id={id} hidden={!expanded} className="sidebar-children">{children}</div>
    </div>
  );
}

export function Sidebar({ current, onOpen, onClose }: { current: WebPane | null; onOpen(p: WebPane): void; onClose(): void }) {
  const machine = useWeb((s) => s.machines[0]);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key !== "Tab") return;
      const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
        .filter((button) => !button.closest("[hidden]"));
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!panel.current?.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open sidebar"]');
      (trigger ?? (previous?.isConnected ? previous : null))?.focus();
    };
  }, [onClose]);
  return (
    <div className="sidebar-root">
      <div className="sidebar-scrim" data-sidebar-scrim onClick={onClose} />
      <div ref={panel} className="mobile-sidebar" role="dialog" aria-modal="true" aria-label="Sessions and Workspaces">
        <header className="sidebar-header">
          <h2>Sessions and Workspaces</h2>
          <button type="button" className="icon-btn" aria-label="Close sidebar" onClick={onClose}>×</button>
        </header>
        <nav className="sidebar-body" aria-label="Sessions and Workspaces">
          {!machine?.sessions.length && <p className="sidebar-empty">No Sessions</p>}
          {machine?.sessions.map((session) => (
            <Branch key={session.name} label={`Session ${session.name}`}>
              {!session.running && <p className="sidebar-session-note">Stopped</p>}
              {session.workspaces.map((workspace) => (
                <Branch key={workspace.workspace_id} label={`Workspace ${workspace.label}`}>
                  {workspace.tabs.flatMap((tab) => tab.panes.map((pane) => {
                    const target = { session: session.name, pane_id: pane.pane_id };
                    return (
                      <button type="button" key={`${tab.tab_id}/${pane.pane_id}`} className="sidebar-pane"
                        aria-current={current && webKey(current) === webKey(target) ? "true" : undefined}
                        disabled={!session.running || !canChat(pane)} title={!canChat(pane) ? "Chat lens supports Claude Code and pi only" : undefined}
                        onClick={() => { if (pane.status === "done") markSeen(webKey(target)); onOpen(target); }}>
                        <AgentMark agent={pane.agent} /><span className="sidebar-pane-title">{pane.title}</span>
                        <span className="status" data-status={pane.status}>{pane.status}</span>
                      </button>
                    );
                  }))}
                </Branch>
              ))}
            </Branch>
          ))}
        </nav>
      </div>
    </div>
  );
}
