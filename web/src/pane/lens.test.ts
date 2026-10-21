import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chooseLens, loadLens, saveLens } from "./lens";

beforeEach(() => localStorage.clear());

afterEach(() => vi.restoreAllMocks());

it.each([
  ["claude", null, "chat"],
  ["pi", null, "chat"],
  [null, null, "terminal"],
  ["codex", "chat", "terminal"],
  ["pi", "terminal", "terminal"],
  [null, "chat", "terminal"],
  ["claude", "garbage", "chat"],
])("selects %s with preference %s", (agent, saved, expected) => {
  expect(chooseLens(agent, saved)).toBe(expected);
});

it("keeps preferences separate by Session and Pane", () => {
  const a = { session: "one", pane_id: "p1" }, b = { session: "two", pane_id: "p1" };
  expect(loadLens(a)).toBeNull();
  saveLens(a, "terminal");
  saveLens(b, "chat");
  expect(loadLens(a)).toBe("terminal");
  expect(loadLens(b)).toBe("chat");
  localStorage.setItem('herdly-web:lens:v1:["one","p1"]', "bad");
  expect(loadLens(a)).toBeNull();
});

it("treats blocked storage as no preference", () => {
  const a = { session: "one", pane_id: "p1" };
  const denied = () => {
    throw new DOMException("denied", "SecurityError");
  };
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(denied);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(denied);
  expect(loadLens(a)).toBeNull();
  expect(() => saveLens(a, "terminal")).not.toThrow();
});
