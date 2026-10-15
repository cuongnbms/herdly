import { describe, expect, it } from "vitest";
import { aliasNameError, enabledConflict, hasAliasPackage, isCatalogEntry, missingTargets, parseAliases, parseSettings, renameAlias, withAliases, withEnabled, type Alias } from "./pi";

const text = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

describe("parseSettings", () => {
  it("reads enabledModels and keeps the whole object", () => {
    const r = parseSettings(text({ theme: "slop", enabledModels: ["xai/grok-4.6", "anthropic/*"] }));
    expect(r).toEqual({ ok: true, value: { json: { theme: "slop", enabledModels: ["xai/grok-4.6", "anthropic/*"] }, enabled: ["xai/grok-4.6", "anthropic/*"] } });
  });
  it("treats a missing key and an empty file as no entries", () => {
    expect(parseSettings(text({ theme: "x" }))).toMatchObject({ ok: true, value: { enabled: [] } });
    expect(parseSettings("")).toEqual({ ok: true, value: { json: {}, enabled: [] } });
  });
  it("rejects broken JSON and non-objects", () => {
    expect(parseSettings("{ nope")).toEqual({ ok: false, error: "settings.json is not valid JSON" });
    expect(parseSettings("[1]")).toEqual({ ok: false, error: "settings.json is not valid JSON" });
  });
  it("rejects a non-array enabledModels", () => {
    expect(parseSettings(text({ enabledModels: "xai/*" }))).toEqual({ ok: false, error: "enabledModels in settings.json is not a list" });
    expect(parseSettings(text({ enabledModels: ["a", 1] }))).toEqual({ ok: false, error: "enabledModels in settings.json is not a list" });
  });
});

describe("withEnabled", () => {
  const json = { theme: "slop", enabledModels: ["a/b"], packages: ["npm:x"] };
  it("replaces the list in place, keeping other keys and their order", () => {
    const out = withEnabled(json, ["c/d", "a/b"]);
    expect(out).toBe(text({ theme: "slop", enabledModels: ["c/d", "a/b"], packages: ["npm:x"] }));
    expect(Object.keys(JSON.parse(out))).toEqual(["theme", "enabledModels", "packages"]);
  });
  it("appends the key when absent", () => {
    expect(Object.keys(JSON.parse(withEnabled({ theme: "x" }, ["a/b"])))).toEqual(["theme", "enabledModels"]);
  });
  it("deletes the key for an empty list", () => {
    expect(withEnabled(json, [])).toBe(text({ theme: "slop", packages: ["npm:x"] }));
  });
  it("does not change its input", () => {
    withEnabled(json, []);
    expect(json.enabledModels).toEqual(["a/b"]);
  });
});

describe("enabledConflict", () => {
  it("is order-sensitive and exact", () => {
    expect(enabledConflict(["a", "b"], ["a", "b"])).toBe(false);
    expect(enabledConflict(["a", "b"], ["b", "a"])).toBe(true);
    expect(enabledConflict(["a"], [])).toBe(true);
  });
});

describe("hasAliasPackage", () => {
  it("finds npm, git and path sources, and object entries", () => {
    expect(hasAliasPackage({ packages: ["npm:pi-model-fallback-alias"] })).toBe(true);
    expect(hasAliasPackage({ packages: ["git:github.com/cuongnbms/pi-model-fallback-alias"] })).toBe(true);
    expect(hasAliasPackage({ packages: ["../src/pi-model-fallback-alias"] })).toBe(true);
    expect(hasAliasPackage({ packages: [{ source: "npm:pi-model-fallback-alias@1.2.0" }] })).toBe(true);
  });
  it("is false without it", () => {
    expect(hasAliasPackage({ packages: ["npm:pi-web-access"] })).toBe(false);
    expect(hasAliasPackage({})).toBe(false);
    expect(hasAliasPackage({ packages: "npm:pi-model-fallback-alias" })).toBe(false);
  });
});

describe("isCatalogEntry", () => {
  const models = [{ provider: "xai", id: "grok-4.6" }];
  it("matches provider/id case-insensitively and nothing else", () => {
    expect(isCatalogEntry("XAI/Grok-4.6", models)).toBe(true);
    expect(isCatalogEntry("xai/*", models)).toBe(false);
    expect(isCatalogEntry("grok", models)).toBe(false);
  });
});

const ALIASES = {
  $settings: { statusRefreshMs: 2000 },
  mid: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"],
  $defaults: { cooldown: { baseMs: 1 } },
  high: { targets: ["openai-codex/gpt-5.6-sol"], timeouts: { stallMs: 5 } },
  top: "alias/mid",
};
const parsed = () => {
  const r = parseAliases(text(ALIASES));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("parseAliases", () => {
  it("lists aliases in file order with their form, skipping $ keys", () => {
    expect(parsed().aliases).toEqual([
      { name: "mid", orig: "mid", form: "array", targets: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"] },
      { name: "high", orig: "high", form: "object", targets: ["openai-codex/gpt-5.6-sol"] },
      { name: "top", orig: "top", form: "string", targets: ["alias/mid"] },
    ]);
  });
  it("reads an empty file as no aliases and rejects bad shapes", () => {
    expect(parseAliases("")).toEqual({ ok: true, value: { raw: {}, aliases: [] } });
    expect(parseAliases("{")).toEqual({ ok: false, error: "model-alias.json is not valid JSON" });
    expect(parseAliases("[]")).toEqual({ ok: false, error: "model-alias.json must be an object" });
    expect(parseAliases(text({ a: 3 }))).toEqual({ ok: false, error: "model-alias.json must be an object" });
  });
});

describe("withAliases", () => {
  it("writes an unchanged file back identically", () => {
    const { raw, aliases } = parsed();
    expect(withAliases(raw, aliases)).toBe(text(ALIASES));
  });
  it("keeps object fields, $ keys and positions; renamed keys stay in place", () => {
    const { raw, aliases } = parsed();
    const next: Alias[] = [
      { ...aliases[0], name: "middle" },
      { ...aliases[1], targets: ["a/b", "alias/middle"] },
      aliases[2],
    ];
    expect(JSON.parse(withAliases(raw, next))).toEqual({
      $settings: { statusRefreshMs: 2000 },
      middle: ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"],
      $defaults: { cooldown: { baseMs: 1 } },
      high: { targets: ["a/b", "alias/middle"], timeouts: { stallMs: 5 } },
      top: "alias/mid",
    });
    expect(Object.keys(JSON.parse(withAliases(raw, next)))).toEqual(["$settings", "middle", "$defaults", "high", "top"]);
  });
  it("turns a changed string form into an array, drops deleted aliases, appends new ones", () => {
    const { raw, aliases } = parsed();
    const next: Alias[] = [
      aliases[1],
      { ...aliases[2], targets: ["alias/high"] },
      { name: "fast", orig: null, form: "array", targets: ["x/y"] },
    ];
    expect(JSON.parse(withAliases(raw, next))).toEqual({
      $settings: { statusRefreshMs: 2000 },
      $defaults: { cooldown: { baseMs: 1 } },
      high: { targets: ["openai-codex/gpt-5.6-sol"], timeouts: { stallMs: 5 } },
      top: ["alias/high"],
      fast: ["x/y"],
    });
  });
});

describe("renameAlias", () => {
  it("renames and rewrites references in every alias", () => {
    const next = renameAlias(parsed().aliases, 0, "middle");
    expect(next[0]).toMatchObject({ name: "middle", orig: "mid" });
    expect(next[2].targets).toEqual(["alias/middle"]);
  });
  it("leaves aliases with similar names alone", () => {
    const list: Alias[] = [
      { name: "a", orig: "a", form: "array", targets: ["x/y"] },
      { name: "b", orig: "b", form: "array", targets: ["alias/a", "alias/ab"] },
    ];
    expect(renameAlias(list, 0, "z")[1].targets).toEqual(["alias/z", "alias/ab"]);
  });
});

describe("aliasNameError", () => {
  const list = parsed().aliases;
  it("checks emptiness, slash, $ prefix and duplicates (not itself)", () => {
    expect(aliasNameError("", list, 0)).toBe("Name is required");
    expect(aliasNameError("a/b", list, 0)).toBe("Name cannot contain /");
    expect(aliasNameError("$x", list, 0)).toBe("Name cannot start with $");
    expect(aliasNameError("high", list, 0)).toBe("Name already used");
    expect(aliasNameError("mid", list, 0)).toBeNull();
  });
});

describe("missingTargets", () => {
  it("names alias targets that point nowhere", () => {
    const list = parsed().aliases.filter((a) => a.name !== "mid");
    expect(missingTargets(list[1], list)).toEqual(["alias/mid"]);
    expect(missingTargets(list[0], list)).toEqual([]);
  });
});
