interface Props {
  path: string;
  origPath: string | null;
  letter: string;
  active: boolean;
  onOpen(pin: boolean): void;
  onMenu?(x: number, y: number): void;
}

/** One changed file: its name, its folder (or `old → new` for a rename) and its status letter. */
export function FileRow({ path, origPath, letter, active, onOpen, onMenu }: Props) {
  const slash = path.lastIndexOf("/");
  const dir = origPath ? `${origPath} → ${path}` : slash >= 0 ? path.slice(0, slash) : "";
  return (
    <button
      type="button"
      className="git-row"
      title={path}
      aria-current={active ? "true" : undefined}
      onClick={() => onOpen(false)}
      onDoubleClick={() => onOpen(true)}
      onContextMenu={
        onMenu &&
        ((e) => {
          e.preventDefault();
          onMenu(e.clientX, e.clientY);
        })
      }
    >
      <span className="git-row-name">{path.slice(slash + 1)}</span>
      <span className="git-row-dir">{dir}</span>
      <span className={`git-letter git-letter-${letter}`}>{letter}</span>
    </button>
  );
}
