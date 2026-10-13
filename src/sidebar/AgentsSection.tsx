import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon } from "../agents/AgentIcon";
import { dashboardCards, nextIdleExpiry, sidebarAgents } from "../dashboard/buckets";
import { paneKey } from "../lib/types";
import { LIST_HEIGHT, useRecentAgents } from "../settings/recentAgents";
import { useApp } from "../store/app";
import { SectionHeader } from "./Sidebar";
import { StatusDot } from "./StatusDot";

/** Agents that are Blocked, Done (not yet seen) or Working, plus those that went idle within the last few minutes
 *  (Settings › General), docked above Machines; shown even when there are none. */
export function AgentsSection() {
  const machines = useApp((s) => s.machines);
  const order = useApp((s) => s.order);
  const doneSeen = useApp((s) => s.doneSeen);
  const since = useApp((s) => s.statusSince);
  const selectedKey = useApp((s) => (s.selected ? paneKey(s.selected) : null));
  const select = useApp((s) => s.select);
  const open = useApp((s) => s.expanded["agents"] ?? true);
  const height = useRecentAgents((s) => s.listHeight);
  const list = useRef<HTMLUListElement>(null);
  const keepIdleMs = useRecentAgents((s) => s.idleMinutes) * 60_000;
  const all = useMemo(() => dashboardCards(machines, order, doneSeen, since), [machines, order, doneSeen, since]);
  // Re-read the clock when the next idle agent's time is up, so it drops out without waiting for a snapshot.
  const [tick, setTick] = useState(0);
  const cards = useMemo(() => sidebarAgents(all, since, keepIdleMs, Date.now()), [all, since, keepIdleMs, tick]);
  useEffect(() => {
    const now = Date.now();
    const next = nextIdleExpiry(all, since, keepIdleMs, now);
    if (next === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), next - now);
    return () => clearTimeout(timer);
  }, [all, since, keepIdleMs, tick]);
  return (
    <section aria-label="Recent agents" className="agents-section">
      {open && <HeightHandle list={list} />}
      <SectionHeader id="agents" label="Recent agents" count={cards.length} />
      {/* A dragged height keeps the list's room even while it is empty. */}
      {open && (cards.length > 0 || height !== null) && (
        <ul className="tree agents-list" ref={list} style={height === null ? undefined : { height }}>
          {cards.map((c) => (
            <li key={c.key}>
              <button
                className={"row agents-row agents-row-" + c.bucket + (c.key === selectedKey ? " active" : "")}
                title={c.pane.cwd ?? undefined}
                onClick={() => select(c.ref)}
              >
                <AgentIcon agent={c.pane.agent} />
                <span className="agents-body">
                  <span className="agents-title">{c.pane.title}</span>
                  <span className="agents-meta">{`${c.session.name} › ${c.workspace.label}`}</span>
                </span>
                <StatusDot status={c.pane.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const KEY_STEP = 16;

/** A strip on the section's top edge, where it meets the Groups: drag up to make the list taller, double-click to fit the rows again, arrows to step. */
function HeightHandle({ list }: { list: RefObject<HTMLUListElement | null> }) {
  const height = useRecentAgents((s) => s.listHeight);
  const setHeight = useRecentAgents((s) => s.setListHeight);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const current = () => height ?? list.current?.getBoundingClientRect().height ?? 0;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { y: e.clientY, h: current() };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    document.body.classList.add("row-resizing");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setHeight(drag.current.h - (e.clientY - drag.current.y));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    document.body.classList.remove("row-resizing");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowUp" ? KEY_STEP : e.key === "ArrowDown" ? -KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    setHeight(current() + step);
  };

  return (
    <div
      className="row-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize Recent agents"
      aria-valuenow={height ?? undefined}
      aria-valuemin={LIST_HEIGHT.min}
      aria-valuemax={LIST_HEIGHT.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => setHeight(null)}
      onKeyDown={onKeyDown}
    />
  );
}
