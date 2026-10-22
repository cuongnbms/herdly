// Real mobile-width layout proof. Only the WebSocket boundary is replaced: no user Session
// or Rust server is touched. Run from web: node scripts/sidebar-dom/run.mjs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const executablePath = process.env.CHROMIUM ?? ["chromium-1243", "chromium-1247"]
  .map((revision) => `${process.env.HOME}/.cache/ms-playwright/${revision}/chrome-linux64/chrome`)
  .find(existsSync);
assert(executablePath, "Set CHROMIUM to a Chromium executable");
const machine = {
  id: "local", label: "local", kind: "local", state: "connected", error: null,
  version: null, pi_agent_dir: null, has_pi: false, status: "idle",
  sessions: [{ name: "default", running: true, status: "idle", error: null,
    workspaces: [{ workspace_id: "w1", label: "Documents", number: 1, status: "idle", tabs:
    Array.from({ length: 16 }, (_, i) => ({ tab_id: `t${i}`, label: `shell-${i}`, number: i + 1, status: "idle", panes: [{
      pane_id: `p${i}`, terminal_id: `term${i}`, title: i ? `A long task title that should truncate on mobile ${i}` : "Documents",
      agent: null, status: "idle", cwd: null,
    }] })),
  }] }],
};
const server = await createServer({ root: resolve(import.meta.dirname, "../.."), server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  for (const width of [390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 650 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
    await page.addInitScript((view) => {
      window.WebSocket = class {
        constructor() {
          setTimeout(() => {
            this.onopen?.();
            this.onmessage?.({ data: JSON.stringify({ type: "machines", views: [view] }) });
          }, 0);
        }
        send() {}
        close() {}
      };
    }, machine);
    await page.goto(origin);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    const drawer = page.getByRole("dialog", { name: "Sessions and Workspaces" });
    const toggle = drawer.getByRole("button", { name: "Workspace Documents", exact: true });
    const plus = drawer.getByRole("button", { name: "New tab in Documents" });
    const [toggleBox, plusBox] = await Promise.all([toggle.boundingBox(), plus.boundingBox()]);
    assert(Math.abs(toggleBox.y - plusBox.y) < 2, "Plus belongs on the workspace header");
    assert(plusBox.width >= 44 && plusBox.height >= 44, "Plus retains a touch-sized target");
    const rows = drawer.locator(".sidebar-pane-row");
    assert.equal(await rows.count(), 16, "Each single-Pane tab has one row");
    assert.equal(await drawer.locator(".sidebar-tab-header").count(), 0, "No repeated tab headings");
    for (const row of await rows.all()) {
      const box = await row.boundingBox();
      assert(box.height <= 48, "Single-Pane rows should not reserve a second line");
      const actions = await row.getByRole("button", { name: /^Tab actions/ }).boundingBox();
      assert(actions.width >= 44 && actions.height >= 44, `Menu retains a touch-sized target: ${JSON.stringify(actions)}`);
      assert(actions.x + actions.width <= width, "Actions stay inside the mobile viewport");
    }
    const last = drawer.getByRole("button", { name: "Tab actions for shell-15", exact: true });
    await last.scrollIntoViewIfNeeded();
    await last.click();
    const menu = drawer.getByRole("menu", { name: "Tab actions for shell-15" });
    await menu.waitFor();
    const [menuBox, bodyBox] = await Promise.all([menu.boundingBox(), drawer.locator(".sidebar-body").boundingBox()]);
    assert(menuBox.y >= bodyBox.y && menuBox.y + menuBox.height <= bodyBox.y + bodyBox.height,
      "The last row's menu must not be clipped by the scrolling sidebar");
    await page.keyboard.press("Escape");
    assert.equal(await drawer.getByRole("menu").count(), 0);
    assert(await last.evaluate((node) => node === document.activeElement), "Escape returns focus to the action button");
    if (process.env.SIDEBAR_SCREENSHOT) {
      await drawer.locator(".sidebar-body").evaluate((node) => { node.scrollTop = 0; });
      await page.screenshot({ path: `${process.env.SIDEBAR_SCREENSHOT}-${width}.png` });
    }
    console.log(`PASS: compact sidebar at ${width}px, 44px touch targets, bottom menu visible`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
