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
});
