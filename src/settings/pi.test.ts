import { describe, expect, it } from "vitest";
import { enabledConflict, hasAliasPackage, isCatalogEntry, parseSettings, withEnabled } from "./pi";

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
