import { beforeEach, describe, expect, it, vi } from "vitest";

const setTheme = vi.fn(async (_theme: unknown) => {});
vi.mock("../lib/ipc", () => ({ setWindowTheme: (t: unknown) => setTheme(t) }));

import { TERM_THEME, TERM_THEME_LIGHT } from "../terminal/theme";
import { DEFAULT_THEME, applyTheme, loadThemePref, resolveTheme, useTheme, watchTermTheme } from "./theme";

const KEY = "herdly:settings";

beforeEach(() => {
  localStorage.clear();
  setTheme.mockClear();
  useTheme.setState({ pref: DEFAULT_THEME, theme: "dark" });
});

describe("loadThemePref", () => {
  it("defaults to dark when nothing or garbage is stored", () => {
    expect(loadThemePref()).toBe("dark");
    localStorage.setItem(KEY, JSON.stringify({ theme: "sepia" }));
    expect(loadThemePref()).toBe("dark");
    localStorage.setItem(KEY, "{nope");
    expect(loadThemePref()).toBe("dark");
  });

  it("reads a stored preference", () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "light" }));
    expect(loadThemePref()).toBe("light");
  });
});

describe("resolveTheme", () => {
  it("passes explicit themes through and resolves system from the OS", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("useTheme.setPref", () => {
  it("persists alongside other settings and updates the resolved theme", () => {
    localStorage.setItem(KEY, JSON.stringify({ notifications: false, terminalFontSize: 15 }));
    useTheme.getState().setPref("light");
    expect(useTheme.getState()).toMatchObject({ pref: "light", theme: "light" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ notifications: false, terminalFontSize: 15, theme: "light" });
  });
});

describe("applyTheme", () => {
  it("sets data-theme and forces the window theme unless following the system", () => {
    applyTheme("light", "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(setTheme).toHaveBeenLastCalledWith("light");
    applyTheme("dark", "system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(setTheme).toHaveBeenLastCalledWith(null);
  });
});

describe("watchTermTheme", () => {
  it("applies the current palette, follows changes, stops after unsubscribe", () => {
    const term = { options: {} as Record<string, unknown> };
    const stop = watchTermTheme(term as never);
    expect(term.options.theme).toBe(TERM_THEME);
    useTheme.getState().setPref("light");
    expect(term.options.theme).toBe(TERM_THEME_LIGHT);
    stop();
    useTheme.getState().setPref("dark");
    expect(term.options.theme).toBe(TERM_THEME_LIGHT);
  });
});
