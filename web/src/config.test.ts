import { describe, expect, it } from "vitest";
import { assetsInline, canChat, CHAT_AGENTS } from "./config";

describe("canChat", () => {
  it("accepts Claude Code and pi only", () => {
    expect(CHAT_AGENTS).toEqual(["claude", "pi"]);
    expect(canChat({ agent: "claude" })).toBe(true);
    expect(canChat({ agent: "pi" })).toBe(true);
    expect(canChat({ agent: "codex" })).toBe(false);
    expect(canChat({ agent: null })).toBe(false);
  });
});

describe("vite build", () => {
  it("never inlines a font, so the CSP's default-src 'self' can load it", () => {
    expect(assetsInline("/w/src/fonts/jetbrains-mono-vietnamese-400-normal.woff2")).toBe(false);
    expect(assetsInline("/w/src/icon.svg")).toBeUndefined();
  });
});
