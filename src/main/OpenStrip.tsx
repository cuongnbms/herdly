import { memo, useState } from "react";
import type { DragEvent } from "react";
import { createPortal } from "react-dom";
import { ContextMenu, type MenuItem } from "../sidebar/ContextMenu";
import { StatusDot } from "../sidebar/StatusDot";
import { AgentIcon } from "../agents/AgentIcon";
import { useTabLayout } from "../settings/tabLayout";
import { closeItemsGuarded } from "../files/closeGuard";
import { useShallow } from "zustand/react/shallow";
import { useDrafts } from "../files/drafts";
import { absPath, type Root } from "../files/root";
import { wsKey } from "../files/store";
import { useResolvedRoots } from "../files/useFilesRoot";
import { useApp, viewedItems } from "../store/app";
import { diffLabel } from "../git/paths";
import { itemKey, type OpenItem } from "../store/openItems";
import type { MachineView, PaneView } from "../lib/types";
import { DiffIcon, CloseIcon, FileIcon } from "../ui/icons";

interface Entry {
  key: string;
  label: string;
  /** The Workspace's label, shown with the title. */
  project: string;
  /** Hover text: where the item lives, then what it is. */
  title: string;
  /** Set for a pane item (an agent or a terminal); a file or diff item shows an icon instead. */
  pane?: PaneView;
  icon?: "file" | "diff";
}

/** A file item's path for its tooltip: `rel` under its Workspace's resolved root, else the full path. */
function filePath(item: Extract<OpenItem, { kind: "file" }>, roots: Record<string, { root: Root }>): string {
  return roots[wsKey(item.ws)]?.root.path === item.root ? item.rel : absPath(item.root, item.rel);
}

function entries(machines: Record<string, MachineView>, items: OpenItem[], roots: Record<string, { root: Root }>): Entry[] {
  return items.flatMap((item): Entry[] => {
    const key = itemKey(item);
    if (item.kind === "diff") {
      const place = placeOf(machines, item.ws.machine_id, item.ws.session, item.ws.workspace_id);
      return place ? [{ key, label: diffLabel(item), project: place.project, title: `${place.where} · ${item.path}`, icon: "diff" }] : [];
    }
    if (item.kind === "file") {
      const place = placeOf(machines, item.ws.machine_id, item.ws.session, item.ws.workspace_id);
      return place ? [{ key, label: item.rel.split("/").pop() ?? item.rel, project: place.project, title: `${place.where} · ${filePath(item, roots)}` }] : [];
    }
    const { machine_id, session, pane_id } = item.ref;
    const machine = machines[machine_id];
    for (const w of machine?.sessions.find((s) => s.name === session)?.workspaces ?? [])
      for (const t of w.tabs)
        for (const pane of t.panes)
          if (pane.pane_id === pane_id) return [{ key, label: pane.title, project: w.label, title: `${machine.label}/${session} · ${w.label} · ${pane.title}`, pane }];
    return [];
  });
}

function placeOf(machines: Record<string, MachineView>, machine_id: string, session: string, workspace_id: string): { where: string; project: string } | null {
  const machine = machines[machine_id];
  const w = machine?.sessions.find((s) => s.name === session)?.workspaces.find((x) => x.workspace_id === workspace_id);
  return w ? { where: `${machine.label}/${session} · ${w.label}`, project: w.label } : null;
}

/** The panes and files opened in the viewed session, like an editor's open files. */
type Side = "before" | "after";

/** Which half of the tab under the pointer: the dragged tab lands on that side of it. */
const sideOf = (e: DragEvent): Side => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientX < r.left + r.width / 2 ? "before" : "after";
};

const TAB_TYPE = "application/x-herdr-open-item";

export const OpenStrip = memo(function OpenStrip() {
  const machines = useApp((s) => s.machines);
  const { items, preview, active } = useApp(viewedItems);
  const activate = useApp((s) => s.activateItem);
  const pin = useApp((s) => s.pinItem);
  const moveItem = useApp((s) => s.moveItem);
  const layout = useTabLayout((s) => s.layout);
  const roots = useResolvedRoots((s) => s.roots);
  // Keys of the dirty Drafts: unchanged by keystrokes once a Draft is dirty.
  const dirty = useDrafts(useShallow((s) => Object.entries(s.drafts).filter(([, d]) => d.dirty).map(([k]) => k)));
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  // The tab being dragged, and the tab and side it would land on.
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ key: string; side: Side } | null>(null);
  const tabs = entries(machines, items, roots);
  if (tabs.length === 0) return null;

  const close = (key: string) => void closeItemsGuarded(key, "one");
  // Commands that would close nothing are left out.
  const menuItems = (key: string): MenuItem[] => {
    const at = tabs.findIndex((e) => e.key === key);
    const list: MenuItem[] = [{ label: "Close", icon: CloseIcon, onSelect: () => close(key) }];
    if (tabs.length > 1) list.push({ label: "Close Others", icon: CloseIcon, onSelect: () => void closeItemsGuarded(key, "others") });
    if (at < tabs.length - 1) list.push({ label: "Close to the Right", icon: CloseIcon, onSelect: () => void closeItemsGuarded(key, "right") });
    list.push({ label: "Close All", icon: CloseIcon, onSelect: () => void closeItemsGuarded(key, "all") });
    return list;
  };

  return (
    <div className={`files-tabs agent-tabs tabs-${layout}`} role="tablist" aria-label="Open items">
      {tabs.map(({ key, label, project, title, pane, icon }) => {
        const isActive = key === active;
        const unsaved = dirty.includes(key);
        const state = `${isActive ? " active" : ""}${key === preview ? " preview" : ""}`;
        const drop = over?.key === key ? ` drop-${over.side}` : "";
        const onDragOver = (e: DragEvent) => {
          if (!dragging || dragging === key) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const side = sideOf(e);
          setOver((p) => (p?.key === key && p.side === side ? p : { key, side }));
        };
        return (
          // The tab and its close button are siblings: a tab must not contain another control.
          <div
            key={key}
            role="none"
            title={title}
            className={`files-tab-item${state}${unsaved ? " dirty" : ""}${dragging === key ? " dragging" : ""}${drop}`}
            draggable
            onDragStart={(e) => {
              // WebKit starts a drag only when it carries data.
              e.dataTransfer.setData(TAB_TYPE, key);
              e.dataTransfer.effectAllowed = "move";
              setDragging(key);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onDragEnter={onDragOver}
            onDragOver={onDragOver}
            onDragLeave={(e) => {
              // By the pointer, not `relatedTarget`, which WebKit may leave null.
              const r = e.currentTarget.getBoundingClientRect();
              if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
              setOver((p) => (p?.key === key ? null : p));
            }}
            onDrop={(e) => {
              const from = dragging;
              setDragging(null);
              setOver(null);
              if (!from || from === key) return;
              e.preventDefault();
              moveItem(from, key, sideOf(e));
            }}
            onClick={() => activate(key)}
            onDoubleClick={() => pin(key)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, key });
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                close(key);
              }
            }}
          >
            <span className="tab-lead">
              {pane ? (
                <>
                  <AgentIcon agent={pane.agent} />
                  <StatusDot status={pane.status} />
                </>
              ) : icon === "diff" ? (
                <DiffIcon className="diff-icon" aria-hidden="true" />
              ) : (
                <FileIcon aria-hidden="true" />
              )}
            </span>
            <span
              role="tab"
              aria-label={`${label}, ${project}`}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={`files-tab${state}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate(key);
                }
              }}
            >
              {layout === "two-lines" ? (
                <>
                  <span className="files-tab-name">{label}</span>
                  <span className="tab-project">{project}</span>
                </>
              ) : (
                <>
                  <span className="tab-project">{project}</span>
                  <span className="tab-sep" aria-hidden="true">›</span>
                  <span className="files-tab-name">{label}</span>
                </>
              )}
            </span>
            <button
              type="button"
              className="files-tab-close"
              aria-label={`Close ${label}${unsaved ? " (unsaved)" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                close(key);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
      {/* Out of the tablist, and fixed to the window rather than to an animating ancestor. */}
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.key)} onClose={() => setMenu(null)} />, document.body)}
    </div>
  );
});
