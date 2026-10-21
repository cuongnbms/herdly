import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { paneKeys } from "../api";
import { CTRL_C_CONFIRM_MS, canChat } from "../config";
import { findRow, groupByStatus, rowPane } from "../list/order";
import { useWeb } from "../store";
import { webKey, type WebPane } from "../types";
import { BackIcon, MenuIcon, MoreIcon } from "../ui/icons";
import { PaneSheet } from "./PaneSheet";

export function ChatHeader({ pane, onBack, onSwitch, onMenu }: { pane: WebPane; onBack(): void; onSwitch?(p: WebPane): void; onMenu?(): void }) {
  const machines = useWeb((s) => s.machines);
  const sessions = useMemo(() => machines.flatMap((m) => m.sessions), [machines]);
  const row = useMemo(() => findRow(sessions, pane), [sessions, pane]);
  const groups = useMemo(() => groupByStatus(sessions), [sessions]);
  const others = groups.needs.filter((r) => canChat(r.pane) && webKey(rowPane(r)) !== webKey(pane));

  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const closeMenu = () => {
    disarm();
    setError(null);
    setMenuOpen(false);
  };

  const send = async (key: string) => {
    try {
      await paneKeys(pane, [key]);
      closeMenu();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const ctrlC = () => {
    if (armed) {
      disarm();
      void send("ctrl+c");
      return;
    }
    setArmed(true);
    timer.current = setTimeout(disarm, CTRL_C_CONFIRM_MS);
  };

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
      <button type="button" className="icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}><MoreIcon /></button>
      {menuOpen && (
        <>
          <div className="menu-backdrop" data-backdrop onClick={closeMenu} />
          <div className="menu" role="menu">
            <button type="button" role="menuitem" onClick={() => void send("esc")}>Send Esc</button>
            <button type="button" role="menuitem" className={armed ? "armed" : undefined} onClick={ctrlC}>{armed ? "Tap again to send Ctrl+C" : "Send Ctrl+C"}</button>
            {error && <div role="alert" className="menu-error">{error}</div>}
          </div>
        </>
      )}
      {sheetOpen && <PaneSheet current={pane} onClose={closeSheet} onSwitch={(p) => onSwitch?.(p)} />}
    </header>
  );
}
