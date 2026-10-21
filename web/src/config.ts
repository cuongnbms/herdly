export const PROMPT_POLL_MS = 1500;
export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 15000;
export const PENDING_STALE_MS = 30000;
export const CHAT_PAGE = 200;
export const SEEN_KEY = "herdly-web:seen";
export const COPIED_MS = 1500;
export const CTRL_C_CONFIRM_MS = 3000;
export const VIBRATE_MS = 200;
export const COMPOSER_MAX_ROWS = 6;
export const DRAFT_PREFIX = "herdly-web:draft:";

export const CHAT_AGENTS = ["claude", "pi"];

export function canChat(p: { agent: string | null }): boolean {
  return p.agent !== null && CHAT_AGENTS.includes(p.agent);
}

/** Vite `build.assetsInlineLimit`: never inline a font (the CSP's default-src 'self' blocks data: fonts). */
export function assetsInline(file: string): false | undefined {
  return file.endsWith(".woff2") ? false : undefined;
}
