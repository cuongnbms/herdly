import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

describe("Sheet", () => {
  it("is a labelled modal dialog that closes on the scrim and on Escape, not on its content", () => {
    const onClose = vi.fn();
    render(<Sheet title="Panes" onClose={onClose}><p>inside</p></Sheet>);
    const dialog = screen.getByRole("dialog", { name: "Panes" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Panes")).toBeInTheDocument();
    fireEvent.click(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector("[data-scrim]")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
