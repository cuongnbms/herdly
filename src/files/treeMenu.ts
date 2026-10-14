import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { MenuItem } from "../sidebar/ContextMenu";
import { CopyIcon } from "../ui/icons";
import { showToast } from "../ui/Toast";
import { absPath } from "./root";

const copy = (text: string, done: string) =>
  writeText(text).then(
    () => showToast(done),
    (e) => console.error("copy failed", e),
  );

/** Copy Path / Copy Relative Path for a tree row at `rel` below `root`. */
export function copyItems(root: string, rel: string): MenuItem[] {
  return [
    { label: "Copy Path", icon: CopyIcon, group: true, onSelect: () => copy(absPath(root, rel), "Path copied") },
    { label: "Copy Relative Path", icon: CopyIcon, onSelect: () => copy(rel, "Relative path copied") },
  ];
}
