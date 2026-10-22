import { useEffect, useRef, useState } from "react";
import { paneKeys } from "../api";
import { CTRL_C_CONFIRM_MS } from "../config";
import type { WebPane } from "../types";
import { MoreIcon } from "../ui/icons";

/** Terminal commands stay beside the touch keys, not in the page header. */
export function TerminalMenu({ pane }: { pane: WebPane }) {
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
    <div className="term-menu" onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className="term-key" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}><MoreIcon /></button>
      {menuOpen && (
        <>
          <div className="menu-backdrop" data-backdrop onClick={closeMenu} />
          <div className="menu term-menu-popover" role="menu">
            <button type="button" role="menuitem" className={armed ? "armed" : undefined} onClick={ctrlC}>{armed ? "Tap again to send Ctrl+C" : "Send Ctrl+C"}</button>
            {error && <div role="alert" className="menu-error">{error}</div>}
          </div>
        </>
      )}
    </div>
  );
}
