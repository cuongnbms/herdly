/**
 * Real production browser smoke for the mobile terminal lens.
 *
 * The Task 6 fixture (`scripts/terminal-dom/run.mjs`) proves xterm's DOM behaviour against a
 * scripted transport served by a bare Vite preview. This script proves the *shipped* path: it
 * builds the production `web/dist` bundle with Vite, serves it through the real Rust
 * `herdly-web serve` middleware (real CSP header, real cookie/Origin gate, real
 * `/ws/terminal`), pairs a device through the real `pair` command and `/pair` route, and drives
 * Chromium over that server against a real, isolated `herdr` Session whose Panes run marker
 * scripts.
 *
 * Isolation: one temporary root holds its own `HOME`, `XDG_CONFIG_HOME` and `XDG_STATE_HOME` for
 * the herdr server it starts, its own web state directory, and its own Session name. Nothing
 * touches the user's herdr Session, server or service; everything this script started is ended
 * in `finally`, on any exit path.
 *
 * Usage:
 *   node scripts/terminal-smoke.mjs                 # build dist, then smoke
 *   node scripts/terminal-smoke.mjs --no-build      # reuse the existing dist
 *   T8_BIN=/path/to/herdly-web HERDR_TEST_BIN=/path/to/herdr CHROMIUM=/path/to/chrome \
 *     node scripts/terminal-smoke.mjs
 *
 * Exit code is non-zero when any assertion fails or a required tool is missing.
 *
 * Labeling, because it decides what the evidence means:
 *   "trusted"  — a real browser input event: Playwright `keyboard`/`touchscreen`, a real
 *                clipboard paste, CDP `Input.dispatchTouchEvent`.
 *   "scripted" — the page's own synthetic DOM events (composition, a non-cancelable input).
 *   "synthetic probe" — a page-local script injected only for the CSP check.
 * No check here is evidence for an iOS or Android device. Those are
 * `docs/mobile-terminal-checklist.md`'s job, and they stay unchecked until a real phone runs
 * them.
 */

import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const WEB = resolve(import.meta.dirname, "..");
const REPO = resolve(WEB, "..");
const RUNS = process.env.T8_EVIDENCE ?? resolve(REPO, ".agentkit/runs/2026-10-21-mobile-terminal-lens");
const EVIDENCE = join(RUNS, "browser-smoke");

/**
 * A Pane script that answers each input line, reports its own grid on `size`, and prints 200
 * lines on `spam` so the browser has real scrollback to scroll.
 */
const ECHO_SCRIPT = `while IFS= read -r line; do
  case "$line" in
    size) set -- $(stty size); printf 'SIZE:%s:%s\\n' "$1" "$2" ;;
    spam) i=0; while [ $i -lt 200 ]; do printf 'ROW_%s\\n' "$i"; i=$((i+1)); done ;;
    *) printf 'GOT:%s\\n' "$line" ;;
  esac
done`;
/**
 * Raw, unbuffered, non-canonical keys with `cat -v`, so every byte the browser sends is
 * printed at once as visible text: an arrow shows up as `^[[A`, Ctrl-C as `^C`, a pointer
 * report as `^[[<...M`. `-icanon` matters: in canonical mode the keys would wait for Enter.
 */
const RAW_SCRIPT = `stty -icanon -isig -echo; exec cat -v`;
/**
 * Arms DECCKM on the line `ARM` and then becomes `cat -v`. It is armed *after* the browser is
 * attached, so xterm really receives the mode change instead of only the redraw herdr replays
 * to a late client, which is what an arrow key's encoding follows.
 */
const APPKEYS_SCRIPT = `stty -icanon -isig -echo
while IFS= read -r line; do
  case "$line" in
    ARM) printf '\\033[?1h'; printf 'ARMED\\n'; exec cat -v ;;
    *) printf 'GOT:%s\\n' "$line" ;;
  esac
done`;
/** The same, with SGR mouse reporting on, so a stray pointer report would be visible as text. */
const MOUSE_SCRIPT = `stty -icanon -isig -echo; printf '\\033[?1000h\\033[?1006h'; exec cat -v`;

const failures = [];
const notes = [];
let step = 0;

function check(name, condition, detail) {
  const label = `${++step}. ${name}`;
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures.push(label);
  console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  return false;
}

function note(line) {
  notes.push(line);
  console.log(`  note ${line}`);
}

/** The Chromium this machine already has; never downloads one. */
function browserPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const home = process.env.HOME ?? "";
  for (const revision of ["chromium-1243", "chromium-1247", "chromium-1200"]) {
    const candidate = join(home, ".cache/ms-playwright", revision, "chrome-linux64/chrome");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function herdrPath() {
  if (process.env.HERDR_TEST_BIN) return process.env.HERDR_TEST_BIN;
  try {
    const found = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

/** The fixture environment: never the caller's herdr variables or state directories. */
function fixtureEnv(root) {
  return {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"),
    PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  };
}

function run(program, args, { env } = {}) {
  return new Promise((done) => {
    const child = spawn(program, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", (e) => done({ code: -1, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

async function waitFor(what, ms, cond) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await cond();
    if (last === true || (last && last.ok)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}${last === undefined ? "" : ` (last: ${JSON.stringify(last)})`}`);
}

/**
 * The Pane ids whose `herdr … terminal attach <terminal_id>` child is alive right now.
 *
 * Matched by the fixture's unique Session name *and* the Terminal id, so it can only ever count
 * this smoke's own attach children.
 */
function attachChildren(session, terminalIds) {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n));
  } catch {
    return found;
  }
  for (const pid of entries) {
    let raw;
    try {
      raw = readFileSync(`/proc/${pid}/cmdline`);
    } catch {
      continue;
    }
    const argv = raw.toString("utf8").split("\0").filter(Boolean);
    const sessionArg = argv.some((a, i) => a === "--session" && argv[i + 1] === session);
    if (!sessionArg) continue;
    const attachTerm = argv.find((a, i) => argv[i - 1] === "attach");
    if (attachTerm !== undefined && (terminalIds === undefined || terminalIds.includes(attachTerm))) found.push(attachTerm);
  }
  return found;
}

async function fetchJson(url, cookie) {
  const res = await fetch(url, { headers: cookie ? { cookie: `herdly_web=${cookie}` } : {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/** Records securitypolicyviolation events and page-level errors for the checks. */
const PAGE_PROBE = `
window.__t8 = window.__t8 || { violations: [] };
window.addEventListener("securitypolicyviolation", (e) => {
  window.__t8.violations.push({ directive: e.violatedDirective, blocked: e.blockedURI });
});
`;

async function main() {
  const build = !process.argv.includes("--no-build");
  const herdr = herdrPath();
  if (!herdr) throw new Error("no herdr binary: set HERDR_TEST_BIN or put herdr on PATH");
  const chrome = browserPath();
  if (!chrome) throw new Error("no Chromium: set CHROMIUM to a browser executable");
  const binary = process.env.T8_BIN ?? join(REPO, "src-tauri/target/debug/herdly-web");
  if (!existsSync(binary)) throw new Error(`no herdly-web binary at ${binary}: build it first`);
  // The fixture must serve the source under test, not a binary built before this run: an
  // incremental rebuild here is seconds, and a stale server would silently prove nothing.
  const built = await run("cargo", ["build", "--manifest-path", join(REPO, "src-tauri/Cargo.toml"), "-p", "herdly-web"], { env: process.env });
  if (built.code !== 0) throw new Error(`cargo build -p herdly-web failed: ${built.stderr.slice(-2000)}`);

  await mkdir(EVIDENCE, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "herdr-web-smoke-"));
  const env = fixtureEnv(root);
  await mkdir(env.HOME, { recursive: true });
  await mkdir(env.TMPDIR, { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "cwd"), { recursive: true });
  await symlink(herdr, join(root, "bin", "herdr")).catch(() => {});

  const sessionName = `herdly-web-smoke-${process.pid}-${randomBytes(3).toString("hex")}`;
  const children = [];
  let server = null;
  let served = null;
  let browser = null;
  const servedLog = [];
  const serverLog = [];
  const screenshot = (page, name) => page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: false });
  const paneRead = async (paneId, lines = 40) =>
    (await run(herdr, ["--session", sessionName, "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], { env })).stdout;

  try {
    const versions = {
      herdr: (await run(herdr, ["--version"], { env })).stdout.trim(),
      chromium: execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim(),
      node: process.version,
      timestamp: new Date().toISOString(),
      session: sessionName,
    };
    console.log(`${versions.herdr}; ${versions.chromium}; node ${versions.node}`);
    note(`fixture root ${root}`);

    // ---- the production bundle, built by the real build command -------------------------
    if (build) {
      const built = await run(join(WEB, "node_modules/.bin/vite"), ["build", "--logLevel", "warn"], { env: process.env });
      if (built.code !== 0) throw new Error(`vite build failed: ${built.stderr || built.stdout}`);
    }
    const dist = join(WEB, "dist");
    const indexHtml = await readFile(join(dist, "index.html"), "utf8");
    check("production bundle built, with an HTML entry", indexHtml.includes('<div id="root">'), indexHtml.slice(0, 120));

    // ---- a private herdr server with three Panes ----------------------------------------
    server = spawn(herdr, ["--session", sessionName, "server"], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    children.push(server);
    server.stdout.on("data", (b) => serverLog.push(String(b)));
    server.stderr.on("data", (b) => serverLog.push(String(b)));
    await waitFor("the fixture herdr server", 60000, async () => (await run(herdr, ["--session", sessionName, "api", "snapshot"], { env })).code === 0);

    const scripts = { echo: ECHO_SCRIPT, raw: RAW_SCRIPT, mouse: MOUSE_SCRIPT, appkeys: APPKEYS_SCRIPT };
    /** Creates a Workspace whose root Pane runs `scriptName`, and waits until it answers. */
    const makePane = async (scriptName, boot) => {
      const file = join(root, `pane-${scriptName}-${randomBytes(2).toString("hex")}.sh`);
      await writeFile(file, `${scripts[scriptName]}\n`);
      const created = await run(
        herdr,
        ["--session", sessionName, "workspace", "create", "--cwd", join(root, "cwd"), "--label", scriptName, "--env", "SHELL=/bin/sh", "--env", "PS1=$ ", "--no-focus"],
        { env },
      );
      const json = JSON.parse(created.stdout).result.root_pane;
      await run(herdr, ["--session", sessionName, "pane", "run", json.pane_id, `exec sh '${file}'`], { env });
      await run(herdr, ["--session", sessionName, "pane", "run", json.pane_id, boot], { env });
      await waitFor(`the ${scriptName} Pane to answer ${boot}`, 30000, async () => (await paneRead(json.pane_id, 20)).includes(boot));
      return { paneId: json.pane_id, terminalId: json.terminal_id };
    };
    const echoPane = await makePane("echo", "BOOT");
    const mousePane = await makePane("mouse", "READY");
    const appPane = await makePane("appkeys", "READY");
    note(`fixture Session ${sessionName}: echo=${echoPane.paneId} mouse=${mousePane.paneId} appkeys=${appPane.paneId}`);
    const allTerminals = [echoPane, mousePane, appPane].map((p) => p.terminalId);
    const live = (terminals = allTerminals) => attachChildren(sessionName, terminals);
    const card = (paneId) => `.pane-card[data-pane="${sessionName}/${paneId}"]`;

    // ---- the real Rust server over the production bundle --------------------------------
    const bind = `127.0.0.1:${18000 + (process.pid % 20000)}`;
    const origin = `http://${bind}`;
    const stateDir = join(root, "web-state");
    const pairOut = await run(binary, ["pair", "--bind", bind, "--origin", origin, "--state", stateDir], { env });
    const pairUrl = pairOut.stdout.split("\n")[0].trim();
    const startServed = async () => {
      const child = spawn(binary, ["serve", "--bind", bind, "--origin", origin, "--static", dist, "--state", stateDir], {
        env: Object.assign({}, env, { RUST_LOG: "info" }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      child.stdout.on("data", (b) => servedLog.push(String(b)));
      child.stderr.on("data", (b) => servedLog.push(String(b)));
      await waitFor("the served process", 60000, async () => {
        try {
          return (await fetch(`${origin}/api/me`)).status === 401;
        } catch {
          return false;
        }
      });
      return child;
    };
    served = await startServed();

    const pairing = await fetch(pairUrl, { redirect: "manual" });
    const setCookie = pairing.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0].replace("herdly_web=", "");
    check("the real /pair route issued a device cookie", [302, 303].includes(pairing.status) && cookie.length > 0, `${pairing.status} ${setCookie.slice(0, 40)}`);

    await waitFor("the served process to list the fixture Panes", 120000, async () => {
      const r = await fetchJson(`${origin}/api/machines`, cookie);
      return r.text.includes(`"pane_id":"${echoPane.paneId}"`) && r.text.includes(`"pane_id":"${appPane.paneId}"`);
    });

    // ---- headers and CSP as the real middleware sends them ------------------------------
    const head = await fetchJson(`${origin}/`, cookie);
    const csp = head.headers.get("content-security-policy") ?? "";
    const ctype = head.headers.get("content-type") ?? "";
    check("index is served as HTML by the real static fallback", ctype.startsWith("text/html"), ctype);
    check("real CSP allows inline styles and nothing else inline", csp.includes("style-src 'self' 'unsafe-inline'") && !csp.includes("'unsafe-eval'") && !csp.includes("script-src"), csp);
    check("real CSP keeps scripts same-origin", csp.includes("default-src 'self'"), csp);
    check("real CSP pins connect-src to the server origin", csp.includes(`connect-src 'self' ws://${bind}`), csp);
    const assetRefs = [...indexHtml.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    check("the bundle references same-origin assets only", assetRefs.length > 0 && assetRefs.every((a) => a.startsWith("/assets/")), JSON.stringify(assetRefs.slice(0, 5)));

    // ---- Chromium ----------------------------------------------------------------------
    browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
      permissions: ["clipboard-read", "clipboard-write"],
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 herdly-smoke",
    });
    await context.addCookies([{ name: "herdly_web", value: cookie, domain: "127.0.0.1", path: "/" }]);
    await context.addInitScript(PAGE_PROBE);
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (m) => {
      const text = m.text();
      // A CSP refusal is evidence for the probe checks, not a page defect: the probe's own
      // inline script and the "script-src falls back to default-src" line it provokes.
      const cspNoise = /Content Security Policy|Refused to execute|Refused to apply inline script|'script-src' was not explicitly set/;
      if (m.type() === "error" && !cspNoise.test(text)) consoleErrors.push(text);
    });
    const responses = [];
    page.on("response", (r) => responses.push({ url: r.url(), status: r.status(), type: r.request().resourceType() }));
    const cdp = await context.newCDPSession(page);

    await page.goto(origin, { waitUntil: "networkidle" });

    // A page-local inline script must be refused by the real CSP. The violation listener is
    // installed first, so the refusal itself is the evidence.
    const inlineProbe = await page.evaluate(async () => {
      const seen = [];
      window.addEventListener("securitypolicyviolation", (e) => seen.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
      window.__t8_inline_ran = false;
      const s = document.createElement("script");
      s.textContent = "window.__t8_inline_ran = true";
      document.head.appendChild(s);
      await new Promise((r) => setTimeout(r, 300));
      return { ran: window.__t8_inline_ran === true, seen };
    });
    check(
      "synthetic probe: an inline page script is BLOCKED by the real CSP",
      inlineProbe.ran === false && inlineProbe.seen.some((v) => v.directive.startsWith("script-src")),
      JSON.stringify(inlineProbe),
    );
    const cspInBrowser = await page.evaluate(async () => (await fetch("/", { credentials: "same-origin" })).headers.get("content-security-policy") ?? "");
    check("the browser reads the same CSP the middleware sends", cspInBrowser === csp, cspInBrowser);

    // ---- the settling window: no user paste or IME leak before Attached -----------------
    // The window is real but short (herdr settles the attach for ~400 ms), so this retries the
    // navigation until it catches the lens in `connecting`, and then proves through the Pane's
    // own output that nothing the user typed, pasted or composed reached it.
    const settleToken = `SETTLE_${process.pid}_${Date.now()}`;
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    let caughtSettling = null;
    for (let attempt = 0; attempt < 6 && caughtSettling === null; attempt++) {
      if (attempt > 0) {
        await page.locator('button[aria-label="Back"]').first().tap();
        await page.waitForSelector(".pane-card", { timeout: 60000 });
      }
      await page.locator(card(echoPane.paneId)).first().tap();
      await page.waitForSelector(".xterm-helper-textarea", { timeout: 60000 });
      const connecting = await page.locator(".term-banner", { hasText: "Connecting…" }).count();
      if (connecting === 0) continue;
      // The clipboard text ends with Enter: a leak would make the Pane's echo script print it
      // immediately, so the check below can see a leak rather than only its absence.
      await page.evaluate((text) => navigator.clipboard.writeText(`${text}\r`), settleToken);
      await page.locator(".xterm-helper-textarea").focus();
      // trusted: a real modifier-key chord reaches the browser's own paste path.
      await page.keyboard.press("Control+V");
      // scripted: an IME composition, which Chromium cannot be driven into headlessly.
      await page.evaluate(() => {
        const ta = document.querySelector(".xterm-helper-textarea");
        ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ướ" }));
        ta.dispatchEvent(new CompositionEvent("compositionend", { data: "ướ" }));
      });
      caughtSettling = { connectingAt: Date.now() };
    }
    check("the lens was caught in its settling window to test it", caughtSettling !== null, JSON.stringify(caughtSettling));
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    // The pasted text ends in Enter, so a leak would already be a printed line in the Pane by
    // now; no extra input is needed to make the absence observable.
    const settledOutput = await paneRead(echoPane.paneId, 40);
    check(
      "no user paste or IME text leaked into the Pane while settling",
      !settledOutput.includes(settleToken) && !settledOutput.includes("ướ"),
      settledOutput.slice(-300),
    );
    await screenshot(page, "390x844-attached");

    // ---- xterm's own runtime styling and the self-hosted font under the real CSP --------
    const xtermInline = await page.evaluate(() => {
      const rows = document.querySelector(".xterm-rows");
      const screen = document.querySelector(".xterm-screen");
      const box = screen ? screen.getBoundingClientRect() : null;
      return { rowsStyled: !!rows && rows.getAttribute("style") !== null, sheets: [...document.styleSheets].length, size: box ? `${Math.round(box.width)}x${Math.round(box.height)}` : null };
    });
    check("xterm's runtime inline styles are allowed and applied", xtermInline.rowsStyled && xtermInline.sheets > 0 && xtermInline.size !== "0x0", JSON.stringify(xtermInline));
    await page.evaluate(() => document.fonts.ready);
    const fontFaces = await page.evaluate(async () => {
      await document.fonts.load('13px "JetBrains Mono"', "A");
      const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, "").includes("JetBrains Mono"));
      return { count: faces.length, loaded: faces.filter((f) => f.status === "loaded").length, check: document.fonts.check('13px "JetBrains Mono"') };
    });
    check("the self-hosted terminal font loads under the real CSP", fontFaces.count > 0 && fontFaces.loaded > 0 && fontFaces.check === true, JSON.stringify(fontFaces));

    // ---- input through the real socket -------------------------------------------------
    const typeLine = async (text) => {
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(text, { delay: 8 });
      await page.keyboard.press("Enter");
      await page.waitForFunction((m) => (document.querySelector(".xterm-rows")?.textContent ?? "").includes(`GOT:${m}`), text, { timeout: 60000 });
    };
    const marker = `MARK_${process.pid}_${Date.now()}`;
    await typeLine(marker);
    check("trusted keyboard input reaches the real Pane and renders", true);
    const utf8 = `ÜNI_✓_日本_${Date.now()}`;
    await typeLine(utf8);
    check("UTF-8 input and output survive the real socket and render", true);
    const once = `ONCE_${process.pid}_${Date.now()}`;
    await typeLine(once);
    const onceCount = (await paneRead(echoPane.paneId, 40)).match(new RegExp(`GOT:${once}`, "g"))?.length ?? 0;
    check("trusted typing is delivered exactly once after Attached", onceCount === 1, String(onceCount));

    // ---- logical keys: arrows follow the terminal's cursor-key mode, Ctrl maps ---------
    await page.locator('button[aria-label="Back"]').first().tap();
    await page.waitForSelector(card(mousePane.paneId), { timeout: 60000 });
    await page.locator(card(mousePane.paneId)).first().tap();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await page.waitForTimeout(800);
    const keyButton = (label) => page.locator(`.term-keys button[aria-label="${label}"]`);
    await keyButton("Arrow up").tap();
    await page.waitForTimeout(600);
    const rawAfterArrow = await paneRead(mousePane.paneId, 20);
    check("the key bar's arrow sends the normal-mode cursor key once", rawAfterArrow.includes("^[[A") && (rawAfterArrow.match(/\^\[\[A/g) ?? []).length === 1, JSON.stringify(rawAfterArrow.slice(-120)));
    await keyButton("Ctrl").tap();
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("c");
    await page.waitForTimeout(600);
    const rawAfterCtrl = await paneRead(mousePane.paneId, 20);
    check("Ctrl then c sends exactly one U+0003", (rawAfterCtrl.match(/\^C/g) ?? []).length === 1, JSON.stringify(rawAfterCtrl.slice(-120)));

    // ---- touch scrolling ----------------------------------------------------------------
    // The Pane is in the mouse-reporting fixture's raw mode, which also makes any stray pointer
    // report visible as text. Measured limit: herdr 0.9.5's attach stream forwards no DECSET
    // modes to the client, so xterm never learns the Pane's application enabled mouse
    // reporting. What this path can prove is below (no report is emitted, the page does not
    // scroll), and the scrollback that follows proves the touch handler still scrolls xterm.
    const beforeSwipe = await paneRead(mousePane.paneId, 20);
    const box = await page.locator(".xterm-screen").boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const swipe = async (x, y, steps) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y + 140 }] });
      for (let i = 1; i <= steps; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 140 - i * 20 }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await swipe(cx, cy, 10);
    await page.waitForTimeout(700);
    const afterSwipe = await paneRead(mousePane.paneId, 20);
    const scrollAfter = await page.evaluate(() => window.scrollY);
    check(
      "trusted swipe emits no pointer report",
      !/\^\[\[<?[0-9;]*M/.test(afterSwipe) && afterSwipe.replace(/\s+/g, " ") === beforeSwipe.replace(/\s+/g, " "),
      JSON.stringify(afterSwipe.slice(-160)),
    );
    check("trusted swipe does not scroll the page", scrollBefore === scrollAfter, `${scrollBefore} -> ${scrollAfter}`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(500);
    const afterTap = await paneRead(mousePane.paneId, 20);
    check("a trusted tap focuses without sending a click", afterTap.replace(/\s+/g, " ") === beforeSwipe.replace(/\s+/g, " "), JSON.stringify(afterTap.slice(-160)));
    // Ctrl still reaches a raw Pane after a gesture, exactly once.
    const ctrlBefore = (beforeSwipe.match(/\^C/g) ?? []).length;
    await keyButton("Ctrl").tap();
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("c");
    await page.waitForTimeout(700);
    const ctrlAfterSwipe = await paneRead(mousePane.paneId, 20);
    check(
      "Ctrl after a gesture still sends exactly one U+0003",
      (ctrlAfterSwipe.match(/\^C/g) ?? []).length === ctrlBefore + 1,
      JSON.stringify(ctrlAfterSwipe.slice(-160)),
    );

    // Real scrollback, then the same gesture must move the terminal's own view.
    await page.locator('button[aria-label="Back"]').first().tap();
    await page.waitForSelector(card(echoPane.paneId), { timeout: 60000 });
    await page.locator(card(echoPane.paneId)).first().tap();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("spam", { delay: 8 });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("ROW_199"), null, { timeout: 60000 });
    const rowsBefore = await page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
    const box2 = await page.locator(".xterm-screen").boundingBox();
    await swipe(box2.x + box2.width / 2, box2.y + box2.height / 2, 12);
    await page.waitForTimeout(900);
    const rowsAfter = await page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
    check(
      "trusted swipe scrolls the terminal's own scrollback",
      rowsBefore !== rowsAfter && rowsAfter.includes("ROW_"),
      JSON.stringify({ before: rowsBefore.slice(0, 40), after: rowsAfter.slice(0, 40) }),
    );

    // The application cursor key mode cannot be observed over this transport: herdr's attach
    // stream reports the Pane's grid, not its modes. Measured here, with the Pane really setting
    // DECCKM (`printf '\033[?1h'`) after the browser attached: the stream carries only
    // cursor-visibility and synchronized-output modes, and the Pane receives the normal-mode
    // form. So the lens sends the normal-mode arrow on a real Pane in application mode, which is
    // `docs/mobile-terminal-checklist.md`'s and the report's documented limitation, and Task 6's
    // harness still proves xterm's own SS3 encoding when a mode change does reach it.
    await page.locator('button[aria-label="Back"]').first().tap();
    await page.waitForSelector(card(appPane.paneId), { timeout: 60000 });
    await page.locator(card(appPane.paneId)).first().tap();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await run(herdr, ["--session", sessionName, "pane", "run", appPane.paneId, "ARM"], { env });
    await waitFor("the Pane to arm DECCKM", 30000, async () => (await paneRead(appPane.paneId, 20)).includes("ARMED"));
    await page.waitForTimeout(1200);
    await keyButton("Arrow up").tap();
    await page.waitForTimeout(900);
    const appKeys = await paneRead(appPane.paneId, 20);
    check(
      "a Pane in application cursor mode still receives the normal-mode arrow (documented limit)",
      appKeys.includes("^[[A") && !appKeys.includes("^[OA"),
      JSON.stringify(appKeys.slice(-200)),
    );
    note("herdr 0.9.5's attach stream forwards no DECCKM/mouse modes, so xterm cannot track them on the real path");

    // ---- layout at phone sizes, and after rotation --------------------------------------
    await page.locator('button[aria-label="Back"]').first().tap();
    await page.waitForSelector(card(echoPane.paneId), { timeout: 60000 });
    await page.locator(card(echoPane.paneId)).first().tap();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    for (const size of [
      { width: 320, height: 640 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 640, height: 320 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(700);
      const dims = await page.evaluate(() => {
        const host = document.querySelector(".term-host");
        const screen = document.querySelector(".xterm-screen");
        const keys = document.querySelector(".term-keys");
        const doc = document.documentElement;
        return {
          host: host ? { w: Math.round(host.getBoundingClientRect().width), h: Math.round(host.getBoundingClientRect().height) } : null,
          screen: screen ? { w: Math.round(screen.getBoundingClientRect().width), h: Math.round(screen.getBoundingClientRect().height) } : null,
          overflowX: doc.scrollWidth > doc.clientWidth,
          overflowY: doc.scrollHeight > doc.clientHeight + 1,
          keyHeights: keys ? [...keys.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().height)) : [],
        };
      });
      const label = `${size.width}x${size.height}`;
      const fits = dims.screen && dims.host && dims.screen.w > 0 && dims.screen.h > 0 && dims.screen.w <= dims.host.w + 1 && dims.screen.h <= dims.host.h + 1;
      check(`${label}: terminal fits its host with no page overflow`, !!fits && !dims.overflowX && !dims.overflowY, JSON.stringify(dims));
      check(`${label}: key-bar targets stay at least 44px`, dims.keyHeights.length > 0 && dims.keyHeights.every((h) => h >= 44), JSON.stringify(dims.keyHeights));
      await screenshot(page, `layout-${label}`);
    }

    // A real resize after rotation reached the Pane's PTY.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(900);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("size", { delay: 8 });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /SIZE:\d+:\d+/.test(document.querySelector(".xterm-rows")?.textContent ?? ""), null, { timeout: 60000 });
    const sizeLine = (await page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "")).match(/SIZE:(\d+):(\d+)/);
    check("a real resize reached the Pane's PTY grid", !!sizeLine && Number(sizeLine[1]) > 0 && Number(sizeLine[2]) > 0, JSON.stringify(sizeLine?.slice(0, 3)));

    // ---- back and pane switching release the attachment --------------------------------
    const echoLive = () => attachChildren(sessionName, [echoPane.terminalId]).length;
    await waitFor("the echo Pane's attach child", 30000, () => echoLive() === 1);
    await page.locator('button[aria-label="Back"]').first().tap();
    await page.waitForSelector(".pane-card", { timeout: 60000 });
    await waitFor("Back to release the attachment", 30000, () => echoLive() === 0);
    check("Back releases the Pane's attachment", true);
    await page.locator(card(echoPane.paneId)).first().tap();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await waitFor("reopening to attach again", 30000, () => echoLive() === 1);
    await page.locator('button[aria-label="Back"]').first().tap();
    await page.waitForSelector(card(appPane.paneId), { timeout: 60000 });
    await page.locator(card(appPane.paneId)).first().tap();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await waitFor("switching Panes to attach only the new one", 30000, () => attachChildren(sessionName, [appPane.terminalId]).length === 1 && echoLive() === 0);
    check("switching Panes releases the old attachment and attaches the new one", true);

    // ---- backgrounding releases the attach; returning takes a fresh one ----------------
    await page.locator('button[aria-label="Back"]').first().tap();
    await page.waitForSelector(card(echoPane.paneId), { timeout: 60000 });
    await page.locator(card(echoPane.paneId)).first().tap();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await waitFor("the echo attach before backgrounding", 30000, () => echoLive() === 1);
    const hide = (hidden) =>
      page.evaluate((h) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await hide(true);
    await waitFor("the backgrounded page to release its attach", 30000, () => echoLive() === 0);
    check("a backgrounded page releases its own attachment", true);
    await hide(false);
    await waitFor("the foregrounded page to attach again", 30000, () => echoLive() === 1);
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    const resumed = `RESUMED_${process.pid}_${Date.now()}`;
    await typeLine(resumed);
    check("the resumed attempt accepts trusted input again", true);

    // Everything up to the deliberate disconnect must be clean; the disconnect itself is
    // expected to make the page's next socket attempt fail, which Chromium logs.
    const consoleErrorsBeforeDisconnect = consoleErrors.length;
    const pageErrorsBeforeDisconnect = pageErrors.length;

    // ---- CSP: the shipped page raised nothing beyond the probe -------------------------
    const allViolations = await page.evaluate(() => window.__t8.violations.slice());
    check("the shipped page raises no CSP violation beyond the inline probe", allViolations.length === inlineProbe.seen.length, `${inlineProbe.seen.length} probe, ${JSON.stringify(allViolations)}`);
    await screenshot(page, "final");

    // ---- disconnect: the process ends, the page says so, no attach child survives ------
    const eventsBefore = servedLog.length;
    void eventsBefore;
    const servedPid = served.pid;
    const termOfEcho = [echoPane.terminalId];
    check("an attach is live before the disconnect", attachChildren(sessionName, termOfEcho).length === 1, JSON.stringify(attachChildren(sessionName, termOfEcho)));
    process.kill(servedPid, "SIGTERM");
    await waitFor("the served process to exit", 60000, () => {
      try {
        process.kill(servedPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await page.waitForFunction(() => /Disconnected|Connecting|reconnect/i.test(document.querySelector(".term-banner")?.textContent ?? "") || !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await waitFor("the attach child to go with the server", 60000, () => attachChildren(sessionName, termOfEcho).length === 0);
    check("SIGTERM on the served process closes its attach child", true);
    // The Pane process itself survives the server that was only attaching to it.
    const survivor = `SURVIVOR_${Date.now()}`;
    await run(herdr, ["--session", sessionName, "pane", "run", echoPane.paneId, survivor], { env });
    await waitFor("the Pane to still answer after the server went away", 30000, async () => (await paneRead(echoPane.paneId, 20)).includes(`GOT:${survivor}`));
    check("the Pane process survives the web server", true);
    served = null;

    // ---- evidence ----------------------------------------------------------------------
    check("the page raised no error before the deliberate disconnect", pageErrorsBeforeDisconnect === 0, JSON.stringify(pageErrors.slice(0, 3)));
    check("the page logged no unexpected console error before the deliberate disconnect", consoleErrorsBeforeDisconnect === 0, JSON.stringify(consoleErrors.slice(0, 3)));
    // After the server is killed, only the refused reconnect may be logged, and only that.
    const afterDisconnect = consoleErrors.slice(consoleErrorsBeforeDisconnect).filter((t) => !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(t));
    check("after the deliberate disconnect only the refused reconnect was logged", afterDisconnect.length === 0 && pageErrors.length === 0, JSON.stringify(afterDisconnect.concat(pageErrors).slice(0, 3)));
    const servedText = servedLog.join("");
    check("the served process logged the graceful shutdown and no panic", servedText.includes("shutting down: closing live terminal attempts") && !/panic/i.test(servedText), servedText.slice(-500));
    const bad = responses.filter((r) => r.status >= 400 && !r.url.endsWith("/favicon.ico"));
    check("every document and asset request was answered by the middleware", bad.length === 0, JSON.stringify(bad.slice(0, 3)));

    await writeFile(join(EVIDENCE, "served.log"), servedText);
    await writeFile(join(EVIDENCE, "herdr-server.log"), serverLog.join(""));
    await writeFile(join(EVIDENCE, "version.json"), JSON.stringify({ ...versions, bind, csp, userAgent: await page.evaluate(() => navigator.userAgent) }, null, 2));
    await writeFile(join(EVIDENCE, "checks.json"), JSON.stringify({ passed: step - failures.length, failed: failures, notes, requests: responses.length }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const child of children) {
      try {
        if (child.pid && child.exitCode === null) {
          if (child === server) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        }
      } catch {
        /* already gone */
      }
    }
    // Only this fixture's Session, by name.
    await run(herdr, ["--session", sessionName, "session", "stop"], { env }).catch(() => {});
    await run(herdr, ["--session", sessionName, "session", "delete"], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failing check(s):\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`\nall ${step} browser checks passed (${notes.length} notes)`);
  console.log(`evidence: ${EVIDENCE}`);
}

main().catch(async (e) => {
  console.error(e);
  await mkdir(EVIDENCE, { recursive: true }).catch(() => {});
  await writeFile(join(EVIDENCE, "error.txt"), String(e?.stack ?? e)).catch(() => {});
  process.exit(1);
});
