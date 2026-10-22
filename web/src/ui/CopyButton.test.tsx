import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as copy from "./copy";
import { CopyButton } from "./CopyButton";

vi.mock("./copy", () => ({ copyText: vi.fn() }));
afterEach(() => vi.useRealTimers());

describe("CopyButton", () => {
  it("copies the text as it is at tap time and says so for 1.5 s", () => {
    vi.useFakeTimers();
    vi.mocked(copy.copyText).mockReturnValue(true);
    let text = "first";
    render(<CopyButton text={() => text} />);
    text = "second";
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copy.copyText).toHaveBeenCalledWith("second");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    expect(screen.getByRole("button", { name: "Copied" })).toHaveAttribute("data-state", "success");
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("says when copying failed", () => {
    vi.mocked(copy.copyText).mockReturnValue(false);
    render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button", { name: "Copy failed" })).toBeInTheDocument();
  });
});
