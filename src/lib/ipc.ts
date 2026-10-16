import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { showToast } from "../ui/Toast";
import type { AttachEvent, BtwEvent, ChatEvent, ChatItem, FileContent, FileEntry, FileList, FileVersion, FileDiff, Forked, GitCommit, GitCommitFile, GitRepo, GitStatus, DiffScope, Located, MachineView, PaneRef, PaneStatusEvent, PiModel, QuotaOutcome, QuotaProvider, SlashCommand, WatchEvent } from "./types";

export const machinesList = () => invoke<MachineView[]>("machines_list");
export const machineConnect = (id: string) => invoke<void>("machine_connect", { id });
export const machineDisconnect = (id: string) => invoke<void>("machine_disconnect", { id });
export const sshHosts = () => invoke<string[]>("ssh_hosts");
export const systemFonts = () => invoke<string[]>("system_fonts");
/** Raw file of an installed font's face (CoreText style name); rejects when not web-loadable. */
export const fontFace = (family: string, style: string) => invoke<ArrayBuffer>("font_face", { family, style });
/** Native appearance (vibrancy, traffic lights); `null` follows the system. */
export const setWindowTheme = (theme: "light" | "dark" | null) => getCurrentWindow().setTheme(theme);
/** The Dock icon's badge count; `undefined` removes it. */
export const setDockBadge = (count: number | undefined) => getCurrentWindow().setBadgeCount(count);
export const machineAdd = (sshTarget: string, label: string | null, herdrPath: string | null) =>
  invoke<MachineView>("machine_add", { sshTarget, label, herdrPath });
export const machineRemove = (id: string) => invoke<void>("machine_remove", { id });
export const machineUpdate = (id: string, herdrPath: string | null) =>
  invoke<MachineView>("machine_update", { id, herdrPath });
export const machineMasterAlive = (id: string) => invoke<boolean>("machine_master_alive", { id });
export const connectOpen = (
  machineId: string,
  cols: number,
  rows: number,
  data: Channel<ArrayBuffer>,
  events: Channel<AttachEvent>,
) => invoke<void>("connect_open", { machineId, cols, rows, data, events });
export const connectWrite = (machineId: string, data: string) => invoke<void>("connect_write", { machineId, data });
export const connectAck = (machineId: string, bytes: number) => invoke<void>("connect_ack", { machineId, bytes });
export const connectResize = (machineId: string, cols: number, rows: number) =>
  invoke<void>("connect_resize", { machineId, cols, rows });
export const connectClose = (machineId: string) => invoke<void>("connect_close", { machineId });
/** The saved sidebar layout, or `null` when none was saved yet. */
export const layoutLoad = () => invoke<unknown>("layout_load");
export const layoutSave = (layout: unknown) => invoke<void>("layout_save", { layout });
export const sessionsRefresh = (machineId: string) => invoke<void>("sessions_refresh", { machineId });
export const sessionStart = (machineId: string, session: string) =>
  invoke<void>("session_start", { machineId, session });
export const sessionStop = (machineId: string, session: string) =>
  invoke<void>("session_stop", { machineId, session });
export const sessionDelete = (machineId: string, session: string) =>
  invoke<void>("session_delete", { machineId, session });
export const herdrCall = <T>(machineId: string, session: string, method: string, params: unknown) =>
  invoke<T>("herdr_call", { machineId, session, method, params }).catch((e: unknown) => {
    if ((e as { code?: string } | null)?.code === "timeout") showToast(`${method} timed out`);
    throw e;
  });
/** Saves image bytes on the Machine (remote ones over ssh) and returns the path there. */
export const imageSaveTemp = (machineId: string, bytes: Uint8Array, ext: string) =>
  invoke<string>("image_save_temp", bytes, { headers: { "x-machine-id": machineId, "x-image-ext": ext } });

export const appQuit = () => invoke<void>("app_quit");
export const onQuitRequested = (fn: () => void): Promise<UnlistenFn> => listen("app://quit-requested", fn);
export const onMachine = (cb: (m: MachineView) => void): Promise<UnlistenFn> =>
  listen<MachineView>("sidebar://machine", (e) => cb(e.payload));
export const onPaneStatus = (cb: (e: PaneStatusEvent) => void): Promise<UnlistenFn> =>
  listen<PaneStatusEvent>("pane://status", (e) => cb(e.payload));
export const notifyPane = (pane: PaneRef, title: string, body: string) =>
  invoke<void>("notify_pane", { pane, title, body });
/** Fires with the pane of a desktop notification the user clicked. */
export const onNotifyActivate = (cb: (pane: PaneRef) => void): Promise<UnlistenFn> =>
  listen<PaneRef>("notify://activate", (e) => cb(e.payload));
/** Fires when the mouse's Back or Forward button is pressed over the window. */
export const onMouseNav = (cb: (dir: "back" | "forward") => void): Promise<UnlistenFn> =>
  listen<"back" | "forward">("mouse://nav", (e) => cb(e.payload));

export interface AttachKey {
  machine_id: string;
  session: string;
  terminal_id: string;
}

export const attachKeyString = (k: AttachKey) => `${k.machine_id}/${k.session}/${k.terminal_id}`;

export const termOpen = (
  k: AttachKey,
  cols: number,
  rows: number,
  takeover: boolean,
  data: Channel<ArrayBuffer>,
  events: Channel<AttachEvent>,
) =>
  invoke<void>("term_open", {
    machineId: k.machine_id,
    session: k.session,
    terminalId: k.terminal_id,
    cols,
    rows,
    takeover,
    data,
    events,
  });
export const termWrite = (key: AttachKey, data: string) => invoke<void>("term_write", { key, data });
export const termResize = (key: AttachKey, cols: number, rows: number) =>
  invoke<void>("term_resize", { key, cols, rows });
export const termAck = (key: AttachKey, bytes: number) => invoke<void>("term_ack", { key, bytes });
export const termRelease = (key: AttachKey) => invoke<void>("term_release", { key });
export const termClose = (key: AttachKey) => invoke<void>("term_close", { key });

export const chatOpen = (p: PaneRef, path: string | null, events: Channel<ChatEvent>) =>
  invoke<Located>("chat_open", { machineId: p.machine_id, session: p.session, paneId: p.pane_id, path, events });
export const chatLocate = (p: PaneRef) =>
  invoke<Located>("chat_locate", { machineId: p.machine_id, session: p.session, paneId: p.pane_id });
export const chatFork = (machineId: string, agent: string, path: string, entryId: string | null) =>
  invoke<Forked>("chat_fork", { machineId, agent, path, entryId });
export const chatBtwAsk = (machineId: string, path: string, question: string, forkId: string | null, askId: string, events: Channel<BtwEvent>) =>
  invoke<void>("chat_btw_ask", { machineId, path, question, forkId, askId, events });
export const chatBtwCancel = (askId: string) => invoke<void>("chat_btw_cancel", { askId });
export const chatBtwDiscard = (machineId: string, path: string, forkId: string) =>
  invoke<void>("chat_btw_discard", { machineId, path, forkId });
export const completeCommands = (p: PaneRef) =>
  invoke<SlashCommand[]>("complete_commands", { machineId: p.machine_id, session: p.session, paneId: p.pane_id });
export const completeFiles = (p: PaneRef) =>
  invoke<string[]>("complete_files", { machineId: p.machine_id, session: p.session, paneId: p.pane_id });
/** Entries of `dir` (relative to the Pane's folder, e.g. `../`), folders ending in `/`; empty when it is missing. */
export const completeEntries = (p: PaneRef, dir: string) =>
  invoke<string[]>("complete_entries", { machineId: p.machine_id, session: p.session, paneId: p.pane_id, dir });
/** Folder names inside `dir` (absolute or `~/…`) on a Machine; empty when it is missing. */
export const completeDirs = (machineId: string, dir: string) => invoke<string[]>("complete_dirs", { machineId, dir });
export const chatGitStatus = (p: PaneRef) =>
  invoke<GitStatus | null>("chat_git_status", { machineId: p.machine_id, session: p.session, paneId: p.pane_id });
export const chatPage = (p: PaneRef, before: number) =>
  invoke<ChatItem[]>("chat_page", { machineId: p.machine_id, session: p.session, paneId: p.pane_id, before });
export const chatImage = (p: PaneRef, ref: string) =>
  invoke<ArrayBuffer>("chat_image", { machineId: p.machine_id, session: p.session, paneId: p.pane_id, ref });
export const chatClose = (p: PaneRef) =>
  invoke<void>("chat_close", { machineId: p.machine_id, session: p.session, paneId: p.pane_id });
export const quotaFetch = (provider: QuotaProvider) => invoke<QuotaOutcome>("quota_fetch", { provider });
export const piModelsList = (machineId: string) => invoke<PiModel[]>("pi_models_list", { machineId });

/** Folders named in `hidden` are left out; files and linked folders with those names are kept. */
export const filesListDir = (machineId: string, root: string, rel: string, hidden: string[] = []) =>
  invoke<FileEntry[]>("files_list_dir", { machineId, root, rel, hidden });
/** Files inside a folder named in `hidden` are left out. */
export const filesListAll = (machineId: string, root: string, hidden: string[] = []) =>
  invoke<FileList>("files_list_all", { machineId, root, hidden });
export const filesRead = (machineId: string, root: string, rel: string) =>
  invoke<FileContent>("files_read", { machineId, root, rel });
export const filesImage = (machineId: string, root: string, rel: string) =>
  invoke<ArrayBuffer>("files_image", { machineId, root, rel });
export const filesHtmlPut = (html: string, scripts: boolean) => invoke<string>("files_html_put", { html, scripts });
export const filesHtmlDrop = (token: string) => invoke<void>("files_html_drop", { token });
export const filesWatch = (machineId: string, root: string, events: Channel<WatchEvent>) => invoke<number>("files_watch", { machineId, root, events });
export const filesUnwatch = (id: number) => invoke<void>("files_unwatch", { id });
export const filesUpload = (machineId: string, root: string, destRel: string, sources: string[]) =>
  invoke<string[]>("files_upload", { machineId, root, destRel, sources });
export const filesDownload = (machineId: string, root: string, rel: string) =>
  invoke<string>("files_download", { machineId, root, rel });
export const filesCreate = (machineId: string, root: string, rel: string, isDir: boolean) =>
  invoke<void>("files_create", { machineId, root, rel, isDir });
/** Renames `rel` within its folder; resolves to its new path. */
export const filesRename = (machineId: string, root: string, rel: string, name: string) =>
  invoke<string>("files_rename", { machineId, root, rel, name });
/** Moves `rel` into the folder `toDir` ("" for the root), keeping its name; resolves to its new path. */
export const filesMove = (machineId: string, root: string, rel: string, toDir: string) =>
  invoke<string>("files_move", { machineId, root, rel, toDir });
export const filesDelete = (machineId: string, root: string, rel: string) =>
  invoke<void>("files_delete", { machineId, root, rel });
/** Rejects with code `conflict` when the file is no longer `expected`. */
export const filesWrite = (machineId: string, root: string, rel: string, text: string, expected: FileVersion | null) =>
  invoke<FileVersion>("files_write", { machineId, root, rel, text, expected });

export const gitRepo = (machineId: string, dir: string) => invoke<GitRepo | null>("git_repo", { machineId, dir });
export const gitLog = (machineId: string, root: string, skip: number, limit: number) =>
  invoke<GitCommit[]>("git_log", { machineId, root, skip, limit });
export const gitCommitFiles = (machineId: string, root: string, sha: string) =>
  invoke<GitCommitFile[]>("git_commit_files", { machineId, root, sha });
export const gitDiff = (machineId: string, root: string, path: string, origPath: string | null, scope: DiffScope, untracked: boolean) =>
  invoke<FileDiff>("git_diff", { machineId, root, path, origPath, scope, untracked });
