import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { usePrompt } from "./usePrompt";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), paneRead: vi.fn(), paneKeys: vi.fn(), paneText: vi.fn() }));

const pane = { session: "s", pane_id: "p1" };
const view = (status: string, title = "t") => ({ pane_id: "p1", terminal_id: "t1", title, cwd: null, agent: "claude", status }) as never;
const SCREEN = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api.paneRead).mockResolvedValue(SCREEN); });
afterEach(() => { vi.useRealTimers(); vi.mocked(api.paneRead).mockReset(); });

describe("usePrompt", () => {
  it("never reads the screen unless the pane is blocked", async () => {
    renderHook(() => usePrompt(pane, view("working")));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(api.paneRead).not.toHaveBeenCalled();
  });

  it("reads at once when blocked, then every 1500 ms, and builds a card", async () => {
    const { result } = renderHook(() => usePrompt(pane, view("blocked")));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.paneRead).toHaveBeenCalledTimes(1);
    expect(api.paneRead).toHaveBeenCalledWith(pane);
    expect(result.current.prompt).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(api.paneRead).toHaveBeenCalledTimes(2);
  });

  it("does not read while the page is hidden", async () => {
    renderHook(() => usePrompt(pane, view("blocked")));
    await act(() => vi.advanceTimersByTimeAsync(0));
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(() => vi.advanceTimersByTimeAsync(4500));
    expect(api.paneRead).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("stops reading and drops the card when the status leaves blocked", async () => {
    const { result, rerender } = renderHook(({ v }) => usePrompt(pane, v), { initialProps: { v: view("blocked") } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    rerender({ v: view("working") });
    await act(() => vi.advanceTimersByTimeAsync(4500));
    expect(result.current.prompt).toBeNull();
    expect(api.paneRead).toHaveBeenCalledTimes(1);
  });

  it("reads again at once when the title changes while blocked", async () => {
    const { rerender } = renderHook(({ v }) => usePrompt(pane, v), { initialProps: { v: view("blocked", "a") } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    rerender({ v: view("blocked", "b") });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.paneRead).toHaveBeenCalledTimes(2);
  });

  it("skips a tick while a read is still in flight", async () => {
    vi.mocked(api.paneRead).mockReturnValue(new Promise(() => {}));
    renderHook(() => usePrompt(pane, view("blocked")));
    await act(() => vi.advanceTimersByTimeAsync(4500));
    expect(api.paneRead).toHaveBeenCalledTimes(1);
  });

  it("ignores a read that lands after the status left blocked", async () => {
    let land!: (s: string) => void;
    vi.mocked(api.paneRead).mockReturnValue(new Promise((r) => (land = r)));
    const { result, rerender } = renderHook(({ v }) => usePrompt(pane, v), { initialProps: { v: view("blocked") } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    rerender({ v: view("working") });
    await act(async () => land(SCREEN));
    expect(result.current.prompt).toBeNull();
  });

  it("keeps the same card object while the screen shows the same prompt", async () => {
    const { result } = renderHook(() => usePrompt(pane, view("blocked")));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const first = result.current.prompt;
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(result.current.prompt).toBe(first);
  });

  it("answers a tapped option by sending the keys, and shows the fresh prompt when nothing was sent", async () => {
    vi.mocked(api.paneKeys).mockResolvedValue(undefined);
    const { result } = renderHook(() => usePrompt(pane, view("blocked")));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const first = result.current.prompt!;
    vi.mocked(api.paneRead).mockResolvedValue("Another question?\n❯ 1. A\n  2. B\n");
    await act(async () => { await result.current.answer({ option_index: 0 }); });
    expect(api.paneKeys).not.toHaveBeenCalled();
    expect(result.current.prompt).not.toBeNull();
    expect(result.current.prompt!.id).not.toBe(first.id);
    expect(result.current.prompt!.question).toBe("Another question?");
  });

  it("surfaces a failed answer", async () => {
    const { result } = renderHook(() => usePrompt(pane, view("blocked")));
    await act(() => vi.advanceTimersByTimeAsync(0));
    vi.mocked(api.paneRead).mockRejectedValue(new Error("pane gone"));
    await act(async () => { await result.current.answer({ option_index: 0 }); });
    expect(result.current.error).toBe("pane gone");
    expect(result.current.busy).toBe(false);
  });
});
