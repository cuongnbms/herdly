import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/ipc", () => ({ notifyPane: vi.fn(async () => {}) }));
import { notifyPane } from "./lib/ipc";
import { notificationSound, notifyPaneStatus, setNotificationSound, shouldNotify } from "./notify";
const ref = { machine_id: "local", session: "default", pane_id: "w1:p1" };
const ev = (status: any, previous: any) => ({ pane: ref, status, previous, title: "Rewrite" });

describe("shouldNotify", () => {
  it("notifies on blocked/done for other panes", () => {
    expect(shouldNotify(ev("blocked", "working"), null, true)).toBe(true);
    expect(shouldNotify(ev("done", "working"), { ...ref, pane_id: "w2:p1" }, true)).toBe(true);
  });
  it("stays quiet otherwise", () => {
    expect(shouldNotify(ev("working", "idle"), null, true)).toBe(false);
    expect(shouldNotify(ev("blocked", "working"), ref, true)).toBe(false);
    expect(shouldNotify(ev("blocked", "working"), null, false)).toBe(false);
    expect(shouldNotify(ev("done", "done"), null, true)).toBe(false);
  });
});

describe("notification sound", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(notifyPane).mockClear();
  });

  it("defaults to the system sound and remembers the one picked", () => {
    expect(notificationSound()).toBe("Default");
    setNotificationSound("Glass");
    expect(notificationSound()).toBe("Glass");
    setNotificationSound("None");
    expect(notificationSound()).toBe("None");
  });

  it("keeps the other settings and falls back on an unknown sound", () => {
    localStorage.setItem("herdly:settings", JSON.stringify({ notifications: false, notificationSound: "Nope" }));
    expect(notificationSound()).toBe("Default");
    setNotificationSound("Ping");
    expect(JSON.parse(localStorage.getItem("herdly:settings")!)).toEqual({ notifications: false, notificationSound: "Ping" });
  });

  it("delivers the notification with the picked sound", async () => {
    setNotificationSound("Hero");
    await notifyPaneStatus(ev("blocked", "working"), null, {});
    expect(notifyPane).toHaveBeenCalledWith(ref, "Rewrite is blocked", "local › default › Rewrite", "Hero");
  });
});
