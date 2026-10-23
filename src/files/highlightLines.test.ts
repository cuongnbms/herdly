import { describe, expect, it } from "vitest";
import { highlightLines } from "./highlightLines";
import { HIGHLIGHT_LIMIT } from "./limits";

const text = (l: { text: string }[]) => l.map((s) => s.text).join("");

describe("highlightLines", () => {
  it("splits into lines and keeps token classes across line breaks", () => {
    const lines = highlightLines("/* a\nb */\nconst x = 1;\n", "x.ts");
    expect(lines).toHaveLength(3);
    expect(lines.map(text)).toEqual(["/* a", "b */", "const x = 1;"]);
    expect(lines[1][0].cls).toContain("hljs-comment");
    expect(lines[2].some((s) => s.cls.includes("hljs-keyword") && s.text === "const")).toBe(true);
  });
  it("unknown extension and huge text are plain", () => {
    expect(highlightLines("a\nb", "x.unknownext")).toEqual([[{ text: "a", cls: "" }], [{ text: "b", cls: "" }]]);
    const big = "x".repeat(HIGHLIGHT_LIMIT + 1);
    expect(highlightLines(big, "a.ts")).toEqual([[{ text: big, cls: "" }]]);
  });
  it("highlights env files as key=value with comments", () => {
    for (const path of [".env", "app/.env.local", "env/local.env", "env/_template.env"]) {
      const lines = highlightLines("# note\nAPI_PORT=3000\n", path);
      expect(lines[0][0].cls, path).toContain("hljs-comment");
      expect(lines[1].some((s) => s.cls.includes("hljs-attr") && s.text === "API_PORT"), path).toBe(true);
    }
  });
});
