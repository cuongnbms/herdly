import { PaneGroups } from "../list/PaneGroups";
import { useWeb } from "../store";
import { Sheet } from "../ui/Sheet";
import { webKey, type WebPane } from "../types";

/** Every Pane of the machine, grouped by status; picking another one switches to it. */
export function PaneSheet({ current, onClose, onSwitch }: { current: WebPane; onClose(): void; onSwitch(p: WebPane): void }) {
  const machine = useWeb((s) => s.machines[0]);
  return (
    <Sheet title="Panes" onClose={onClose}>
      <PaneGroups
        machine={machine}
        current={webKey(current)}
        onOpen={(p) => {
          onClose();
          if (webKey(p) !== webKey(current)) onSwitch(p);
        }}
      />
    </Sheet>
  );
}
