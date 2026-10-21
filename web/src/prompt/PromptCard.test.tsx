import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptCard } from "./PromptCard";

const prompt = { id: "x", agent: "claude", kind: "approval", title: "Bash", question: "Do you want to proceed?", body: null,
  options: [{ label: "Yes", description: null }, { label: "No", description: "and tell Claude why" }], multi_select: false, custom_option_index: 2 } as never;

describe("PromptCard", () => {
  it("answers with the tapped option or typed text", () => {
    const onAnswer = vi.fn();
    render(<PromptCard prompt={prompt} busy={false} error={null} onAnswer={onAnswer} />);
    expect(screen.getByText("Do you want to proceed?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("No"));
    expect(onAnswer).toHaveBeenLastCalledWith({ option_index: 1 });
    fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "use pnpm" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenLastCalledWith({ custom_text: "use pnpm" });
  });

  it("disables options while busy", () => {
    render(<PromptCard prompt={prompt} busy={true} error="pane gone" onAnswer={() => {}} />);
    expect(screen.getByText("Yes").closest("button")).toBeDisabled();
    expect(screen.getByText("pane gone")).toBeInTheDocument();
  });

  it("submits the checked options of a multi-select", () => {
    const multi = { ...(prompt as object), multi_select: true, custom_option_index: null, options: [{ label: "A", description: null }, { label: "B", description: null }, { label: "C", description: null }] } as never;
    const onAnswer = vi.fn();
    render(<PromptCard prompt={multi} busy={false} error={null} onAnswer={onAnswer} />);
    expect(screen.queryByLabelText("Answer")).toBeNull();
    fireEvent.click(screen.getByLabelText("C"));
    fireEvent.click(screen.getByLabelText("A"));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenLastCalledWith({ option_indices: [0, 2] });
  });
});
