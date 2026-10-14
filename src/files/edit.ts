import { filesCreate, filesDelete, filesMove, filesRename } from "../lib/ipc";
import { showToast } from "../ui/Toast";

const basename = (p: string) => p.split("/").pop() ?? p;

const errorMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);

/** Runs `op`, reporting a failure through a toast; null when it failed. */
async function report<T>(what: string, rel: string, op: () => Promise<T>): Promise<T | null> {
  try {
    return await op();
  } catch (e) {
    showToast(`Cannot ${what} ${basename(rel)}: ${errorMessage(e)}`);
    return null;
  }
}

/** Creates an empty file, or a folder, at `rel`; true when it was made. */
export const createItem = async (machineId: string, root: string, rel: string, isDir: boolean) =>
  (await report("create", rel, () => filesCreate(machineId, root, rel, isDir).then(() => true))) ?? false;

/** Renames `rel` to `name` in its folder; its new path, or null when it failed. */
export const renameItem = (machineId: string, root: string, rel: string, name: string) =>
  report("rename", rel, () => filesRename(machineId, root, rel, name));

/** Moves `rel` into the folder `toDir` ("" for the root); its new path, or null when it failed. */
export const moveItem = (machineId: string, root: string, rel: string, toDir: string) =>
  report("move", rel, () => filesMove(machineId, root, rel, toDir));

/** Deletes `rel` and everything in it; true when it is gone. */
export const deleteItem = async (machineId: string, root: string, rel: string) =>
  (await report("delete", rel, () => filesDelete(machineId, root, rel).then(() => true))) ?? false;
