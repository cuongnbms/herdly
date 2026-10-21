import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copy";

afterEach(() => {
  delete (document as { execCommand?: unknown }).execCommand;
});

describe("copyText", () => {
  it("copies through a selected off-screen textarea and removes it", () => {
    let seen: string | null = null;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((cmd: string) => {
        seen = cmd === "copy" ? (document.activeElement as HTMLTextAreaElement).value : null;
        return true;
      }),
    });
    expect(copyText("pnpm test")).toBe(true);
    expect(seen).toBe("pnpm test");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("returns false when the browser refuses or throws, and still removes the textarea", () => {
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    expect(copyText("x")).toBe(false);
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => { throw new Error("no"); }) });
    expect(copyText("x")).toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});
