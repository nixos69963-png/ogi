/**
 * Keys: one listener on stdin, one owner of the screen at a time.
 *
 * A prompt line and a picker both need every keystroke, and two `stdin.on("data")`
 * listeners would each see every byte and fight over the cursor. So there is one
 * listener, installed once, and it hands the decoded keys to whoever holds the
 * hub. A picker takes the hub for as long as the question is open and gives it
 * back; the prompt line picks up where it was.
 *
 * Decoding is ours because the escape sequences arrive whole or not at all: an
 * arrow is `ESC [ A`, and a lone `ESC` followed by nothing for a beat is the
 * Escape key. Everything else is one character.
 */
import { borrowScreen } from "./terminal.ts";

export type KeyName = "up" | "down" | "left" | "right" | "home" | "end" | "enter" | "escape" | "backspace" | "delete" | "tab" | "ctrl-c" | "ctrl-d" | "ctrl-u" | "ctrl-w" | "ctrl-l" | "char";

export interface Key {
  name: KeyName;
  /** The printable character, when there is one. */
  char?: string;
}

const SEQUENCES: Record<string, KeyName> = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[H": "home",
  "[F": "end",
  "[1~": "home",
  "[4~": "end",
  "[3~": "delete",
  "[2~": "home",
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
};

const CONTROL: Record<string, KeyName> = {
  "\u0003": "ctrl-c",
  "\u0004": "ctrl-d",
  "\u000c": "ctrl-l",
  "\u0015": "ctrl-u",
  "\u0017": "ctrl-w",
};

/** Turn one chunk of terminal input into whole keys. A partial escape is dropped, not guessed. */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const byte = chunk[i]!;
    if (byte === "\x1b") {
      const rest = chunk.slice(i + 1);
      // `ESC ` plus a CSI sequence, or `ESC O` for the application-cursor forms.
      const match = /^(\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/.exec(rest);
      if (match) {
        const seq = match[1] ?? "";
        const name = SEQUENCES[seq];
        if (name) keys.push({ name });
        i += 1 + seq.length;
        continue;
      }
      if (rest.length === 0) {
        keys.push({ name: "escape" });
        i += 1;
        continue;
      }
      // ESC followed by something we do not know: treat it as the Escape key and
      // let the rest decode as ordinary characters.
      keys.push({ name: "escape" });
      i += 1;
      continue;
    }
    const control = CONTROL[byte];
    if (control) {
      keys.push({ name: control });
      i += 1;
      continue;
    }
    if (byte === "\r" || byte === "\n") {
      keys.push({ name: "enter" });
      // Windows and some terminals send CRLF; swallow the pair as one Enter.
      i += chunk[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (byte === "\x7f" || byte === "\b") {
      keys.push({ name: "backspace" });
      i += 1;
      continue;
    }
    if (byte === "\t") {
      keys.push({ name: "tab" });
      i += 1;
      continue;
    }
    // A pasted line arrives as one chunk; the newline inside it is an Enter.
    if (byte === "\u0000") {
      i += 1;
      continue;
    }
    keys.push({ name: "char", char: byte });
    i += 1;
  }
  return keys;
}

export interface KeyHub {
  /** The standing owner of the keys — the prompt line. Null while nothing reads. */
  setResident(handler: ((key: Key) => void) | null): void;
  /**
   * Take the keys until the returned function is called: a picker uses this so the
   * prompt line underneath it is not left with a stale idea of what is on screen.
   * The bottom of the screen comes with the keys, and goes back with them.
   */
  take(handler: (key: Key) => void): () => void;
  /** Stop listening. Safe to call twice. */
  close(): void;
}

/** The part of a terminal stream this module needs — small enough for a test to fake. */
export interface KeyStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  setRawMode?(on: boolean): void;
  isTTY?: boolean;
  resume?(): void;
}

/**
 * Install the listener. `input` is injectable so a test can feed keys and read
 * what the handler saw, without a pty.
 */
export function createKeyHub(input: KeyStream = process.stdin as unknown as KeyStream): KeyHub {
  let resident: ((key: Key) => void) | null = null;
  let borrower: ((key: Key) => void) | null = null;
  let raw = false;
  let closed = false;

  const onData = (data: Buffer | string): void => {
    if (closed) return;
    if (!borrower && !resident) return;
    const text = typeof data === "string" ? data : data.toString("utf8");
    for (const key of decodeKeys(text)) {
      const now = borrower ?? resident;
      if (!now) return;
      now(key);
    }
  };

  if (typeof input.setRawMode === "function" && input.isTTY) {
    try {
      input.setRawMode(true);
      raw = true;
    } catch {
      raw = false;
    }
  }
  input.on("data", onData);
  input.resume?.();

  return {
    setResident(handler) {
      resident = handler;
    },
    take(handler) {
      const giveBackScreen = borrowScreen();
      borrower = handler;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        borrower = null;
        giveBackScreen();
      };
    },
    close() {
      if (closed) return;
      closed = true;
      resident = null;
      borrower = null;
      input.off("data", onData);
      if (raw && typeof input.setRawMode === "function") {
        try {
          input.setRawMode(false);
        } catch {
          /* the stream is already gone */
        }
      }
    },
  };
}

let shared: KeyHub | null = null;

/** One hub per process: two listeners on stdin would each see every keystroke. */
export function keyHub(input?: KeyStream): KeyHub {
  if (!shared) shared = createKeyHub(input ?? (process.stdin as unknown as KeyStream));
  return shared;
}

export function closeKeyHub(): void {
  shared?.close();
  shared = null;
}

/** Whether a keyboard picker can be shown at all, as opposed to reading a line. */
export function pickable(): boolean {
  return Boolean((process.stdin as unknown as KeyStream).isTTY) && Boolean(process.stdout.isTTY);
}
