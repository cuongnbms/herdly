import { useCallback, useMemo, useState } from "react";
import { findRow, groupByStatus, rowPane } from "../list/order";
import type { Lens } from "../pane/lens";
import { useWeb } from "../store";
import { webKey, type WebPane } from "../types";
import { BackIcon, ChatIcon, MenuIcon, TerminalIcon } from "../ui/icons";
import { PaneSheet } from "./PaneSheet";

export function ChatHeader({ pane, onBack, onSwitch, onMenu, lens, onLens, chatEnabled = true }: {
  pane: WebPane;
  onBack(): void;
  onSwitch?(p: WebPane): void;
  onMenu?(): void;
  /** The Lens shown, or omitted for a header without the Chat/Terminal selector. */
  lens?: Lens;
  onLens?(lens: Lens): void;
  /** A Pane whose Agent has a Chat lens; only then is Chat selectable. */
  chatEnabled?: boolean;
}) {
  const machines = useWeb((s) => s.machines);
  const sessions = useMemo(() => machines.flatMap((m) => m.sessions), [machines]);
  const row = useMemo(() => findRow(sessions, pane), [sessions, pane]);
  const groups = useMemo(() => groupByStatus(sessions), [sessions]);
  const others = groups.needs.filter((r) => webKey(rowPane(r)) !== webKey(pane));

  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  return (
    <header className="chat-header">
      {onMenu && <button type="button" className="icon-btn" aria-label="Open sidebar" aria-haspopup="dialog" onClick={onMenu}><MenuIcon /></button>}
      <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}><BackIcon /></button>
      <button type="button" className="chat-title" aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>
        <span className="chat-title-main">{row?.pane.title ?? pane.pane_id}</span>
        <span className="chat-title-sub">{row ? `${row.session} › ${row.workspace}` : pane.session}</span>
        <span className="status" data-status={row?.status ?? "unknown"} />
      </button>
      {onSwitch && others.length > 0 && (
        <button type="button" className="need-chip" aria-label={`${others.length} need you`} onClick={() => onSwitch(rowPane(others[0]))}>● {others.length}</button>
      )}
      {lens !== undefined && onLens && (
        <div className="lens-switch" role="group" aria-label="Lens">
          <button type="button" className="lens-opt" aria-label="Chat" title="Chat" aria-pressed={lens === "chat"} disabled={!chatEnabled} onClick={() => onLens("chat")}><ChatIcon /></button>
          <button type="button" className="lens-opt" aria-label="Terminal" title="Terminal" aria-pressed={lens === "terminal"} onClick={() => onLens("terminal")}><TerminalIcon /></button>
        </div>
      )}
      {sheetOpen && <PaneSheet current={pane} onClose={closeSheet} onSwitch={(p) => onSwitch?.(p)} />}
    </header>
  );
}
