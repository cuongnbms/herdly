import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("shows HTML as text and opens links safely", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> see [docs](https://example.com)'} />);
    expect(container.querySelector("img")).toBeNull();
    const a = screen.getByText("docs");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
