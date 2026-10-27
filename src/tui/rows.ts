/**
 * Transcript rows as data, not as escape codes.
 *
 * The line UI paints colour into the stream (`\x1b[32m…`). A full-screen renderer
 * cannot do that: it lays rows out in boxes that wrap, scroll and resize, so it has
 * to know *which characters are green* after the layout, not before. A row is
 * therefore a list of toned pieces and `paint()` is the only place OpenTUI appears.
 *
 * The tones are named for their job, not for an ANSI colour, and `paint()` is the
 * only place that knows what each one looks like.
 */
import { RGBA, StyledText, bold as chunkBold, type TextChunk } from "@opentui/core";

export type Tone =
  | "plain"
  | "dim"
  | "bold"
  | "grey"
  | "rule"
  | "brand"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan";

export interface Segment {
  tone: Tone;
  text: string;
  /** Ground under this piece only: a chip, or the band behind a line you typed. */
  fill?: { bg: string; fg?: string };
  /** Ink over this piece only, for a colour that is not one of the tones: the logo's cobalt. */
  fg?: string;
}

/**
 * Ink, not ANSI names. The screen the operator asked for paints flat dark rows and
 * uses colour only for emphasis, so every tone carries an explicit value instead of
 * borrowing whatever the terminal calls green.
 */
const INK: Record<Exclude<Tone, "plain" | "bold">, string> = {
  /** secondary text, the colour of almost everything quiet */
  dim: "#999999",
  grey: "#7f7f7f",
  /** the hairline rules that separate one part of the screen from the next */
  rule: "#4d4d4d",
  /** the one warm mark on the screen: the wordmark and the bullets */
  brand: "#d77757",
  red: "#ff6b80",
  green: "#4eba65",
  yellow: "#e5c07b",
  /** the pointer, the caret, the choice the keyboard is on */
  blue: "#b1b9f9",
  magenta: "#af87ff",
  cyan: "#48968c",
};

/** The ground under a chip: the pointer colour, with dark ink on top of it. */
const CHIP = { bg: INK.blue, fg: "#1a1a1a" };
/** The ground behind a line the operator typed. */
const BAND = { bg: "#2e2e2e" };
/** The ground under a changed line. A patch is the one place this screen paints blocks. */
const ADDED = { bg: "#225c2b" };
const REMOVED = { bg: "#7a2936" };

function inked(hex: string): (text: string) => TextChunk {
  const fg = RGBA.fromHex(hex);
  return (text) => ({ __isChunk: true, text, fg });
}

const CHUNK: Record<Tone, (text: string) => TextChunk> = {
  plain: (text) => ({ __isChunk: true, text }),
  bold: chunkBold,
  dim: inked(INK.dim),
  grey: inked(INK.grey),
  rule: inked(INK.rule),
  brand: inked(INK.brand),
  red: inked(INK.red),
  green: inked(INK.green),
  yellow: inked(INK.yellow),
  blue: inked(INK.blue),
  magenta: inked(INK.magenta),
  cyan: inked(INK.cyan),
};

function seg(tone: Tone, text: string): Segment {
  return { tone, text };
}

/** A word on a filled lavender ground — the reference screen's only block of colour. */
export function chip(text: string): Segment {
  return { ...seg("plain", text), fill: CHIP };
}

/** A line the operator typed, set on a grey band so it reads as theirs, not the agent's. */
export function band(text: string, tone: Tone = "bold"): Segment {
  return { ...seg(tone, text), fill: BAND };
}

/** A line the patch adds, and a line it takes away — ink on the ground that says which. */
export const addedLine = (text: string): Segment => ({ ...seg("green", text), fill: ADDED });
export const removedLine = (text: string): Segment => ({ ...seg("red", text), fill: REMOVED });

export const plain = (text: string): Segment => seg("plain", text);
export const dim = (text: string): Segment => seg("dim", text);
export const bold = (text: string): Segment => seg("bold", text);
export const grey = (text: string): Segment => seg("grey", text);
export const rule = (text: string): Segment => seg("rule", text);
export const brand = (text: string): Segment => seg("brand", text);
export const red = (text: string): Segment => seg("red", text);
export const green = (text: string): Segment => seg("green", text);
export const yellow = (text: string): Segment => seg("yellow", text);
export const blue = (text: string): Segment => seg("blue", text);
export const magenta = (text: string): Segment => seg("magenta", text);
export const cyan = (text: string): Segment => seg("cyan", text);

/** A piece in a colour of its own. Only the logo reaches for this one. */
export const ink = (hex: string, text: string): Segment => ({ ...seg("plain", text), fg: hex });

/** A row from pieces; empty text drops and nested rows splice in, so a caller can
 *  pass a conditional segment or a whole sub-row without thinking about which. */
export function row(...parts: (Segment | Segment[] | null | undefined)[]): Segment[] {
  const out: Segment[] = [];
  const add = (part: Segment): void => {
    if (!part.text) return;
    const last = out[out.length - 1];
    // Only merge pieces that look identical: a filled piece never joins its neighbour.
    if (last && last.tone === part.tone && last.fg === part.fg && !last.fill && !part.fill) last.text += part.text;
    else out.push({ ...part });
  };
  for (const part of parts) {
    if (!part) continue;
    if (Array.isArray(part)) for (const nested of part) add(nested);
    else add(part);
  }
  return out;
}

/** Collapse adjacent same-tone pieces and turn a row into what OpenTUI draws. */
export function paint(parts: Segment[]): StyledText {
  return new StyledText(
    parts.map((part) => {
      const chunk = CHUNK[part.tone](part.text);
      if (part.fg) chunk.fg = RGBA.fromHex(part.fg);
      if (part.fill) {
        chunk.bg = RGBA.fromHex(part.fill.bg);
        if (part.fill.fg) chunk.fg = RGBA.fromHex(part.fill.fg);
      }
      return chunk;
    }),
  );
}

/** The same row as the text it shows — for tests, and for copying out of a frame. */
export function textOf(parts: Segment[]): string {
  return parts.map((part) => part.text).join("");
}

/** One line, no newlines, cut with an ellipsis: a row in a box must stay in its box. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

/** The plainest possible row: one tone for the whole line. */
export function simple(text: string, tone: Tone = "plain"): Segment[] {
  return text ? [{ tone, text }] : [];
}
