import { ChevronIcon } from "../ui/icons";
import type { GitRepo } from "../lib/types";
import { useGit } from "./store";
import { sections, type Row } from "./sections";

interface Props {
  repo: GitRepo;
  activeKey: string | null;
  keyOf(row: Row): string;
  onOpen(row: Row, pin: boolean): void;
  onMenu(row: Row, x: number, y: number): void;
}

export function ChangeList({ repo, activeKey, keyOf, onOpen, onMenu }: Props) {
  const collapsed = useGit((s) => s.collapsed);
  const toggleSection = useGit((s) => s.toggleSection);
  const { merge, staged, changes } = sections(repo.entries);
  const hidden = repo.total - repo.entries.length;

  const section = (id: string, name: string, rows: Row[]) => {
    const open = !collapsed[id];
    return (
      <div className="git-section" role="group" aria-label={name} key={id}>
        <button type="button" className="git-section-head" aria-expanded={open} onClick={() => toggleSection(id)}>
          <ChevronIcon className={open ? "open" : undefined} />
          {name} <span className="git-count">({rows.length})</span>
        </button>
        {open &&
          rows.map((row) => {
            const slash = row.path.lastIndexOf("/");
            const name = row.path.slice(slash + 1);
            const dir = row.origPath ? `${row.origPath} → ${row.path}` : slash >= 0 ? row.path.slice(0, slash) : "";
            const k = keyOf(row);
            return (
              <button
                type="button"
                className="git-row"
                key={`${row.scope}:${row.path}`}
                title={row.path}
                aria-current={k === activeKey ? "true" : undefined}
                onClick={() => onOpen(row, false)}
                onDoubleClick={() => onOpen(row, true)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu(row, e.clientX, e.clientY);
                }}
              >
                <span className="git-row-name">{name}</span>
                <span className="git-row-dir">{dir}</span>
                <span className={`git-letter git-letter-${row.letter}`}>{row.letter}</span>
              </button>
            );
          })}
      </div>
    );
  };

  return (
    <>
      {merge.length > 0 && section("merge", "Merge Changes", merge)}
      {section("staged", "Staged Changes", staged)}
      {section("changes", "Changes", changes)}
      {hidden > 0 && <div className="git-more">{`… ${hidden} more files`}</div>}
    </>
  );
}
