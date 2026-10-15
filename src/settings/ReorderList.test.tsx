import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReorderList } from "./ReorderList";

const dt = () => {
  const data: Record<string, string> = {};
  return { data, types: [] as string[], effectAllowed: "", dropEffect: "",
    setData(t: string, v: string) { data[t] = v; this.types.push(t); }, getData: (t: string) => data[t] ?? "", setDragImage() {} };
};

function setup(items = ["a", "b", "c"]) {
  const onChange = vi.fn();
  render(<ReorderList label="Order" items={items} onChange={onChange} />);
  const rows = () => within(screen.getByRole("list", { name: "Order" })).getAllByRole("listitem");
  return { onChange, rows };
}

describe("ReorderList", () => {
  it("shows the items in order", () => {
    const { rows } = setup();
    expect(rows().map((r) => r.querySelector(".reorder-text")!.textContent)).toEqual(["a", "b", "c"]);
  });
  it("moves an item by dragging its grip onto another row", () => {
    const { onChange, rows } = setup();
    const dataTransfer = dt();
    const grip = screen.getAllByTitle("Drag to reorder")[0];
    fireEvent.dragStart(grip, { dataTransfer });
    fireEvent.dragOver(rows()[2], { dataTransfer });
    expect(rows()[2].className).toContain("drop-after");
    fireEvent.drop(rows()[2], { dataTransfer });
    // jsdom rects are empty, so every drop lands after the target.
    expect(onChange).toHaveBeenCalledWith(["b", "c", "a"]);
  });
  it("removes an item", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove b" }));
    expect(onChange).toHaveBeenCalledWith(["a", "c"]);
  });
  it("moves with Option-Up / Option-Down", () => {
    const { onChange } = setup();
    fireEvent.keyDown(screen.getByRole("button", { name: "Remove b" }), { key: "ArrowUp", altKey: true });
    expect(onChange).toHaveBeenLastCalledWith(["b", "a", "c"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "Remove c" }), { key: "ArrowDown", altKey: true });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it("renders custom content", () => {
    render(<ReorderList label="T" items={["x"]} onChange={() => {}} render={(it, i) => <em>{`${i + 1}. ${it}`}</em>} />);
    expect(screen.getByText("1. x").tagName).toBe("EM");
  });
});
