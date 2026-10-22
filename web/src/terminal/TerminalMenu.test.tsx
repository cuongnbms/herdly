import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { TerminalMenu } from "./TerminalMenu";

vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), paneKeys: vi.fn() }));
const pane = { session: "s", pane_id: "p1" };
afterEach(cleanup);
beforeEach(() => vi.mocked(api.paneKeys).mockReset().mockResolvedValue(undefined as never));
describe("TerminalMenu", () => {
  it("asks twice before Ctrl+C, and forgets the first tap after 3 s", async () => {
    vi.useFakeTimers();
    try {
      render(<TerminalMenu pane={pane} />);
      fireEvent.click(screen.getByLabelText("More"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Send Ctrl+C" }));
      expect(api.paneKeys).not.toHaveBeenCalled();
      expect(screen.getByRole("menuitem", { name: "Tap again to send Ctrl+C" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(3000));
      fireEvent.click(screen.getByRole("menuitem", { name: "Send Ctrl+C" }));
      expect(api.paneKeys).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Tap again to send Ctrl+C" })));
      expect(api.paneKeys).toHaveBeenCalledWith(pane, ["ctrl+c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows why a key failed, in the menu", async () => {
    vi.mocked(api.paneKeys).mockRejectedValueOnce(new Error("pane gone"));
    render(<TerminalMenu pane={pane} />);
    fireEvent.click(screen.getByLabelText("More"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send Ctrl+C" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Tap again to send Ctrl+C" }));
    await waitFor(() => expect(within(screen.getByRole("menu")).getByRole("alert")).toHaveTextContent("pane gone"));
  });

  it("closes the menu on a tap outside it", () => {
    render(<TerminalMenu pane={pane} />);
    fireEvent.click(screen.getByLabelText("More"));
    fireEvent.click(document.querySelector("[data-backdrop]")!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

});
