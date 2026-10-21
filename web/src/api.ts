import { CHAT_PAGE } from "./config";
import type { ChatItem, MachineView, WebPane } from "./types";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { credentials: "same-origin" }
      : {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  const res = await fetch(url, init);
  if (!res.ok) {
    const e = await res.json().catch(() => null);
    throw new ApiError(res.status, e?.code ?? "unknown", e?.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

export const getMe = () => call<{ device_id: string; name: string }>("/api/me");

export const getMachines = () => call<MachineView[]>("/api/machines");

export function chatPage(p: WebPane, before: number, limit = CHAT_PAGE): Promise<ChatItem[]> {
  const q = new URLSearchParams({ session: p.session, pane_id: p.pane_id, before: String(before), limit: String(limit) });
  return call<ChatItem[]>(`/api/chat/page?${q}`);
}

export async function paneRead(p: WebPane): Promise<string> {
  return (await call<{ text: string }>("/api/pane/read", { session: p.session, pane_id: p.pane_id })).text;
}

export async function panePrompt(p: WebPane, text: string): Promise<void> {
  await call("/api/pane/prompt", { session: p.session, pane_id: p.pane_id, text });
}

export async function paneKeys(p: WebPane, keys: string[]): Promise<void> {
  await call("/api/pane/keys", { session: p.session, pane_id: p.pane_id, keys });
}

export async function paneText(p: WebPane, text: string): Promise<void> {
  await call("/api/pane/text", { session: p.session, pane_id: p.pane_id, text });
}
