import { Channel } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { chatLocate, chatPage } from "../lib/ipc";
import { paneKey, type AppError, type ChatEvent, type ChatItem, type Located, type PaneRef, type PaneView } from "../lib/types";
import { useApp } from "../store/app";
import { onOpenFailure, openChat, watchMachine } from "./chatSession";
import { PromptPanel } from "./PromptPanel";
import { pendingQuestions } from "./prompt/askedPreviews";
import { emptyChat, prepend, reduce, type ChatState } from "./chatStore";
import { ChatItemView } from "./ChatItemView";
import { canFork, forkChat, latestForkRow } from "./forkChat";
import { ChatOpenContext, ChatPaneContext, revokeChatImages } from "./images";
import { WorkBlockView } from "./WorkBlockView";
import { buildRows } from "./workBlocks";
import { ChatOutline } from "./ChatOutline";
import { currentEntry, outline } from "./outline";
import { Composer } from "./Composer";
import { BtwCard } from "./BtwCard";
import { closeSide, setBtwMode, useBtw } from "./btw";
import { WorkingIndicator } from "./WorkingIndicator";
import { usePiModelPicker } from "./usePiModelPicker";
import { usePendingTranscript } from "./pendingTranscript";
import { useOutgoing } from "./outgoing";
import { ArrowDownIcon } from "../ui/icons";
import { RESTORE_PAGES, restoreTarget, rowForItem, savedPosition, savePosition, topVisible } from "./readingPosition";
import { forgetTranscript, rememberedTranscript, rememberTranscript, TranscriptPicker } from "./TranscriptPicker";

/** How long an open that has not answered yet may go without saying the transcript is loading. */
const LOADING_DELAY = 150;
/** How long a row an append brought eases in (the CSS --t): a row remounted later shows at once. */
const ENTER_MS = 180;
/** The share of the way to the end the follow scroll covers each frame. */
const FOLLOW_STEP = 0.3;

type Action = (ChatEvent & { atBottom?: boolean }) | { type: "prepend"; items: ChatItem[]; before: number };
const reducer = (s: ChatState, a: Action): ChatState => (a.type === "prepend" ? prepend(s, a.items, a.before) : reduce(s, a, a.atBottom));

export function ChatLens({ pane, view }: { pane: PaneRef; view: PaneView }) {
  const key = paneKey(pane);
  const setLensOverride = useApp((s) => s.setLensOverride);
  const pinAgent = useApp((s) => s.pinAgent);
  const machineState = useApp((s) => s.machines[pane.machine_id]?.state);
  const sawDown = useRef(false);
  const [state, dispatch] = useReducer(reducer, emptyChat);
  const latest = useRef(state);
  latest.current = state;
  const [located, setLocated] = useState<Located | null>(null);
  const [openError, setOpenError] = useState<AppError | null>(null);
  const [unseen, setUnseen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const loadingOlder = useRef(false);
  const anchor = useRef<number | null>(null);
  const forceBottom = useRef(true);
  const generation = useRef(0);
  const handle = useRef<{ close: () => void } | null>(null);
  // The open's Transcript path, once known: the reading position is kept under it.
  const pathRef = useRef<string | null>(null);
  // A restore is owed until the first Reset of an open has been placed (or given up on).
  const restoreArmed = useRef(false);
  const restorePages = useRef(0);
  const resets = useRef(0);
  // Bumped when the restore may proceed (the path became known, paging gave up): the effect re-runs.
  const [restoreTick, setRestoreTick] = useState(0);
  const saveReadingRef = useRef(() => {});
  // Bumped on each `reset`: thumbnails that failed while the tail was gone ask again.
  const [opened, setOpened] = useState(0);
  // The first Reset waits for the whole backlog (seconds over a slow ssh): say so meanwhile.
  const [loaded, setLoaded] = useState(false);
  // Held back while the open may be a reattach to the running tail, whose Reset comes at once:
  // shown once the open turns out to have located, or after `LOADING_DELAY` without an answer.
  const [loadingShown, setLoadingShown] = useState(false);
  const loadingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Work blocks the user opened or closed, by block id: a virtualized row forgets its own state.
  const [chosenOpen, setChosenOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  // The turn picked in the rail stays lit until the user scrolls: near the end it may not reach
  // the top, and the end rule would light the last turn instead.
  const [picked, setPicked] = useState<string | null>(null);
  // The Pane `/model` was sent to: pi waits on its picker idle, so the picker is looked for then.
  const [modelFor, setModelFor] = useState<string | null>(null);
  const picker = usePiModelPicker(pane, modelFor === key && view.agent === "pi", () => setModelFor(null));
  useEffect(() => setModelFor(null), [key]);
  // Sent messages shown until the transcript echoes them.
  const outgoing = useOutgoing();
  const outgoingRef = useRef(0);
  outgoingRef.current = outgoing.list.length;
  // The first absolute index the appends since the last render brought, and whether a sent
  // message was shown meanwhile: its echo takes its place rather than coming in.
  const enterFrom = useRef<{ at: number; echo: boolean } | null>(null);
  // The open's item total as its events have told it.
  const heard = useRef(0);
  // Rows easing in, by key, until when.
  const entering = useRef(new Map<string, number>());
  // The scroll before the appends since the last render.
  const topBefore = useRef<number | null>(null);

  // `known`: where `path` was located, when the caller already knows (kept over what opening returns).
  const open = useCallback(
    (path: string | null, known?: Located) => {
      saveReadingRef.current();
      pathRef.current = null;
      restoreArmed.current = true;
      restorePages.current = 0;
      resets.current = 0;
      const gen = ++generation.current;
      setOpenError(null);
      setLoaded(false);
      setLoadingShown(false);
      clearTimeout(loadingTimer.current);
      loadingTimer.current = setTimeout(() => {
        if (gen === generation.current) setLoadingShown(true);
      }, LOADING_DELAY);
      const channel = new Channel<ChatEvent>();
      channel.onmessage = (ev) => {
        if (gen !== generation.current) return;
        if (ev.type === "reset" || ev.type === "error") setLoaded(true);
        // Counted here, not read off the last render: a reset and an append may land before it.
        if (ev.type === "append") {
          topBefore.current ??= scrollRef.current?.scrollTop ?? null;
          const at = heard.current;
          heard.current += ev.items.length;
          enterFrom.current = { at: Math.min(at, enterFrom.current?.at ?? at), echo: !!enterFrom.current?.echo || outgoingRef.current > 0 };
        }
        if (ev.type === "reset") {
          heard.current = ev.total;
          enterFrom.current = null;
        }
        // A reset may come after a send (a slow first load, pi's branch switch): keep what it does not echo.
        if (ev.type === "append" || ev.type === "reset") outgoing.seen(ev.items);
        if (ev.type === "reset") {
          // Only the open's first Reset is restored; a later one (a branch switch) goes to the bottom.
          if (resets.current++ > 0) restoreArmed.current = false;
          forceBottom.current = true;
          setOpened((n) => n + 1);
        }
        dispatch(ev.type === "append" ? { ...ev, atBottom: atBottom.current } : ev);
      };
      handle.current?.close();
      const h = openChat(pane, path, channel);
      handle.current = h;
      h.opened
        .then((l) => {
          if (gen !== generation.current || !l) return;
          pathRef.current = (known ?? l).path;
          setLocated(known ?? l);
          setRestoreTick((n) => n + 1);
          clearTimeout(loadingTimer.current);
          if (!l.cached) setLoadingShown(true);
          // Reopened on the running tail without locating: the agent may since have moved on to
          // another transcript, so locate it now, off the open's path.
          if (l.cached && path === null) {
            chatLocate(pane).then(
              (fresh) => {
                if (gen !== generation.current) return;
                if (fresh.path !== l.path) open(fresh.path, fresh);
                else setLocated(fresh);
              },
              () => {},
            );
          }
        })
        .catch((e: AppError) => {
          if (gen !== generation.current) return;
          const machine = useApp.getState().machines[pane.machine_id]?.state;
          switch (onOpenFailure(path, e, machine)) {
            case "retry_auto":
              forgetTranscript(key);
              open(null);
              break;
            case "fallback":
              // In memory only: a fresh pane's transcript appears after its first prompt, and
              // useTranscriptProbe returns to Chat then when new agents open on Chat.
              setLensOverride(key, "terminal");
              break;
            case "error":
              setOpenError(e);
          }
        });
    },
    [pane, key, setLensOverride, outgoing.seen, outgoing.clear],
  );

  // The tail dies with an ssh drop: reopen once the Machine is back.
  useEffect(() => {
    const w = watchMachine(sawDown.current, machineState);
    sawDown.current = w.sawDown;
    if (w.reopen) open(rememberedTranscript(key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineState]);

  useEffect(() => {
    setChosenOpen(new Map());
    setPicked(null);
    setLocated(null);
    outgoing.clear();
    open(rememberedTranscript(key));
    return () => {
      saveReadingRef.current();
      generation.current++;
      handle.current?.close();
      handle.current = null;
      clearTimeout(loadingTimer.current);
      revokeChatImages(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A new Claude has no transcript until its first prompt: chat with it on the expected path.
  const pending = !!located?.pending && state.items.length === 0;
  usePendingTranscript(pane, located, state.items.length === 0, view.status, () => open(null));
  // Items on the pending path mean Claude wrote the file there: it is located now (forks, side questions).
  const written = !!located?.pending && state.items.length > 0;
  useEffect(() => {
    if (written) setLocated((l) => l && { ...l, pending: false });
  }, [written]);

  const choose = (path: string) => {
    outgoing.clear();
    rememberTranscript(key, path);
    open(path);
  };

  // Tool results render inside their call; each turn's work folds into one row.
  const { rows, results } = useMemo(() => buildRows(state.items, state.total - state.items.length), [state.items, state.total]);
  const asked = useMemo(() => pendingQuestions(state.items), [state.items]);
  useMemo(() => {
    const from = enterFrom.current;
    if (!from) return;
    enterFrom.current = null;
    const until = performance.now() + ENTER_MS;
    for (const r of rows) {
      if (r.at < from.at || entering.current.has(r.key)) continue;
      if (from.echo && r.kind === "item" && r.item.kind === "user") continue;
      entering.current.set(r.key, until);
    }
  }, [rows]);
  const now = performance.now();
  for (const [k, until] of entering.current) if (until <= now) entering.current.delete(k);
  const toggle = useCallback((id: string, wasOpen: boolean) => {
    setChosenOpen((m) => new Map(m).set(id, !wasOpen));
  }, []);
  const forkPath = located?.path;
  const forkAgent = located?.agent;
  /** The user message whose fork is running, so its button shows busy. */
  const [forking, setForking] = useState<string | null>(null);
  const onFork = useCallback(
    async (it: { id: string; text: string }) => {
      setForking(it.id);
      try {
        await forkChat(pane, forkAgent as "claude" | "pi", forkPath!, it);
      } finally {
        setForking((f) => (f === it.id ? null : f));
      }
    },
    [pane, forkAgent, forkPath],
  );
  /** A fork from the latest entry is running, so the last answer's button shows busy. */
  const [forkingLatest, setForkingLatest] = useState(false);
  const onForkLatest = useCallback(async () => {
    setForkingLatest(true);
    try {
      await forkChat(pane, forkAgent as "claude" | "pi", forkPath!, null);
    } finally {
      setForkingLatest(false);
    }
  }, [pane, forkAgent, forkPath]);
  const forkable = canFork(view.agent, located) && located?.agent === view.agent;
  // A thread belongs to the Transcript it forked; a lens that moved to another one drops it.
  const btwPathOf = useBtw((s) => s.threads[key]?.path);
  useEffect(() => {
    if (btwPathOf && located?.path && located.path !== btwPathOf) void closeSide(pane);
  }, [btwPathOf, located?.path, pane]);
  // Side questions need a located Claude Transcript to fork.
  const btwPath = forkable && located?.agent === "claude" ? forkPath : null;
  const btwMode = useBtw((s) => !!s.mode[key]);
  const live = view.status === "working" || view.status === "blocked";
  // Mid-turn the newest entry can be a tool call still waiting for its result.
  const latestRow = forkable ? latestForkRow(rows, live) : -1;

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (i) => rows[i].key,
  });

  // Where the reader is, kept for the next time this transcript is opened.
  const loadedRef = useRef(false);
  loadedRef.current = loaded;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  saveReadingRef.current = () => {
    const path = pathRef.current;
    // Mid-restore the view sits at the bottom: that is not where the reader was.
    if (!path || !loadedRef.current || restoreArmed.current) return;
    const total = latest.current.total;
    if (atBottom.current) return savePosition(key, path, { atBottom: true, item: 0, delta: 0, total });
    const top = topVisible(rowsRef.current, virt.getVirtualItems(), virt.scrollOffset ?? 0);
    if (top) savePosition(key, path, { atBottom: false, ...top, total });
  };

  // The frame of the scroll easing down to the end, while it runs.
  const following = useRef(0);
  const stopFollow = () => {
    cancelAnimationFrame(following.current);
    following.current = 0;
  };
  // A hidden window gets no frames: a follow there would stall short of the end, so it lands at once.
  const landFollow = () => {
    if (!following.current) return;
    stopFollow();
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };
  useEffect(() => {
    const hide = () => {
      if (document.hidden) landFollow();
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      stopFollow();
    };
  }, []);
  // Eases down to the end, chasing it as rows measure and more come in.
  const follow = () => {
    const el = scrollRef.current;
    if (!el || following.current) return;
    if (document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const step = () => {
      const left = el.scrollHeight - el.clientHeight - el.scrollTop;
      const was = el.scrollTop;
      el.scrollTop = left > 1 ? was + Math.ceil(left * FOLLOW_STEP) : el.scrollHeight;
      // At the end, or held where it is: done.
      if (left <= 1 || el.scrollTop === was) {
        following.current = 0;
        return;
      }
      following.current = requestAnimationFrame(step);
    };
    following.current = requestAnimationFrame(step);
  };

  const prevRows = useRef(0);
  const prevItems = useRef(0);
  useLayoutEffect(() => {
    // Items, not rows: a tool call joining the live work block grows that row, not the count.
    const grew = state.items.length > prevItems.current;
    const before = topBefore.current;
    topBefore.current = null;
    // WebKit, laying out a sent message's removal together with its echo's row, scrolls up by the
    // message's height: an append only adds below, so it puts the view back where it was.
    const el = scrollRef.current;
    if (grew && anchor.current === null && el && before !== null && el.scrollTop < before) el.scrollTop = before;
    if (anchor.current !== null) {
      // Older items were prepended: keep the previously-first row in view.
      const added = rows.length - prevRows.current;
      virt.scrollToIndex(Math.max(0, added), { align: "start" });
      anchor.current = null;
    } else if (forceBottom.current || (grew && atBottom.current)) {
      if (forceBottom.current) {
        stopFollow();
        if (rows.length > 0) virt.scrollToIndex(rows.length - 1, { align: "end" });
        // Sent messages sit below the rows: the end is past the last row.
        if (outgoingRef.current > 0 && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      } else {
        follow();
      }
      forceBottom.current = rows.length === 0;
      atBottom.current = true;
      setUnseen(false);
    } else if (grew) {
      setUnseen(true);
    }
    prevRows.current = rows.length;
    prevItems.current = state.items.length;
  }, [rows.length, state.items.length, virt]);

  // The first Reset of an open lands on the saved row, paging older items in when it lies before the window.
  useLayoutEffect(() => {
    const path = pathRef.current;
    if (!restoreArmed.current || !loaded || !path || located?.pending) return;
    const total = state.total;
    const target = restoreTarget(savedPosition(key, path), total, total - state.items.length, restorePages.current);
    if (target.kind === "bottom") {
      restoreArmed.current = false;
    } else if (target.kind === "page") {
      if (loadingOlder.current) return;
      loadingOlder.current = true;
      const gen = generation.current;
      const before = target.before;
      // Stop paging: the next pass lands on the earliest loaded item.
      const giveUp = () => {
        restorePages.current = RESTORE_PAGES;
        setRestoreTick((n) => n + 1);
      };
      chatPage(pane, before)
        .then((older) => {
          loadingOlder.current = false;
          if (gen !== generation.current) return;
          const now = latest.current;
          if (now.total - now.items.length !== before) {
            restoreArmed.current = false;
            return;
          }
          if (older.length === 0) {
            giveUp();
            return;
          }
          restorePages.current++;
          dispatch({ type: "prepend", items: older, before });
        })
        .catch((e) => {
          loadingOlder.current = false;
          if (gen === generation.current) giveUp();
          console.error("chat_page failed", e);
        });
    } else {
      restoreArmed.current = false;
      forceBottom.current = false;
      atBottom.current = false;
      const place = () => {
        const [start] = virt.getOffsetForIndex(rowForItem(rows, target.item), "start") ?? [0];
        virt.scrollToOffset(start + target.delta);
      };
      place();
      requestAnimationFrame(place);
      if (target.unseen) setUnseen(true);
    }
  }, [loaded, located?.path, rows.length, state.items.length, restoreTick]);

  // The scroll area's height when last seen: a scroll that comes with a new height is the layout's.
  const viewHeight = useRef(0);
  // Rows measure taller than their estimate after the jump, and the working indicator
  // shrinks the viewport: neither fires a scroll event, so stay pinned while at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el) return;
    viewHeight.current = el.clientHeight;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      viewHeight.current = el.clientHeight;
      // A follow under way chases the new end itself.
      if (atBottom.current && anchor.current === null && !following.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const resized = el.clientHeight !== viewHeight.current;
    viewHeight.current = el.clientHeight;
    // Its own scroll, short of the end until the last frame.
    if (following.current) return;
    // The prompt card giving way to the composer grows the area, and WebKit clamps the scroll
    // to a layout in between, short of the end: that is not the reader leaving it.
    if (resized && atBottom.current) el.scrollTop = el.scrollHeight;
    else atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
    if (atBottom.current) setUnseen(false);
    if (el.scrollTop <= 0 && !loadingOlder.current) {
      const before = state.total - state.items.length;
      if (before <= 0) return;
      loadingOlder.current = true;
      const gen = generation.current;
      chatPage(pane, before)
        .then((older) => {
          if (gen !== generation.current || older.length === 0) return;
          // A trim or reset since the fetch moved the window: the reducer drops the page, so
          // leave no anchor behind for it.
          const now = latest.current;
          if (now.total - now.items.length !== before) return;
          anchor.current = 0;
          dispatch({ type: "prepend", items: older, before });
        })
        .catch((e) => console.error("chat_page failed", e))
        .finally(() => {
          loadingOlder.current = false;
        });
    }
  };

  // A message just sent shows at the bottom: follow it there.
  const sendCount = outgoing.list.length;
  const prevSends = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const grew = sendCount > prevSends.current;
    prevSends.current = sendCount;
    if (!el || !grew) return;
    atBottom.current = true;
    setUnseen(false);
    follow();
  }, [sendCount]);

  const jumpBottom = () => {
    stopFollow();
    if (rows.length > 0) virt.scrollToIndex(rows.length - 1, { align: "end" });
    atBottom.current = true;
    setUnseen(false);
  };

  // The outline rail follows the first row in view, or the last turn once at the end.
  const entries = useMemo(() => outline(rows), [rows]);
  const scrollTop = virt.scrollOffset ?? 0;
  const topRow = virt.getVirtualItems().find((v) => v.end > scrollTop)?.index ?? 0;
  const atEnd = rows.length > 0 && scrollTop + (virt.scrollRect?.height ?? 0) >= virt.getTotalSize() - 40;
  const pickedAt = picked === null ? -1 : entries.findIndex((e) => e.key === picked);
  const current = pickedAt >= 0 ? pickedAt : currentEntry(entries, topRow, atEnd);
  // The reader taking the scroll stops the follow; where they leave it decides whether it resumes.
  const unpick = () => {
    stopFollow();
    setPicked(null);
  };
  // Off the bottom before the scroll lands: an append meanwhile would pull the view back down.
  const jumpTo = (row: number) => {
    stopFollow();
    atBottom.current = false;
    setPicked(entries.find((e) => e.row === row)?.key ?? null);
    virt.scrollToIndex(row, { align: "start" });
  };

  const err = openError ?? state.error;
  return (
    <ChatPaneContext.Provider value={pane}>
    <ChatOpenContext.Provider value={opened}>
    <div className="chat-lens">
    <div className="chat-main">
      {located && <TranscriptPicker located={located} onChoose={choose} />}
      {err && <div className="chat-notice chat-error">{err.code}: {err.message}</div>}
      {pending && !err && outgoing.list.length === 0 && <div className="chat-notice neutral">New conversation: send the first message to start it.</div>}
      {!loaded && loadingShown && !pending && !err && <div className="chat-notice neutral">Loading transcript…</div>}
      {/* The pill sits on the scroll area's bottom edge, above whichever panel is below it. */}
      <div className="chat-scroll-wrap">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} onWheel={unpick} onPointerDown={unpick} onKeyDown={unpick}>
        <div ref={contentRef} style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((v) => {
            const row = rows[v.index];
            return (
              <div
                key={v.key}
                className={entering.current.has(row.key) ? "chat-enter" : undefined}
                data-index={v.index}
                ref={virt.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
              >
                {row.kind === "work" ? (
                  <WorkBlockView
                    block={row.block}
                    results={results}
                    open={chosenOpen.get(row.block.id) ?? row.last}
                    onToggle={toggle}
                    live={live && row.last}
                  />
                ) : (
                  <ChatItemView
                    item={row.item}
                    copy
                    onFork={forkable ? onFork : undefined}
                    onForkLatest={v.index === latestRow ? onForkLatest : undefined}
                    forking={
                      v.index === latestRow ? forkingLatest : row.item.kind === "user" && !!row.item.id && row.item.id === forking
                    }
                    result={row.item.kind === "tool_call" ? results.get(row.item.id) : undefined}
                  />
                )}
              </div>
            );
          })}
        </div>
        {outgoing.list.map((o) => (
          <div key={o.id} className={`chat-row chat-user chat-outgoing${o.sent ? "" : " sending"}`} aria-busy={!o.sent}>
            {o.previews.some(Boolean) && (
              <div className="chat-images">
                {o.previews.map((url, i) => url && <div key={i} className="chat-image"><img src={url} alt="" /></div>)}
              </div>
            )}
            {o.text !== "" && (
              <div className="chat-user-line">
                <div className="chat-bubble">{o.text}</div>
              </div>
            )}
          </div>
        ))}
      </div>
      {unseen && (
        <button className="chat-new" onClick={jumpBottom}>
          <ArrowDownIcon /> New messages
        </button>
      )}
      </div>
      <WorkingIndicator status={view.status} />
      <BtwCard pane={pane} />
      {view.status === "blocked" || picker.open ? (
        <>
          <PromptPanel pane={pane} view={view} fallback={view.status === "blocked"} asked={asked} />
          {/* A side question can still be asked while the Agent waits on its prompt. */}
          {view.status === "blocked" && btwPath &&
            (btwMode ? (
              <Composer pane={pane} agent={view.agent} btwPath={btwPath} status={view.status} btwOnly />
            ) : (
              <button className="btw-open" onClick={() => setBtwMode(key, true)}>
                btw — ask a side question
              </button>
            ))}
        </>
      ) : (
        <Composer pane={pane} agent={view.agent} btwPath={btwPath} status={view.status} onPiModel={() => setModelFor(key)} meta={state.meta} onSend={(text, previews) => {
          // Chatting with an agent keeps its tab.
          pinAgent(pane);
          return outgoing.start(text, previews);
        }} />
      )}
    </div>
    <ChatOutline entries={entries} current={current} onJump={jumpTo} />
    </div>
    </ChatOpenContext.Provider>
    </ChatPaneContext.Provider>
  );
}
