import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_SRC = resolve(__dirname);
const DESKTOP_SRC = resolve(__dirname, "../../src");
const ALLOWED = ["lib/types", "chat/chatStore", "chat/checklist", "chat/workBlocks", "chat/prompt/screenPrompt", "chat/prompt/sendAnswer"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const specifiers = (src: string) => [...src.matchAll(/(?:import|export)[^"']*?from\s*["']([^"']+)["']/g)].map((m) => m[1]);
const resolveTs = (base: string) => [".ts", ".tsx"].map((e) => base + e).find((p) => { try { return statSync(p).isFile(); } catch { return false; } }) ?? base;

describe("imports from the desktop app", () => {
  it("use only the allowed modules", () => {
    const used = files(WEB_SRC).flatMap((f) => specifiers(readFileSync(f, "utf8"))).filter((s) => s.startsWith("@desktop/"));
    for (const s of used) expect(ALLOWED).toContain(s.slice("@desktop/".length));
  });

  it("reach only relative imports inside src/, never lib/ipc or Tauri", () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const s of specifiers(readFileSync(file, "utf8"))) {
        expect(s.startsWith("."), `${file} imports ${s}`).toBe(true);
        const next = resolveTs(resolve(dirname(file), s));
        expect(next.endsWith(join("lib", "ipc.ts"))).toBe(false);
        walk(next);
      }
    };
    for (const m of ALLOWED) walk(resolveTs(join(DESKTOP_SRC, m)));
    expect(seen.size).toBeGreaterThanOrEqual(ALLOWED.length);
  });
});
