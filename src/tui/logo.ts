/**
 * The welcome mark: the lab logo rebuilt from squares, the way the web app draws it —
 * sample the bitmap onto a grid, keep the lit cells, drop a few of them at random so
 * the mark reads as distressed rather than printed.
 *
 * Why the decoder lives here: a terminal has no `<img>`, and this project is not going
 * to pull in an image library for one banner. A PNG at 8 bits, non-interlaced, is a
 * header, one zlib stream and five filter types — under a hundred lines. And a logo
 * that cannot be read is no banner, never a broken screen.
 *
 * The one thing the browser version gets to do that this cannot: square cells. A
 * terminal character is about twice as tall as it is wide, so a grid of characters is
 * a stretched logo. Half-blocks fix it — `▀`, `▄`, `█` stack two logo rows into one
 * text line, and each cell ends up as square as the web version's.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { ink, plain, row, type Segment } from "./rows.ts";

/** The cobalt from the web logo: every blue pixel in the mark is exactly this. */
export const LOGO_BLUE = "#2e5bff";
const SEED = 9;
/** A lit cell in twenty gives up, so the mark reads as worn without turning to static —
 *  a tenth is the web version's number, but its bars are three or four cells thick and
 *  ours are two. AGENT_BANNER_WEAR moves it. */
const WEAR = Number(process.env.AGENT_BANNER_WEAR ?? 0.05);
/** Below this the pixel is the dark behind the logo, not part of the mark. A cell
 *  that is only half covered is an edge, and edges are what turn a mark to noise. */
const MIN_ALPHA = 60;
const MIN_BRIGHT = 0.12;
/** A banner taller than this eats the screen the transcript needs. */
const MAX_LINES = 10;

interface Raster {
  width: number;
  height: number;
  /** row-major, 4 bytes per pixel */
  rgba: Uint8Array;
}

interface Cell {
  x: number;
  y: number;
  hex: string;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paeth(a: number, b: number, c: number): number {
  const p = b - c;
  const q = a - c;
  const r = a + b - c * 2;
  return p * p <= q * q && p * p <= r * r ? a : q * q <= r * r ? b : c;
}

/**
 * 8-bit PNG → RGBA. Only what a logo actually is: no interlace, no 16-bit, no
 * sub-blocks of a bigger image. Anything else returns null and the banner is skipped.
 */
export function decodePng(bytes: Buffer): Raster | null {
  if (bytes.length < 24) return null;
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return null;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let depth = 0;
  let interlace = 1;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let transparent: Buffer | null = null;

  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = at + 8;
    if (length < 0 || body + length + 4 > bytes.length) return null;
    if (type === "IHDR") {
      width = bytes.readUInt32BE(body);
      height = bytes.readUInt32BE(body + 4);
      depth = bytes[body + 8] ?? 0;
      colorType = bytes[body + 9] ?? -1;
      interlace = bytes[body + 12] ?? 1;
    } else if (type === "PLTE") palette = bytes.subarray(body, body + length);
    else if (type === "tRNS") transparent = bytes.subarray(body, body + length);
    else if (type === "IDAT") idat.push(bytes.subarray(body, body + length));
    else if (type === "IEND") break;
    at = body + length + 4;
  }

  if (!width || !height || depth !== 8 || interlace !== 0 || idat.length === 0) return null;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : colorType === 3 ? 1 : 0;
  if (!channels) return null;

  let scan: Buffer;
  try {
    scan = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = width * channels;
  const raw = Buffer.alloc(stride * height);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = scan[at++];
    if (filter === undefined || filter > 4) return null;
    const line = raw.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x += 1) {
      const value = scan[at++];
      if (value === undefined) return null;
      const a = x >= channels ? line[x - channels] ?? 0 : 0;
      const b = above ? above[x] ?? 0 : 0;
      const c = x >= channels && above ? above[x - channels] ?? 0 : 0;
      const back = filter === 0 ? value : filter === 1 ? value + a : filter === 2 ? value + b : filter === 3 ? value + ((a + b) >> 1) : value + paeth(a, b, c);
      line[x] = back & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  const band = (pixel: number, channel: number): number => raw[pixel * channels + channel] ?? 0;
  for (let i = 0; i < width * height; i += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    if (colorType === 6) {
      r = band(i, 0);
      g = band(i, 1);
      b = band(i, 2);
      a = band(i, 3);
    } else if (colorType === 2) {
      r = band(i, 0);
      g = band(i, 1);
      b = band(i, 2);
    } else if (colorType === 0) {
      r = g = b = band(i, 0);
    } else if (colorType === 4) {
      r = g = b = band(i, 0);
      a = band(i, 1);
    } else {
      const index = band(i, 0);
      if (!palette || index * 3 + 2 >= palette.length) return null;
      r = palette[index * 3] ?? 0;
      g = palette[index * 3 + 1] ?? 0;
      b = palette[index * 3 + 2] ?? 0;
      a = transparent?.[index] ?? 255;
    }
    const out = i * 4;
    rgba[out] = r;
    rgba[out + 1] = g;
    rgba[out + 2] = b;
    rgba[out + 3] = a;
  }
  return { width, height, rgba };
}

/**
 * The bitmap onto a `cols`-wide grid. Colour is averaged the way a canvas does it —
 * weighted by alpha — so a soft edge over transparent does not come out as a pale
 * block, and the same seed with the same grid drops the same cells every run.
 */
export function sampleLogo(img: Raster, cols: number, seed = SEED): { rows: number; cells: Cell[] } {
  const rows = Math.max(6, Math.min(MAX_LINES * 2, Math.round((cols * img.height) / img.width)));
  const rand = mulberry32(seed);
  const cells: Cell[] = [];
  for (let y = 0; y < rows; y += 1) {
    const y0 = Math.floor((y * img.height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / rows));
    for (let x = 0; x < cols; x += 1) {
      const x0 = Math.floor((x * img.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / cols));
      let alpha = 0;
      let sumA = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let seen = 0;
      for (let py = y0; py < y1 && py < img.height; py += 1) {
        for (let px = x0; px < x1 && px < img.width; px += 1) {
          const at = (py * img.width + px) * 4;
          const a = img.rgba[at + 3] ?? 0;
          const weight = a / 255;
          alpha += a;
          sumA += weight;
          sr += (img.rgba[at] ?? 0) * weight;
          sg += (img.rgba[at + 1] ?? 0) * weight;
          sb += (img.rgba[at + 2] ?? 0) * weight;
          seen += 1;
        }
      }
      if (!seen) continue;
      const meanAlpha = alpha / seen;
      if (meanAlpha < MIN_ALPHA) continue;
      const r = sumA ? sr / sumA : 0;
      const g = sumA ? sg / sumA : 0;
      const b = sumA ? sb / sumA : 0;
      const bright = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      if (bright < MIN_BRIGHT) continue;
      if (rand() < WEAR) continue;
      const blue = b > r + 25 && b > g + 10;
      // The browser paints a lit-but-not-blue pixel as white at an alpha; on a dark
      // screen that is the same as a grey, so the alpha is folded into the value.
      const grey = Math.round(240 * (0.45 + bright * 0.55));
      const hex = blue ? LOGO_BLUE : `#${grey.toString(16).padStart(2, "0").repeat(3)}`;
      cells.push({ x, y, hex });
    }
  }
  return { rows, cells };
}

function logoFile(): string {
  const override = process.env.AGENT_LOGO?.trim();
  if (override) return override;
  return path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "assets", "logo.png");
}

let cached: { file: string; image: Raster | null } | null = null;

function loadLogo(): Raster | null {
  const file = logoFile();
  if (cached?.file === file) return cached.image;
  let image: Raster | null = null;
  try {
    image = decodePng(Buffer.from(readFileSync(file)));
  } catch {
    image = null;
  }
  cached = { file, image };
  return image;
}

/** How many columns fit: one character each, a margin so the row never wraps, and
 *  never more than the line budget can hold at this mark's near-square ratio. */
export function logoColumns(width: number): number {
  const wanted = Math.min(MAX_LINES * 2, Math.max(12, width - 6));
  const forced = Number(process.env.AGENT_BANNER_COLS);
  return Number.isFinite(forced) && forced >= 4 && forced <= 60 ? Math.trunc(forced) : wanted;
}

/** Two cells, one character: the pair of halves that shows both. */
function stack(top: string | undefined, bottom: string | undefined): { char: string; hex: string } | null {
  if (!top && !bottom) return null;
  // One of them cobalt, the other a worn grey: the mark is the blue, so the blue wins.
  const hex = top === bottom ? top ?? bottom! : top === LOGO_BLUE || bottom === LOGO_BLUE ? LOGO_BLUE : (top ?? bottom)!;
  return { char: top && bottom ? "█" : top ? "▀" : "▄", hex };
}

/**
 * The mark as transcript rows, or nothing at all when it is switched off
 * (`AGENT_BANNER=0`) or the logo cannot be read.
 */
export function logoRows(options: { width?: number; cols?: number } = {}): Segment[][] {
  if (process.env.AGENT_BANNER === "0") return [];
  const image = loadLogo();
  if (!image) return [];
  const cols = options.cols ?? logoColumns(options.width ?? 80);
  const { rows, cells } = sampleLogo(image, cols);
  const grid = new Map<string, string>();
  for (const cell of cells) grid.set(`${cell.x},${cell.y}`, cell.hex);
  const out: Segment[][] = [];
  for (let line = 0; line * 2 < rows; line += 1) {
    const parts: Segment[] = [];
    for (let x = 0; x < cols; x += 1) {
      const pair = stack(grid.get(`${x},${line * 2}`), grid.get(`${x},${line * 2 + 1}`));
      parts.push(pair ? ink(pair.hex, pair.char) : plain(" "));
    }
    out.push(row(...parts));
  }
  return out;
}
