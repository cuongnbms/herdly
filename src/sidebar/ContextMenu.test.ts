import { describe, expect, it } from "vitest";
import { placeMenu } from "./ContextMenu";

const view = { w: 1000, h: 700 };
const menu = { w: 200, h: 250 };

describe("placeMenu", () => {
  it("opens down and right of the pointer when it fits", () => {
    expect(placeMenu(100, 100, menu, view)).toEqual({ left: 100, top: 100, up: false, leftward: false });
  });

  it("opens upward when the pointer is too close to the bottom", () => {
    expect(placeMenu(100, 600, menu, view)).toEqual({ left: 100, top: 350, up: true, leftward: false });
  });

  it("opens leftward when the pointer is too close to the right edge", () => {
    expect(placeMenu(900, 100, menu, view)).toEqual({ left: 700, top: 100, up: false, leftward: true });
  });

  it("stays inside the window when neither side has room", () => {
    const tall = { w: 200, h: 650 };
    expect(placeMenu(100, 300, tall, view).top).toBe(view.h - tall.h - 4);
  });
});
