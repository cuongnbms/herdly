import { useMemo, useState } from "react";
import { canChat } from "../config";
import { webKey, type MachineView, type WebPane } from "../types";
import { PaneCard } from "./PaneCard";
import { groupByStatus, rowPane, type PaneRow } from "./order";
import { markSeen, shownStatus } from "./seen";

const LABELS = [["needs", "Needs you"], ["working", "Working"], ["done", "Done"], ["idle", "Idle"]] as const;

export function PaneGroups({ machine, current, onOpen }: { machine: MachineView | undefined; current: string | null; onOpen(p: WebPane): void }) {
  const [bump, setBump] = useState(0);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bump re-reads the seen marks
  const groups = useMemo(() => groupByStatus(machine?.sessions ?? [], shownStatus), [machine, bump]);

  const tap = (row: PaneRow) => {
    const key = webKey(rowPane(row));
    if (!canChat(row.pane)) {
      setUnsupported(key);
      return;
    }
    if (row.pane.status === "done") {
      markSeen(key);
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
                return <PaneCard key={`${key}@${row.workspace_id}`} row={row} current={current === key} hint={unsupported === key} onTap={() => tap(row)} />;
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
