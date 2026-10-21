import { useCallback, useEffect, useState } from "react";
import type { Socket } from "../socket";
import { useWeb } from "../store";
import type { MachineView, WebPane } from "../types";
import { canChat } from "../config";
import { ChatHeader } from "../chat/ChatHeader";
import { ChatScreen } from "../chat/ChatScreen";
import { TerminalLens, type TransportFactory } from "../terminal/TerminalLens";
import { chooseLens, loadLens, saveLens, type Lens } from "./lens";

/** The Agent of this Pane, or null while no Machine view knows it. */
function agentOf(machines: MachineView[], pane: WebPane): string | null {
  for (const machine of machines) {
    for (const session of machine.sessions) {
      if (session.name !== pane.session) continue;
      for (const workspace of session.workspaces) {
        for (const tab of workspace.tabs) {
          const view = tab.panes.find((p) => p.pane_id === pane.pane_id);
          if (view) return view.agent;
        }
      }
    }
  }
  return null;
}

export interface PaneScreenProps {
  pane: WebPane;
  socket?: Socket;
  onBack(): void;
  onSwitch(p: WebPane): void;
  onMenu(): void;
  /** A test double for the terminal transport; the real `TerminalSocket` is the default. */
  transport?: TransportFactory;
}

/**
 * One Pane with its one header: Back, title and switcher, the Chat/Terminal selector and the
 * needs-you chip. The Chat subscription belongs to this screen, and exists only while Chat is
 * shown: hiding Chat releases the live subscription and showing it again takes a new one.
 */
export function PaneScreen({ pane, socket, onBack, onSwitch, onMenu, transport }: PaneScreenProps) {
  const agent = useWeb((s) => agentOf(s.machines, pane));
  const chatEnabled = canChat({ agent });
  /** The Lens the user picked for this Pane, or null while it follows the Agent and storage. */
  const [chosen, setChosen] = useState<Lens | null>(null);
  const lens = chosen ?? chooseLens(agent, loadLens(pane));
  // Chat hidden while Terminal is shown: the last Chat state stays, only the live feed stops.
  const [chatShown, setChatShown] = useState(lens === "chat");

  useEffect(() => {
    if (!chatShown) return;
    socket?.subscribe(pane);
    return () => socket?.unsubscribe(pane);
  }, [pane, socket, chatShown]);

  const onLens = useCallback(
    (next: Lens) => {
      setChosen(next);
      setChatShown(next === "chat");
      saveLens(pane, next);
    },
    [pane],
  );

  return (
    <div className="pane-screen">
      <ChatHeader pane={pane} onBack={onBack} onSwitch={onSwitch} onMenu={onMenu} lens={lens} onLens={onLens} chatEnabled={chatEnabled} />
      {lens === "terminal" ? (
        <TerminalLens pane={pane} transport={transport} />
      ) : (
        <ChatScreen pane={pane} onBack={onBack} onRetry={() => socket?.subscribe(pane)} onSwitch={onSwitch} onMenu={onMenu} showHeader={false} />
      )}
    </div>
  );
}
