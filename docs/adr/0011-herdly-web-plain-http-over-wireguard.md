# 0011: Herdly Web serves plain HTTP over WireGuard, accepting that the WireGuard hub can read it

> Status: Accepted · Date: 2026-10-21

## Context

Herdly Web lets a phone type into the devbox's Agents, so who can reach it and who can read its
traffic matter. The phone reaches the devbox over an existing hub-and-spoke WireGuard network
(one peer, `198.51.100.7`, allowed IPs `192.0.2.0/24`); the hub decrypts each packet and
re-encrypts it towards the devbox. Tailscale is not installed. A secure context (HTTPS) is
needed only for a service worker, Web Push and the clipboard, none of which the MVP uses.

Source: [design spec](../superpowers/specs/2026-10-21-herdly-web-mobile-design.md).

## Decision

- Herdly Web speaks plain HTTP and WebSocket, bound only to the devbox's WireGuard address
  (`192.0.2.10`), never `0.0.0.0`.
- Access needs a Paired device cookie (one-time pairing link, revocable) and, for every POST
  and WebSocket upgrade, an `Origin` equal to Herdly Web's own.
- No TLS, no service worker. If a secure context is ever needed, the Chrome flag
  `unsafely-treat-insecure-origin-as-secure` for this origin is the user's chosen path.

This wins over a domain with a Let's Encrypt certificate and over a private CA on the phone
because it needs no domain, DNS token or certificate on the phone, and the MVP has no feature
that requires a secure context.

## Consequences

- The WireGuard hub's operator can read the traffic, including the pairing token, the cookie
  and Chat content, and could replay the cookie. Acceptable only while the hub is the user's
  own.
- Web Push (later work) needs a secure context: either the Chrome flag on the phone or a
  revisit of this ADR.
- The cookie cannot be `Secure`.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| Domain + Let's Encrypt (DNS-01), A record to `192.0.2.10` | Needs a domain and a DNS API token; more setup than the MVP needs. |
| Private CA (mkcert) installed on the phone | Certificate management on the phone for no MVP feature. |
| Tailscale `serve` (HTTPS + identity) | Not installed; would add a second overlay network next to WireGuard. |
| LAN only | Unreachable away from home. |
