import { lazy, Suspense, useEffect, useMemo, type CSSProperties } from "react";
import "./fonts/fonts.css";
import "./styles.css";
import { appQuit, machinesList, onMachine, onMouseNav, onNotifyActivate, onQuitRequested, onPaneStatus, sessionStart } from "./lib/ipc";
import { notifyPaneStatus } from "./notify";
import { Palette } from "./palette/Palette";
import { Settings } from "./settings/Settings";
import { applyChatFont, useSettings } from "./settings/store";
import { applyTheme, useTheme } from "./settings/theme";
import { Header } from "./main/Header";
import { OpenStrip } from "./main/OpenStrip";
import { Sidebar } from "./sidebar/Sidebar";
import { ResizeHandle } from "./sidebar/ResizeHandle";
import { useSidebarWidths } from "./settings/sidebarWidths";
import { guardFileDrops } from "./sidebar/dnd";
import { AgentList } from "./agents/AgentList";
import { AgentDashboard } from "./dashboard/AgentDashboard";
import { FilesPanel } from "./files/FilesPanel";
import { GitPanel } from "./git/GitPanel";
import { useFilesPanel } from "./files/panelStore";
import { openNewTabHere } from "./agents/newTabShortcut";
import { paneKey } from "./lib/types";
import { activeItem, chosenLens, selectedPane, useApp, viewedItems } from "./store/app";
import { itemKey } from "./store/openItems";
import { syncDockBadge } from "./store/dockBadge";
import { syncSeenToHerdr } from "./store/seenSync";
import { closeItemsGuarded, settleDrafts } from "./files/closeGuard";
import { useDrafts } from "./files/drafts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { UnsavedDialog } from "./files/unsaved";
import { showToast, Toasts } from "./ui/Toast";
import { openUrl } from "@tauri-apps/plugin-opener";
import { defaultLens } from "./lens";
import { useTranscriptProbe } from "./chat/transcriptProbe";
import { AlertIcon, LayersIcon, TerminalIcon } from "./ui/icons";
import { StartingOverlay } from "./terminal/StartingOverlay";
import { goBack, goForward } from "./store/history";

function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

function EmptyMain() {
  const local = useApp((s) => s.machines["local"]);
  if (local?.state === "error" && local.error?.code === "herdr_not_found") {
    return (
      <EmptyState icon={<AlertIcon />} title="herdr is not installed on this Mac">
        <p className="empty-hint">The app talks to the herdr multiplexer running on each machine.</p>
        <p>
          <a
            className="btn btn-primary"
            href="https://herdr.dev"
            onClick={(e) => {
              e.preventDefault();
              void openUrl("https://herdr.dev").catch((err) => console.error("openUrl failed", err));
            }}
          >
            Install herdr
          </a>
        </p>
      </EmptyState>
    );
  }
  if (local?.state === "connected" && !local.sessions.some((s) => s.running)) {
    return (
      <EmptyState icon={<LayersIcon />} title="No running sessions">
        <p className="empty-hint">Start a herdr session to see its workspaces and agents here.</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() =>
            void sessionStart("local", "default").catch((err: unknown) =>
              showToast(`Could not start the default session: ${(err as { message?: string } | null)?.message ?? String(err)}`),
            )
          }
        >
          Start default session
        </button>
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<TerminalIcon />} title="Select a pane">
      <p className="empty-hint">
        Pick an agent from the list, or press <kbd>⌘</kbd> <kbd>K</kbd> to jump to any pane.
      </p>
    </EmptyState>
  );
}

const ChatLens = lazy(() => import("./chat/ChatLens").then((m) => ({ default: m.ChatLens })));
const TerminalLens = lazy(() => import("./terminal/TerminalLens").then((m) => ({ default: m.TerminalLens })));
// react-markdown and lowlight load with the first open file, not with the app.
const FileViewer = lazy(() => import("./files/FileViewer").then((m) => ({ default: m.FileViewer })));

export default function App() {
  const upsert = useApp((s) => s.upsertMachine);
  // Only the selected Pane and its ids: a change elsewhere on its Machine does not re-render App.
  const selected = useApp((s) => s.selected);
  const pane = useApp((s) => selectedPane(s)?.pane ?? null);
  const remembered = useApp((s) => (s.selected ? chosenLens(s, paneKey(s.selected)) : undefined));
  const starting = useApp((s) => (s.selected ? !!s.starting[paneKey(s.selected)] : false));
  const paletteOpen = useApp((s) => s.paletteOpen);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const dashboardOpen = useApp((s) => s.dashboardOpen);
  const item = useApp(activeItem);
  const online = useApp((s) => (item && item.kind !== "agent" ? s.machines[item.ws.machine_id]?.state === "connected" : false));
  const chatFontSize = useSettings((s) => s.chatFontSize);

  const theme = useTheme((s) => s.theme);
  const themePref = useTheme((s) => s.pref);

  useEffect(() => applyChatFont(chatFontSize), [chatFontSize]);
  useEffect(() => applyTheme(theme, themePref), [theme, themePref]);
  useEffect(() => syncSeenToHerdr(), []);
  useEffect(() => syncDockBadge(), []);
  useEffect(() => guardFileDrops(), []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void machinesList().then((ms) => {
      if (!cancelled) ms.forEach(upsert);
    }).catch((e) => console.error("machines_list failed", e));
    void onMachine(upsert).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [upsert]);

  // Notifications: show one per status change, and jump to its pane when clicked.
  useEffect(() => {
    let cancelled = false;
    const unlisten: (() => void)[] = [];
    const keep = (u: () => void) => {
      if (cancelled) u();
      else unlisten.push(u);
    };
    void onPaneStatus((ev) => {
      const { selected, machines } = useApp.getState();
      void notifyPaneStatus(ev, selected, machines);
    }).then(keep);
    void onNotifyActivate((pane) => useApp.getState().select(pane)).then(keep);
    // The mouse's Back and Forward buttons, caught natively: WKWebView does not pass them to the page.
    void onMouseNav((dir) => {
      if (document.querySelector(".overlay")) return;
      if (dir === "back") goBack();
      else goForward();
    }).then(keep);
    return () => {
      cancelled = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  // Closing the window or quitting asks about unsaved Drafts first.
  useEffect(() => {
    const allKeys = () => Object.keys(useDrafts.getState().drafts);
    const unlisten = [
      getCurrentWindow().onCloseRequested(async (e) => {
        e.preventDefault();
        if (await settleDrafts(allKeys())) await getCurrentWindow().destroy();
      }),
      onQuitRequested(async () => {
        if (await settleDrafts(allKeys())) await appQuit();
      }),
    ];
    return () => unlisten.forEach((u) => void u.then((f) => f()));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While the dashboard is open, ⌘K focuses its search instead.
      if (e.metaKey && e.key.toLowerCase() === "k" && !useApp.getState().dashboardOpen) {
        e.preventDefault();
        const { paletteOpen, setPaletteOpen } = useApp.getState();
        setPaletteOpen(!paletteOpen);
      }
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (e.repeat) return;
        const { dashboardOpen, setDashboardOpen, setPaletteOpen } = useApp.getState();
        setPaletteOpen(false);
        setDashboardOpen(!dashboardOpen);
      }
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        if (e.repeat) return;
        openNewTabHere().catch((err: unknown) =>
          showToast(`Could not open a new tab: ${(err as { message?: string } | null)?.message ?? String(err)}`),
        );
      }
      const plain = e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey;
      const k = e.key.toLowerCase();
      // A dialog keeps its keys.
      if (document.querySelector(".overlay")) return;
      if (plain && k === "e") {
        e.preventDefault();
        if (e.repeat) return;
        // Flips the shown pane between the Terminal and Chat lenses; a file or diff item has no lens.
        const s = useApp.getState();
        const sel = selectedPane(s);
        const shown = activeItem(s);
        if (!sel?.pane.agent || (shown && shown.kind !== "agent")) return;
        const key = paneKey({ machine_id: sel.machine.id, session: sel.session.name, pane_id: sel.pane.pane_id });
        s.setLens(key, defaultLens(sel.pane, chosenLens(s, key)) === "chat" ? "terminal" : "chat");
      } else if (plain && k === "p") {
        e.preventDefault();
        if (e.repeat || useApp.getState().paletteOpen) return;
        useFilesPanel.getState().focusGoto();
      } else if (plain && k === "w") {
        e.preventDefault();
        if (e.repeat) return;
        const active = viewedItems(useApp.getState()).active;
        if (active) void closeItemsGuarded(active, "one");
      } else if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault();
        useApp.getState().cycleItems(e.code === "BracketLeft" ? -1 : 1);
      } else if (plain && (e.code === "BracketLeft" || e.code === "BracketRight") && !e.defaultPrevented) {
        // An editor that took ⌘[ (indent) has already prevented it.
        e.preventDefault();
        if (e.code === "BracketLeft") goBack();
        else goForward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { machine_id, session, pane_id } = selected ?? {};
  const selRef = useMemo(
    () => (machine_id && session && pane_id ? { machine_id, session, pane_id } : null),
    [machine_id, session, pane_id],
  );
  const ref = pane ? selRef : null;
  const key = ref ? paneKey(ref) : "";
  useTranscriptProbe(ref, pane?.status);

  const sidebarW = useSidebarWidths((s) => s.sidebar);
  const agentsW = useSidebarWidths((s) => s.agents);

  return (
    <div className="app" style={{ "--sidebar-w": `${sidebarW}px`, "--agents-w": `${agentsW}px` } as CSSProperties}>
      <nav className="sidebar" aria-label="Machines">
        <div className="titlebar" data-tauri-drag-region />
        <div className="sidebar-scroll">
          <Sidebar />
        </div>
        <Settings />
        <ResizeHandle column="sidebar" label="Resize Machines" />
      </nav>
      <aside className="agents" aria-label="Agents">
        <AgentList />
        <FilesPanel />
        <GitPanel />
        <ResizeHandle column="agents" label="Resize Agents" />
      </aside>
      <main className="main">
        {item?.kind === "file" ? (
          <>
            {pane && ref ? <Header /> : <div className="titlebar" data-tauri-drag-region />}
            <OpenStrip />
            <Suspense fallback={null}>
              <FileViewer key={itemKey(item)} item={item} online={online} />
            </Suspense>
          </>
        ) : pane && ref ? (
          <>
            <Header />
            <OpenStrip />
            <Suspense fallback={null}>
              {defaultLens(pane, remembered) === "chat" ? (
                <ChatLens key={key} pane={ref} view={pane} />
              ) : (
                <TerminalLens key={key} pane={ref} terminalId={pane.terminal_id} />
              )}
            </Suspense>
          </>
        ) : selRef && starting ? (
          // herdr reports a new pane only in its next snapshot: keep the loading overlay up until then
          // rather than flashing the empty state.
          <>
            <div className="titlebar" data-tauri-drag-region />
            <OpenStrip />
            <div className="term-lens">
              <StartingOverlay pane={selRef} />
            </div>
          </>
        ) : (
          <>
            <div className="titlebar" data-tauri-drag-region />
            <OpenStrip />
            <div className="main-empty">
              <EmptyMain />
            </div>
          </>
        )}
      </main>
      {dashboardOpen && <AgentDashboard />}
      <Toasts />
      <UnsavedDialog />
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
