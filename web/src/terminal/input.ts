/**
 * The one place user-typed text becomes terminal input.
 *
 * xterm reports user typing and terminal-generated protocol replies (DA, DSR, focus, mouse,
 * colour queries) through the same `onData` event, so Ctrl cannot be applied there without
 * transforming a reply. The lens therefore maps only text it knows a human produced.
 */

/**
 * Ctrl accelerators: ASCII `@`..`_` (case-insensitive letters) and `?` for DEL.
 *
 * The input range is checked before any case conversion: `toUpperCase()` is a Unicode case fold
 * ("ß"→"SS", "ı"→"I", "ſ"→"S"), so folding first would turn non-ASCII text into a control
 * byte. Only ASCII letters are folded, and only after they pass the range test.
 */
export function controlCharacter(text: string): string | null {
  if (text.length !== 1) return null;
  if (text === "?") return "\x7f";
  const code = text.charCodeAt(0);
  if (code < 0x20 || code > 0x7f) return null;
  const ascii = code >= 0x61 && code <= 0x7a ? code - 0x20 : code; // a..z → A..Z
  if (ascii < 0x40 || ascii > 0x5f) return null;
  return String.fromCharCode(ascii - 0x40);
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
