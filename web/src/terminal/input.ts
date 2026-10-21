/**
 * The one place user-typed text becomes terminal input.
 *
 * xterm reports user typing and terminal-generated protocol replies (DA, DSR, focus, mouse,
 * colour queries) through the same `onData` event, so Ctrl cannot be applied there without
 * transforming a reply. The lens therefore maps only text it knows a human produced.
 */

/** Ctrl accelerators: ASCII `@`..`_` (case-insensitive letters) and `?` for DEL. */
export function controlCharacter(text: string): string | null {
  if (text.length !== 1) return null;
  if (text === "?") return "\x7f";
  const code = text.toUpperCase().charCodeAt(0);
  if (code < 0x40 || code > 0x5f) return null;
  return String.fromCharCode(code - 0x40);
}

export type CursorDirection = "up" | "down" | "left" | "right";

const CURSOR: Record<CursorDirection, string> = { up: "A", down: "B", right: "C", left: "D" };

/** Arrow encoding for the terminal's current cursor-key mode (DECCKM). */
export function cursorKey(direction: CursorDirection, application: boolean): string {
  return `\x1b${application ? "O" : "["}${CURSOR[direction]}`;
}

/**
 * One-shot Ctrl state for user entry. The next user-originated text passes through
 * {@link controlCharacter}; unsupported text is sent unchanged. Both paths clear Ctrl.
 * Terminal replies never come through here.
 */
export class UserEntry {
  private armed = false;

  get ctrl(): boolean {
    return this.armed;
  }

  arm(): void {
    this.armed = true;
  }

  /** Drops a pending Ctrl: blur, disconnect, Lens change. */
  clear(): void {
    this.armed = false;
  }

  /** Maps one user entry and consumes Ctrl if it was armed. */
  apply(text: string): string {
    if (!this.armed) return text;
    this.armed = false;
    return controlCharacter(text) ?? text;
  }
}
