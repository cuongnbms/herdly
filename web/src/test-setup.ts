import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no matchMedia and no 2d canvas. Real xterm 6 needs both at construction time
// (device-pixel watch, colour parsing), so shim the browser capabilities only; the terminal
// itself stays real in these tests.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
if (typeof HTMLCanvasElement !== "undefined" && !HTMLCanvasElement.prototype.getContext.toString().includes("native")) {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
// jsdom has no ResizeObserver. Layout changes are a browser capability, not the behaviour under
// test; the real fit/resize proof lives in the browser fixture.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

afterEach(() => cleanup());
