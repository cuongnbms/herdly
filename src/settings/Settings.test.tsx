import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  systemFonts: vi.fn(async () => ["CaskaydiaCove Nerd Font Mono", "Lilex", "Menlo"]),
}));
import { loadLensSettings, useLensSettings } from "./lens";
import { DEFAULT_HIDDEN_FOLDERS, loadHiddenFolders, useHiddenFolders } from "./hiddenFolders";
import { DEFAULT_QUICK_REPLIES, loadQuickReplies, QUICK_REPLIES_MAX, useQuickReplies } from "./quickReplies";
import { DEFAULT_IDLE_MINUTES, loadIdleMinutes, useRecentAgents } from "./recentAgents";
import { Settings } from "./Settings";
import { DEFAULTS, loadFonts, useSettings } from "./store";
import { useTheme } from "./theme";
import { loadTabLayout, useTabLayout } from "./tabLayout";

beforeEach(() => {
  localStorage.clear();
  useSettings.setState({ ...DEFAULTS });
});

function openSettings() {
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("tab", { name: "Fonts" }));
}

describe("Settings dialog", () => {
  it("switches the theme from the Appearance section", () => {
    useTheme.setState({ pref: "dark", theme: "dark" });
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(useTheme.getState()).toMatchObject({ pref: "light", theme: "light" });
    expect(screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem("herdly:settings")!).theme).toBe("light");
  });

  it("switches the tab layout from the Appearance section and keeps it", () => {
    useTabLayout.setState({ layout: "one-line" });
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    expect(screen.getByRole("button", { name: "One line" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Two lines" }));
    expect(useTabLayout.getState().layout).toBe("two-lines");
    expect(screen.getByRole("button", { name: "Two lines" }).getAttribute("aria-pressed")).toBe("true");
    expect(loadTabLayout()).toBe("two-lines");
  });

  it("reads one line when no tab layout or an unknown one is saved", () => {
    expect(loadTabLayout()).toBe("one-line");
    localStorage.setItem("herdly:settings", JSON.stringify({ tabLayout: "three-lines" }));
    expect(loadTabLayout()).toBe("one-line");
  });

  it("opens as a dialog on the General section and switches sections", () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Notifications" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Fonts" }));
    expect(screen.getByRole("combobox", { name: "Terminal font" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Notifications" })).toBeNull();
  });

  it("closes on Escape and on the close button", () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Settings recent agents", () => {
  beforeEach(() => useRecentAgents.setState({ idleMinutes: DEFAULT_IDLE_MINUTES }));

  it("sets how long idle agents stay in Recent agents, down to Off, and remembers it", () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("3 min")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Increase keep idle agents" }));
    expect(loadIdleMinutes()).toBe(4);
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "Decrease keep idle agents" }));
    expect(useRecentAgents.getState().idleMinutes).toBe(0);
    expect(screen.getByText("Off")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Decrease keep idle agents" }) as HTMLButtonElement).disabled).toBe(true);
    expect(loadIdleMinutes()).toBe(0);
  });
});

describe("Settings quick replies", () => {
  beforeEach(() => useQuickReplies.setState({ show: true, replies: [...DEFAULT_QUICK_REPLIES] }));

  function openChat() {
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
  }

  it("switches the quick replies off", () => {
    openChat();
    const sw = screen.getByRole<HTMLInputElement>("switch", { name: "Quick replies" });
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    expect(useQuickReplies.getState().show).toBe(false);
  });

  it("chooses the lens a new agent opens on, and remembers it", () => {
    useLensSettings.setState({ newAgentLens: "terminal" });
    openChat();
    const group = screen.getByRole("group", { name: "New agent opens in" });
    expect(within(group).getByRole("button", { name: "terminal" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "chat" }));
    expect(useLensSettings.getState().newAgentLens).toBe("chat");
    expect(loadLensSettings().newAgentLens).toBe("chat");
  });

  it("edits, removes, adds and resets replies", () => {
    openChat();
    fireEvent.change(screen.getByRole("textbox", { name: "Quick reply 1" }), { target: { value: "go on" } });
    expect(useQuickReplies.getState().replies[0]).toBe("go on");
    fireEvent.click(screen.getByRole("button", { name: "Remove quick reply 2" }));
    expect(useQuickReplies.getState().replies).toEqual(["go on", "no", "commit and push", "retry"]);
    fireEvent.click(screen.getByRole("button", { name: "Add quick reply" }));
    expect(useQuickReplies.getState().replies).toHaveLength(5);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Quick reply 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset quick replies" }));
    expect(useQuickReplies.getState().replies).toEqual(DEFAULT_QUICK_REPLIES);
  });

  it("stops adding at the limit", () => {
    useQuickReplies.setState({ replies: Array.from({ length: QUICK_REPLIES_MAX }, (_, i) => `r${i}`) });
    openChat();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add quick reply" }).disabled).toBe(true);
  });

  const dt = () => {
    const data: Record<string, string> = {};
    return { data, types: [] as string[], effectAllowed: "", dropEffect: "",
      setData(t: string, v: string) { data[t] = v; this.types.push(t); }, getData: (t: string) => data[t] ?? "", setDragImage() {} };
  };
  const grip = (n: number) => screen.getAllByTitle("Drag to reorder")[n - 1];
  const row = (n: number) => screen.getByRole("textbox", { name: `Quick reply ${n}` }).closest<HTMLElement>(".quick-reply-row")!;
  const values = () => screen.getAllByRole<HTMLInputElement>("textbox", { name: /^Quick reply \d+$/ }).map((i) => i.value);
  const drag = (from: number, to: number) => {
    const dataTransfer = dt();
    fireEvent.dragStart(grip(from), { dataTransfer });
    fireEvent.dragEnter(row(to), { dataTransfer });
    fireEvent.dragOver(row(to), { dataTransfer });
    fireEvent.drop(row(to), { dataTransfer });
    fireEvent.dragEnd(grip(from), { dataTransfer });
  };

  it("moves a reply by dragging its handle onto another row", () => {
    openChat();
    // jsdom rects are empty, so every drop lands after the target.
    drag(1, 3);
    expect(values()).toEqual(["yes", "no", "continue", "commit and push", "retry"]);
    expect(loadQuickReplies().replies).toEqual(["yes", "no", "continue", "commit and push", "retry"]);
    expect(document.querySelector(".dragging, .drop-before, .drop-after")).toBeNull();
  });

  it("marks the dragged row and where it would land", () => {
    openChat();
    const dataTransfer = dt();
    fireEvent.dragStart(grip(1), { dataTransfer });
    fireEvent.dragOver(row(3), { dataTransfer });
    expect(row(1).className).toContain("dragging");
    expect(row(3).className).toContain("drop-after");
  });

  it("leaves the list alone when the drop would not move the reply", () => {
    openChat();
    drag(2, 1);
    drag(2, 2);
    expect(useQuickReplies.getState().replies).toEqual(DEFAULT_QUICK_REPLIES);
  });

  it("ignores a drag that did not start on a handle", () => {
    openChat();
    const dataTransfer = dt();
    fireEvent.dragOver(row(3), { dataTransfer });
    fireEvent.drop(row(3), { dataTransfer });
    expect(document.querySelector(".drop-before, .drop-after")).toBeNull();
    expect(useQuickReplies.getState().replies).toEqual(DEFAULT_QUICK_REPLIES);
  });

  it("moves the focused reply with Option-Up and Option-Down, keeping it focused", () => {
    openChat();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Quick reply 1" }), { key: "ArrowDown", altKey: true });
    expect(values()).toEqual(["yes", "continue", "no", "commit and push", "retry"]);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Quick reply 2" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Quick reply 2" }), { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Quick reply 1" }), { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Quick reply 5" }), { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Quick reply 3" }), { key: "ArrowDown" });
    expect(values()).toEqual(DEFAULT_QUICK_REPLIES);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Quick reply 1" }));
  });
});

describe("Settings fonts", () => {
  it("searches installed fonts and picks one with a click", async () => {
    openSettings();
    const box = screen.getByRole("combobox", { name: "Terminal font" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "lil" } });
    const option = await screen.findByRole("option", { name: "Lilex" });
    expect(screen.queryByRole("option", { name: "Menlo" })).toBeNull();
    fireEvent.mouseDown(option);
    expect(useSettings.getState().terminalFontFamily).toBe("Lilex");
    expect(loadFonts().terminalFontFamily).toBe("Lilex");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("picks the highlighted font with arrows and Enter", async () => {
    openSettings();
    const box = screen.getByRole("combobox", { name: "Terminal font" });
    fireEvent.focus(box);
    await screen.findByRole("option", { name: "Menlo" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useSettings.getState().terminalFontFamily).toBe("CaskaydiaCove Nerd Font Mono");
  });

  it("says when nothing matches, and Escape closes only the list", async () => {
    openSettings();
    const box = screen.getByRole("combobox", { name: "Terminal font" });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(await screen.findByText("No matching fonts")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(useSettings.getState().terminalFontFamily).toBe("JetBrains Mono");
  });

  it("steps the terminal and chat sizes", () => {
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Increase terminal size" }));
    fireEvent.click(screen.getByRole("button", { name: "Decrease chat size" }));
    expect(useSettings.getState().terminalFontSize).toBe(13.5);
    expect(useSettings.getState().chatFontSize).toBe(13);
    expect(screen.getByText("13.5px")).toBeTruthy();
  });

  it("disables a stepper at its limit", () => {
    useSettings.setState({ terminalFontSize: 20 });
    openSettings();
    expect((screen.getByRole("button", { name: "Increase terminal size" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("resets fonts to defaults", () => {
    useSettings.getState().set({ terminalFontSize: 18, terminalFontFamily: "Menlo" });
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Reset fonts" }));
    expect(useSettings.getState()).toMatchObject(DEFAULTS);
  });
});

describe("Settings files", () => {
  beforeEach(() => useHiddenFolders.setState({ folders: loadHiddenFolders() }));

  function openFiles() {
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    return screen.getByRole("textbox", { name: "Hidden folders" }) as HTMLTextAreaElement;
  }

  it("lists the hidden folders one per line and saves the edit on blur", () => {
    const box = openFiles();
    expect(box.value).toBe(DEFAULT_HIDDEN_FOLDERS.join("\n"));
    fireEvent.change(box, { target: { value: "logs\n\n tmp \n" } });
    expect(useHiddenFolders.getState().folders).toEqual(DEFAULT_HIDDEN_FOLDERS);
    fireEvent.blur(box);
    expect(useHiddenFolders.getState().folders).toEqual(["logs", "tmp"]);
    expect(loadHiddenFolders()).toEqual(["logs", "tmp"]);
    expect(box.value).toBe("logs\ntmp");
  });

  it("resets the hidden folders to the defaults", () => {
    useHiddenFolders.getState().setFolders(["logs"]);
    const box = openFiles();
    const reset = screen.getByRole("button", { name: "Reset hidden folders" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(useHiddenFolders.getState().folders).toEqual(DEFAULT_HIDDEN_FOLDERS);
    expect(box.value).toBe(DEFAULT_HIDDEN_FOLDERS.join("\n"));
    expect(reset.disabled).toBe(true);
  });
});
