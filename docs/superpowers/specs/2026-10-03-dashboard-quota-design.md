# Quota column on the Agent Dashboard

Date: 2026-10-03
Status: draft

## Purpose

Show, on the Agent Dashboard, how much of each Provider's Quota has been used and when
each Window resets, so a glance at the board tells whether the agents are about to hit a
limit.

The Agents run on the local Mac and on remote Machines, but they spend the same accounts.
A Quota belongs to a Provider, not to a Machine, and it is read once, on this Mac.

Reference: herdpet (`/Users/cuongnb/Workspace/utils/herdpet`), whose Quota card was built
and verified against real responses on 2026-09-17 (its spec
`docs/superpowers/specs/2026-09-17-quota-design.md`, ADR 0005). This design ports that
behaviour — endpoints, headers, parsing, outcome mapping, schedule, formatting — from
Swift to the Tauri app's Rust core and React UI. Where this spec is silent on a detail of
parsing or formatting, herdpet's behaviour is the reference.

## Scope

In:

- Four Providers: Claude (Claude Code subscription), Codex (ChatGPT plan), OpenCode Go,
  Grok.
- Credentials read from this Mac only, at their default locations.
- Claude's per-model weekly limits (`weekly_scoped`).
- A fifth column, **Quota**, on the right of the Agent Dashboard board, after Idle.

Out:

- Reading credentials on remote Machines.
- Refreshing, writing or rotating any token; launching any CLI (ADR 0002).
- Codex's `additional_rate_limits`, reset credits, credit balances, dollar amounts.
- Environment overrides (`CODEX_HOME`, `GROK_HOME`, `CLAUDE_CONFIG_DIR`): an app launched
  from Finder does not inherit the shell environment.
- Notifications about Quota; a Quota badge on the sidebar dashboard entry.
- Fetching while the dashboard is closed.

## Providers

Every endpoint is undocumented. All four report **used** percent; the app uses used
percent everywhere and never converts to remaining. Every request is a `GET` with
`Authorization: Bearer <token>`, `Accept: application/json` and a 10 s timeout.

### Claude

- **Credential**: macOS Keychain generic password, service `Claude Code-credentials`, read
  with `/usr/bin/security find-generic-password -s "Claude Code-credentials" -w`. The
  value is JSON; the token is `claudeAiOauth.accessToken`. `expiresAt` is ignored.
- **Request**: `https://api.anthropic.com/api/oauth/usage`, with
  `anthropic-beta: oauth-2025-04-20` and `User-Agent: claude-code/2.1.0`.
- **Windows**: from `limits[]` in order: `kind == "session"` → `5h` (18000 s);
  `"weekly_all"` → `week` (604800 s); `"weekly_scoped"` → `week · <scope.model.display_name>`
  (604800 s; skipped without a display name); other kinds ignored. Each entry has
  `percent` and `resets_at`. When `limits` is absent or yields no Window, fall back to
  `five_hour` → `5h` and `seven_day` → `week`, each with `utilization` (or
  `used_percentage`) and `resets_at`.

### Codex

- **Credential**: `~/.codex/auth.json`, `tokens.access_token`, optional
  `tokens.account_id`.
- **Request**: `https://chatgpt.com/backend-api/wham/usage`, with `User-Agent: codex-cli`,
  `OpenAI-Beta: codex-1`, `originator: Codex Desktop`, and
  `ChatGPT-Account-Id: <account_id>` when present.
- **Windows**: `rate_limit.primary_window` then `rate_limit.secondary_window` (either may be
  `null`), each with `used_percent`, `limit_window_seconds`, `reset_at` (epoch seconds).
  Label from the duration: 18000 → `5h`, 604800 → `week`, otherwise a compact duration
  (`3h`, `2d`, `90m`), `limit` when missing.

### OpenCode Go

- **Credential**: opencode v2 keeps it in `~/.local/share/opencode/opencode.db`, table
  `credential`, the newest active row with `integration_id = 'opencode-go'`, field `key` of
  its JSON `value`; read with `/usr/bin/sqlite3 -readonly`, then `immutable=1` when a clean
  exit has removed the WAL. opencode v1 kept it in `~/.local/share/opencode/auth.json`,
  field `["opencode-go"].key`, still read when the database has none.
- **Request**: `https://opencode.ai/zen/go/v1/usage`, no extra headers.
- **Windows**: `usage.rolling` → `5h`, `usage.weekly` → `week`, `usage.monthly` → `month`
  (no duration); each has `percent` and `resetsAt`.
- 403 whose body has `error.type == "EntitlementError"` → no subscription.

### Grok

- **Credential**: `~/.grok/auth.json`, an object keyed by issuer. Prefer the key equal to
  `https://auth.x.ai` or starting with `https://auth.x.ai::`; otherwise the first other
  issuer with a `key`, in sorted key order. Fields `key` and optional `user_id`.
- **Request**: `https://cli-chat-proxy.grok.com/v1/billing?format=credits`, with
  `X-XAI-Token-Auth: xai-grok-cli` and `x-userid: <user_id>` when present.
- **Windows**: fields under `config` (or top level). One Window: percent
  `creditUsagePercent`; reset `currentPeriod.end`, else `billingPeriodEnd`; duration from
  the period's start/end. Label from `currentPeriod.type`: `USAGE_PERIOD_TYPE_WEEKLY` →
  `week`, `…_MONTHLY` → `month`, otherwise `period`. `creditUsagePercent` absent but
  `currentPeriod` present → 0% (proto3 drops zeros); neither → no Window.

### Dates

A date is an ISO-8601 string with offset and up to six fractional digits
(`2026-09-17T14:00:00.551304+00:00`, `…000Z`), or a number: epoch seconds, or
milliseconds when above 1e10. `null` → no reset. Percent is clamped to 0…100. A JSON
`true`/`false` is never read as a number.

## Rust core: `src-tauri/src/quota/`

Pure modules, each unit tested with the response fixtures copied from herdpet's
`Tests/HerdviewCoreTests/Quota*Tests.swift`:

- `mod.rs` — types, all `Serialize` with camelCase:
  - `Provider` enum `claude | codex | opencodeGo | grok`.
  - `QuotaWindow { label: String, used_percent: f64, resets_at: Option<i64> /* epoch ms */, duration_secs: Option<u64> }`.
  - `QuotaOutcome`, tagged `{"kind": …}`:
    `ok { windows, fetchedAt }`, `notSignedIn`, `signInExpired`, `noSubscription`,
    `rateLimited { until /* epoch ms */ }`, `failed { reason }`.
  - `fetch(provider) -> QuotaOutcome`: read credential → build request → send → classify.
- `credentials.rs` — one `parse_*(&[u8]) -> Option<Credential>` per source; `None` = not
  signed in. `read(provider)` reads the file (missing → not signed in) or runs `security`
  (exit 44 → not signed in; other non-zero → `failed("Keychain access denied")`; stderr
  discarded; 30 s timeout).
- `requests.rs` — `request(provider, &Credential) -> (Url, Vec<(header, value)>)`, so URL
  and headers are testable without the network.
- `parsers.rs` — `parse(provider, &[u8]) -> Vec<QuotaWindow>`; lenient, skips what it
  cannot read.
- `outcome.rs` — `classify(provider, status, body, retry_after, now) -> QuotaOutcome`:

  | Input | Outcome |
  |---|---|
  | 200, ≥ 1 Window | `ok` |
  | 200, no Window | `failed("unreadable response")` |
  | 401; 403 other than OpenCode `EntitlementError` | `signInExpired` |
  | OpenCode 403 `EntitlementError` | `noSubscription` |
  | 429 | `rateLimited(now + Retry-After s)`, default 15 min, capped at 60 min |
  | other | `failed("HTTP <status>")` |
  | network error / timeout | `failed("network error")` |

HTTP uses `reqwest` (`default-features = false`, features `json`, `rustls-tls`), a client
with no cookie store. Logging: `quota <provider>: <outcome kind>` only — never a token,
never a body.

Command in `commands.rs`, registered in `lib.rs`:

```rust
#[tauri::command]
pub async fn quota_fetch(provider: Provider) -> Result<QuotaOutcome, AppError>
```

It never returns `Err` for Provider-side conditions; those are outcomes.

## Frontend

- `src/lib/ipc.ts`: `quotaFetch(provider)`; types in `src/lib/types.ts`.
- `src/quota/schedule.ts` (pure): `isDue(trigger, lastStarted, rateLimitedUntil, now)` with
  triggers `tick` (5 min since last start), `shown` (≥ 60 s since last start), `manual`
  (always); any trigger is refused while `now < rateLimitedUntil`.
- `src/quota/entry.ts` (pure): `QuotaEntry = loading | notSignedIn | ok(report) |
  problem(message, last?)` and `applying(entry, outcome)`: keeps the last good report
  through sign-in expired, rate limited and failed; drops it on no subscription.
  Messages: "sign-in expired — run claude|codex|opencode|grok", "no Go subscription",
  "rate limited", plus `failed` reasons.
- `src/quota/format.ts` (pure): percent (`19%`), time to reset (`4d`, `1d5h`, `1h36m`,
  `36m`, `<1m`, `reset pending`), `updated 23m ago`, and `tone(window, now)`:
  `muted` when the Window has no duration; `warn` when used ≥ 90% or used is ahead of the
  elapsed fraction of the Window; else `ok`.
- Store (`src/store/app.ts`): `quota: Record<Provider, { entry, lastStarted?, rateLimitedUntil?, inFlight }>`
  and `refreshQuota(trigger)`, which fetches every due Provider in parallel; a fetch in
  flight leaves the entry as it was.
- `src/dashboard/QuotaColumn.tsx`: while the dashboard is mounted, calls
  `refreshQuota("shown")` on mount and `refreshQuota("tick")` every 30 s; a `now` state
  ticking every second drives countdowns.

### The column

`<section className="dash-col dash-col-quota" role="region" aria-label="Quota">`, rendered
after the four bucket columns and outside search and filters. Its head shows `Quota` and a
refresh button (spinner while any Provider is in flight) in place of the count. One card
per Provider, always in the order Claude, Codex, OpenCode Go, Grok, so a missing row is
never read as "no limit":

```
[claude]  Claude
          5h     ▓▓░░░░  19% · 1h36m
          week   ▓▓▓░░░  28% · 4d
          week · Fable ▓░░  10% · 4d
[codex]   Codex
          week   ░░░░░░   0% · 6d
[grok]    Grok
          sign-in expired — run grok · updated 3h ago
          week   ▓▓▓▓▓▓ 100% · 2d     (dimmed)
```

- Icon from `AgentIcon` (`claude`, `codex`, `opencode`, `grok`), then the name.
- A Window row: label, a thin bar with a tick at the elapsed fraction, percent, time to
  reset. Bar colour from `tone`; at ≥ 90% the percent is bold.
- `notSignedIn`: "not signed in". `problem` with `last`: message and "updated … ago", then
  the last Windows at reduced opacity. `problem` without `last`: the message only.
  `loading`: the name only.
- Cards are not buttons; clicking does nothing.
- The board grid becomes five columns; the board already scrolls horizontally when narrow.

## Testing

- Rust `#[test]` in each module: parsers per Provider against the herdpet fixtures (Codex
  `null` secondary and odd durations, Claude fallback and scoped without display name,
  Grok without percent, clamping, fractional-second dates, bool-not-number); credentials
  per source (present, missing fields, malformed, Grok issuer preference); requests (URL,
  headers, optional headers omitted); every row of the classify table including
  Retry-After default and cap.
- Vitest: `schedule`, `entry`, `format`; `QuotaColumn` rendering each entry state with
  `quotaFetch` mocked; `AgentDashboard` shows the Quota region and search does not hide it.
- By hand in the running app: numbers match herdpet's card for all four Providers;
  renaming `~/.grok/auth.json` shows "not signed in" after a manual refresh; with the
  dashboard closed no `quota` log lines appear.

## Documentation

- `CONTEXT.md`: Provider, Quota, Window, Reset.
- ADR 0002: read Quota from Provider APIs with the CLIs' stored credentials, never
  refreshing them (ported from herdpet ADR 0005).
