import { MenuIcon } from "../ui/icons";
import { useWeb } from "../store";
import type { WebPane } from "../types";
import { PaneGroups } from "./PaneGroups";

export function PaneList({ onOpen, onMenu }: { onOpen(p: WebPane): void; onMenu?(): void }) {
  const machine = useWeb((s) => s.machines[0]);
  const empty = machine !== undefined && machine.sessions.every((s) => s.workspaces.every((w) => w.tabs.every((t) => t.panes.length === 0)));
  return (
    <main className="pane-list">
      <header className="list-header">
        {onMenu && <button type="button" className="icon-btn" aria-label="Open sidebar" aria-haspopup="dialog" onClick={onMenu}><MenuIcon /></button>}
        <h1 className="list-title">Herdly</h1>
        {machine && (
          <>
            <span className="conn-dot" data-ok={machine.state === "connected"} />
            <span>{machine.label}</span>
          </>
        )}
      </header>
      {machine?.error && <div role="alert" className="banner banner-err"><strong>{machine.state}</strong>: <span>{machine.error.message}</span></div>}
      <PaneGroups machine={machine} current={null} onOpen={onOpen} />
      {empty && <p className="list-empty">No Panes</p>}
    </main>
  );
}
