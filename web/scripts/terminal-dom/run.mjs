/**
 * Real-xterm DOM proof for the terminal lens.
 *
 * jsdom cannot prove what xterm does with a real textarea: composition, paste, cursor-key mode,
 * mouse-reporting touch handling. This fixture builds the harness page with Vite, serves it from a
 * temporary free loopback port, and drives Chromium (Playwright) through the required cases.
 *
 * Isolated by construction: it serves only `scripts/terminal-dom/dist` on 127.0.0.1, opens no Rust
 * server, writes no state, and touches no user Session.
 *
 * Usage: node scripts/terminal-dom/run.mjs
 * Exit code is non-zero when any assertion fails.
 */

import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { build } from "vite";

const HERE = import.meta.dirname;
const DIST = resolve(HERE, "dist");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".map": "application/json" };

/** The browser that CI/user machines have: the Playwright cache Chromium, or an explicit path. */
function browserPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const home = process.env.HOME ?? "";
  for (const revision of ["chromium-1243", "chromium-1247", "chromium-1200"]) {
    const candidate = join(home, ".cache/ms-playwright", revision, "chrome-linux64/chrome");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const failures = [];
const checks = [];
const evidence = { caveat: "Real Chromium layout with EMULATED visualViewport API; not a physical keyboard, Safari, or Android hardware acceptance.", geometry: [] };
const evidenceDir = process.env.TERMINAL_DOM_EVIDENCE;
async function saveEvidence() {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "viewport-browser.json"), JSON.stringify({ ...evidence, checks, failures }, null, 2));
}
/** Wire text the lens sent, ignoring acknowledgements (which the fixture records separately). */
const sentTexts = (log) => log.filter((e) => e.kind === "input" || e.kind === "reply").map((e) => e.text);
function check(name, condition, detail) {
  checks.push({ name, passed: !!condition, detail });
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

async function main() {
  // Build only the harness page: the production bundle is Task 8's job.
  await build({
    root: HERE,
    logLevel: "warn",
    build: {
      outDir: DIST,
      emptyOutDir: true,
      rollupOptions: { input: resolve(HERE, "index.html") },
    },
    resolve: { alias: { "@desktop": resolve(HERE, "../../../src") } },
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    const file = join(DIST, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const executablePath = browserPath();
  if (!executablePath) throw new Error("no Chromium build found; set CHROMIUM to a browser executable");
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  evidence.executablePath = executablePath;
  evidence.browserVersion = browser.version();

  try {
    // A phone-sized viewport with a coarse pointer: touch is what the lens has to handle.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!document.querySelector(".xterm-helper-textarea"));

    const log = () => page.evaluate(() => window.wire.log.map((e) => ({ ...e })));
    const clear = () => page.evaluate(() => (window.wire.log.length = 0));
    const ta = ".xterm-helper-textarea";

    console.log("terminal lens, real xterm DOM");
    check("one xterm mounted", (await page.locator(".xterm").count()) === 1);
    check("no autofocus on entry", await page.evaluate(() => document.activeElement === document.body));
    const starts = await page.evaluate(() => window.wire.starts);
    check(
      "first attempt opened with a measured grid, normal takeover",
      starts.length === 1 && starts[0].takeover === false && starts[0].cols > 0 && starts[0].rows > 0,
      JSON.stringify(starts),
    );
    check("connecting banner visible", await page.getByText("Connecting…").isVisible());

    // --- Settling: a real query is answered, while user entry is captured -------------------
    await clear();
    await page.evaluate(() => window.feed("\x1b[c"));
    await page.waitForFunction(() => window.wire.log.some((e) => e.text.includes("[?1;2c")));
    const reply = (await log()).find((e) => e.text.includes("[?1;2c"));
    check("xterm answers DA before Attached", reply !== undefined, JSON.stringify(await log()));

    await clear();
    await page.locator(ta).focus();
    await page.keyboard.type("x");
    await page.waitForTimeout(150);
    check("typing before Attached sends nothing", (await log()).length === 0, JSON.stringify(await log()));

    // Real paste through the browser's clipboard path, still settling.
    await page.evaluate(async () => {
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      event.clipboardData.setData("text/plain", "pasted-before");
      document.querySelector(".xterm-helper-textarea").dispatchEvent(event);
    });
    await page.waitForTimeout(100);
    check("paste before Attached sends nothing", (await log()).length === 0, JSON.stringify(await log()));

    // Real composition events (as a mobile IME produces) while settling.
    await page.evaluate(() => {
      const ta = document.querySelector(".xterm-helper-textarea");
      ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      ta.value = "ướ";
      ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ướ" }));
      ta.dispatchEvent(new CompositionEvent("compositionend", { data: "ướ" }));
    });
    await page.waitForTimeout(150);
    check("composition before Attached sends nothing", (await log()).length === 0, JSON.stringify(await log()));

    // --- Attached ---------------------------------------------------------------------------
    await page.evaluate(() => window.attach());
    await page.waitForTimeout(50);
    check("banner clears once Attached", (await page.getByText("Connecting…").count()) === 0);

    await clear();
    await page.locator(ta).focus();
    await page.keyboard.type("hi");
    await page.waitForFunction(() => window.wire.log.filter((e) => e.kind === "input").length > 0);
    const typed = (await log()).filter((e) => e.kind === "input").map((e) => e.text).join("");
    check("typing after Attached goes out once", typed === "hi", JSON.stringify(typed));

    await clear();
    await page.evaluate(async () => {
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      event.clipboardData.setData("text/plain", "echo hi\nthere");
      document.querySelector(".xterm-helper-textarea").dispatchEvent(event);
    });
    await page.waitForTimeout(150);
    const pasted = (await log()).filter((e) => e.kind === "input").map((e) => e.text);
    check(
      "paste after Attached arrives once with terminal line endings",
      pasted.length === 1 && pasted[0] === "echo hi\rthere",
      JSON.stringify(pasted),
    );

    await clear();
    await page.evaluate(() => {
      const ta = document.querySelector(".xterm-helper-textarea");
      ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      ta.value = "ướ";
      ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ướ" }));
      ta.dispatchEvent(new CompositionEvent("compositionend", { data: "ướ" }));
    });
    await page.waitForTimeout(200);
    const composed = (await log()).filter((e) => e.kind === "input").map((e) => e.text);
    check("IME composition after Attached arrives once", composed.length === 1 && composed[0] === "ướ", JSON.stringify(composed));

    // --- Output still renders and ACKs once after parse -------------------------------------
    await clear();
    await page.evaluate(() => window.feed("MARKER-42\r\n"));
    await page.waitForFunction(() => window.wire.log.some((e) => e.kind === "ack"));
    await page.waitForTimeout(150);
    const acked = (await log()).filter((e) => e.kind === "ack");
    check("output is acknowledged once after parsing", acked.length === 1 && acked[0].text === "11", JSON.stringify(acked));
    const text = await page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
    check("output text is visible", text.includes("MARKER-42"), text.slice(-80));

    // --- Ctrl must not consume, and must not rewrite, protocol replies -----------------------
    await clear();
    await page.getByRole("button", { name: "Ctrl" }).click();
    await page.evaluate(() => window.feed("\x1b[c"));
    await page.waitForFunction(() => window.wire.log.some((e) => e.text.includes("[?1;2c")));
    const ctrlLog = await log();
    check(
      "query reply under armed Ctrl is untouched and Ctrl stays armed",
      ctrlLog.filter((e) => e.kind === "input" || e.kind === "reply").map((e) => e.text).join("") === "\x1b[?1;2c" &&
        (await page.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed")) === "true",
      JSON.stringify(ctrlLog),
    );
    await page.locator(ta).focus();
    await page.keyboard.type("c");
    await page.waitForTimeout(150);
    const ctrlTyped = (await log()).filter((e) => e.kind !== "ack").map((e) => e.text);
    check(
      "Ctrl is spent on the next character",
      ctrlTyped.join("").endsWith("\x03") && (await page.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed")) === "false",
      JSON.stringify(ctrlTyped),
    );

    // A mobile keyboard inserts text with no printable keydown. Chromium's `Input.insertText`
    // (a trusted CDP event, measured: beforeinput -> input only) is that exact path.
    const cdp = await page.context().newCDPSession(page);
    const mobileType = async (text) => {
      await cdp.send("Input.insertText", { text });
      await page.waitForTimeout(200);
    };
    await page.locator(ta).focus();

    await clear();
    await page.getByRole("button", { name: "Ctrl" }).click();
    await mobileType("c");
    const inputOnly = sentTexts(await log());
    check(
      "Ctrl maps a trusted insertText-only c to U+0003 once",
      JSON.stringify(inputOnly) === JSON.stringify(["\u0003"]) &&
        (await page.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed")) === "false",
      JSON.stringify(inputOnly),
    );

    // The same character typed once before arming Ctrl must still map, and consecutive entries of
    // the same character must all arrive: the gate keeps no synthetic tail between insertions.
    await clear();
    await mobileType("c");
    await page.getByRole("button", { name: "Ctrl" }).click();
    await mobileType("c");
    await mobileType("c");
    const repeat = sentTexts(await log());
    check(
      "consecutive same-character insertions all arrive, first Ctrl one mapped once",
      JSON.stringify(repeat) === JSON.stringify(["c", "\u0003", "c"]),
      JSON.stringify(repeat),
    );

    // A Ctrl insertion the gate cancels: Chromium emits no `input` for it (measured), so the next
    // unrelated insertion of the same character must not be swallowed.
    await clear();
    await page.getByRole("button", { name: "Ctrl" }).click();
    await mobileType("c");
    await mobileType("c");
    const afterCancel = sentTexts(await log());
    check(
      "a canceled Ctrl insertion does not eat the next same-character entry",
      JSON.stringify(afterCancel) === JSON.stringify(["\u0003", "c"]),
      JSON.stringify(afterCancel),
    );

    // SYNTHETIC BOUNDARY: a non-cancelable beforeinput. Chromium 153 never emits this itself
    // (measured: every real beforeinput is cancelable), so this check stands in for browsers that
    // do. Unsupported text must still reach the wire once and leave no debt behind.
    await clear();
    await page.getByRole("button", { name: "Ctrl" }).click();
    const syntheticNonCancelable = async (text) => {
      await page.evaluate((value) => {
        const ta = document.querySelector(".xterm-helper-textarea");
        ta.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: value, bubbles: true, cancelable: false }));
        ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: value, bubbles: true }));
      }, text);
      await page.waitForTimeout(200);
    };
    await syntheticNonCancelable("ß");
    await syntheticNonCancelable("ß");
    const unsupportedNonCancelable = sentTexts(await log());
    check(
      "SYNTHETIC non-cancelable unsupported insertion passes through once each, no stale debt",
      JSON.stringify(unsupportedNonCancelable) === JSON.stringify(["ß", "ß"]) &&
        (await page.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed")) === "false",
      JSON.stringify(unsupportedNonCancelable),
    );

    // SYNTHETIC BOUNDARY: the mapped counterpart must send one control byte, not two.
    await clear();
    await page.getByRole("button", { name: "Ctrl" }).click();
    await syntheticNonCancelable("c");
    const mappedNonCancelable = sentTexts(await log());
    check(
      "SYNTHETIC non-cancelable mapped insertion sends U+0003 once",
      JSON.stringify(mappedNonCancelable) === JSON.stringify(["\u0003"]),
      JSON.stringify(mappedNonCancelable),
    );

    // A modifier keydown must not spend Ctrl before the character arrives.
    await clear();
    await page.getByRole("button", { name: "Ctrl" }).click();
    await page.keyboard.down("Shift");
    await page.waitForTimeout(100);
    const afterShift = {
      armed: await page.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed"),
      sent: sentTexts(await log()),
    };
    await page.keyboard.up("Shift");
    check(
      "Shift keydown does not spend Ctrl",
      afterShift.armed === "true" && afterShift.sent.length === 0,
      JSON.stringify(afterShift),
    );
    // ...and the C that follows still becomes ^C.
    await clear();
    await page.keyboard.down("Shift");
    await page.keyboard.press("KeyC");
    await page.keyboard.up("Shift");
    await page.waitForTimeout(200);
    const afterShiftC = sentTexts(await log());
    check(
      "Ctrl then Shift+C sends U+0003",
      afterShiftC.join("") === "\u0003" &&
        (await page.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed")) === "false",
      JSON.stringify(afterShiftC),
    );

    // Positive control for the non-ASCII rule: unsupported text goes out unchanged, once.
    await clear();
    await page.getByRole("button", { name: "Ctrl" }).click();
    await mobileType("ß");
    const nonAscii = sentTexts(await log());
    check(
      "unsupported non-ASCII insertText is sent unchanged once and spends Ctrl",
      JSON.stringify(nonAscii) === JSON.stringify(["ß"]) &&
        (await page.getByRole("button", { name: "Ctrl" }).getAttribute("aria-pressed")) === "false",
      JSON.stringify(nonAscii),
    );

    // --- Arrows follow the terminal's cursor-key mode ---------------------------------------
    await clear();
    await page.getByRole("button", { name: "Arrow up" }).click();
    await page.waitForTimeout(100);
    check("arrow in normal mode", JSON.stringify(sentTexts(await log())) === JSON.stringify(["\x1b[A"]), JSON.stringify(await log()));
    await clear();
    await page.evaluate(() => window.feed("\x1b[?1h"));
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Arrow left" }).click();
    await page.waitForTimeout(100);
    check("arrow in application mode", JSON.stringify(sentTexts(await log())) === JSON.stringify(["\x1bOD"]), JSON.stringify(await log()));

    // --- Touch scrolling while the terminal has mouse reporting on --------------------------
    // Fill scrollback so there is something to scroll, then turn on SGR mouse reporting.
    await clear();
    await page.evaluate(async () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n";
      await window.feed(lines);
      await window.feed("\x1b[?1000h\x1b[?1006h");
    });
    await page.waitForTimeout(400);
    /** The `line N` shown on the grid's top row: smaller is older scrollback. */
    const topLine = () =>
      page.evaluate(() => {
        const match = /line (\d+)/.exec(document.querySelector(".xterm-rows")?.firstElementChild?.textContent ?? "");
        return match ? Number(match[1]) : null;
      });
    const box = await page.locator(".xterm-screen").boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // A real one-finger swipe on a touch-enabled Chromium context; `dy` is the finger's travel.
    await page.touchscreen.tap(cx, cy).catch(() => {});
    const client = await page.context().newCDPSession(page);
    const swipe = async (dy) => {
      const from = cy - dy / 2;
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: from }] });
      for (let step = 1; step <= 8; step++) {
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx, y: from + (dy * step) / 8 }] });
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(300);
    };
    // Natural phone scrolling: the content follows the finger, so pulling down reveals older
    // lines and, at the bottom, pushing up has nothing newer to show.
    const atBottom = await topLine();
    await swipe(-160);
    const afterUp = await topLine();
    check("finger up at the bottom stays on the newest output", afterUp === atBottom, `${atBottom} -> ${afterUp}`);
    await swipe(160);
    const afterDown = await topLine();
    check("finger down scrolls into older scrollback", atBottom !== null && afterDown !== null && afterDown < atBottom, `${atBottom} -> ${afterDown}`);
    await swipe(-160);
    const afterBack = await topLine();
    check("finger up scrolls back toward newer output", afterDown !== null && afterBack !== null && afterBack > afterDown, `${afterDown} -> ${afterBack}`);
    const touchLog = (await log()).filter((e) => e.kind === "input" || e.kind === "reply");
    check("swipe sent no pointer reports", touchLog.length === 0, JSON.stringify(touchLog));

    // A tap focuses without clicking a terminal target.
    await clear();
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(200);
    check(
      "tap focuses and sends no click",
      (await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea"))) === true &&
        (await log()).length === 0,
      JSON.stringify(await log()),
    );

    // --- Layout: 320px and rotation ---------------------------------------------------------
    for (const size of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(400);
      const dims = await page.evaluate(() => {
        const host = document.querySelector(".term-host");
        const screen = document.querySelector(".xterm-screen");
        const keys = document.querySelector(".term-keys");
        if (!host || !screen || !keys) return null;
        const h = host.getBoundingClientRect();
        const s = screen.getBoundingClientRect();
        return {
          hostWidth: Math.round(h.width),
          screenWidth: Math.round(s.width),
          screenHeight: Math.round(s.height),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          keyHeight: [...keys.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().height)),
        };
      });
      check(`${size.width}x${size.height}: terminal fits the viewport`, !!dims && dims.screenWidth > 0 && dims.screenHeight > 0 && !dims.overflow, JSON.stringify(dims));
      check(`${size.width}x${size.height}: key buttons are 44px targets`, !!dims && dims.keyHeight.every((h) => h >= 44), JSON.stringify(dims?.keyHeight));
    }

    // Each resize must not resend an identical grid.
    const resizes = await page.evaluate(() => window.wire.log.filter((e) => e.kind === "resize").map((e) => e.text));
    check("no duplicate resize is sent", new Set(resizes).size === resizes.length, JSON.stringify(resizes));

    // --- EMULATED OS visualViewport boundary, real Chromium client/layout geometry -----------
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => !!document.querySelector(".xterm-helper-textarea"));
    await page.evaluate(() => {
      const vv = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
      const listeners = new Map();
      const add = vv.addEventListener.bind(vv);
      const remove = vv.removeEventListener.bind(vv);
      vv.addEventListener = (type, listener, options) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
        add(type, listener, options);
      };
      vv.removeEventListener = (type, listener, options) => {
        listeners.get(type)?.delete(listener);
        remove(type, listener, options);
      };
      Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
      window.viewportFixture = { vv, listeners };
      window.visible(true); // remount onto the emulated OS API, not an emulated renderer
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.attach());
    await page.waitForTimeout(400); // Attached removes the banner, so compare the settled grid.
    const geometry = async (label) => {
      const result = await page.evaluate(() => {
        const rect = (selector) => {
          const el = document.querySelector(selector);
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, width: r.width, height: r.height, clientHeight: el.clientHeight };
        };
        return {
          innerHeight: window.innerHeight, layoutHeight: document.documentElement.clientHeight,
          dvh: getComputedStyle(document.querySelector(".pane-screen")).height,
          viewport: { height: window.visualViewport.height, top: window.visualViewport.offsetTop },
          pane: rect(".pane-screen"), host: rect(".term-host"), screen: rect(".xterm-screen"), keys: rect(".term-keys"),
          resizes: window.wire.log.filter((e) => e.kind === "resize").map((e) => JSON.parse(e.text)),
          starts: window.wire.starts,
          focused: document.activeElement?.classList.contains("xterm-helper-textarea"),
        };
      });
      evidence.geometry.push({ label, ...result });
      return result;
    };
    const full = await geometry("full");
    const fullGrid = full.resizes.at(-1) ?? full.starts.at(-1);
    await clear();
    await page.evaluate(() => {
      const { vv } = window.viewportFixture;
      vv.height = 440;
      vv.offsetTop = 36;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(400);
    const shrunk = await geometry("visual-only shrink and pan");
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, "viewport-shrunk.png") });
    check("EMULATED visual-only keyboard keeps actual host/keybar within visible bounds and changes grid",
      shrunk.innerHeight === full.innerHeight && shrunk.layoutHeight === full.layoutHeight &&
      shrunk.pane.top >= 36 && shrunk.host.top >= 36 && shrunk.keys.bottom <= 476 &&
      shrunk.screen.bottom <= shrunk.keys.top && shrunk.host.clientHeight < full.host.clientHeight &&
      shrunk.resizes.length === 1 && shrunk.resizes[0].rows < fullGrid.rows,
      JSON.stringify({ full, shrunk }));
    await page.evaluate(() => {
      const { vv } = window.viewportFixture;
      vv.dispatchEvent(new Event("resize")); vv.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(400);
    const repeated = await geometry("repeat unchanged");
    check("EMULATED viewport duplicate events send no duplicate size or input and never focus",
      repeated.resizes.length === 1 && !repeated.focused && sentTexts(await log()).length === 0,
      JSON.stringify(repeated));
    await page.evaluate(() => {
      const { vv } = window.viewportFixture;
      vv.height = window.innerHeight; vv.offsetTop = 0; vv.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(400);
    const restored = await geometry("restored");
    check("EMULATED keyboard dismiss restores actual geometry and original grid once",
      restored.host.clientHeight === full.host.clientHeight && restored.keys.bottom === full.keys.bottom &&
      restored.resizes.length === 2 && restored.resizes[1].rows === fullGrid.rows,
      JSON.stringify(restored));
    // Browser already resizes content: absolute visible bounds, never subtract keyboard twice.
    await page.evaluate(() => {
      const { vv } = window.viewportFixture;
      vv.height = 440; vv.offsetTop = 0;
    });
    await page.setViewportSize({ width: 390, height: 440 });
    await page.waitForTimeout(400);
    const contentResized = await geometry("layout and visual viewport both resized");
    check("EMULATED already-resized content is not shrunk twice",
      contentResized.innerHeight === 440 && contentResized.pane.height === 440 && contentResized.keys.bottom === 440,
      JSON.stringify(contentResized));
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const cleaned = await page.evaluate(() => {
      const pane = document.querySelector(".pane-screen");
      const { vv, listeners } = window.viewportFixture;
      vv.height = 300; vv.dispatchEvent(new Event("resize")); vv.dispatchEvent(new Event("scroll"));
      return { style: pane.getAttribute("style"), marker: pane.hasAttribute("data-terminal-viewport"), listeners: [...listeners].map(([type, set]) => [type, set.size]) };
    });
    check("EMULATED viewport listeners and owned CSS clean up on real Lens switch",
      !cleaned.style && !cleaned.marker && cleaned.listeners.every(([, count]) => count === 0), JSON.stringify(cleaned));
    evidence.cleanup = cleaned;
    await page.evaluate(() => Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined }));
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.waitForTimeout(400);
    await page.evaluate(() => window.attach());
    await page.waitForTimeout(400);
    const fallback = await page.evaluate(() => {
      const pane = document.querySelector(".pane-screen");
      return { height: pane.clientHeight, marker: pane.hasAttribute("data-terminal-viewport"), host: document.querySelector(".term-host").clientHeight, innerHeight };
    });
    check("no visualViewport API falls back to normal layout and fitting",
      !fallback.marker && fallback.height === fallback.innerHeight && fallback.host > 0, JSON.stringify(fallback));
    evidence.fallback = fallback;
    if (evidenceDir) await page.screenshot({ path: join(evidenceDir, "viewport-chat-cleanup.png") });
    check("no page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  } finally {
    await saveEvidence();
    await browser.close();
    await new Promise((done) => server.close(done));
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failing check(s):\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nall browser checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
