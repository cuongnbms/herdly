import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../ui/copy";
import { Markdown } from "./Markdown";

vi.mock("../ui/copy", () => ({ copyText: vi.fn(() => true) }));
beforeEach(() => vi.mocked(copyText).mockClear());

describe("Markdown", () => {
  it("shows HTML as text and opens links safely", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> see [docs](https://example.com)'} />);
    expect(container.querySelector("img")).toBeNull();
    const a = screen.getByText("docs");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("labels a code block with its language and copies its text", () => {
    render(<Markdown text={"```ts\nconst a = 1;\n```"} />);
    expect(screen.getByText("ts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(copyText).toHaveBeenCalledWith(expect.stringMatching(/^const a = 1;\n?$/));
  });

  it("labels a code block without a language as text", () => {
    render(<Markdown text={"```\nplain words\n```"} />);
    expect(screen.getByText("text")).toBeInTheDocument();
  });

  it("puts a table in a scrolling wrapper", () => {
    const { container } = render(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(container.querySelector(".table-wrap > table")).not.toBeNull();
  });
});
