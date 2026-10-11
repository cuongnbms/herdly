import { useMemo } from "react";
import { AgentIcon } from "../agents/AgentIcon";
import { dashboardCards, sidebarAgents } from "../dashboard/buckets";
import { paneKey } from "../lib/types";
import { useApp } from "../store/app";
import { SectionHeader } from "./Sidebar";
import { StatusDot } from "./StatusDot";

/** Agents that are Blocked, Done (not yet seen) or Working, docked above Machines; shown even when there are none. */
export function AgentsSection() {
  const machines = useApp((s) => s.machines);
  const order = useApp((s) => s.order);
  const doneSeen = useApp((s) => s.doneSeen);
  const since = useApp((s) => s.statusSince);
  const selectedKey = useApp((s) => (s.selected ? paneKey(s.selected) : null));
  const select = useApp((s) => s.select);
  const open = useApp((s) => s.expanded["agents"] ?? true);
  const cards = useMemo(() => sidebarAgents(dashboardCards(machines, order, doneSeen, since)), [machines, order, doneSeen, since]);
  return (
    <section aria-label="Working agents" className="agents-section">
      <SectionHeader id="agents" label="Working agents" count={cards.length} />
      {open && cards.length > 0 && (
        <ul className="tree">
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
