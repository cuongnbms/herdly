# Terminal lens DOM fixture

Proves what jsdom cannot: xterm's real textarea, composition, paste, cursor-key modes and
mouse-reporting touch handling. `run.mjs` builds `harness.tsx` with Vite, serves the output from a
temporary free loopback port and drives Chromium through `playwright-core`.

```sh
pnpm --dir web test:terminal-dom
```

It is standalone on purpose: no Rust server, no pairing cookie, no user Session. Task 8's
`terminal-smoke.mjs` reuses the same assertions against the production bundle served by the real
Rust middleware. Browser: Playwright's cached Chromium (`$CHROMIUM` overrides the path).
Dist output stays untracked (`scripts/terminal-dom/dist/`).

The fixture also mounts the real PaneScreen/header and emulates the OS `visualViewport` API
with resize/scroll events while Chromium's layout viewport stays unchanged. It checks actual
host/screen/keybar client geometry, shrink/restore grids, unchanged-size suppression, no entry
or focus, already-resized-content fallback, API-absent fallback, and Lens-switch cleanup.
This is real Chromium rendering with an **emulated API**, not a physical soft keyboard or
Safari/Android hardware acceptance. Set `TERMINAL_DOM_EVIDENCE` to an existing writable directory
to save executable/version, geometry/checks JSON and screenshots.
