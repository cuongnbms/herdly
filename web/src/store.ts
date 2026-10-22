import { create } from "zustand";
import { emptyChat, prepend, reduce, type ChatState } from "@desktop/chat/chatStore";
import type { Conn } from "./socket";
import { clearSeen } from "./list/seen";
import { webKey, type AppError, type ChatItem, type Frame, type Located, type MachineView, type WebPane } from "./types";

export interface ChatView {
  chat: ChatState;
  located: Located | null;
  error: AppError | null;
}

interface WebState {
  conn: Conn;
  /** The device pairing was revoked: only a socket that opens again clears this. */
  authLost: boolean;
  /**
   * The connection was being opened when the pairing was revoked. A socket's `onopen` for an
   * attempt started before the revocation proves nothing about pairing, so it is refused until
   * a connection is opened after `authLost`.
   */
  authStale: boolean;
  /** The connection was open and has been lost since: reconnect attempts show the bar. */
  lost: boolean;
  machines: MachineView[];
  /** The Pane whose Chat is shown, or null for the list. */
  open: WebPane | null;
  chats: Record<string, ChatView>;
  openChat(p: WebPane): void;
  closeChat(): void;
  apply(f: Frame): void;
  setConn(c: Conn): void;
  prependOlder(key: string, items: ChatItem[], before: number): void;
  clearChat(key: string): void;
}

const emptyView: ChatView = { chat: emptyChat, located: null, error: null };

function withChat(chats: Record<string, ChatView>, pane: WebPane, patch: (v: ChatView) => ChatView) {
  const key = webKey(pane);
  return { ...chats, [key]: patch(chats[key] ?? emptyView) };
}

export const useWeb = create<WebState>()((set) => ({
  conn: "connecting",
  authLost: false,
  authStale: false,
  lost: false,
  machines: [],
  open: null,
  chats: {},

  openChat: (p) => set({ open: p }),
  closeChat: () => set({ open: null }),

  apply: (f) =>
    set((s) => {
      switch (f.type) {
        case "machines":
          return { machines: f.views };
        case "machine": {
          const i = s.machines.findIndex((m) => m.id === f.view.id);
          return { machines: i < 0 ? [...s.machines, f.view] : s.machines.map((m, j) => (j === i ? f.view : m)) };
        }
        case "pane_status": {
          const { pane, status, title } = f.ev;
          clearSeen(webKey({ session: pane.session, pane_id: pane.pane_id }));
          return {
            machines: s.machines.map((m) => ({
              ...m,
              sessions: m.sessions.map((se) => ({
                ...se,
                workspaces: se.workspaces.map((w) => ({
                  ...w,
                  tabs: w.tabs.map((t) => ({
                    ...t,
                    panes: t.panes.map((p) => (m.id === pane.machine_id && se.name === pane.session && p.pane_id === pane.pane_id ? { ...p, status, title } : p)),
                  })),
                })),
              })),
            })),
          };
        }
        case "chat_opened":
          return { chats: withChat(s.chats, f.pane, (v) => ({ ...v, located: f.located, error: null })) };
        case "chat":
          return { chats: withChat(s.chats, f.pane, (v) => ({ ...v, chat: reduce(v.chat, f.event, false) })) };
        case "chat_error":
          return { chats: withChat(s.chats, f.pane, (v) => ({ ...v, error: f.error })) };
        default:
          return {};
      }
    }),

  setConn: (conn) =>
    set((s) => {
      // A revoked pairing is sticky, whichever socket noticed it: the Chat socket's frames and a
      // live Machine view are not fresh authentication, so they cannot bring the paired UI back.
      // Only a socket that opens again proves the device is paired, and only one whose attempt
      // began after the revocation: an `onopen` already in flight was not re-authenticated.
      if (conn === "unpaired") return { conn, authLost: true, authStale: true };
      // A connection whose handshake starts now is a new authentication attempt, so a later
      // `open` on it is proof; an `open` on one started before is not.
      if (conn === "connecting") return s.authLost ? { authStale: false, lost: s.lost } : { conn, lost: s.lost };
      if (s.authLost) {
        if (conn === "open" && !s.authStale) return { conn, lost: false, authLost: false };
        return { lost: conn === "down" ? true : s.lost };
      }
      return { conn, lost: conn === "open" ? false : s.lost || conn === "down" };
    }),

  prependOlder: (key, items, before) =>
    set((s) => {
      const v = s.chats[key];
      return v ? { chats: { ...s.chats, [key]: { ...v, chat: prepend(v.chat, items, before) } } } : {};
    }),

  clearChat: (key) =>
    set((s) => {
      const { [key]: _gone, ...chats } = s.chats;
      return { chats };
    }),
}));
