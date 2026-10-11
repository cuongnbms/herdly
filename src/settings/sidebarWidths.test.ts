import { beforeEach, describe, expect, it } from "vitest";
import { COLUMNS, loadWidths, useSidebarWidths } from "./sidebarWidths";

const KEY = "herdr-app:settings";

beforeEach(() => {
  localStorage.clear();
  useSidebarWidths.setState({ sidebar: COLUMNS.sidebar.def, agents: COLUMNS.agents.def });
});

describe("loadWidths", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadWidths()).toEqual({ sidebar: 248, agents: 288 });
  });

  it("returns defaults when storage is corrupt", () => {
    localStorage.setItem(KEY, "{nope");
    expect(loadWidths()).toEqual({ sidebar: 248, agents: 288 });
  });

  it("reads stored widths and clamps them", () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 10, agentsWidth: 9999 }));
    expect(loadWidths()).toEqual({ sidebar: COLUMNS.sidebar.min, agents: COLUMNS.agents.max });
  });

  it("ignores values of the wrong type", () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: "wide", agentsWidth: null }));
    expect(loadWidths()).toEqual({ sidebar: 248, agents: 288 });
  });
});

describe("setWidth", () => {
  it("clamps, rounds and saves next to the other settings", () => {
    localStorage.setItem(KEY, JSON.stringify({ tabLayout: "two-lines" }));
    useSidebarWidths.getState().setWidth("agents", 300.6);
    useSidebarWidths.getState().setWidth("sidebar", 5);
    expect(useSidebarWidths.getState()).toMatchObject({ agents: 301, sidebar: COLUMNS.sidebar.min });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      tabLayout: "two-lines",
      agentsWidth: 301,
      sidebarWidth: COLUMNS.sidebar.min,
    });
  });
});
