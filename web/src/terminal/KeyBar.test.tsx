import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyBar } from "./KeyBar";

afterEach(() => cleanup());

describe("KeyBar", () => {
  it("sends logical keys with accessible labels", () => {
    const onKey = vi.fn();
    render(<KeyBar disabled={false} ctrl={false} onCtrl={() => {}} onKey={onKey} />);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    fireEvent.click(screen.getByRole("button", { name: "Tab" }));
    for (const label of ["Arrow up", "Arrow down", "Arrow left", "Arrow right"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }
    expect(onKey.mock.calls.map((c) => c[0])).toEqual(["escape", "tab", "up", "down", "left", "right"]);
  });

  it("shows Ctrl as a toggle and reports its state", () => {
    const onCtrl = vi.fn();
    const { rerender } = render(<KeyBar disabled={false} ctrl={false} onCtrl={onCtrl} onKey={() => {}} />);
    const ctrl = screen.getByRole("button", { name: "Ctrl" });
    expect(ctrl).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(ctrl);
    expect(onCtrl).toHaveBeenCalledTimes(1);
    rerender(<KeyBar disabled={false} ctrl onCtrl={onCtrl} onKey={() => {}} />);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
  });

  it("disables every key while the terminal cannot take user input", () => {
    const onKey = vi.fn();
    const onCtrl = vi.fn();
    render(<KeyBar disabled ctrl={false} onCtrl={onCtrl} onKey={onKey} />);
    for (const label of ["Esc", "Tab", "Ctrl", "Arrow up", "Arrow down", "Arrow left", "Arrow right"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onKey).not.toHaveBeenCalled();
    expect(onCtrl).not.toHaveBeenCalled();
    // The same buttons are enabled in the cases above, so the absence assertions discriminate.
  });

  it("keeps the terminal's focus instead of taking it from the page", () => {
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    render(<KeyBar disabled={false} ctrl={false} onCtrl={() => {}} onKey={() => {}} />);
    const tab = screen.getByRole("button", { name: "Tab" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(field).toHaveFocus();
    field.remove();
  });
});
