import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { chatPage, panePrompt } from "../api";
import { CHAT_PAGE } from "../config";
import { useWeb } from "../store";
import { webKey, type ChatItem, type PaneView, type WebPane } from "../types";
import { ItemView, userBubble } from "./ItemView";
import { isStale, settle, type Pending } from "./pending";
import { ChatHeader } from "./ChatHeader";
import { PromptCard } from "../prompt/PromptCard";
import { Composer, type Draft } from "./Composer";
import { loadDraft, saveDraft } from "./drafts";
import { usePrompt } from "../prompt/usePrompt";

const AT_BOTTOM_PX = 40;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The prompt card instead of the Composer while the Pane is blocked. */
function BottomBar({ pane, view, onSent, onFailed }: { pane: WebPane; view: PaneView | undefined; onSent(text: string): number; onFailed(id: number): void }) {
  const blocked = view?.status === "blocked";
  const key = webKey(pane);
  // The draft lives here, not in Composer, so a prompt that hides Composer does not lose it.
  const [draft, setDraftState] = useState<Draft>(() => ({ text: loadDraft(key), error: null }));
  const setDraft = (d: Draft) => {
    setDraftState(d);
    saveDraft(key, d.text);
  };
  const send = async () => {
    const t = draft.text;
    if (!t.trim()) return;
    setDraftState({ text: "", error: null });
    saveDraft(key, "");
    const id = onSent(t);
    try {
      await panePrompt(pane, t);
    } catch (e) {
      const cur = loadDraft(key);
      const restored = cur ? `${t}\n${cur}` : t;
      saveDraft(key, restored);
      setDraftState({ text: restored, error: errorText(e) });
      onFailed(id);
    }
  };
  return (
    blocked ? <BlockedPrompt pane={pane} view={view} /> : <Composer pane={pane} working={view?.status === "working"} draft={draft} setDraft={setDraft} onSend={send} />
  );
}

/** Owns the clock for "not seen yet", so its tick re-renders only this bubble. */
function PendingBubble({ p }: { p: Pending }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div data-pending style={{ ...userBubble, opacity: 0.55 }}>
      <div>{p.text}</div>
      {isStale(p, now) && <div style={{ fontSize: 12 }}>not seen yet</div>}
    </div>
  );
}

function BlockedPrompt({ pane, view }: { pane: WebPane; view: PaneView }) {
  const { prompt, answer, busy, error } = usePrompt(pane, view);
  return prompt ? <PromptCard key={prompt.id} prompt={prompt} busy={busy} error={error} onAnswer={(a) => void answer(a)} /> : null;
}

export function ChatScreen({ pane, onBack, onRetry, onSwitch }: { pane: WebPane; onBack(): void; onRetry(): void; onSwitch?(p: WebPane): void }) {
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

  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
    if (el.scrollTop > 0 || before <= 0 || asked.current === before) return;
    const at = before;
    asked.current = at;
    chatPage(pane, at, CHAT_PAGE).then(
      (older) => {
        asked.current = null;
        const el2 = box.current;
        const itemsOf = () => useWeb.getState().chats[key]?.chat.items;
        const was = itemsOf();
        anchorHeight.current = el2 ? el2.scrollHeight : null;
        prependOlder(key, older, at);
        // A stale page changes nothing: no render follows, so drop the anchor.
        if (itemsOf() === was) anchorHeight.current = null;
      },
      () => {
        asked.current = null;
      },
    );
  }, [before, pane, key, prependOlder]);

  const onSent = (text: string) => {
    const id = nextId.current++;
    setPending((ps) => [...ps, { id, text, sentAt: Date.now() }]);
    return id;
  };
  const onFailed = (id: number) => setPending((ps) => ps.filter((p) => p.id !== id));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", maxWidth: 720, margin: "0 auto" }}>
      <ChatHeader pane={pane} onBack={onBack} onSwitch={onSwitch} />
      {view?.located?.ambiguous && <div style={{ padding: "4px 12px", fontSize: 13 }}>Several transcripts match; showing the newest</div>}
      {error && (
        <div role="alert" style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: "#c0392b", color: "#fff" }}>
          <span style={{ flex: 1 }}>{error.message}</span>
          <button type="button" onClick={onRetry} style={{ minHeight: 44 }}>Retry</button>
        </div>
      )}
      <div ref={box} data-transcript onScroll={onScroll} style={{ flex: 1, overflowY: "auto" }}>
        {items.map((it, i) => <ItemView key={before + i} item={it} />)}
        {pending.map((p) => <PendingBubble key={p.id} p={p} />)}
      </div>
      <footer className="chat-footer">
        <BottomBar pane={pane} view={paneView} onSent={onSent} onFailed={onFailed} />
      </footer>
    </div>
  );
}
