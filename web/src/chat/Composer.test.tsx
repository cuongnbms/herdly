import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { Composer, type Draft } from "./Composer";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), paneKeys: vi.fn() }));

const pane = { session: "s", pane_id: "p1" };
const onSend = vi.fn();
function Harness({ working, text = "", error = null }: { working: boolean; text?: string; error?: string | null }) {
  const [draft, setDraft] = useState<Draft>({ text, error });
  return <Composer pane={pane} working={working} draft={draft} setDraft={setDraft} onSend={onSend} />;
}

beforeEach(() => {
  onSend.mockReset();
  vi.mocked(api.paneKeys).mockReset().mockResolvedValue(undefined as never);
});

describe("Composer", () => {
  it("is Stop while working with a blank field, and Stop sends Esc", async () => {
    render(<Harness working />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.paneKeys).toHaveBeenCalledWith(pane, ["esc"]));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("turns into Send once something is typed, even while working", () => {
    render(<Harness working />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "also check lint" } });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("is a disabled Send when not working and the field is blank", () => {
    render(<Harness working={false} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows why Stop failed", async () => {
    vi.mocked(api.paneKeys).mockRejectedValueOnce(new Error("pane gone"));
    render(<Harness working />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("pane gone"));
  });

  it("shows the draft's send error", () => {
    render(<Harness working={false} text="hello" error="pane gone" />);
    expect(screen.getByRole("alert")).toHaveTextContent("pane gone");
  });

  it("sizes the field to its content plus the border, capped at six rows plus padding and border", () => {
    const proto = HTMLTextAreaElement.prototype;
    const stub = (name: string, value: number) => vi.spyOn(proto, name as "scrollHeight", "get").mockReturnValue(value);
    stub("offsetHeight", 44);
    stub("clientHeight", 42); // a 2px border
    const scroll = stub("scrollHeight", 42);
    render(<Harness working={false} />);
    const field = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(field.style.height).toBe("44px");
    scroll.mockReturnValue(500);
    fireEvent.change(field, { target: { value: "a\nb\nc\nd\ne\nf\ng\nh" } });
    // jsdom has no line-height, so the row falls back to 22px: 22 * 6 + 20 + 2
    expect(field.style.height).toBe("154px");
    vi.restoreAllMocks();
  });
});
