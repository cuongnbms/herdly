import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { showToast } from "../ui/Toast";
import { filesImage, filesListAll, filesListDir, filesRead, herdrCall } from "./ipc";

describe("herdrCall", () => {
  it("toasts on timeout and rethrows", async () => {
    (invoke as any).mockRejectedValueOnce({ code: "timeout", message: "x" });
    await expect(herdrCall("local", "default", "pane.read", {})).rejects.toMatchObject({ code: "timeout" });
    expect(showToast).toHaveBeenCalledWith("pane.read timed out");
  });
  it("does not toast other errors", async () => {
    (invoke as any).mockRejectedValueOnce({ code: "io", message: "x" });
    vi.mocked(showToast).mockClear();
    await expect(herdrCall("local", "default", "pane.read", {})).rejects.toBeTruthy();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("files ipc", () => {
  it("passes camelCase args", async () => {
    (invoke as any).mockResolvedValueOnce({ kind: "text", text: "x", truncated: false, size: 1, mtime: 2 });
    await filesRead("devtuf", "~/app", "src/a.ts");
    expect(invoke).toHaveBeenLastCalledWith("files_read", { machineId: "devtuf", root: "~/app", rel: "src/a.ts" });
  });
  it("passes camelCase args to the other files commands", async () => {
    (invoke as any).mockResolvedValue(null);
    await filesListDir("devtuf", "~/app", "src");
    expect(invoke).toHaveBeenLastCalledWith("files_list_dir", { machineId: "devtuf", root: "~/app", rel: "src", hidden: [] });
    await filesListDir("devtuf", "~/app", "src", [".git"]);
    expect(invoke).toHaveBeenLastCalledWith("files_list_dir", { machineId: "devtuf", root: "~/app", rel: "src", hidden: [".git"] });
    await filesListAll("devtuf", "~/app");
    expect(invoke).toHaveBeenLastCalledWith("files_list_all", { machineId: "devtuf", root: "~/app" });
    await filesImage("local", "/x", "a.png");
    expect(invoke).toHaveBeenLastCalledWith("files_image", { machineId: "local", root: "/x", rel: "a.png" });
  });
});
