import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./nav/Sidebar";
import type { Socket } from "./socket";
import { PaneList } from "./list/PaneList";
import { PaneScreen } from "./pane/PaneScreen";
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

/** `socket` is main.tsx's one Chat connection; PaneScreen subscribes through it only for Chat. */
export function App({ socket }: { socket?: Socket }) {
  useAttention();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarSession, setSidebarSession] = useState<string | null>(null);
  const [sidebarWorkspaces, setSidebarWorkspaces] = useState<Record<string, boolean>>({});
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const conn = useWeb((s) => s.conn);
  const lost = useWeb((s) => s.lost);
  const open = useWeb((s) => s.open);
  const openChat = useWeb((s) => s.openChat);
  const closeChat = useWeb((s) => s.closeChat);
  const clearChat = useWeb((s) => s.clearChat);
  const openKey = open ? webKey(open) : null;
  // Selecting a Pane is not a subscription: PaneScreen owns the Chat subscription, and its
  // unmount releases it, so Back and a Pane switch clean up without App touching the wire.
  const back = (p: WebPane) => {
    clearChat(webKey(p));
    closeChat();
  };
  const switchTo = (next: WebPane) => {
    if (open) clearChat(webKey(open));
    openChat(next);
  };
  // Android asks the React screen first: WebView history does not track Pane selection.
  useEffect(() => {
    const onAndroidBack = (event: Event) => {
      if (conn === "unpaired" || !open) return;
      event.preventDefault();
      clearChat(webKey(open));
      closeChat();
    };
    window.addEventListener("herdly:android-back", onAndroidBack);
    return () => window.removeEventListener("herdly:android-back", onAndroidBack);
  }, [conn, open, clearChat, closeChat]);
  if (conn === "unpaired") return <NotPaired />;
  return (
    <>
      <div className="app-content" inert={sidebarOpen}>
      {(conn === "down" || (conn === "connecting" && lost)) && <div role="status" className="banner banner-warn reconnect">Disconnected, reconnecting…</div>}
      {open ? <PaneScreen key={openKey} pane={open} socket={socket} onBack={() => back(open)} onSwitch={switchTo} onMenu={() => setSidebarOpen(true)} /> : <PaneList onOpen={openChat} onMenu={() => setSidebarOpen(true)} />}
      </div>
      {sidebarOpen && <Sidebar
        current={open}
        selectedSession={sidebarSession}
        onSelectSession={setSidebarSession}
        expandedWorkspaces={sidebarWorkspaces}
        onToggleWorkspace={(key, expanded) => setSidebarWorkspaces((previous) => ({ ...previous, [key]: expanded }))}
        onClose={closeSidebar}
        onOpen={(p) => { closeSidebar(); if (!open || webKey(p) !== openKey) switchTo(p); }}
      />}
    </>
  );
}
