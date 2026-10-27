/**
 * Keys and the one-owner hub, proved without a pty.
 *
 * The hub is the piece that decides who sees a keystroke, and getting that wrong
 * is how an arrow key ends up typed into a task or an approval answered by
 * whatever the operator was already writing. So the fake stream below is the whole
 * test rig: feed bytes, read decoded keys.
 */
import { describe, expect, it } from "bun:test";
import { createKeyHub, decodeKeys, type KeyStream } from "#ui/keys.ts";

function fakeStream(): KeyStream & { sends: (text: string) => void; modes: boolean[] } {
  const listeners: ((chunk: Buffer | string) => void)[] = [];
  const modes: boolean[] = [];
  return {
    isTTY: true,
    modes,
    on(_event, listener) {
      listeners.push(listener);
    },
    off(_event, listener) {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    setRawMode(on: boolean) {
      modes.push(on);
    },
    resume() {},
    sends(text) {
      for (const listener of [...listeners]) listener(text);
    },
  };
}

const names = (chunk: string): string[] => decodeKeys(chunk).map((key) => (key.name === "char" ? key.char! : key.name));

describe("decodeKeys", () => {
  it("reads plain characters one at a time", () => {
    expect(names("abc")).toEqual(["a", "b", "c"]);
  });

  it("reads the arrow sequences in both forms terminals send", () => {
    expect(names("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual(["up", "down", "right", "left"]);
    expect(names("\x1bOA")).toEqual(["up"]);
  });

  it("reads home, end and delete", () => {
    expect(names("\x1b[H\x1b[F\x1b[3~")).toEqual(["home", "end", "delete"]);
  });

  it("collapses the CRLF a Windows terminal sends into one Enter", () => {
    expect(names("a\r\nb")).toEqual(["a", "enter", "b"]);
  });

  it("reads the control keys that mean stop and erase", () => {
    expect(names("\x03\x04\x15\x7f\t")).toEqual(["ctrl-c", "ctrl-d", "ctrl-u", "backspace", "tab"]);
  });

  it("calls a lone escape an escape instead of waiting for a sequence", () => {
    expect(names("\x1b")).toEqual(["escape"]);
  });

  it("keeps a pasted task readable, newlines and all", () => {
    expect(names("line one\nline two")).toEqual(["l", "i", "n", "e", " ", "o", "n", "e", "enter", "l", "i", "n", "e", " ", "t", "w", "o"]);
  });

  it("reads a chunk split in the middle of an escape as escape plus characters", () => {
    expect(names("\x1b")).toEqual(["escape"]);
    expect(names("[A")).toEqual(["[", "A"]);
  });
});

describe("the key hub", () => {
  it("gives raw mode to the terminal once and takes it back on close", () => {
    const stream = fakeStream();
    const hub = createKeyHub(stream);
    expect(stream.modes).toEqual([true]);
    hub.close();
    expect(stream.modes).toEqual([true, false]);
    hub.close();
    expect(stream.modes.length, "closing twice must not turn raw mode off twice").toBe(2);
  });

  it("routes keys to the prompt line, to the picker while it holds them, and back", () => {
    const stream = fakeStream();
    const hub = createKeyHub(stream);
    const seen: string[] = [];
    hub.setResident((key) => seen.push(`line:${key.name}`));
    stream.sends("a");

    const release = hub.take((key) => seen.push(`pick:${key.name}`));
    stream.sends("\x1b[B");
    stream.sends("b");
    release();
    stream.sends("c");
    hub.setResident(null);
    stream.sends("d");

    expect(seen).toEqual(["line:char", "pick:down", "pick:char", "line:char"]);
  });

  it("hands the keys straight back when a picker closes mid-chunk", () => {
    const stream = fakeStream();
    const hub = createKeyHub(stream);
    const seen: string[] = [];
    let release = (): void => {};
    release = hub.take((key) => {
      seen.push(`pick:${key.name}`);
      if (key.name === "enter") release();
    });
    hub.setResident((key) => seen.push(`line:${key.name}`));
    stream.sends("\rx");
    expect(seen).toEqual(["pick:enter", "line:char"]);
  });

  it("ignores input entirely when nobody holds the keys", () => {
    const stream = fakeStream();
    const hub = createKeyHub(stream);
    let hits = 0;
    hub.setResident(() => {
      hits += 1;
    });
    hub.setResident(null);
    stream.sends("abc");
    expect(hits).toBe(0);
  });
});
