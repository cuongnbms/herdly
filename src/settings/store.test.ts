import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULTS,
  applyChatFont,
  ensureTermFont,
  filterFonts,
  fontFamilies,
  loadFonts,
  termFontFamily,
  useSettings,
  watchTermFont,
} from "./store";

const { fontFace } = vi.hoisted(() => ({ fontFace: vi.fn() }));
vi.mock("../lib/ipc", () => ({ systemFonts: vi.fn(async () => []), fontFace }));

const KEY = "herdly:settings";

beforeEach(() => {
  localStorage.clear();
  useSettings.setState({ ...DEFAULTS });
});

describe("loadFonts", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadFonts()).toEqual(DEFAULTS);
  });

  it("returns defaults when storage is corrupt", () => {
    localStorage.setItem(KEY, "{nope");
    expect(loadFonts()).toEqual(DEFAULTS);
  });

  it("reads stored values and clamps sizes", () => {
    localStorage.setItem(KEY, JSON.stringify({ terminalFontSize: 99, chatFontSize: 2, terminalFontFamily: "Menlo" }));
    expect(loadFonts()).toEqual({ terminalFontSize: 20, chatFontSize: 11, terminalFontFamily: "Menlo" });
  });

  it("ignores values of the wrong type", () => {
    localStorage.setItem(KEY, JSON.stringify({ terminalFontSize: "big", terminalFontFamily: 3 }));
    expect(loadFonts()).toEqual(DEFAULTS);
  });
});

describe("useSettings.set", () => {
  it("persists and keeps other settings such as notifications", () => {
    localStorage.setItem(KEY, JSON.stringify({ notifications: false }));
    useSettings.getState().set({ terminalFontSize: 15 });
    expect(useSettings.getState().terminalFontSize).toBe(15);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ notifications: false, terminalFontSize: 15 });
  });

  it("clamps sizes", () => {
    useSettings.getState().set({ chatFontSize: 40 });
    expect(useSettings.getState().chatFontSize).toBe(18);
  });

  it("reset restores defaults", () => {
    useSettings.getState().set({ terminalFontSize: 18, terminalFontFamily: "Menlo" });
    useSettings.getState().reset();
    expect(useSettings.getState()).toMatchObject(DEFAULTS);
    expect(loadFonts()).toEqual(DEFAULTS);
  });
});

describe("termFontFamily", () => {
  it("quotes the family and adds a fallback", () => {
    expect(termFontFamily("SF Mono")).toBe('"SF Mono", Menlo, monospace');
  });
});

describe("applyChatFont", () => {
  it("sets the --chat-font variable", () => {
    applyChatFont(15);
    expect(document.documentElement.style.getPropertyValue("--chat-font")).toBe("15px");
  });
});

describe("watchTermFont", () => {
  it("applies current fonts, follows changes and refits; stops after unsubscribe", () => {
    const term = { options: {} as Record<string, unknown> };
    const fit = { fit: vi.fn() };
    const stop = watchTermFont(term as never, fit as never, -1);
    expect(term.options.fontSize).toBe(12);
    expect(term.options.fontFamily).toBe(termFontFamily("JetBrains Mono"));

    useSettings.getState().set({ terminalFontSize: 16 });
    expect(term.options.fontSize).toBe(15);
    expect(fit.fit).toHaveBeenCalled();

    stop();
    useSettings.getState().set({ terminalFontSize: 18 });
    expect(term.options.fontSize).toBe(15);
  });
});

describe("ensureTermFont", () => {
  it("registers each face the backend returns as a web font, once per family", async () => {
    const added: { family: string; descriptors: FontFaceDescriptors; loaded: boolean }[] = [];
    vi.stubGlobal(
      "FontFace",
      class {
        loaded = false;
        constructor(
          public family: string,
          _src: ArrayBuffer,
          public descriptors: FontFaceDescriptors = {},
        ) {}
        async load() {
          this.loaded = true;
          return this;
        }
      },
    );
    const add = vi.fn((f: (typeof added)[number]) => added.push(f));
    Object.defineProperty(document, "fonts", { configurable: true, value: { add } });
    fontFace.mockImplementation(async (_family: string, style: string) => {
      if (style === "Italic") throw { code: "not_found" };
      return new ArrayBuffer(8);
    });

    await ensureTermFont("Lilex");
    await ensureTermFont("Lilex");

    expect(fontFace).toHaveBeenCalledTimes(4);
    expect(added.map((f) => [f.family, f.descriptors, f.loaded])).toEqual([
      ["Lilex", {}, true],
      ["Lilex", { weight: "700" }, true],
      ["Lilex", { weight: "700", style: "italic" }, true],
    ]);
    vi.unstubAllGlobals();
  });

  it("leaves the bundled font alone", async () => {
    fontFace.mockClear();
    await ensureTermFont("JetBrains Mono");
    expect(fontFace).not.toHaveBeenCalled();
  });
});

describe("fontFamilies", () => {
  it("puts the bundled font first and drops duplicates", () => {
    expect(fontFamilies(["Lilex", "JetBrains Mono", "Menlo"])).toEqual(["JetBrains Mono", "Lilex", "Menlo"]);
  });
});

describe("filterFonts", () => {
  it("matches case-insensitively anywhere in the name, prefix matches first", () => {
    const all = ["CaskaydiaCove Nerd Font Mono", "FiraCode Nerd Font Mono", "Lilex", "Menlo", "Monaco"];
    expect(filterFonts(all, "mo")).toEqual(["Monaco", "CaskaydiaCove Nerd Font Mono", "FiraCode Nerd Font Mono"]);
    expect(filterFonts(all, "  LIL ")).toEqual(["Lilex"]);
    expect(filterFonts(all, "")).toEqual(all);
  });
});
