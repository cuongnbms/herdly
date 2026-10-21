import type { AppError, ChatEvent, Located, MachineView, PaneStatusEvent } from "@desktop/lib/types";

export type {
  AgentStatus,
  AppError,
  ChatEvent,
  ChatItem,
  Located,
  MachineView,
  PaneStatusEvent,
} from "@desktop/lib/types";

export interface WebPane {
  session: string;
  pane_id: string;
}

export const webKey = (p: WebPane) => `${p.session}/${p.pane_id}`;

export type Frame =
  | { type: "machines"; views: MachineView[] }
  | { type: "machine"; view: MachineView }
  | { type: "pane_status"; ev: PaneStatusEvent }
  | { type: "chat_opened"; pane: WebPane; located: Located }
  | { type: "chat"; pane: WebPane; event: ChatEvent }
  | { type: "chat_error"; pane: WebPane; error: AppError };
