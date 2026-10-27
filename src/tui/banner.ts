/**
 * What the screen opens on: a card, the way a terminal agent says hello — the mark on
 * the left, who you are talking to on the right, all of it inside one hairline.
 *
 * The mark is the block robot from the reference `llm/main.py` startup banner, drawn
 * in the lab's cobalt. The distressed-pixel logo the web app draws is still here behind
 * `AGENT_BANNER=logo`; `AGENT_BANNER=0` draws no picture at all.
 *
 * The card is assembled here so the screen never has to know how the mark is made.
 */
import { ink } from "./rows.ts";
import { bold, brand, dim, plain, row, rule, textOf, type Segment } from "./rows.ts";
import { LOGO_BLUE, logoRows } from "./logo.ts";

const GAP = 3;

/** Four lines, nine columns: the reference robot without its antenna row. */
const ROBOT = ["█████████", "█▄█████▄█", "█████████", "█ █   █ █"];

const LINE = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  bar: "─",
  side: "│",
};

function widthOf(parts: Segment[]): number {
  return [...textOf(parts)].length;
}

function pad(parts: Segment[], width: number): Segment[] {
  const length = widthOf(parts);
  return length >= width ? parts : [...parts, plain(" ".repeat(width - length))];
}

function markRows(width: number): Segment[][] {
  const choice = process.env.AGENT_BANNER;
  if (choice === "logo") return logoRows({ width: width - 8 });
  return ROBOT.map((line) => [ink(LOGO_BLUE, line)]);
}

/**
 * The card, or the plain greeting when the mark is switched off or the screen is too
 * narrow to hold the picture and the words side by side.
 */
export function welcomeBanner(width: number, model: string, workspace: string): Segment[][] {
  const greeting = row(brand("agent"), dim(" — full screen. /help lists the commands, @ hands over a file, Ctrl+C stops a run."));
  const words: Segment[][] = [
    row(bold("Welcome to agent!")),
    row(dim("/help lists the commands, @ hands over a file.")),
    row(dim("Model: "), plain(model)),
    row(dim("Dir: "), plain(workspace)),
  ];
  const mark = markRows(width);
  if (!mark.length) return [greeting];

  const markWidth = Math.max(...mark.map(widthOf));
  const wordsWidth = Math.max(...words.map(widthOf));
  const inner = 1 + markWidth + GAP + wordsWidth + 1;
  if (inner + 4 > width) {
    // Narrow screen: the picture above the words beats two boxes squeezed into a row.
    return [...mark, [], ...words, []];
  }

  const card: Segment[][] = [row(rule(`${LINE.topLeft}${LINE.bar.repeat(inner)}${LINE.topRight}`))];
  const body = Math.max(mark.length, words.length);
  for (let index = 0; index < body; index += 1) {
    const left = pad(mark[index] ?? [], markWidth);
    const right = pad(words[index] ?? [], wordsWidth);
    card.push(row(rule(LINE.side), plain(" "), left, plain(" ".repeat(GAP)), right, plain(" "), rule(LINE.side)));
  }
  card.push(row(rule(`${LINE.bottomLeft}${LINE.bar.repeat(inner)}${LINE.bottomRight}`)));
  // One blank row after the card, so the transcript never starts against the border.
  card.push([]);
  return card;
}
