import { useMemo, useState } from "react";
import { webKey, type MachineView, type WebPane } from "../types";
import { PaneCard } from "./PaneCard";
import { groupByStatus, rowPane, type PaneRow } from "./order";
import { markSeen, shownStatus } from "./seen";

const LABELS = [["needs", "Needs you"], ["working", "Working"], ["done", "Done"], ["idle", "Idle"]] as const;

export function PaneGroups({ machine, current, onOpen }: { machine: MachineView | undefined; current: string | null; onOpen(p: WebPane): void }) {
  const [bump, setBump] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bump re-reads the seen marks
  const groups = useMemo(() => groupByStatus(machine?.sessions ?? [], shownStatus), [machine, bump]);

  // Every Pane opens: a shell has no Chat lens but its Terminal lens is always there.
  const tap = (row: PaneRow) => {
    if (row.pane.status === "done") {
      markSeen(webKey(rowPane(row)));
      setBump((n) => n + 1);
    }
    onOpen(rowPane(row));
  };

  return (
    <>
      {LABELS.map(([id, label]) =>
        groups[id].length === 0 ? null : (
          <section key={id} data-group={id}>
            <h2 className="group-head"><span>{label}</span><span className="group-count">{groups[id].length}</span></h2>
            <ul className="pane-cards">
              {groups[id].map((row) => {
                const key = webKey(rowPane(row));
                return <PaneCard key={`${key}@${row.workspace_id}`} row={row} current={current === key} onTap={() => tap(row)} />;
              })}
            </ul>
          </section>
        ),
      )}
      {groups.failed.map((f) => <p key={f.name} className="session-failed">{`${f.name}: ${f.message}`}</p>)}
      {groups.stopped.length > 0 && <p className="sessions-stopped">{`Stopped: ${groups.stopped.join(", ")}`}</p>}
    </>
  );
}
