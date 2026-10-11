import { useEffect, useRef, useState } from "react";
import type { WorkspaceView } from "../lib/types";
import { PathInput } from "../ui/PathInput";
import { FOLDER_HINT, getFolder, setFolder, suggestFolder } from "../workspaces/folder";
import { AgentIcon } from "./AgentIcon";
import { AGENTS, openAgentTab, type Agent } from "./openAgentTab";

export function NewAgentDialog({
  machineId,
  session,
  workspace,
  onClose,
  onError,
}: {
  machineId: string;
  session: string;
  workspace: WorkspaceView;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const ref = { machine_id: machineId, session, workspace_id: workspace.workspace_id };
  const [stored] = useState(() => getFolder(ref));
  const [folder, setFolderValue] = useState(() => suggestFolder(workspace));
  // Clicking an agent submits the form; Enter in the folder field picks the first (claude).
  const picked = useRef<Agent>(AGENTS[0]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const start = async (agent: Agent) => {
    const cwd = (stored ?? folder).trim();
    if (!cwd) return;
    onClose();
    try {
      if (stored === null) setFolder(ref, cwd);
      await openAgentTab(machineId, session, workspace.workspace_id, agent, cwd);
    } catch (e) {
      onError((e as { message?: string }).message ?? String(e));
    }
  };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-label="New agent"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          const agent = picked.current;
          picked.current = AGENTS[0];
          void start(agent);
        }}
      >
        <div className="dialog-head">
          <h3>New agent in {workspace.label}</h3>
          <kbd aria-hidden="true">esc</kbd>
        </div>
        {stored === null && (
          <PathInput machineId={machineId} label="Folder" autoFocus value={folder} placeholder="/path/to/project" onChange={setFolderValue}
            hint={`Saved as the workspace folder, so this is asked only once. ${FOLDER_HINT}`} />
        )}
        <div className="agent-pick" role="group" aria-label="Agent">
          {AGENTS.map((a, i) => (
            <button key={a} type="submit" autoFocus={stored !== null && i === 0} onClick={() => (picked.current = a)}>
              <span aria-hidden="true"><AgentIcon agent={a === "shell" ? null : a} /></span>
              {a}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
