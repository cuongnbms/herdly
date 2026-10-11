import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { COLUMNS, useSidebarWidths } from "../settings/sidebarWidths";
import { ResizeHandle } from "./ResizeHandle";

beforeEach(() => {
  localStorage.clear();
  useSidebarWidths.setState({ sidebar: COLUMNS.sidebar.def, agents: COLUMNS.agents.def });
});

const handle = () => screen.getByRole("separator");

describe("ResizeHandle", () => {
  it("drags the column wider by the pointer's travel", () => {
    render(<ResizeHandle column="agents" label="Resize Agents" />);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 540, pointerId: 1 });
    expect(useSidebarWidths.getState().agents).toBe(328);
    fireEvent.pointerUp(handle(), { clientX: 540, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 600, pointerId: 1 });
    expect(useSidebarWidths.getState().agents).toBe(328);
  });

  it("ignores moves without a press", () => {
    render(<ResizeHandle column="sidebar" label="Resize Machines" />);
    fireEvent.pointerMove(handle(), { clientX: 900, pointerId: 1 });
    expect(useSidebarWidths.getState().sidebar).toBe(248);
  });

  it("double-click restores the default width", () => {
    useSidebarWidths.setState({ sidebar: 400 });
    render(<ResizeHandle column="sidebar" label="Resize Machines" />);
    fireEvent.doubleClick(handle());
    expect(useSidebarWidths.getState().sidebar).toBe(248);
  });

  it("arrow keys step the width and it reports its value", () => {
    render(<ResizeHandle column="sidebar" label="Resize Machines" />);
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(useSidebarWidths.getState().sidebar).toBe(264);
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(useSidebarWidths.getState().sidebar).toBe(232);
    expect(handle().getAttribute("aria-valuenow")).toBe("232");
    expect(handle().getAttribute("aria-label")).toBe("Resize Machines");
  });
});
