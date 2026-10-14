import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { invoke } from "@tauri-apps/api/core";
import { HtmlView } from "./HtmlView";

let n = 0;
const args = (cmd: string) => vi.mocked(invoke).mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
const frame = () => document.querySelector("iframe.files-html") as HTMLIFrameElement | null;
const shows = (token: string) => waitFor(() => expect(frame()?.getAttribute("src")).toBe(`herdly-html://localhost/${token}`));

describe("HtmlView", () => {
  beforeEach(() => {
    n = 0;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "files_html_put" ? `t${++n}` : undefined));
  });

  it("shows the stored page in a frame that may run nothing", async () => {
    render(<HtmlView text="<p>a</p>" scripts={false} />);
    await shows("t1");
    expect(frame()!.getAttribute("sandbox")).toBe("");
    expect(frame()!.getAttribute("title")).toBe("HTML preview");
    expect(args("files_html_put")).toEqual([{ html: "<p>a</p>", scripts: false }]);
  });

  it("with Scripts on the frame may run scripts and nothing more", async () => {
    render(<HtmlView text="<p>a</p>" scripts />);
    await shows("t1");
    expect(frame()!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(args("files_html_put")).toEqual([{ html: "<p>a</p>", scripts: true }]);
  });

  it("stores the page again and drops the old one when the text or Scripts changes", async () => {
    const { rerender } = render(<HtmlView text="a" scripts={false} />);
    await shows("t1");
    rerender(<HtmlView text="b" scripts={false} />);
    await shows("t2");
    rerender(<HtmlView text="b" scripts />);
    await shows("t3");
    expect(args("files_html_drop")).toEqual([{ token: "t1" }, { token: "t2" }]);
  });

  it("drops its page when it goes away", async () => {
    const { unmount } = render(<HtmlView text="a" scripts={false} />);
    await shows("t1");
    unmount();
    expect(args("files_html_drop")).toEqual([{ token: "t1" }]);
  });

  it("drops a page that arrives after a newer one was asked for", async () => {
    let release!: (token: string) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => (release = r as (token: string) => void)));
    const { rerender } = render(<HtmlView text="a" scripts={false} />);
    rerender(<HtmlView text="b" scripts={false} />);
    await shows("t1");
    await act(async () => release("late"));
    expect(args("files_html_drop")).toContainEqual({ token: "late" });
    expect(frame()!.getAttribute("src")).toBe("herdly-html://localhost/t1");
  });

  it("says why when the page cannot be stored", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("boom"));
    render(<HtmlView text="a" scripts={false} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Cannot show this page: boom");
    expect(frame()).toBeNull();
  });

  it("keeps the sandbox of the page on show until the new page is stored", async () => {
    const { rerender } = render(<HtmlView text="a" scripts={false} />);
    await shows("t1");
    let release!: (token: string) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => (release = r as (token: string) => void)));
    rerender(<HtmlView text="a" scripts />);
    expect(frame()!.getAttribute("sandbox")).toBe("");
    await act(async () => release("t2"));
    await shows("t2");
    expect(frame()!.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("stores the page again on a reload even when the text is the same", async () => {
    const { rerender } = render(<HtmlView text="a" scripts={false} reloads={0} />);
    await shows("t1");
    rerender(<HtmlView text="a" scripts={false} reloads={1} />);
    await shows("t2");
    expect(args("files_html_put")).toEqual([
      { html: "a", scripts: false },
      { html: "a", scripts: false },
    ]);
    expect(args("files_html_drop")).toEqual([{ token: "t1" }]);
  });

  it("gives the keys back to the app when the pointer leaves a focused frame", async () => {
    render(<HtmlView text="a" scripts={false} />);
    await shows("t1");
    const wrap = document.querySelector(".files-html-wrap")!;
    // jsdom does not move focus on an iframe's blur(), so the call is what is checked.
    const blur = vi.spyOn(frame()!, "blur");
    const other = document.body.appendChild(document.createElement("button"));
    other.focus();
    fireEvent.pointerLeave(wrap);
    expect(document.activeElement).toBe(other);
    expect(blur).not.toHaveBeenCalled();
    frame()!.focus();
    fireEvent.pointerLeave(wrap);
    expect(blur).toHaveBeenCalledTimes(1);
    other.remove();
  });
});
