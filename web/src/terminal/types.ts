/** The character grid the browser asks the terminal to be. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

/** A text event the server sends, or one the transport reports locally. */
export type TerminalEvent =
  | { type: "attached" }
  | { type: "held" }
  | { type: "exited"; code: number | null }
  | { type: "detached" }
  | { type: "error"; error: { code: string; message: string } }
  | { type: "connecting" }
  | { type: "disconnected" }
  | { type: "unpaired" };
