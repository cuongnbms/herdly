import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./nav/Sidebar";
import type { Socket } from "./socket";
import { ChatScreen } from "./chat/ChatScreen";
import { PaneList } from "./list/PaneList";
import { useAttention } from "./attention";
import { useWeb } from "./store";
import { webKey, type WebPane } from "./types";

function NotPaired() {
  return (
    <main className="notpaired">
      <div className="notpaired-card">
        <h1>Not paired</h1>
        <p>Open a pairing link from herdly-web pair on the devbox.</p>
      </div>
    </main>
  );
}

/** `socket` is main.tsx's one connection; the screens built on this shell subscribe through it. */
export function App({ socket }: { socket?: Socket }) {
  useAttention();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const conn = useWeb((s) => s.conn);
  const lost = useWeb((s) => s.lost);
  const open = useWeb((s) => s.open);
  const openChat = useWeb((s) => s.openChat);
  const closeChat = useWeb((s) => s.closeChat);
  const clearChat = useWeb((s) => s.clearChat);
  const openKey = open ? webKey(open) : null;
  useEffect(() => {
    if (open) socket?.subscribe(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, socket]);
  const back = (p: WebPane) => {
    socket?.unsubscribe(p);
    clearChat(webKey(p));
    closeChat();
  };
  const switchTo = (next: WebPane) => {
    if (open) {
      socket?.unsubscribe(open);
      clearChat(webKey(open));
    }
    openChat(next);
  };
  if (conn === "unpaired") return <NotPaired />;
  return (
    <>
      <div className="app-content" inert={sidebarOpen}>
      {(conn === "down" || (conn === "connecting" && lost)) && <div role="status" className="banner banner-warn reconnect">Disconnected, reconnecting…</div>}
      {open ? <ChatScreen key={openKey} pane={open} onBack={() => back(open)} onRetry={() => socket?.subscribe(open)} onMenu={() => setSidebarOpen(true)} onSwitch={switchTo} /> : <PaneList onOpen={openChat} onMenu={() => setSidebarOpen(true)} />}
      </div>
      {sidebarOpen && <Sidebar current={open} onClose={closeSidebar} onOpen={(p) => { closeSidebar(); if (!open || webKey(p) !== openKey) switchTo(p); }} />}
    </>
  );
}
