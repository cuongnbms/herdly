import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { machineConnect } from "../lib/ipc";
import type { MachineView, WorkspaceView } from "../lib/types";
import { useApp } from "../store/app";
import { ConfirmDialog, ContextMenu, TextDialog } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import { MoveToGroupDialog } from "./MoveToGroupDialog";
import type { SessionKey } from "./groups";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import { NewSessionDialog } from "./NewSessionDialog";
import { NewAgentDialog } from "../agents/NewAgentDialog";
import { FOLDER_HINT, setFolder } from "../workspaces/folder";
import type { WorkspaceRef } from "../workspaces/folder";
import { AddMachineDialog } from "../machines/AddMachineDialog";
const ConnectDialog = lazy(() => import("../machines/ConnectDialog").then((m) => ({ default: m.ConnectDialog })));

type Dialog =
  | { kind: "rename"; title: string; initial: string; submitLabel: string; run: (label: string) => Promise<unknown> }
  | { kind: "confirm"; title: string; message: string; confirmLabel: string; run: () => Promise<unknown> }
  | { kind: "session"; machineId?: string; groupId?: string }
  | { kind: "workspace"; machineId: string; session: string; defaultCwd: string }
  | { kind: "agent"; machineId: string; session: string; workspace: WorkspaceView }
  | { kind: "folder"; ref: WorkspaceRef; initial: string }
  | { kind: "move"; key: SessionKey }
  | { kind: "add-machine" }
  | { kind: "connect"; machine: MachineView };

export interface Actions {
  menu: (e: MouseEvent, items: MenuItem[]) => void;
  /** The menu at a point, e.g. under the button that opened it. */
  menuAt: (x: number, y: number, items: MenuItem[]) => void;
  rename: (title: string, initial: string, run: (label: string) => Promise<unknown>, submitLabel?: string) => void;
  confirm: (title: string, message: string, confirmLabel: string, run: () => Promise<unknown>) => void;
  /** No `machineId`: the dialog offers a machine picker. `groupId`: place the new session there. */
  newSession: (machineId?: string, groupId?: string) => void;
  newWorkspace: (machineId: string, session: string) => void;
  newAgent: (machineId: string, session: string, workspace: WorkspaceView) => void;
  changeFolder: (ref: WorkspaceRef, initial: string) => void;
  moveToGroup: (key: SessionKey) => void;
  addMachine: () => void;
  connect: (machine: MachineView) => void;
  guard: (run: () => Promise<unknown>) => void;
}

const ActionsCtx = createContext<Actions | null>(null);
export const useActions = () => useContext(ActionsCtx);

/** A cwd to pre-fill for a new workspace: the selected pane's, else any pane's in the session. */
function defaultCwdFor(machineId: string, sessionName: string): string {
  const { machines, selected } = useApp.getState();
  const session = machines[machineId]?.sessions.find((s) => s.name === sessionName);
  const panes = session?.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes)) ?? [];
  if (selected && selected.machine_id === machineId && selected.session === sessionName) {
    const cwd = panes.find((p) => p.pane_id === selected.pane_id)?.cwd;
    if (cwd) return cwd;
  }
  return panes.find((p) => p.cwd)?.cwd ?? "";
}

function errorMessage(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? String(e);
}

/** Context menu, dialogs and the action error line shared by the Sidebar and the Agents column. */
export function ActionsProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guard = useCallback((run: () => Promise<unknown>) => {
    setError(null);
    run().catch((e) => setError(errorMessage(e)));
  }, []);
  const actions = useMemo<Actions>(
    () => ({
      guard,
      menu: (e, items) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items });
      },
      menuAt: (x, y, items) => setMenu({ x, y, items }),
      rename: (title, initial, run, submitLabel = "Rename") => setDialog({ kind: "rename", title, initial, submitLabel, run }),
      confirm: (title, message, confirmLabel, run) => setDialog({ kind: "confirm", title, message, confirmLabel, run }),
      newAgent: (machineId, session, workspace) => setDialog({ kind: "agent", machineId, session, workspace }),
      changeFolder: (ref, initial) => setDialog({ kind: "folder", ref, initial }),
      moveToGroup: (key) => setDialog({ kind: "move", key }),
      addMachine: () => setDialog({ kind: "add-machine" }),
      // Batch first (key or agent); the dialog opens only when that needs the user.
      connect: (machine) => {
        if (machine.state === "error" && machine.error?.code === "ssh_auth") {
          setDialog({ kind: "connect", machine });
          return;
        }
        setError(null);
        machineConnect(machine.id).catch((e) => {
          if ((e as { code?: string } | null)?.code === "ssh_auth") setDialog({ kind: "connect", machine });
          else setError(errorMessage(e));
        });
      },
      newSession: (machineId, groupId) => setDialog({ kind: "session", machineId, groupId }),
      newWorkspace: (machineId, session) =>
        setDialog({ kind: "workspace", machineId, session, defaultCwd: defaultCwdFor(machineId, session) }),
    }),
    [guard],
  );
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  let modal: ReactNode = null;
  if (dialog?.kind === "rename") {
    modal = (
      <TextDialog title={dialog.title} initial={dialog.initial} submitLabel={dialog.submitLabel} onClose={closeDialog}
        onSubmit={(v) => v.trim() && guard(() => dialog.run(v.trim()))} />
    );
  } else if (dialog?.kind === "confirm") {
    modal = (
      <ConfirmDialog title={dialog.title} message={dialog.message} confirmLabel={dialog.confirmLabel}
        onClose={closeDialog} onConfirm={() => guard(dialog.run)} />
    );
  } else if (dialog?.kind === "session") {
    modal = <NewSessionDialog machineId={dialog.machineId} groupId={dialog.groupId} onClose={closeDialog} onError={setError} />;
  } else if (dialog?.kind === "workspace") {
    modal = (
      <NewWorkspaceDialog machineId={dialog.machineId} session={dialog.session} defaultCwd={dialog.defaultCwd}
        onClose={closeDialog} onError={setError} />
    );
  } else if (dialog?.kind === "agent") {
    modal = (
      <NewAgentDialog machineId={dialog.machineId} session={dialog.session} workspace={dialog.workspace}
        onClose={closeDialog} onError={setError} />
    );
  } else if (dialog?.kind === "folder") {
    modal = (
      <TextDialog title="Workspace folder" initial={dialog.initial} submitLabel="Save" folderOn={dialog.ref.machine_id} hint={FOLDER_HINT}
        onClose={closeDialog}
        onSubmit={(v) => v.trim() && setFolder(dialog.ref, v)} />
    );
  } else if (dialog?.kind === "move") {
    modal = <MoveToGroupDialog sessionKey={dialog.key} onClose={closeDialog} />;
  } else if (dialog?.kind === "add-machine") {
    modal = (
      <AddMachineDialog
        onClose={closeDialog}
        onNeedAuth={(m) => setDialog({ kind: "connect", machine: useApp.getState().machines[m.id] ?? m })}
      />
    );
  } else if (dialog?.kind === "connect") {
    modal = (
      <Suspense fallback={null}>
        <ConnectDialog machine={dialog.machine} onClose={closeDialog} />
      </Suspense>
    );
  }

  return (
    <ActionsCtx.Provider value={actions}>
      {children}
      {error && (
        <p className="error action-error" role="alert" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {modal}
    </ActionsCtx.Provider>
  );
}
