import { describe, expect, it } from "vitest";
import { diffLabel, relInRoot } from "./paths";

const base = { kind: "diff" as const, ws: { machine_id: "m", session: "s", workspace_id: "w" }, root: "/r", repo: "/r", prefix: "", origPath: null, untracked: false };

describe("relInRoot", () => {
  it("maps a repository path below the root's prefix, and refuses one outside it", () => {
    expect(relInRoot("", "src/a.ts")).toBe("src/a.ts");
    expect(relInRoot("src/", "src/a.ts")).toBe("a.ts");
    expect(relInRoot("src/", "docs/a.md")).toBeNull();
    expect(relInRoot("src/", "srcx/a.ts")).toBeNull();
  });
});

describe("diffLabel", () => {
  it("names the file and the scope", () => {
    expect(diffLabel({ ...base, path: "src/git.rs", scope: { kind: "worktree" } })).toBe("git.rs (Working Tree)");
    expect(diffLabel({ ...base, path: "git.rs", scope: { kind: "staged" } })).toBe("git.rs (Index)");
    expect(diffLabel({ ...base, path: "a/b.ts", scope: { kind: "commit", sha: "e9aa2fd0", short: "e9aa2fd" } })).toBe("b.ts @ e9aa2fd");
  });
});
