import { create } from "zustand";
import { AGENTS, type Agent } from "../agents/openAgentTab";

/** Shared with store.ts, theme.ts, lens.ts, quickReplies.ts and notify.ts: one JSON object, each writer merges its own keys. */
const SETTINGS_KEY = "herdly:settings";

function readRaw(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const p = raw ? (JSON.parse(raw) as unknown) : null;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function save(patch: Record<string, unknown>): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readRaw(), ...patch }));
  } catch {
    /* ignore */
  }
}

/** What ⌘T starts in its new Tab. */
export function loadNewTabAgent(): Agent {
  const v = readRaw().newTabAgent;
  return AGENTS.includes(v as Agent) ? (v as Agent) : "claude";
}

interface NewTabStore {
  agent: Agent;
  setAgent: (agent: Agent) => void;
}

export const useNewTab = create<NewTabStore>((setState) => ({
  agent: loadNewTabAgent(),
  setAgent: (agent) => {
    save({ newTabAgent: agent });
    setState({ agent });
  },
}));
