import { beforeEach, describe, expect, it } from "vitest";
import type { SlashCommand } from "../lib/types";
import { rankCommands, rankFiles, readUsage, recordUse } from "./complete";

const cmd = (name: string): SlashCommand => ({ name, description: "", source: "builtin" });
const names = (c: SlashCommand[]) => c.map((x) => x.name);
const all = ["clear", "compact", "config", "superpowers:brainstorming", "doctor"].map(cmd);

describe("rankCommands", () => {
  it("ranks prefix, then substring, then subsequence", () => {
    expect(names(rankCommands(all, "co", {}))).toEqual(["compact", "config", "doctor"]);
    expect(names(rankCommands(all, "br", {}))).toEqual(["superpowers:brainstorming"]);
    expect(names(rankCommands(all, "", {}))).toEqual(["clear", "compact", "config", "doctor", "superpowers:brainstorming"]);
    expect(names(rankCommands([cmd("Review")], "re", {}))).toEqual(["Review"]);
  });
  it("lets usage reorder within a tier only", () => {
    expect(names(rankCommands(all, "co", { config: 3, doctor: 9 }))).toEqual(["config", "compact", "doctor"]);
  });
});

describe("rankFiles", () => {
  const files = ["README.md", "src/chat/Composer.tsx", "src/chat/composer.css", "docs/compose-notes.md", "src/lib/ipc.ts"];
  it("scores substring matches, file name first", () => {
    expect(rankFiles(files, "composer")).toEqual(["src/chat/composer.css", "src/chat/Composer.tsx"]);
    expect(rankFiles(files, "ipc")).toEqual(["src/lib/ipc.ts"]);
  });
  it("caps the list", () => {
    expect(rankFiles(files, "s", 2)).toHaveLength(2);
  });
});

describe("usage", () => {
  beforeEach(() => localStorage.clear());
  it("counts picks per agent and survives bad storage", () => {
    recordUse("claude", "compact");
    expect(recordUse("claude", "compact")).toEqual({ compact: 2 });
    expect(readUsage("claude")).toEqual({ compact: 2 });
    expect(readUsage("pi")).toEqual({});
    localStorage.setItem("herdly:slash-usage:codex", "not json");
    expect(readUsage("codex")).toEqual({});
  });
});
