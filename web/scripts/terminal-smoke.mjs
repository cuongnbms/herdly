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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, connect } from "node:net";
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
    size*) set -- $(stty size); printf 'SIZE:%s:%s:%s\\n' "$1" "$2" "$(printf '%s' "$line" | cut -d' ' -f2-)" ;;
    spam) i=0; while [ $i -lt 200 ]; do printf 'ROW_%s\\n' "$i"; i=$((i+1)); done ;;
    *) printf 'GOT:%s\\n' "$line" ;;
  esac
done`;
/**
 * The echo script plus a `query` request: it prints a real DA1 request (`ESC[c`) into its own
 * output, so the *page's* xterm receives a terminal query over the real transport and has to
 * answer it. `query` is answered with a marker so the test knows when it ran.
 */
const QUERY_SCRIPT = `while IFS= read -r line; do
  case "$line" in
    query) printf '\\033[c'; printf 'QUERY-SENT\\n' ;;
    size*) set -- $(stty size); printf 'SIZE:%s:%s:%s\\n' "$1" "$2" "$(printf '%s' "$line" | cut -d' ' -f2-)" ;;
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

function run(program, args, { env, cwd } = {}) {
  return new Promise((done) => {
    const child = spawn(program, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
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

/**
 * Controlled delivery delay at the OS TCP boundary, not a replacement WebSocket.
 * HTTP, upgrades, client input, and pre-Attached output pass unchanged to/from Rust.
 * Only the first real Attached frame and its suffix are held. Each complete server frame
 * retains its original header/payload; release writes that queue once, in receive order.
 */
async function deliveryGate(targetPort) {
  const sockets = new Set();
  const frames = [];
  const queued = [];
  let armed = true;
  let held = false;
  let released = false;
  let downstream;
  let releaseTail = () => {};
  let heldResolve;
  const attached = new Promise((resolve) => { heldResolve = resolve; });
  const listener = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    let requestLine = "";
    let terminalRoute = false;
    client.on("data", (chunk) => {
      if (requestLine.includes("\r\n")) return;
      requestLine += chunk.toString();
      terminalRoute = /^GET \/ws\/terminal(?:\?| )/.test(requestLine);
    });
    client.pipe(upstream);
    client.on("close", () => upstream.destroy());
    upstream.on("end", () => client.end());
    let headers = Buffer.alloc(0);
    let pending = Buffer.alloc(0);
    let mode = "headers";
    upstream.on("data", (chunk) => {
      if (mode === "headers") {
        headers = Buffer.concat([headers, chunk]);
        const end = headers.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = headers.subarray(0, end + 4);
        chunk = headers.subarray(end + 4);
        client.write(head);
        mode = terminalRoute && /^HTTP\/1\.[01] 101\b/.test(head.toString()) && armed ? "frames" : "pass";
        headers = Buffer.alloc(0);
      }
      if (mode === "pass" || released) {
        client.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 15;
        let length = pending[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = Number(pending.readBigUInt64BE(2));
          offset = 10;
        }
        if (pending.length < offset + length) return;
        const raw = Buffer.from(pending.subarray(0, offset + length));
        pending = pending.subarray(offset + length);
        const payload = raw.subarray(offset);
        const isAttached = opcode === 1 && payload.toString() === '{"type":"attached"}';
        if (isAttached && armed) {
          held = true;
          armed = false;
          downstream = client;
          releaseTail = () => {
            if (pending.length) client.write(pending);
            pending = Buffer.alloc(0);
          };
        }
        const entry = { seq: frames.length, at: Date.now(), opcode, raw: raw.toString("base64"), hex: [...payload].map((b) => b.toString(16).padStart(2, "0")).join(" "), text: payload.toString(), held, releasedAt: held ? null : Date.now() };
        frames.push(entry);
        if (held) queued.push({ raw, entry });
        else client.write(raw);
        if (isAttached && held) heldResolve();
      }
    });
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  return {
    bind: `127.0.0.1:${listener.address().port}`,
    attached,
    frames,
    release() {
      if (!held || released || !downstream || downstream.destroyed) throw new Error("no live held Attached frame to release");
      for (const { raw, entry } of queued.splice(0)) {
        downstream.write(raw);
        entry.releasedAt = Date.now();
      }
      releaseTail();
      held = false;
      released = true;
    },
    async close() {
      queued.length = 0;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => listener.close(resolve));
    },
  };
}

/** Records securitypolicyviolation events and page-level errors for the checks. */
const PAGE_PROBE = `
window.__t8 = window.__t8 || { violations: [], wire: [], events: [], connections: [], closes: [] };
// Every gate-relevant DOM event, with the payload it carried and the phase the page was in at
// dispatch: "banner" is null once the page is Attached (there is no banner then), so "pre
// Attached" is read at the dispatch instant rather than assumed after the fact.
for (const ty of ["paste", "beforeinput", "input", "keydown", "compositionstart", "compositionend"]) {
  document.addEventListener(ty, (e) => {
    window.__t8.events.push({
      ty,
      cls: e.constructor.name,
      data: e.data ?? (e.clipboardData ? e.clipboardData.getData("text/plain") : null),
      key: e.key ?? null,
      prevented: e.defaultPrevented,
      banner: document.querySelector(".term-banner")?.textContent ?? null,
      at: Date.now(),
    });
  }, true);
}
window.addEventListener("securitypolicyviolation", (e) => {
  window.__t8.violations.push({ directive: e.violatedDirective, blocked: e.blockedURI });
});
// Record what the lens itself puts on the socket, with the phase the page was in at that
// instant: this is the wire oracle, not a guess from rendered output.
(() => {
  const Native = window.WebSocket;
  function Recording(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    window.__t8.connections.push({ url: String(url), at: Date.now() });
    ws.addEventListener("close", (e) => window.__t8.closes.push({ url: String(url), code: e.code, reason: e.reason, at: Date.now() }));
    const log = (kind, data) => {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer ?? data);
      window.__t8.wire.push({
        kind,
        url: String(url),
        text: new TextDecoder().decode(bytes),
        hex: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" "),
        len: bytes.length,
        banner: document.querySelector(".term-banner")?.textContent ?? null,
        at: Date.now(),
      });
    };
    const send = ws.send.bind(ws);
    ws.send = (data) => { log("out", data); return send(data); };
    ws.addEventListener("message", (e) => log("in", e.data));
    return ws;
  }
  Recording.prototype = Native.prototype;
  window.WebSocket = Recording;
})();
`;

async function main() {
  const build = !process.argv.includes("--no-build");
  if (process.platform !== "linux") {
    throw new Error(`this smoke reads /proc to count attach children, so it runs on Linux only (platform: ${process.platform})`);
  }
  const herdr = herdrPath();
  if (!herdr) throw new Error("no herdr binary: set HERDR_TEST_BIN or put herdr on PATH");
  const chrome = browserPath();
  if (!chrome) throw new Error("no Chromium: set CHROMIUM to a browser executable");
  // The binary is built before it is looked for: a fresh checkout has no target/ directory, and
  // refusing to start there would fail a run that could simply have built what it needs.
  const binary = process.env.T8_BIN ?? join(REPO, "src-tauri/target/debug/herdly-web");
  if (!process.env.T8_BIN) {
    // The fixture must serve the source under test, not a binary built before this run: an
    // incremental rebuild here is seconds, and a stale server would silently prove nothing.
    const built = await run("cargo", ["build", "--manifest-path", join(REPO, "src-tauri/Cargo.toml"), "-p", "herdly-web"], { env: process.env });
    if (built.code !== 0) throw new Error(`cargo build -p herdly-web failed: ${built.stderr.slice(-2000)}`);
  }
  if (!existsSync(binary)) throw new Error(`no herdly-web binary at ${binary} after the build`);

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
  let networkGate = null;
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
      executables: { node: process.execPath, herdr, chromium: chrome, rust: binary },
      timestamp: new Date().toISOString(),
      session: sessionName,
    };
    console.log(`${versions.herdr}; ${versions.chromium}; node ${versions.node}`);
    note(`fixture root ${root}`);

    // ---- the production bundle, built by the real build command -------------------------
    // Vite resolves its project from the process cwd, not from where its binary lives: run it
    // inside `web/`, or from the repo root it would build the desktop app's own index.html into
    // the root `dist/` while this smoke kept serving `web/dist` from a previous run. The bundle
    // the server serves is therefore proven to be the one this run produced.
    const dist = join(WEB, "dist");
    /** Milliseconds of the newest JavaScript asset in `web/dist/assets`. */
    const newestAsset = () => {
      const dir = join(dist, "assets");
      if (!existsSync(dir)) return 0;
      const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
      return files.length === 0 ? 0 : Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs));
    };
    // A build starting now must produce assets newer than this instant. That is what ties the
    // served bundle to this invocation: an earlier `web/dist`, or one Vite wrote into the repo
    // root because it was run from the wrong project, cannot satisfy it.
    const buildStartedAt = Date.now();
    const staleBefore = newestAsset();
    if (build) {
      const built = await run(join(WEB, "node_modules/.bin/vite"), ["build", "--logLevel", "warn"], { env: process.env, cwd: WEB });
      if (built.code !== 0) throw new Error(`vite build in ${WEB} failed: ${built.stderr || built.stdout}`);
      note(`vite build ran with cwd ${WEB}`);
    }
    const indexHtml = await readFile(join(dist, "index.html"), "utf8");
    check(
      "the served bundle is the web app's, built by this run",
      indexHtml.includes('<div id="root">') &&
        readFileSync(join(WEB, "package.json"), "utf8").includes("herdly-web-ui") &&
        (!build || (newestAsset() >= buildStartedAt - 1000 && newestAsset() >= staleBefore)),
      `index=${indexHtml.length}B newest=${new Date(newestAsset()).toISOString()} buildStart=${new Date(buildStartedAt).toISOString()} staleBefore=${staleBefore ? new Date(staleBefore).toISOString() : "none"}`,
    )

    // ---- a private herdr server with three Panes ----------------------------------------
    server = spawn(herdr, ["--session", sessionName, "server"], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    children.push(server);
    server.stdout.on("data", (b) => serverLog.push(String(b)));
    server.stderr.on("data", (b) => serverLog.push(String(b)));
    await waitFor("the fixture herdr server", 60000, async () => (await run(herdr, ["--session", sessionName, "api", "snapshot"], { env })).code === 0);

    const scripts = { echo: ECHO_SCRIPT, query: QUERY_SCRIPT, raw: RAW_SCRIPT, mouse: MOUSE_SCRIPT, appkeys: APPKEYS_SCRIPT };
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
    const queryPane = await makePane("query", "READY");
    const mousePane = await makePane("mouse", "READY");
    const appPane = await makePane("appkeys", "READY");
    note(`fixture Session ${sessionName}: echo=${echoPane.paneId} mouse=${mousePane.paneId} appkeys=${appPane.paneId}`);
    const allTerminals = [echoPane, mousePane, appPane].map((p) => p.terminalId);
    const live = (terminals = allTerminals) => attachChildren(sessionName, terminals);
    const card = (paneId) => `.pane-card[data-pane="${sessionName}/${paneId}"]`;

    // ---- the real Rust server over the production bundle --------------------------------
    const rustBind = `127.0.0.1:${18000 + (process.pid % 20000)}`;
    networkGate = await deliveryGate(Number(rustBind.split(":")[1]));
    const bind = networkGate.bind;
    const origin = `http://${bind}`;
    note("controlled delivery delay: native TCP gate holds the real Rust Attached frame and ordered suffix, never fabricates protocol success");
    const stateDir = join(root, "web-state");
    const pairOut = await run(binary, ["pair", "--bind", bind, "--origin", origin, "--state", stateDir], { env });
    const pairUrl = pairOut.stdout.split("\n")[0].trim();
    const startServed = async () => {
      const child = spawn(binary, ["serve", "--bind", rustBind, "--origin", origin, "--static", dist, "--state", stateDir], {
        env: Object.assign({}, env, { RUST_LOG: "info" }),
        stdio: ["ignore", "pipe", "pipe"],
        // Its own group, so cleanup can end it and every attach child it started in one signal
        // instead of racing them one by one.
        detached: true,
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
    const failedRequests = [];
    page.on("requestfailed", (r) => failedRequests.push({ url: r.url(), error: r.failure()?.errorText }));
    page.on("response", (r) => responses.push({ url: r.url(), status: r.status(), type: r.request().resourceType() }));
    const cdp = await context.newCDPSession(page);

  /**
   * The Pane's own PTY grid, as it reports it, ordered `rows:cols` like `stty size`.
   *
   * It overloads the echo script's `size` request with a unique tag, answers with
   * `SIZE:<rows>:<cols>:<tag>`, and waits in the *rendered* terminal for that tag, so a stale
   * report from an earlier viewport can never satisfy this question.
   */
  let sizeSeq = 0;
  const ptyGrid = async (paneId) => {
    const tag = `g${++sizeSeq}x${randomBytes(2).toString("hex")}`;
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(`size ${tag}`, { delay: 6 });
    await page.keyboard.press("Enter");
    let last = "";
    for (let i = 0; i < 120; i++) {
      last = await page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "");
      const m = last.match(new RegExp(`SIZE:(\\d+):(\\d+):${tag}`));
      if (m) return { rows: Number(m[1]), cols: Number(m[2]), tag };
      await page.waitForTimeout(200);
    }
    throw new Error(`no PTY size for ${tag}; last rows: ${JSON.stringify(last.slice(-200))}`);
  };
  /**
   * The grid the browser's terminal actually has, measured from what xterm rendered.
   *
   * xterm keeps its cell size on the helper textarea (one cell wide, one cell tall) and sizes
   * `.xterm-screen` to `cols × cellWidth` by `rows × cellHeight`, so the screen box divided by that
   * cell size is the grid it is rendering. The rendered row elements are a cross-check: xterm
   * writes one `<div>` per visible row. Neither number comes from what the lens says it sent.
   */
  const browserGrid = () =>
    page.evaluate(() => {
      const screen = document.querySelector(".xterm-screen");
      const ta = document.querySelector(".xterm-helper-textarea");
      const rows = document.querySelector(".xterm-rows");
      if (!screen || !ta) return { cols: 0, rows: 0, why: "no xterm" };
      const cellW = parseFloat(ta.style.width) || ta.getBoundingClientRect().width;
      const cellH = parseFloat(ta.style.height) || ta.getBoundingClientRect().height;
      const box = screen.getBoundingClientRect();
      return {
        cols: cellW > 0 ? Math.round(box.width / cellW) : 0,
        rows: cellH > 0 ? Math.round(box.height / cellH) : 0,
        cell: { w: Math.round(cellW * 1000) / 1000, h: Math.round(cellH * 1000) / 1000 },
        screenPx: { w: Math.round(box.width), h: Math.round(box.height) },
        domRows: rows ? rows.children.length : 0,
      };
    });

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

    // ---- the settling window: query/reply, and no user input before Attached ------------
    // Three requirements meet here, and each is checked on the wire rather than in rendered text:
    //   (a) xterm answers a terminal query while the attempt is still settling,
    //   (b) a paste and an IME composition reach nothing while the lens is still Connecting,
    //   (c) the same delivery *does* reach the Pane once Attached — the positive control that
    //       proves this harness can deliver it at all.
    //
    // One delivery is used in both (b) and (c), so the difference between them is the phase and
    // nothing else: a `paste` event at the page boundary the OS menu uses, carrying the real
    // clipboard payload, plus Chromium's own IME path. The delivery is labelled SCRIPTED where
    // it is synthesized; what it proves is that this page's gate drops it while settling and
    // lets it through when Attached, not that a phone's OS menu behaves this way.
    // The two payloads this section uses, one per delivery path. Neither is ever typed, so if one
    // appears in the Pane it can only have arrived through the path being tested. The paste
    // payload carries no newline on purpose: a leak that stops in the Pane's canonical line
    // buffer is invisible to `pane read`, and only the controlled flush below can reveal it.
    const settleToken = `SETTLE_${process.pid}_${Date.now()}`;
    const imeText = `ướ${settleToken}`;
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    /** Puts `text` on the real clipboard and delivers it as a `paste`, returning the event the
     * page observed at dispatch (payload, phase) so the caller can judge it, not assume it. */
    const pasteDelivery = async (page, text) => {
      await page.evaluate((t) => navigator.clipboard.writeText(t), text);
      return page.evaluate(async () => {
        const before = window.__t8.events.length;
        const payload = await navigator.clipboard.readText();
        const dt = new DataTransfer();
        dt.setData("text/plain", payload);
        const ta = document.querySelector(".xterm-helper-textarea");
        ta.focus();
        ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
        const seen = window.__t8.events.slice(before).filter((e) => e.ty === "paste");
        return { payload, dispatched: seen.length, seen, banner: document.querySelector(".term-banner")?.textContent ?? null };
      });
    };
    /** Commits `text` through Chromium's IME path, returning what the page saw at dispatch. */
    const imeDelivery = async (page, cdp, text) => {
      const before = await page.evaluate(() => window.__t8.events.length);
      await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      await cdp.send("Input.insertText", { text });
      await page.waitForTimeout(120);
      return page.evaluate((from) => window.__t8.events.slice(from), before);
    };

    /** The Pane's own screen, as the Pane reports it (not what the browser renders). */
    const paneScreen = async (paneId, lines = 60) => paneRead(paneId, lines);

    // --- (a) hold the real Attached boundary, without racing the server's 400ms window ---
    // Real binary output before Attached still reaches xterm and is ACKed. No browser event
    // handler, terminal parser, or client send path is replaced by this OS-network gate.
    await page.evaluate(() => {
      window.__t8.wire.length = 0;
      window.__t8.events.length = 0;
    });
    await page.locator(card(queryPane.paneId)).first().tap();
    await page.waitForSelector(".xterm-helper-textarea", { timeout: 60000 });
    await waitFor("the real server Attached frame held at TCP boundary", 30000, () => networkGate.frames.some((f) => f.held && f.text === '{"type":"attached"}'));
    await networkGate.attached;
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("GOT:READY"), null, { timeout: 30000 });
    const preAttached = await page.evaluate(() => ({
      banner: document.querySelector(".term-banner")?.textContent,
      rows: document.querySelector(".xterm-rows")?.textContent,
      wire: window.__t8.wire.slice(),
    }));
    check("real xterm parses and ACKs raw pre-Attached output while Connecting",
      preAttached.banner === "Connecting…" && preAttached.rows.includes("GOT:READY") &&
        preAttached.wire.some((f) => f.kind === "in" && f.len > 0 && !f.text.startsWith("{")) &&
        preAttached.wire.some((f) => f.kind === "out" && f.text.startsWith('{"type":"ack",')),
      JSON.stringify(preAttached));
    const sentAt = Date.now();
    const queryRun = await run(herdr, ["--session", sessionName, "pane", "run", queryPane.paneId, "query"], { env });
    if (queryRun.code !== 0) throw new Error(`Pane query failed: ${queryRun.stderr}`);
    await waitFor("the real Pane query marker", 30000, async () => (await paneScreen(queryPane.paneId)).includes("QUERY-SENT"));
    const focusBanner = await page.evaluate(() => document.querySelector(".term-banner")?.textContent ?? null);
    const settlingPaste = await pasteDelivery(page, settleToken);
    const settlingImeEvents = await imeDelivery(page, cdp, imeText);
    const afterState = await page.evaluate(() => document.querySelector(".term-banner")?.textContent ?? null);
    const settling = {
      sentAt, focusBanner, afterState, paneId: queryPane.paneId, terminalId: queryPane.terminalId,
      settlingPaste, settlingImeEvents,
      events: await page.evaluate(() => window.__t8.events.slice()),
      paneOutput: await paneScreen(queryPane.paneId),
    };
    check("the lens was caught in its settling window to test it", settling !== null, JSON.stringify({ ...settling, paneOutput: undefined, events: undefined }));
    check(
      "the page reported Connecting… at both ends of the settling inputs",
      settling.focusBanner === "Connecting…" && settling.afterState === "Connecting…",
      JSON.stringify({ focus: settling?.focusBanner, after: settling?.afterState }),
    );
    check(
      "the Pane really wrote its DA1 query during the settling window",
      settling !== null && /QUERY-SENT/.test(settling.paneOutput),
      JSON.stringify(settling?.paneOutput?.slice(-200)),
    );

    // The settling deliveries really happened, at the page boundary, with their payload and the
    // phase at dispatch: without this the absence checks below would pass on a probe that never
    // fired (the vacuity the previous round had).
    const settlingPasteEvent = settling?.settlingPaste?.seen?.find((e) => e.ty === "paste") ?? null;
    const settlingImeSaw = settling?.settlingImeEvents ?? [];
    check(
      "scripted paste really dispatched while Connecting, carrying the payload",
      settling !== null &&
        settlingPasteEvent !== null &&
        settling.settlingPaste.payload === settleToken &&
        settlingPasteEvent.data === settleToken &&
        settlingPasteEvent.banner === "Connecting…" && settling.settlingPaste.banner === "Connecting…",
      JSON.stringify({
        payload: settling?.settlingPaste?.payload,
        dispatched: settling?.settlingPaste?.dispatched,
        event: settlingPasteEvent,
      }),
    );
    check(
      "scripted IME really dispatched while Connecting, carrying the composed text",
      settlingImeSaw.some((e) => e.ty === "compositionend" && e.data === imeText) &&
        settlingImeSaw.some((e) => e.ty === "input" && e.data === imeText) &&
        settlingImeSaw.every((e) => e.banner === "Connecting…"),
      JSON.stringify(settlingImeSaw.map((e) => ({ ty: e.ty, data: e.data, banner: e.banner }))),
    );

    // MEASURED LIMITATION, and an open requirement rather than a covered one.
    //
    // The brief asks for a real xterm query/reply during settling. On this transport it cannot
    // happen: herdr 0.9.5 runs its own terminal emulation for the Pane, so a query the Pane writes
    // (`ESC[c`, measured above) is answered *inside herdr* and only the answer appears in the
    // Pane's screen — the client's own stream never carries the query, and therefore xterm is
    // never asked and never replies. The one query that does reach a client is herdr's startup
    // probe, which `herdly-core`'s attach reader recognises and answers itself (PROBE/PROBE_REPLY),
    // by approved design from Task 2. So this assertion states what really happened; the
    // requirement itself stays OPEN — see the report.
    const queryReachedPage = (await page.evaluate(() => window.__t8.wire.slice())).some(
      (f) => f.kind === "in" && /\x1b\[c/.test(f.text),
    );
    check(
      "herdr's emulation answers the Pane's query itself: it never reaches xterm (I3 OPEN)",
      settling !== null && /\[\?62;22c/.test(await paneScreen(queryPane.paneId)) && !queryReachedPage,
      JSON.stringify({ paneAnswered: (await paneScreen(queryPane.paneId)).slice(-160), queryReachedPage }),
    );
    note("I3 OPEN: a production xterm query/reply during settling is not observable through herdr 0.9.5's attach stream");

    // The wire oracle for the settling window: nothing the user did reached the socket. Only
    // JSON protocol frames (open/ack/resize) may be there.
    const settlingWire = await page.evaluate(() => window.__t8.wire.slice());
    const settlingLeaks = settlingWire.filter((f) => f.kind === "out" && !/^\{/.test(f.text));
    check(
      "the settling deliveries put no user text on the wire",
      settlingLeaks.length === 0 && settlingWire.length > 0 && settling !== null,
      JSON.stringify(settlingWire.map((f) => f.text)),
    );
    // The line-buffer oracle: the Pane this settling attempt really attached to (the query Pane,
    // not the echo one) is asked for input *after* it is Attached. A prefix stuck in its canonical
    // line buffer would be echoed by that flush, so the flush is both the reveal and the proof
    // that the buffer was read at all.
    networkGate.release();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("QUERY-SENT"), null, { timeout: 30000 });
    const replay = await page.evaluate(() => window.__t8.wire.filter((f) => f.kind === "in" && f.url.endsWith("/ws/terminal")));
    const boundaryFrames = networkGate.frames.filter((f) => f.opcode === 1 || f.opcode === 2);
    check("real server frames replay once in order, including Attached and queued output",
      replay.length >= boundaryFrames.length && boundaryFrames.every((f, i) => f.hex === replay[i].hex) &&
        boundaryFrames.every((f) => replay.filter((r) => r.hex === f.hex).length === boundaryFrames.filter((r) => r.hex === f.hex).length) &&
        replay.filter((f) => f.text === '{"type":"attached"}').length === 1 &&
        boundaryFrames.some((f) => f.held && f.text === '{"type":"attached"}' && f.releasedAt >= sentAt),
      JSON.stringify({ received: replay.length, forwarded: boundaryFrames.length }));
    // The controlled flush: an Attached-time line ending in Enter, so the Pane's line buffer is
    // really read and anything it held would be echoed back with it.
    const flushToken = `FLUSH_${process.pid}_${Date.now()}`;
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(flushToken, { delay: 6 });
    await page.keyboard.press("Enter");
    // The flush's own answer must appear: without it the absence below would be vacuous, so a
    // missing answer is a failure of this check rather than an exception that hides it.
    const flushAnswered = await page
      .waitForFunction((m) => (document.querySelector(".xterm-rows")?.textContent ?? "").includes(`GOT:${m}`), flushToken, { timeout: 60000 })
      .then(() => true)
      .catch(() => false);
    const flushed = await paneScreen(queryPane.paneId);
    check(
      "after the Attached flush the settling Pane's line buffer holds nothing from the window",
      flushAnswered &&
        flushed.includes(`GOT:${flushToken}`) &&
        !flushed.includes(settleToken) &&
        !flushed.includes(imeText),
      JSON.stringify({ flushToken, flushAnswered, tail: flushed.slice(-400) }),
    );

    // --- (c) positive control: the SAME two deliveries DO reach the Pane once Attached -----
    // The mouse Pane runs the raw `cat -v` reader, so bytes are echoed back as text with no line
    // buffering and no shell interpretation: the oracle is the byte itself.
    await page.locator('button[aria-label="Back"]').first().tap();
    await page.waitForSelector(card(mousePane.paneId), { timeout: 60000 });
    await page.locator(card(mousePane.paneId)).first().tap();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await page.waitForTimeout(600);
    const controlIme = `CTRL_IME_${Date.now()}`;
    const controlPaste = `CTRL_PASTE_${Date.now()}`;
    await page.locator(".xterm-helper-textarea").focus();
    const controlPasteDelivery = await pasteDelivery(page, controlPaste);
    let afterPaste = "";
    for (let i = 0; i < 40; i++) {
      afterPaste = await paneScreen(mousePane.paneId, 30);
      if (afterPaste.includes(controlPaste)) break;
      await page.waitForTimeout(200);
    }
    const controlImeEvents = await imeDelivery(page, cdp, controlIme);
    await page.waitForTimeout(600);
    const afterIme = await paneScreen(mousePane.paneId, 30);
    // The delivery is the same one the settling window used, so the only difference is phase.
    const controlPasteEvent = controlPasteDelivery.seen.find((e) => e.ty === "paste") ?? null;
    check(
      "positive control: the same scripted paste reached the Pane after Attached",
      afterPaste.includes(controlPaste) &&
        controlPasteDelivery.payload === controlPaste &&
        (controlPasteEvent?.data ?? "").includes(controlPaste) &&
        !/\bConnecting\b/.test(controlPasteEvent?.banner ?? ""),
      JSON.stringify({ payload: controlPasteDelivery.payload, event: controlPasteEvent, tail: afterPaste.slice(-200) }),
    );
    check(
      "positive control: the same IME commit reached the Pane after Attached",
      afterIme.includes(controlIme) &&
        controlImeEvents.some((e) => e.ty === "compositionend" && (e.data ?? "").includes(controlIme)),
      JSON.stringify({ events: controlImeEvents.map((e) => ({ ty: e.ty, data: e.data, banner: e.banner })), tail: afterIme.slice(-200) }),
    );

    // One merged timeline, so the ordering between what the page saw and what it sent is in the
    // artifact rather than left to prose: each entry keeps its own discriminator.
    const timeline = [
      ...(settling?.events ?? []).map((e) => ({ at: e.at, kind: "event", ty: e.ty, data: e.data, banner: e.banner })),
      ...(settlingWire ?? []).map((f) => ({ at: f.at, kind: f.kind === "out" ? "sent" : "received", text: f.text, banner: f.banner })),
      ...(controlPasteDelivery.seen ?? []).map((e) => ({ at: e.at, kind: "event", ty: e.ty, data: e.data, banner: e.banner })),
      ...(controlImeEvents ?? []).map((e) => ({ at: e.at, kind: "event", ty: e.ty, data: e.data, banner: e.banner })),
    ].sort((a, b) => a.at - b.at);

    // Everything this section observed, saved as evidence rather than described in prose.
    writeFileSync(
      join(EVIDENCE, "settling-window.json"),
      JSON.stringify(
        {
          phase: { settlingBanner: settling?.focusBanner, attachedBanner: null },
          pane: { settling: { paneId: queryPane.paneId, terminalId: queryPane.terminalId }, positive: { paneId: mousePane.paneId, terminalId: mousePane.terminalId } },
          settling: {
            paste: settling?.settlingPaste,
            imeEvents: settlingImeSaw,
            wire: settlingWire,
            afterState: settling.afterState,
            deliveryDelay: "real Attached + ordered suffix held at native TCP boundary",
            boundaryFrames,
            replay,
            flushToken,
            paneScreen: flushed,
          },
          positive: {
            paste: { delivery: controlPasteDelivery, payload: controlPaste },
            imeEvents: controlImeEvents,
            controlIme,
            paneScreen: afterPaste,
          },
          timeline,
          labels: {
            paste: "scripted (ClipboardEvent at the page boundary, real clipboard payload)",
            ime: "trusted (Chromium Input.imeSetComposition/insertText)",
            i3: "OPEN — herdr 0.9.5 answers the Pane's query in its own emulation",
          },
        },
        null,
        2,
      ),
    );

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
    // Back to the echo Pane: it answers each typed line with `GOT:`, which the earlier settling
    // and control sections left behind on other Panes.
    await page.locator('button[aria-label="Back"]').first().tap();
    await page.waitForSelector(card(echoPane.paneId), { timeout: 60000 });
    await page.locator(card(echoPane.paneId)).first().tap();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await page.waitForTimeout(600);
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
    // Each viewport is checked twice over: the DOM fits with no overflow, and the Pane's own PTY
    // reports exactly the grid the browser's terminal has. Each PTY answer is requested with a
    // fresh tag, so an older `SIZE:` line cannot satisfy it, and the expected value is the
    // browser grid itself rather than a "positive number" stand-in.
    // The measuring Pane is the echo one: the previous section left the app-cursor-mode Pane
    // open, so open the echo Pane again before asking either side for a grid.
    await page.locator('button[aria-label="Back"]').first().tap();
    await page.waitForSelector(card(echoPane.paneId), { timeout: 60000 });
    await page.locator(card(echoPane.paneId)).first().tap();
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    await waitFor("the echo Pane's attach for the grid checks", 30000, () => attachChildren(sessionName, [echoPane.terminalId]).length === 1);
    const sizesSeen = [];
    for (const size of [
      { width: 320, height: 640 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 640, height: 320 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(900);
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
      const grid = await browserGrid();
      const pty = await ptyGrid(echoPane.paneId);
      sizesSeen.push({ label, grid, pty });
      check(
        `${label}: the Pane's PTY grid equals the browser's (${pty.rows} rows x ${pty.cols} cols)`,
        grid.cols > 0 && grid.rows > 0 && pty.cols === grid.cols && pty.rows === grid.rows,
        JSON.stringify({ label, grid, pty }),
      );
      await screenshot(page, `layout-${label}`);
    }
    // The grid has to move with the viewport: a smoke that never resized would report one grid.
    const grids = sizesSeen.map((s) => `${s.pty.rows}x${s.pty.cols}`);
    check(
      "the PTY grid follows the viewport (resize frames really reach it)",
      new Set(grids).size >= 2,
      JSON.stringify(sizesSeen.map((s, i) => `${s.label}=${grids[i]}`)),
    );
    // Rotation is a real change and a real change back, each measured on both sides.
    const portraitBefore = sizesSeen.find((s) => s.label === "390x844");
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(900);
    const landscapeGrid = await browserGrid();
    const landscapePty = await ptyGrid(echoPane.paneId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(900);
    const backGrid = await browserGrid();
    const backPty = await ptyGrid(echoPane.paneId);
    check(
      "rotating to landscape and back changes then restores the PTY grid",
      landscapePty.cols === landscapeGrid.cols &&
        landscapePty.rows === landscapeGrid.rows &&
        landscapePty.cols > portraitBefore.pty.cols &&
        backPty.cols === portraitBefore.pty.cols &&
        backPty.rows === portraitBefore.pty.rows &&
        backGrid.cols === portraitBefore.grid.cols,
      JSON.stringify({
        portrait: `${portraitBefore.pty.rows}x${portraitBefore.pty.cols}`,
        landscape: `${landscapePty.rows}x${landscapePty.cols} vs browser ${landscapeGrid.rows}x${landscapeGrid.cols}`,
        back: `${backPty.rows}x${backPty.cols}`,
      }),
    );

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
    // SCRIPTED: `document.hidden` is overridden and `visibilitychange` is dispatched from the
    // page. This exercises the lens's visibility handler; it is not OS/browser backgrounding
    // evidence, which stays on the manual phone checklist.
    const hide = (hidden) =>
      page.evaluate((h) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await hide(true);
    await waitFor("the backgrounded page to release its attach", 30000, () => echoLive() === 0);
    check("scripted visibilitychange: hiding the page releases its own attachment", true);
    await hide(false);
    await waitFor("the foregrounded page to attach again", 30000, () => echoLive() === 1);
    await page.waitForFunction(() => !document.querySelector(".term-banner"), null, { timeout: 60000 });
    const resumed = `RESUMED_${process.pid}_${Date.now()}`;
    await typeLine(resumed);
    check("scripted visibilitychange: the resumed attempt accepts trusted input again", true);

    // Everything up to the deliberate disconnect must be clean. Close1000 is final: there
    // must be no next socket attempt, refused-reconnect console exception, or app-data send.
    const consoleErrorsBeforeDisconnect = consoleErrors.length;
    const pageErrorsBeforeDisconnect = pageErrors.length;

    // ---- CSP: the shipped page raised nothing beyond the probe -------------------------
    const allViolations = await page.evaluate(() => window.__t8.violations.slice());
    check("the shipped page raises no CSP violation beyond the inline probe", allViolations.length === inlineProbe.seen.length, `${inlineProbe.seen.length} probe, ${JSON.stringify(allViolations)}`);
    await screenshot(page, "final");

    // ---- disconnect: the process ends, the page says so, no attach child survives ------
    const beforeClose = await page.evaluate(() => ({
      rows: document.querySelector(".xterm-rows")?.textContent ?? "",
      connections: window.__t8.connections.filter((f) => f.url.endsWith("/ws/terminal")).length,
      sent: window.__t8.wire.filter((f) => f.kind === "out" && f.url.endsWith("/ws/terminal")).length,
    }));
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
    const closedText = "Connection closed (code 1000). Reattach to try again.";
    await page.waitForFunction((expected) => document.querySelector(".term-banner > span")?.textContent === expected, closedText, { timeout: 60000 });
    const reattach = page.getByRole("button", { name: "Reattach", exact: true });
    check("close1000 shows exact Closed status and accessible enabled Reattach",
      await reattach.count() === 1 && await reattach.isVisible() && await reattach.isEnabled() &&
        await page.locator('.term-banner[role="status"] > span').textContent() === closedText);
    // Observation beyond the first retry slot (1s); this is a negative retry oracle, not a
    // settling race or a retry used to obtain green. Never type through a closed socket.
    await page.waitForTimeout(1500);
    const closed = await page.evaluate(() => ({
      rows: document.querySelector(".xterm-rows")?.textContent ?? "",
      banner: document.querySelector(".term-banner > span")?.textContent,
      connections: window.__t8.connections.filter((f) => f.url.endsWith("/ws/terminal")),
      closes: window.__t8.closes.filter((f) => f.url.endsWith("/ws/terminal")),
      sent: window.__t8.wire.filter((f) => f.kind === "out" && f.url.endsWith("/ws/terminal")).length,
    }));
    check("close1000 retains output and makes no automatic retry or app-data send",
      beforeClose.rows.trimEnd().length > 0 && closed.rows.trimEnd() === beforeClose.rows.trimEnd() && closed.banner === closedText &&
        closed.connections.length === beforeClose.connections && closed.closes.at(-1)?.code === 1000 &&
        closed.sent === beforeClose.sent,
      JSON.stringify({ beforeClose, closed }));
    await writeFile(join(EVIDENCE, "disconnect.json"), JSON.stringify({ beforeClose, closed }, null, 2));
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
    // The independent Machine/Chat /ws intentionally still reconnects (not this lens).
    // Allow only its exact handshake error and /api/me network errors proven by requestfailed;
    // never blanket-filter Failed to load resource, or any /ws/terminal error.
    const afterDisconnect = consoleErrors.slice(consoleErrorsBeforeDisconnect);
    const allowedNetwork = failedRequests.filter((r) => r.url === `${origin}/api/me` &&
      /^net::ERR_(EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_REFUSED)$/.test(r.error ?? ""));
    const remainingNetwork = allowedNetwork.map((r) => `Failed to load resource: ${r.error}`);
    const unexpected = afterDisconnect.filter((t) => {
      if (t === `WebSocket connection to 'ws://${bind}/ws' failed: Connection closed before receiving a handshake response`) return false;
      const i = remainingNetwork.indexOf(t);
      if (i >= 0) { remainingNetwork.splice(i, 1); return false; }
      return true;
    });
    check("final close1000 has no unexpected error (only independently evidenced Machine/Chat network loss)", unexpected.length === 0 && pageErrors.length === 0, JSON.stringify({ unexpected, pageErrors, afterDisconnect, failedRequests }));
    await writeFile(join(EVIDENCE, "disconnect-console.json"), JSON.stringify({ afterDisconnect, failedRequests, unexpected }, null, 2));
    const servedText = servedLog.join("");
    check("the served process logged the graceful shutdown and no panic", servedText.includes("shutting down: closing live terminal attempts") && !/panic/i.test(servedText), servedText.slice(-500));
    const bad = responses.filter((r) => r.status >= 400 && !r.url.endsWith("/favicon.ico"));
    check("every document and asset request was answered by the middleware", bad.length === 0, JSON.stringify(bad.slice(0, 3)));

    await writeFile(join(EVIDENCE, "served.log"), servedText);
    await writeFile(join(EVIDENCE, "herdr-server.log"), serverLog.join(""));
    await writeFile(join(EVIDENCE, "version.json"), JSON.stringify({ ...versions, bind, csp, userAgent: await page.evaluate(() => navigator.userAgent) }, null, 2));
    await writeFile(join(EVIDENCE, "checks.json"), JSON.stringify({ passed: step - failures.length, failed: failures, notes, requests: responses.length }, null, 2));
  } finally {
    if (networkGate) {
      await writeFile(join(EVIDENCE, "delivery-gate.json"), JSON.stringify({ label: "controlled delivery delay of real Rust frames at native TCP boundary", frames: networkGate.frames }, null, 2)).catch((e) => {
        failures.push(`cannot save delivery-gate evidence: ${e.message}`);
      });
      await networkGate.close();
    }
    if (browser) await browser.close().catch(() => {});
    // Every process this run started is its own group leader, so one signal per group ends it and
    // anything it spawned (the served process and its attach children, the herdr server and its
    // Panes) instead of leaving an orphan behind.
    for (const child of children) {
      try {
        if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        /* already gone */
      }
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Only this fixture's Session, by name; then its directory.
    await run(herdr, ["--session", sessionName, "session", "stop"], { env }).catch(() => {});
    await run(herdr, ["--session", sessionName, "session", "delete"], { env }).catch(() => {});
    // Report any survivor rather than silently leaking it: a leftover process would mean the
    // cleanup contract ("only its own children, all of them") did not hold.
    const leftover = [];
    for (const pid of readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n))) {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
        if (argv.some((a) => a === sessionName) || argv.some((a) => a.includes(root))) leftover.push(`${pid} ${argv.slice(0, 3).join(" ")}`);
      } catch {
        /* exited meanwhile */
      }
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
    if (leftover.length > 0) {
      failures.push(`cleanup left ${leftover.length} process(es): ${leftover.join("; ")}`);
      console.log(`  FAIL cleanup: ${leftover.length} process(es) survived`);
    }
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
