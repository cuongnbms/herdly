import { type CSSProperties, type DragEvent, memo, useEffect, useRef, useState } from "react";
import { notificationsEnabled, setNotificationsEnabled } from "../notify";
import { CloseIcon, GearIcon, GripIcon } from "../ui/icons";
import { FontPicker } from "./FontPicker";
import { DEFAULT_HIDDEN_FOLDERS, useHiddenFolders } from "./hiddenFolders";
import { NEW_AGENT_LENSES, useLensSettings } from "./lens";
import { useNewTab } from "./newTab";
import { AGENTS } from "../agents/openAgentTab";
import { DEFAULT_QUICK_REPLIES, moveReply, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, useQuickReplies } from "./quickReplies";
import { dropZone } from "../sidebar/dnd";
import { IDLE_MINUTES, useRecentAgents } from "./recentAgents";
import { CHAT_SIZE, DEFAULTS, TERM_SIZE, useSettings } from "./store";
import { THEME_PREFS, useTheme } from "./theme";
import { TAB_LAYOUTS, useTabLayout } from "./tabLayout";

/** How far one press of − or + moves a font size, in px. */
const SIZE_STEP = 0.5;

function Stepper({
  label,
  value,
  range,
  onChange,
  step = SIZE_STEP,
  format = (v) => `${v}px`,
}: {
  label: string;
  value: number;
  range: { min: number; max: number };
  onChange: (v: number) => void;
  step?: number;
  format?: (v: number) => string;
}) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <div className="stepper">
        <button aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= range.min} onClick={() => onChange(value - step)}>
          −
        </button>
        <output>{format(value)}</output>
        <button aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= range.max} onClick={() => onChange(value + step)}>
          +
        </button>
      </div>
    </div>
  );
}

function GeneralSettings() {
  const [notify, setNotify] = useState(notificationsEnabled);
  const newTab = useNewTab();
  const recent = useRecentAgents();
  return (
    <>
      <div className="setting-row">
        <span id="new-tab-label">New tab (⌘T) opens</span>
        <div
          className="seg seg-n"
          role="group"
          aria-labelledby="new-tab-label"
          style={{ "--n": AGENTS.length, "--i": AGENTS.indexOf(newTab.agent) } as CSSProperties}
        >
          <span className="seg-thumb" />
          {AGENTS.map((a) => (
            <button key={a} aria-pressed={a === newTab.agent} onClick={() => newTab.setAgent(a)}>
              {a}
            </button>
          ))}
        </div>
      </div>
      <p className="note">⌘T opens a tab next to the selected pane, in its workspace's folder.</p>
      <Stepper
        label="Keep idle agents"
        value={recent.idleMinutes}
        range={IDLE_MINUTES}
        step={1}
        format={(v) => (v === 0 ? "Off" : `${v} min`)}
        onChange={recent.setIdleMinutes}
      />
      <p className="note">How long an agent stays in Recent agents after it goes idle. Off lists only blocked, done and working agents.</p>
      <label className="switch">
        <span>Notifications</span>
        <input
          type="checkbox"
          role="switch"
          checked={notify}
          onChange={(e) => {
            setNotify(e.target.checked);
            setNotificationsEnabled(e.target.checked);
          }}
        />
      </label>
      <p className="note">
        For exact chat binding, run <code>herdr integration install claude</code> / <code>pi</code> on each machine.
      </p>
    </>
  );
}

function AppearanceSettings() {
  const pref = useTheme((s) => s.pref);
  const setPref = useTheme((s) => s.setPref);
  const i = THEME_PREFS.findIndex((t) => t.id === pref);
  const layout = useTabLayout((s) => s.layout);
  const setLayout = useTabLayout((s) => s.setLayout);
  return (
    <>
      <div className="setting-row">
        <span id="theme-label">Theme</span>
        <div
          className="seg seg-n"
          role="group"
          aria-labelledby="theme-label"
          style={{ "--n": THEME_PREFS.length, "--i": i } as CSSProperties}
        >
          <span className="seg-thumb" />
          {THEME_PREFS.map((t) => (
            <button key={t.id} aria-pressed={t.id === pref} onClick={() => setPref(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <p className="note">System follows the macOS appearance.</p>
      <div className="setting-row">
        <span id="tab-layout-label">Tabs</span>
        <div
          className="seg seg-n"
          role="group"
          aria-labelledby="tab-layout-label"
          style={{ "--n": TAB_LAYOUTS.length, "--i": TAB_LAYOUTS.findIndex((l) => l.id === layout) } as CSSProperties}
        >
          <span className="seg-thumb" />
          {TAB_LAYOUTS.map((l) => (
            <button key={l.id} aria-pressed={l.id === layout} onClick={() => setLayout(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <p className="note">Each open tab shows its agent and workspace; two lines put the workspace under the title.</p>
    </>
  );
}

function FontSettings() {
  const s = useSettings();
  const isDefault =
    s.terminalFontFamily === DEFAULTS.terminalFontFamily &&
    s.terminalFontSize === DEFAULTS.terminalFontSize &&
    s.chatFontSize === DEFAULTS.chatFontSize;
  return (
    <>
      <FontPicker label="Terminal font" value={s.terminalFontFamily} onChange={(f) => s.set({ terminalFontFamily: f })} />
      <Stepper label="Terminal size" value={s.terminalFontSize} range={TERM_SIZE} onChange={(v) => s.set({ terminalFontSize: v })} />
      <Stepper label="Chat size" value={s.chatFontSize} range={CHAT_SIZE} onChange={(v) => s.set({ chatFontSize: v })} />
      <p className="note">Lists the monospace fonts installed on this Mac. JetBrains Mono is bundled and covers Vietnamese.</p>
      <div className="settings-foot">
        <button className="btn btn-xs" aria-label="Reset fonts" disabled={isDefault} onClick={s.reset}>
          Reset to defaults
        </button>
      </div>
    </>
  );
}

/** What a Quick reply row drag carries; WebKit starts a drag only when it carries data. */
const QUICK_REPLY_TYPE = "application/x-herdr-quick-reply";

type Side = "before" | "after";
const sideOf = (e: DragEvent) => dropZone(e.currentTarget.getBoundingClientRect(), e.clientY, "session") as Side;

function ChatSettings() {
  const q = useQuickReplies();
  const lens = useLensSettings();
  const list = useRef<HTMLDivElement>(null);
  const added = useRef(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<{ i: number; side: Side } | null>(null);
  // Focus the row just added, so typing goes straight into it.
  useEffect(() => {
    if (!added.current) return;
    added.current = false;
    list.current?.querySelector<HTMLInputElement>(".quick-reply-row:last-child input")?.focus();
  }, [q.replies.length]);
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };
  /** True when the reply moved. */
  const move = (from: number, target: number, side: Side) => {
    const next = moveReply(q.replies, from, target, side);
    if (next) q.setReplies(next);
    return next !== null;
  };
  const isDefault = q.replies.length === DEFAULT_QUICK_REPLIES.length && q.replies.every((r, i) => r === DEFAULT_QUICK_REPLIES[i]);
  return (
    <>
      <div className="setting-row">
        <span id="new-agent-lens-label">New agent opens in</span>
        <div
          className="seg seg-n"
          role="group"
          aria-labelledby="new-agent-lens-label"
          style={{ "--n": NEW_AGENT_LENSES.length, "--i": NEW_AGENT_LENSES.indexOf(lens.newAgentLens) } as CSSProperties}
        >
          <span className="seg-thumb" />
          {NEW_AGENT_LENSES.map((l) => (
            <button key={l} aria-pressed={l === lens.newAgentLens} onClick={() => lens.setNewAgentLens(l)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <p className="note">Terminal keeps a new agent on the Terminal until you switch. Chat opens it on Chat once it has started, where you can type its first prompt.</p>
      <label className="switch">
        <span>Quick replies</span>
        <input type="checkbox" role="switch" checked={q.show} onChange={(e) => q.setShow(e.target.checked)} />
      </label>
      <p className="note">Buttons above the message box that send a short reply in one click. Drag a handle to reorder, or press ⌥↑ / ⌥↓ in a reply.</p>
      <div className="quick-reply-list" ref={list}>
        {q.replies.map((r, i) => {
          const onDragOver = (e: DragEvent) => {
            if (dragging === null) return;
            const side = sideOf(e);
            if (!moveReply(q.replies, dragging, i, side)) {
              e.dataTransfer.dropEffect = "none";
              setOver((p) => (p?.i === i ? null : p));
              return;
            }
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOver((p) => (p?.i === i && p.side === side ? p : { i, side }));
          };
          const drop = over?.i === i ? ` drop-${over.side}` : "";
          return (
            <div
              key={i}
              className={`quick-reply-row${dragging === i ? " dragging" : ""}${drop}`}
              onDragEnter={onDragOver}
              onDragOver={onDragOver}
              onDragLeave={(e) => {
                // By the pointer, not `relatedTarget`, which WebKit may leave null.
                const b = e.currentTarget.getBoundingClientRect();
                if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) return;
                setOver((p) => (p?.i === i ? null : p));
              }}
              onDrop={(e) => {
                const from = dragging;
                endDrag();
                if (from === null) return;
                e.preventDefault();
                move(from, i, sideOf(e));
              }}
            >
              {/* Only the grip drags, so selecting text in the field still works. */}
              <span
                className="quick-reply-grip"
                title="Drag to reorder"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(QUICK_REPLY_TYPE, String(i));
                  e.dataTransfer.effectAllowed = "move";
                  const rowEl = e.currentTarget.closest<HTMLElement>(".quick-reply-row");
                  if (rowEl) {
                    const b = rowEl.getBoundingClientRect();
                    e.dataTransfer.setDragImage(rowEl, e.clientX - b.left, e.clientY - b.top);
                  }
                  setDragging(i);
                }}
                onDragEnd={endDrag}
              >
                <GripIcon />
              </span>
              <input
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                aria-label={`Quick reply ${i + 1}`}
                value={r}
                maxLength={QUICK_REPLY_MAX_CHARS}
                placeholder="Reply text"
                onChange={(e) => q.setReplies(q.replies.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  const up = e.key === "ArrowUp";
                  const to = up ? i - 1 : i + 1;
                  // Rows are keyed by index, so the moved reply now shows in the field at `to`.
                  if (move(i, to, up ? "before" : "after")) list.current?.querySelectorAll<HTMLInputElement>(".quick-reply-row input")[to]?.focus();
                }}
              />
              <button className="icon-btn" aria-label={`Remove quick reply ${i + 1}`} onClick={() => q.setReplies(q.replies.filter((_, j) => j !== i))}>
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
      <div className="settings-foot">
        <button
          className="btn btn-xs"
          aria-label="Add quick reply"
          disabled={q.replies.length >= QUICK_REPLIES_MAX}
          onClick={() => {
            added.current = true;
            q.setReplies([...q.replies, ""]);
          }}
        >
          Add reply
        </button>
        <button className="btn btn-xs" aria-label="Reset quick replies" disabled={isDefault} onClick={q.reset}>
          Reset to defaults
        </button>
      </div>
    </>
  );
}

function FilesSettings() {
  const h = useHiddenFolders();
  // Edited as text and saved on blur, so a new line can be typed before it holds a name.
  const [draft, setDraft] = useState(() => h.folders.join("\n"));
  const isDefault = h.folders.length === DEFAULT_HIDDEN_FOLDERS.length && h.folders.every((f, i) => f === DEFAULT_HIDDEN_FOLDERS[i]);
  const commit = () => {
    h.setFolders(draft.split("\n"));
    setDraft(useHiddenFolders.getState().folders.join("\n"));
  };
  return (
    <>
      <label className="setting-col">
        <span>Hidden folders</span>
        <textarea
          className="hidden-folders"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          rows={8}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
        />
      </label>
      <p className="note">One folder name per line. The Files tree leaves these folders out until its eye button is on; files with these names still show.</p>
      <div className="settings-foot">
        <button
          className="btn btn-xs"
          aria-label="Reset hidden folders"
          disabled={isDefault && draft === h.folders.join("\n")}
          onClick={() => {
            h.reset();
            setDraft(DEFAULT_HIDDEN_FOLDERS.join("\n"));
          }}
        >
          Reset to defaults
        </button>
      </div>
    </>
  );
}

/** Add a section here for each new group of settings. */
const SECTIONS = [
  { id: "general", label: "General", Body: GeneralSettings },
  { id: "appearance", label: "Appearance", Body: AppearanceSettings },
  { id: "fonts", label: "Fonts", Body: FontSettings },
  { id: "chat", label: "Chat", Body: ChatSettings },
  { id: "files", label: "Files", Body: FilesSettings },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [active, setActive] = useState<SectionId>("general");
  const section = SECTIONS.find((x) => x.id === active) ?? SECTIONS[0];
  const ref = useRef<HTMLDivElement>(null);
  // Focus the dialog so Escape reaches it (autoFocus only applies to form controls).
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={ref}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <nav className="settings-nav" role="tablist" aria-orientation="vertical">
          <div className="settings-nav-title">Settings</div>
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={x.id === active}
              className={x.id === active ? "active" : undefined}
              onClick={() => setActive(x.id)}
            >
              {x.label}
            </button>
          ))}
        </nav>
        <section className="settings-body" role="tabpanel" aria-label={section.label}>
          <header className="settings-head">
            <h3>{section.label}</h3>
            <button className="icon-btn" aria-label="Close settings" onClick={onClose}>
              ×
            </button>
          </header>
          <section.Body />
        </section>
      </div>
    </div>
  );
}

// Takes no props: memo keeps it out of App's re-renders; it reads the store itself.
export const Settings = memo(function Settings() {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings">
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
      <button className="icon-btn" aria-label="Settings" aria-expanded={open} onClick={() => setOpen(true)}>
        <GearIcon />
      </button>
    </div>
  );
});
