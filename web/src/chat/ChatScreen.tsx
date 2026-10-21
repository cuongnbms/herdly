import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { chatPage, panePrompt } from "../api";
import { CHAT_PAGE } from "../config";
import { useWeb } from "../store";
import { webKey, type ChatItem, type WebPane } from "../types";
import { ItemView, userBubble } from "./ItemView";
import { isStale, settle, type Pending } from "./pending";

const BADGE: Record<string, string> = { blocked: "#c0392b", working: "#2e7d32", done: "#1565c0", idle: "#757575", unknown: "#757575" };
const AT_BOTTOM_PX = 40;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What the bottom bar holds; Task 11 swaps the Composer for the prompt card while blocked. */
function Composer({ pane, onSent, onFailed }: { pane: WebPane; onSent(text: string): number; onFailed(id: number): void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const t = text;
    if (!t.trim()) return;
    setText("");
    setError(null);
    const id = onSent(t);
    try {
      await panePrompt(pane, t);
    } catch (e) {
      setText((cur) => (cur ? `${t}\n${cur}` : t));
      setError(errorText(e));
      onFailed(id);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {error && <div role="alert" style={{ color: "#c0392b", fontSize: 13 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea aria-label="Message" rows={2} value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, font: "inherit", minHeight: 44 }} />
        <button type="button" onClick={send} style={{ minHeight: 44, minWidth: 64 }}>Send</button>
      </div>
    </div>
  );
}

export function ChatScreen({ pane, onBack, onRetry }: { pane: WebPane; onBack(): void; onRetry(): void }) {
  const key = webKey(pane);
  const view = useWeb((s) => s.chats[key]);
  const paneView = useWeb((s) =>
    s.machines.flatMap((m) => m.sessions).filter((se) => se.name === pane.session)
      .flatMap((se) => se.workspaces).flatMap((w) => w.tabs).flatMap((t) => t.panes).find((p) => p.pane_id === pane.pane_id),
  );
  const prependOlder = useWeb((s) => s.prependOlder);

  const items: ChatItem[] = view?.chat.items ?? [];
  const total = view?.chat.total ?? 0;
  const before = total - items.length;
  const error = view?.error ?? view?.chat.error ?? null;

  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchorHeight = useRef<number | null>(null);
  const asked = useRef<number | null>(null);

  // Pending messages: settled only by items that arrived after the send.
  const [pending, setPending] = useState<Pending[]>([]);
  const nextId = useRef(1);
  const prevItems = useRef<ChatItem[]>(items);
  const [now, setNow] = useState(() => Date.now());

  useLayoutEffect(() => {
    const prev = prevItems.current;
    prevItems.current = items;
    if (prev === items) return;
    const last = prev[prev.length - 1];
    const at = last === undefined ? -1 : items.lastIndexOf(last);
    const fresh = at >= 0 ? items.slice(at + 1) : items;
    if (fresh.length > 0) setPending((ps) => settle(ps, fresh));
  }, [items]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (anchorHeight.current !== null) {
      el.scrollTop += el.scrollHeight - anchorHeight.current;
      anchorHeight.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items, pending]);

  useEffect(() => {
    if (pending.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);

  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
    if (el.scrollTop > 0 || before <= 0 || asked.current === before) return;
    const at = before;
    asked.current = at;
    anchorHeight.current = el.scrollHeight;
    chatPage(pane, at, CHAT_PAGE).then(
      (older) => prependOlder(key, older, at),
      () => {
        anchorHeight.current = null;
        asked.current = null;
      },
    );
  }, [before, pane, key, prependOlder]);

  const onSent = (text: string) => {
    const id = nextId.current++;
    setNow(Date.now());
    setPending((ps) => [...ps, { id, text, sentAt: Date.now() }]);
    return id;
  };
  const onFailed = (id: number) => setPending((ps) => ps.filter((p) => p.id !== id));

  const status = paneView?.status ?? "unknown";
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", maxWidth: 720, margin: "0 auto" }}>
      <header style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #8884" }}>
        <button type="button" aria-label="Back" onClick={onBack} style={{ minHeight: 44, minWidth: 44 }}>←</button>
        <strong style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{paneView?.title ?? pane.pane_id}</strong>
        <span data-status={status} style={{ background: BADGE[status] ?? BADGE.unknown, color: "#fff", borderRadius: 10, padding: "2px 8px", fontSize: 12 }}>{status}</span>
      </header>
      {view?.located?.ambiguous && <div style={{ padding: "4px 12px", fontSize: 13 }}>Several transcripts match; showing the newest</div>}
      {error && (
        <div role="alert" style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: "#c0392b", color: "#fff" }}>
          <span style={{ flex: 1 }}>{error.message}</span>
          <button type="button" onClick={onRetry} style={{ minHeight: 44 }}>Retry</button>
        </div>
      )}
      <div ref={box} data-transcript onScroll={onScroll} style={{ flex: 1, overflowY: "auto" }}>
        {items.map((it, i) => <ItemView key={before + i} item={it} />)}
        {pending.map((p) => (
          <div key={p.id} data-pending style={{ ...userBubble, opacity: 0.55 }}>
            <div>{p.text}</div>
            {isStale(p, now) && <div style={{ fontSize: 12 }}>not seen yet</div>}
          </div>
        ))}
      </div>
      <footer style={{ padding: "8px 12px", borderTop: "1px solid #8884" }}>
        <Composer pane={pane} onSent={onSent} onFailed={onFailed} />
      </footer>
    </div>
  );
}
