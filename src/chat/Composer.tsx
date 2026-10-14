import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { herdrCall, imageSaveTemp } from "../lib/ipc";
import { paneKey, type AgentStatus, type ChatMeta, type PaneRef, type SlashCommand } from "../lib/types";
import { quickReplyButtons, useQuickReplies } from "../settings/quickReplies";
import { CloseIcon, SendIcon, StopIcon } from "../ui/icons";
import { CompletionMenu } from "./CompletionMenu";
import { GitStatusLine } from "./GitStatus";
import { rankCommands, rankFiles, readUsage, recordUse, splitParentQuery } from "./complete";
import { dirSuggestions } from "../lib/pathInput";
import { askSide, setBtwMode, useBtw } from "./btw";
import { readDraft, useDraft, writeDraft } from "./drafts";
import { usePaneImages, type Attachment } from "./draftImages";
import { activeTrigger, applyCompletion } from "./mentions";
import { modelLabel } from "./modelLabel";
import { ModelMenu } from "./ModelMenu";
import { useClaudeSuggestion } from "./useClaudeSuggestion";
import { useCompletions } from "./useCompletions";
import { IMAGE_EXTS } from "../terminal/imagePaste";

// Key names verified against herdr's key parser (pane.send_keys accepts esc, ctrl+c,
// shift+tab, enter, up, down, 1; unknown names fail with `invalid_key`).
const KEYS: { label: string; key: string }[] = [
  { label: "Esc", key: "esc" },
  { label: "Ctrl+C", key: "ctrl+c" },
  { label: "⇧Tab", key: "shift+tab" },
];

// Agents whose TUI turns a bracketed-pasted image path into an image attachment (as when
// pasting a screenshot in a terminal); `agent.prompt` frames text and path as one paste,
// so each path goes first on its own. Other agents get an `@path` file mention.
const PATH_PASTE_AGENTS = new Set(["claude", "codex", "gemini"]);

// Claude Code attaches a pasted image path asynchronously; submitting sooner can drop the
// image (herdr likewise holds `agent.prompt`'s Enter back 300 ms behind its text).
export const IMAGE_SETTLE_MS = 300;

// Agents whose Slash commands the Composer can list.
const SLASH_AGENTS = new Set(["claude", "pi", "codex"]);

// pi's /model opens a picker in the terminal; `/model <name>` may switch without one.
const PI_MODEL_RE = /^\/model(\s|$)/;

const bracketedPaste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const mention = (path: string) => (/[\s"]/.test(path) ? `@"${path}"` : `@${path}`);

// Unique across Composers: one pane's images outlive the Composer that pasted them.
let nextId = 0;

const revoke = (a: Attachment) => {
  if (a.preview) URL.revokeObjectURL(a.preview);
};

export function Composer({
  pane,
  agent,
  status,
  onPiModel,
  meta,
  onSend,
  btwPath,
  btwOnly,
}: {
  pane: PaneRef;
  agent: string | null;
  status?: AgentStatus;
  /** Called once `/model` has gone to pi, whose picker the Chat lens then shows as a card. */
  onPiModel?: () => void;
  meta?: ChatMeta;
  /**
   * Called as a message goes out, with its text and image previews; the returned function is
   * told whether it went through. The previews of a send that went through are the caller's to
   * revoke; a failed send's go back into the box.
   */
  onSend?: (text: string, previews: string[]) => (ok: boolean) => void;
  /** The located Claude Transcript's path when side questions (btw) are available; else none. */
  btwPath?: string | null;
  /**
   * Only side questions (beside a blocked Agent's prompt card): always in btw mode, with nothing
   * that talks to the Agent; leaving the mode is the caller's cue to fold the box away.
   */
  btwOnly?: boolean;
}) {
  const key = paneKey(pane);
  const btwMode = useBtw((s) => !!s.mode[key]);
  const btwOn = !!btwPath && (!!btwOnly || btwMode);
  const btwRunning = useBtw((s) => {
    const turns = s.threads[key]?.turns;
    return !!turns && turns.length > 0 && turns[turns.length - 1].running;
  });
  const draftId = btwOn ? `btw:${key}` : key;
  const [text, setText] = useState(() => readDraft(draftId));
  // Kept per pane outside the Composer, so a tab switch does not drop them; a paste or send
  // in flight updates the pane it started on.
  const [images, setImages] = usePaneImages(key);
  const [error, setError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [usage, setUsage] = useState<Record<string, number>>(() => (agent ? readUsage(agent) : {}));
  const box = useRef<HTMLTextAreaElement>(null);

  // The box grows with its text up to the CSS max-height, then scrolls; `rows` sets its floor.
  const fit = () => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [text]);
  // A narrower pane wraps the same text onto more lines.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => setUsage(agent ? readUsage(agent) : {}), [agent]);
  // Whenever the mode changes (button, Cmd+B, or the Transcript going away), the old box's text
  // is kept under its own Draft and the new box's is loaded, before useDraft can write the old
  // text over it.
  const [shownId, setShownId] = useState(draftId);
  if (shownId !== draftId) {
    writeDraft(shownId, text);
    setShownId(draftId);
    setText(readDraft(draftId));
    setDismissed(false);
  }
  // Sending clears the text and a failed send restores it, so the draft follows both.
  useDraft(draftId, text);

  /** Swaps between the agent box and the side-question box, each keeping its own Draft. */
  const toggleBtw = () => {
    if (!btwPath) return;
    setBtwMode(key, !btwOn);
  };
  // A shown Composer takes the keyboard when nothing else holds it (as the Terminal does), so a
  // new agent's Chat is ready to type into once the Terminal it replaced has taken its focus away.
  useEffect(() => {
    const el = document.activeElement;
    if (!el || el === document.body) box.current?.focus({ preventScroll: true });
  }, []);
  // Entering the mode (by button or Cmd+B) puts the caret in the box.
  useEffect(() => {
    if (btwOn) box.current?.focus();
  }, [btwOn]);

  const [sending, setSending] = useState(false);
  // Read only while the box is empty (that is when the suggestion shows, and Tab takes it), and
  // not while a send is on its way: Claude's box would still show the old suggestion.
  const { suggestion, clear: clearSuggestion } = useClaudeSuggestion(pane, agent, status, text === "" && !sending && !btwOn);
  const offered = text === "" && !btwOn ? suggestion : null;
  const label = modelLabel(meta);
  // Where the model menu opens from; null while it is closed.
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  const showQuick = useQuickReplies((s) => s.show);
  const quickReplies = quickReplyButtons(useQuickReplies((s) => s.replies));

  const found = activeTrigger(text, caret, { skills: agent === "codex" });
  const trigger = !btwOn && found && (found.kind === "file" || (agent && SLASH_AGENTS.has(agent))) ? found : null;
  const query = trigger?.query;
  const kind = trigger?.kind ?? null;
  const prefix = trigger?.prefix ?? "/";
  // `@../…` lists that one folder; other mentions rank the files under the Pane's folder.
  const parent = kind === "file" ? splitParentQuery(query ?? "") : null;
  const { commands, files, loading, error: listError } = useCompletions(pane, kind, parent?.dir);
  // Up to thousands of paths: rank them only when the list or the query changes.
  const fileRows = useMemo(() => {
    if (kind !== "file") return [];
    const split = splitParentQuery(query ?? "");
    return split ? dirSuggestions(files, split.dir.slice(0, -1), split.prefix) : rankFiles(files, query ?? "");
  }, [kind, files, query]);
  const rows: (SlashCommand | string)[] =
    kind === "slash"
      ? rankCommands(
          commands.filter((c) => (c.trigger === "$") === (prefix === "$")),
          query ?? "",
          usage,
        )
      : fileRows;
  useEffect(() => setActive(0), [kind, prefix, query]);
  const open = trigger !== null && !dismissed && (loading || listError || rows.length > 0);
  const capturing = open && rows.length > 0;
  const current = Math.min(active, Math.max(rows.length - 1, 0));

  const choose = (i: number) => {
    const row = rows[i];
    if (!trigger || row === undefined) return;
    const insert = typeof row === "string" ? mention(row) : `${prefix}${row.name}`;
    // A folder keeps the mention open, so its entries are listed next.
    const folder = typeof row === "string" && row.endsWith("/");
    const next = applyCompletion(text, trigger, folder ? insert : `${insert} `);
    setText(next.text);
    setCaret(next.caret);
    setDismissed(false);
    if (typeof row !== "string" && agent) setUsage(recordUse(agent, row.name));
    requestAnimationFrame(() => box.current?.setSelectionRange(next.caret, next.caret));
  };

  const call = (method: string, params: unknown) =>
    herdrCall(pane.machine_id, pane.session, method, params).then(
      () => setError(null),
      (e) => {
        console.error(method, "failed", e);
        setError(`Send failed: ${e?.message ?? String(e)}`);
        return Promise.reject(e);
      },
    );

  const attach = async (file: File) => {
    const ext = IMAGE_EXTS[file.type];
    if (!ext) {
      setError(`Image paste failed: ${file.type} is not supported`);
      return;
    }
    const id = nextId++;
    const preview = typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
    setImages((cur) => [...cur, { id, preview, path: null }]);
    try {
      const path = await imageSaveTemp(pane.machine_id, new Uint8Array(await file.arrayBuffer()), ext);
      setImages((cur) => cur.map((a) => (a.id === id ? { ...a, path } : a)));
    } catch (e) {
      console.error("image_save_temp failed", e);
      setError(`Image paste failed: ${(e as { message?: string })?.message ?? String(e)}`);
      setImages((cur) => {
        cur.filter((a) => a.id === id).forEach(revoke);
        return cur.filter((a) => a.id !== id);
      });
    }
  };

  const remove = (id: number) =>
    setImages((cur) => {
      cur.filter((a) => a.id === id).forEach(revoke);
      return cur.filter((a) => a.id !== id);
    });

  const uploading = images.some((a) => a.path === null);
  const canSend = btwOn
    ? text.trim() !== "" && !btwRunning
    : !uploading && (text.trim() !== "" || images.length > 0);

  const submit = async (sent: string, paths: string[]) => {
    const target = pane.pane_id;
    if (paths.length === 0) return call("agent.prompt", { target, text: sent });
    if (agent && PATH_PASTE_AGENTS.has(agent)) {
      for (const path of paths) await call("pane.send_text", { pane_id: target, text: bracketedPaste(path) });
      await new Promise((r) => setTimeout(r, IMAGE_SETTLE_MS));
      return sent.trim()
        ? call("agent.prompt", { target, text: sent })
        : call("agent.send_keys", { target, keys: ["enter"] });
    }
    const mentions = paths.map(mention).join(" ");
    return call("agent.prompt", { target, text: sent.trim() ? `${mentions} ${sent}` : mentions });
  };

  const send = () => {
    if (!canSend) return;
    if (btwOn && btwPath) {
      void askSide(pane, btwPath, text);
      setText("");
      return;
    }
    const sent = text;
    const sentImages = images;
    setText("");
    setImages([]);
    // The suggestion was for the turn this send answers.
    clearSuggestion();
    setSending(true);
    const settle = onSend?.(sent, sentImages.map((a) => a.preview));
    // Optimistic clear; restore the draft if the prompt did not go through (unless the user typed meanwhile).
    submit(sent, sentImages.map((a) => a.path as string))
      .then(
        () => {
          if (settle) settle(true);
          else sentImages.forEach(revoke);
          if (agent === "pi" && PI_MODEL_RE.test(sent.trim())) onPiModel?.();
        },
        () => {
          settle?.(false);
          setText((cur) => (cur === "" ? sent : cur));
          setImages((cur) => (cur.length === 0 ? sentImages : (sentImages.forEach(revoke), cur)));
        },
      )
      .finally(() => setSending(false));
  };

  /** A canned reply goes straight out; what is typed in the box stays a draft. */
  const sendQuick = (reply: string) => {
    if (sending) return;
    clearSuggestion();
    setSending(true);
    const settle = onSend?.(reply, []);
    call("agent.prompt", { target: pane.pane_id, text: reply })
      .then(
        () => settle?.(true),
        () => settle?.(false),
      )
      .finally(() => setSending(false));
  };

  return (
    <div className={`composer${btwOn ? " btw" : ""}`}>
      {/* Quick replies and keys go to the Agent; the blocked prompt card has its own keys. */}
      {!btwOnly && (
        <div className="composer-top">
          {!btwOn && showQuick && quickReplies.length > 0 && (
            <div className="composer-quick" role="group" aria-label="Quick replies">
              {quickReplies.map((reply, i) => (
                <button key={`${i}:${reply}`} className="composer-quick-reply" title={`Send “${reply}”`} disabled={sending} onClick={() => sendQuick(reply)}>
                  {reply}
                </button>
              ))}
            </div>
          )}
          <div className="composer-keys">
            {KEYS.map((k) => (
              <button key={k.key} className="keycap" onClick={() => call("agent.send_keys", { target: pane.pane_id, keys: [k.key] }).catch(() => {})}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="composer-box">
        {!btwOn && images.length > 0 && (
          <div className="composer-images">
            {images.map((a, i) => (
              <div key={a.id} className={`composer-image${a.path === null ? " saving" : ""}`}>
                <img src={a.preview || undefined} alt={`Pasted image ${i + 1}`} />
                <button className="composer-image-remove" aria-label={`Remove image ${i + 1}`} onClick={() => remove(a.id)}>
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}
        {open && trigger && kind && (
          <CompletionMenu
            kind={kind}
            prefix={prefix}
            items={rows}
            active={current}
            loading={loading}
            error={listError}
            onChoose={choose}
          />
        )}
        <textarea
          ref={box}
          value={text}
          rows={2}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          placeholder={
            btwOn
              ? "Ask a side question (not added to the Transcript)…"
              : offered
              ? `${offered}  (Tab to use)`
              : "Message the agent…  (Enter to send, Shift+Enter for newline, paste images)"
          }
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            setDismissed(false);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            if (btwOn) return;
            const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
            if (files.length === 0) return;
            // Text that came with the image still lands in the textarea.
            if (!e.clipboardData.getData("text/plain")) e.preventDefault();
            files.forEach((f) => void attach(f));
          }}
          onKeyDown={(e) => {
            // Escape closes any open list, a loading or failed one included.
            if (open && e.key === "Escape" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              return setDismissed(true);
            }
            if (e.nativeEvent.isComposing) {
              /* an IME owns these keys */
            } else if (btwPath && e.code === "KeyB" && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
              e.preventDefault();
              return toggleBtw();
            } else if (btwOn && e.key === "Escape") {
              e.preventDefault();
              return toggleBtw();
            }
            if (capturing && !e.nativeEvent.isComposing) {
              const move = (by: number) => {
                e.preventDefault();
                setActive((current + by + rows.length) % rows.length);
              };
              if (e.key === "ArrowDown") return move(1);
              if (e.key === "ArrowUp") return move(-1);
              // Shift+Enter keeps its newline.
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                return choose(current);
              }
            }
            // After the completion list: Tab takes the suggestion into the empty box, as in Claude's own input.
            if (offered && e.key === "Tab" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              setText(offered);
              setCaret(offered.length);
              requestAnimationFrame(() => box.current?.setSelectionRange(offered.length, offered.length));
              return;
            }
            if ((e.key === "Home" || e.key === "End") && !e.altKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              return setCaret(jumpToEdge(e.currentTarget, e.key === "Home", e.metaKey || e.ctrlKey, e.shiftKey));
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          {!btwOnly && <GitStatusLine pane={pane} status={status} />}
          {btwPath && (
            <button
              className="composer-btw"
              title="Side question (Cmd+B)"
              aria-pressed={btwOn}
              onClick={toggleBtw}
            >
              btw
            </button>
          )}
          {btwOnly ? null : agent === "claude" ? (
            // Claude takes /model and /effort with an argument; only while idle, since a turn would
            // queue them and a blocked prompt would take the text as its answer.
            <button
              className="composer-model"
              title="Model · reasoning effort · context tokens"
              aria-haspopup="menu"
              aria-expanded={menuAt !== null}
              disabled={status === "working" || status === "blocked"}
              onClick={(e) => setMenuAt(e.currentTarget.getBoundingClientRect())}
            >
              {label ?? "Model"}
            </button>
          ) : (
            label && (
              <span className="composer-model" title="Model · reasoning effort · context tokens">
                {label}
              </span>
            )
          )}
          {/* Esc interrupts the agent's turn without killing it the way Ctrl+C can. Send stays
              usable beside it: the agent queues text sent while it works. Stop stays mounted,
              disabled while idle, so the row doesn't shift when a turn starts or ends. In btw mode
              it is hidden but keeps its place, so toggling btw doesn't move the buttons: the side
              question has its own Stop on the card. */}
          {!btwOnly && (
            <button
              className="stop"
              aria-label="Stop"
              title="Stop (Esc)"
              hidden={btwOn}
              disabled={btwOn || status !== "working"}
              onClick={() => call("agent.send_keys", { target: pane.pane_id, keys: ["esc"] }).catch(() => {})}
            >
              <StopIcon />
            </button>
          )}
          <button className="send" aria-label="Send" disabled={!canSend} onClick={send}>
            <SendIcon />
          </button>
          {menuAt && (
            <ModelMenu
              anchor={menuAt}
              meta={meta}
              onPick={sendQuick}
              onClose={() => setMenuAt(null)}
            />
          )}
        </div>
      </div>
      {error && <div className="chat-error composer-error" role="alert">{error}</div>}
    </div>
  );
}

// macOS WebKit binds Home and End to scrolling, leaving the caret where it was. Move it to the
// edge of its line instead (of the whole text with Cmd/Ctrl), extending the selection with Shift.
function jumpToEdge(box: HTMLTextAreaElement, home: boolean, whole: boolean, extend: boolean): number {
  const { value, selectionStart: start, selectionEnd: end } = box;
  const backward = box.selectionDirection === "backward";
  const head = backward ? start : end;
  const anchor = backward ? end : start;
  const lineEnd = value.indexOf("\n", head);
  const to = whole
    ? home ? 0 : value.length
    : home ? value.lastIndexOf("\n", head - 1) + 1 : lineEnd === -1 ? value.length : lineEnd;
  if (!extend) box.setSelectionRange(to, to);
  else if (to < anchor) box.setSelectionRange(to, anchor, "backward");
  else box.setSelectionRange(anchor, to, "forward");
  return to;
}
