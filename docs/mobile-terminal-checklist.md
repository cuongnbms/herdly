# Mobile Terminal lens — manual acceptance checklist

This checklist is the part of Task 8's acceptance that **only a real phone can answer**, plus the
limits the automated evidence does not cover. Nothing here is signed off: every row is
`awaiting a real phone` until someone runs it on hardware and fills in the date, device and
result. Do not mark a row passed from Chromium, Playwright, jsdom or emulation — those prove the
DOM contract, not a phone.

Two things are already proven automatically, and this file does not repeat them:

- `web/scripts/terminal-smoke.mjs` (59 checks) drives real Chromium over the production bundle
  served by the real Rust middleware, attached through a real `/ws/terminal` to a real isolated
  herdr Session: CSP, fonts, render, sizes 320x640/390x844 and rotation (each compared with the
  Pane's own PTY grid), the settling window (a scripted paste and a trusted IME composition reach
  nothing while Connecting, and a controlled Attached-time flush proves the Pane's line buffer is
  empty), the same two deliveries reaching the Pane once Attached, UTF-8, input-once, Ctrl, arrows,
  touch swipe and tap, Back and Pane switching, backgrounding, resize, and the SIGTERM path. Its
  `settling-window.json` records each delivery's payload and the phase at dispatch.
  One requirement stays **open**, not passed: a production xterm query/reply during settling is
  not observable through herdr 0.9.5, which answers a Pane's query in its own emulation.
- `src-tauri/web/tests/terminal_herdr.rs` (10 ignored tests) proves the real herdr lifecycle:
  attach, exclusivity, Held, explicit takeover, delayed cleanup, Pane survival, resize, exit,
  shutdown, SIGTERM with a live attach, an attach whose child exits with no ACK at all, and that a
  failure inside the served process's startup window reaps it.
- `src-tauri/web/tests/terminal_ws.rs` proves, over the real `AttachManager`/PTY path, that a
  reader with no ACK really pauses past core's 1 MiB high water mark, resumes when an ACK spends
  the credit, and finishes bounded when the Pane exits underneath it.

## How to run this checklist

1. Phone and Machine on the same trusted WireGuard network (see [ADR
   0011](../docs/adr/0011-herdly-web-plain-http-over-wireguard.md)); no port forwarding, no
   public exposure.
2. Pair from the phone: `herdly-web pair`, open the link within 10 minutes.
3. Open a Pane, switch it to **Terminal** in the header's Chat/Terminal selector.
4. Fill in a row only after it behaves as described. Record the phone, OS version, browser
   version, date, and whether the Machine's UI was open on the same Pane.

## iOS Safari

Status: **awaiting a real phone** (no iOS device has run any row below).

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | The Terminal lens opens and shows live output | Output appears within a few seconds; no device frame or desktop layout | awaiting a real phone |
| 2 | The soft keyboard opens on tap and does not cover the prompt | The grid refits above the keyboard (visual viewport), the prompt stays visible | awaiting a real phone |
| 3 | Typing reaches the Pane once per character | One character per keystroke, no doubled letters, no dropped first character | awaiting a real phone |
| 4 | Vietnamese IME (Telex or VNI) composes correctly | Accented text arrives composed (`ướ`, `đ`), no half-composed fragments, no duplicate send on commit | awaiting a real phone |
| 5 | Emoji and non-Latin text | Renders without breaking the grid; the Pane receives the same bytes | awaiting a real phone |
| 6 | Safe area | No control sits under the notch or the home indicator in portrait or landscape | awaiting a real phone |
| 7 | Rotation | The terminal refits, the Pane's `stty size` changes to the new grid, scrollback reflows | awaiting a real phone |
| 8 | Key bar | Esc, Tab, Ctrl and the four arrows send once; Ctrl+C interrupts a running command | awaiting a real phone |
| 9 | Touch scroll in a TUI with mouse reporting on | Pulling down shows older output (herdr's history, or the TUI's own view); a tap does not click a TUI target | awaiting a real phone |
| 10 | Backgrounding (lock screen, app switch) | Returning shows a fresh attempt and **input typed while away is gone** (see "Known loss" below) | awaiting a real phone |
| 11 | Held by the desktop | With the same Terminal open in Herdly on the Machine, the phone shows "Another device is attached" and **Take over** moves it to the phone | awaiting a real phone |
| 12 | Desktop interruption from the phone | After taking over on the phone, the desktop's terminal shows it was taken over and stops mirroring | awaiting a real phone |
| 13 | Reconnect after a network drop | The banner shows reconnecting; when the network returns the terminal reattaches | awaiting a real phone |
| 14 | Final output on close | Output printed just before a command exits is visible, and the banner reports the exit | awaiting a real phone |
| 15 | Pairing revocation | Revoking the device (`herdly-web revoke <id>`) ends the session and the UI says it is not paired | awaiting a real phone |

## Android Chrome

Status: **awaiting a real phone** (no Android device has run any row below).

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | The Terminal lens opens and shows live output | Output appears within a few seconds; phone layout, no horizontal scroll | awaiting a real phone |
| 2 | Gboard opens on tap and does not cover the prompt | The grid refits; the prompt and the key bar stay visible | awaiting a real phone |
| 3 | Hardware/gesture Back | Back leaves the Pane (release the attach), it does not leave the page or kill the app | awaiting a real phone |
| 4 | Typing reaches the Pane once per character | No doubled letters, no missed first character after focus | awaiting a real phone |
| 5 | Vietnamese IME (Telex/VNI) | Composed text arrives whole; no fragments and no duplicate on commit | awaiting a real phone |
| 6 | Emoji and non-Latin text | Renders without breaking the grid, bytes agree with the Pane | awaiting a real phone |
| 7 | Safe area and cutout | Nothing under the cutout or gesture bar, portrait and landscape | awaiting a real phone |
| 8 | Rotation | Refits, Pane grid changes, scrollback reflows | awaiting a real phone |
| 9 | Key bar | Esc, Tab, Ctrl and arrows send once; Ctrl+C interrupts | awaiting a real phone |
| 10 | Touch scroll in a TUI with mouse reporting on | Pulling down shows older output (herdr's history or the TUI's view); tap does not click a TUI target | awaiting a real phone |
| 11 | Backgrounding (app switch, screen off) | Returning shows a fresh attempt; input typed while away is gone | awaiting a real phone |
| 12 | Held / Take over against the desktop | Held banner, **Take over** wins, the desktop stops mirroring | awaiting a real phone |
| 13 | Reconnect after Wi-Fi to mobile data | The banner reports reconnecting and the terminal comes back | awaiting a real phone |
| 14 | Final output on close | Last output before an exit is visible and the exit is reported | awaiting a real phone |
| 15 | Pairing revocation | The session ends and the UI says it is not paired | awaiting a real phone |

## Known limits and known loss (accepted, not defects)

- **Input typed while the page is hidden is lost.** Backgrounding releases the Attach (a phone
  must not hold a Terminal while locked), so keystrokes entered while away have nowhere to go;
  they are deliberately not queued and replayed. See "release on backgrounding" in
  [web/README.md](../web/README.md).
- **The exit code is the attach command's, not the Pane process's.** Measured against herdr
  0.9.5: `herdr terminal attach` exits `1` whatever the Pane's process returned, and core reports
  the child's status. The banner's "code N" is therefore the CLI's status.
- **An application's terminal modes do not reach the browser.** herdr 0.9.5's attach stream
  carries the Pane's screen, not its DECSET modes, so xterm never learns the Pane set application
  cursor keys or enabled mouse reporting. Consequence: the key bar's arrows always send the
  normal-mode form. Verified in the smoke: with the Pane really setting `ESC[?1h`, the stream
  carries only cursor-visibility and synchronized-output modes and the Pane receives `ESC[A`.
- **Scrollback lives in herdr, not in the browser.** On attach, herdr turns on the alternate
  screen and SGR mouse reporting in the client and paints only the visible grid, so the browser's
  xterm has no history. A swipe therefore goes up as wheel reports, the same as a desktop wheel:
  herdr scrolls its own history, or hands the wheel to an application that asked for the mouse.
  Content moves at twice the finger, a flick keeps scrolling and slows down (a touch stops it),
  and a tap still sends no click. herdr repaints whole lines per report, so the motion is
  line by line, not pixel smooth.
- **Terminal queries are answered by herdr, not by the browser's xterm.** herdr emulates each
  Pane's terminal, so a query a program writes (`ESC[c`, `ESC[5n`, an OSC colour query) is answered
  inside herdr; the client never sees the query. Measured: the Pane's own screen shows the answer
  (`ESC[?62;22c`), and the browser's socket carries no query. The one query that does reach a
  client is herdr's startup probe, answered by `herdly-core`'s attach reader by approved design.
  Nothing in this checklist depends on the phone answering a terminal query.
- **Same trusted network only.** The server speaks plain HTTP on the WireGuard address; the hub
  can read the traffic. Do not expose it to the internet or an untrusted LAN.
- **The desktop app is unaffected.** The lens is a browser surface; no desktop UI or IPC changes
  with it, and an already-installed desktop needs no upgrade.

## What a pass means

A row is passed only with a device, OS, browser version, date and the observer's initials in
this file's git history. Anything else — including a clean Playwright run — stays
`awaiting a real phone`.
