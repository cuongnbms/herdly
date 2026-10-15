import { type CSSProperties, type DragEvent, memo, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { notificationsEnabled, setNotificationsEnabled } from "../notify";
import { CloseIcon, GearIcon, GripIcon } from "../ui/icons";
import { FontPicker } from "./FontPicker";
import { DEFAULT_HIDDEN_FOLDERS, useHiddenFolders } from "./hiddenFolders";
import { NEW_AGENT_LENSES, useLensSettings } from "./lens";
import { useNewTab } from "./newTab";
import { PiSettings } from "./PiSettings";
import { AGENTS } from "../agents/openAgentTab";
import { DEFAULT_QUICK_REPLIES, moveReply, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, useQuickReplies } from "./quickReplies";
import { dropZone } from "../sidebar/dnd";
import { IDLE_MINUTES, useRecentAgents } from "./recentAgents";
import { CHAT_SIZE, DEFAULTS, TERM_SIZE, useSettings } from "./store";
import { THEME_PREFS, useTheme } from "./theme";
import { TAB_LAYOUTS, useTabLayout } from "./tabLayout";

/** How far one press of − or + moves a font size, in px. */
const SIZE_STEP = 0.5;

/** A card of setting rows, with an optional heading above it. */
export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      {title && <h4 className="settings-group-title">{title}</h4>}
      <div className="settings-card">{children}</div>
    </section>
  );
}

/** One setting: its label and description on the left, its control on the right (or below, when `stack`). */
export function Row({
  label,
  desc,
  htmlFor,
  labelId,
  stack,
  children,
}: {
  label: string;
  desc?: ReactNode;
  /** The control's id, so clicking the label focuses or toggles it. */
  htmlFor?: string;
  /** For a control named by `aria-labelledby`. */
  labelId?: string;
  stack?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={stack ? "setting-row setting-stack" : "setting-row"}>
      <div className="setting-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span id={labelId}>{label}</span>}
        {desc && <p className="setting-desc">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

/** A segmented choice between a few options, in a Row. */
function Choice<T extends string>({
  label,
  desc,
  options,
  value,
  onChange,
}: {
  label: string;
  desc?: ReactNode;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <Row label={label} desc={desc} labelId={id}>
      <div
        className="seg seg-n"
        role="group"
        aria-labelledby={id}
        style={{ "--n": options.length, "--i": options.findIndex((o) => o.id === value) } as CSSProperties}
      >
        <span className="seg-thumb" />
        {options.map((o) => (
          <button key={o.id} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </Row>
  );
}

/** An on/off setting in a Row. */
function Switch({ label, desc, checked, onChange }: { label: string; desc?: ReactNode; checked: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <Row label={label} desc={desc} htmlFor={id}>
      <input id={id} className="switch" type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Row>
  );
}

const asOptions = <T extends string>(ids: readonly T[]) => ids.map((id) => ({ id, label: id }));

function Stepper({
  label,
  desc,
  value,
  range,
  onChange,
  step = SIZE_STEP,
  format = (v) => `${v}px`,
}: {
  label: string;
  desc?: ReactNode;
  value: number;
  range: { min: number; max: number };
  onChange: (v: number) => void;
  step?: number;
  format?: (v: number) => string;
}) {
  return (
    <Row label={label} desc={desc}>
      <div className="stepper">
        <button aria-label={`Decrease ${label.toLowerCase()}`} disabled={value <= range.min} onClick={() => onChange(value - step)}>
          −
        </button>
        <output>{format(value)}</output>
        <button aria-label={`Increase ${label.toLowerCase()}`} disabled={value >= range.max} onClick={() => onChange(value + step)}>
          +
        </button>
      </div>
    </Row>
  );
}

function GeneralSettings() {
  const [notify, setNotify] = useState(notificationsEnabled);
  const newTab = useNewTab();
  const recent = useRecentAgents();
  return (
    <>
      <Group>
        <Choice
          label="New tab (⌘T) opens"
          desc="Next to the selected pane, in its workspace's folder."
          options={asOptions(AGENTS)}
          value={newTab.agent}
          onChange={newTab.setAgent}
        />
        <Stepper
          label="Keep idle agents"
          desc="How long an agent stays in Recent agents after it goes idle. Off lists only blocked, done and working agents."
          value={recent.idleMinutes}
          range={IDLE_MINUTES}
          step={1}
          format={(v) => (v === 0 ? "Off" : `${v} min`)}
          onChange={recent.setIdleMinutes}
        />
        <Switch
          label="Notifications"
          checked={notify}
          onChange={(on) => {
            setNotify(on);
            setNotificationsEnabled(on);
          }}
        />
      </Group>
      <p className="note">
        For exact chat binding, run <code>herdr integration install claude</code> / <code>pi</code> on each machine.
      </p>
    </>
  );
}

function AppearanceSettings() {
  const pref = useTheme((s) => s.pref);
  const setPref = useTheme((s) => s.setPref);
  const layout = useTabLayout((s) => s.layout);
  const setLayout = useTabLayout((s) => s.setLayout);
  return (
    <Group>
      <Choice label="Theme" desc="System follows the macOS appearance." options={THEME_PREFS} value={pref} onChange={setPref} />
      <Choice
        label="Tabs"
        desc="Each open tab shows its agent and workspace; two lines put the workspace under the title."
        options={TAB_LAYOUTS}
        value={layout}
        onChange={setLayout}
      />
    </Group>
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
      <Group>
        <FontPicker
          label="Terminal font"
          desc="The monospace fonts installed on this Mac. JetBrains Mono is bundled and covers Vietnamese."
          value={s.terminalFontFamily}
          onChange={(f) => s.set({ terminalFontFamily: f })}
        />
        <Stepper label="Terminal size" value={s.terminalFontSize} range={TERM_SIZE} onChange={(v) => s.set({ terminalFontSize: v })} />
        <Stepper label="Chat size" value={s.chatFontSize} range={CHAT_SIZE} onChange={(v) => s.set({ chatFontSize: v })} />
      </Group>
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
      <Group>
        <Choice
          label="New agent opens in"
          desc="Terminal keeps a new agent on the Terminal until you switch. Chat opens it on Chat once it has started, where you can type its first prompt."
          options={asOptions(NEW_AGENT_LENSES)}
          value={lens.newAgentLens}
          onChange={lens.setNewAgentLens}
        />
      </Group>
      <Group>
        <Switch
          label="Quick replies"
          desc="Buttons above the message box that send a short reply in one click. Drag a handle to reorder, or press ⌥↑ / ⌥↓ in a reply."
          checked={q.show}
          onChange={q.setShow}
        />
        <div className="quick-reply-list settings-card-body" ref={list}>
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
      </Group>
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
  const id = useId();
  // Edited as text and saved on blur, so a new line can be typed before it holds a name.
  const [draft, setDraft] = useState(() => h.folders.join("\n"));
  const isDefault = h.folders.length === DEFAULT_HIDDEN_FOLDERS.length && h.folders.every((f, i) => f === DEFAULT_HIDDEN_FOLDERS[i]);
  const commit = () => {
    h.setFolders(draft.split("\n"));
    setDraft(useHiddenFolders.getState().folders.join("\n"));
  };
  return (
    <>
      <Group>
        <Row
          label="Hidden folders"
          desc="One folder name per line. The Files tree leaves these folders out until its eye button is on; files with these names still show."
          htmlFor={id}
          stack
        >
          <textarea
            id={id}
            className="hidden-folders"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            rows={8}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
        </Row>
      </Group>
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
  { id: "pi", label: "pi", Body: PiSettings },
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
              <CloseIcon />
            </button>
          </header>
          {/* Keyed so a new section starts at the top. */}
          <div className="settings-scroll" key={section.id}>
            <section.Body />
          </div>
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
