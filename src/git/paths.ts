import type { DiffItem } from "../store/openItems";

/** The path below the Files root for the repository path `path`, when it starts with the root's `prefix` (`""` or ending in `/`); else null. */
export function relInRoot(prefix: string, path: string): string | null {
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** A diff tab's title, like VS Code's: the file name and what it is compared against. */
export function diffLabel(item: DiffItem): string {
  const name = item.path.split("/").pop() ?? item.path;
  const { scope } = item;
  return scope.kind === "worktree" ? `${name} (Working Tree)` : scope.kind === "staged" ? `${name} (Index)` : `${name} @ ${scope.short}`;
}
