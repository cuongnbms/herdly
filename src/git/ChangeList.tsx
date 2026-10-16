import { ChevronIcon } from "../ui/icons";
import type { GitRepo } from "../lib/types";
import { FileRow } from "./FileRow";
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
          rows.map((row) => (
            <FileRow
              key={`${row.scope}:${row.path}`}
              path={row.path}
              origPath={row.origPath}
              letter={row.letter}
              active={keyOf(row) === activeKey}
              onOpen={(pin) => onOpen(row, pin)}
              onMenu={(x, y) => onMenu(row, x, y)}
            />
          ))}
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
