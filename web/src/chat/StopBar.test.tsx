import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { StopBar } from "./StopBar";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), paneKeys: vi.fn().mockResolvedValue(undefined) }));

describe("StopBar", () => {
  it("sends esc and ctrl+c", async () => {
    render(<StopBar pane={{ session: "s", pane_id: "p1" }} />);
    fireEvent.click(screen.getByText("Esc"));
    fireEvent.click(screen.getByText("Ctrl+C"));
    await waitFor(() => expect(api.paneKeys).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.paneKeys).mock.calls.map((c) => c[1])).toEqual([["esc"], ["ctrl+c"]]);
  });

  it("shows why a key failed", async () => {
    vi.mocked(api.paneKeys).mockRejectedValueOnce(new Error("pane gone"));
    render(<StopBar pane={{ session: "s", pane_id: "p1" }} />);
    fireEvent.click(screen.getByText("Esc"));
    await waitFor(() => expect(screen.getByText("pane gone")).toBeInTheDocument());
  });
});
