/**
 * What the model wrote, as the model meant it.
 *
 * A run's report arrives as markdown: `### Key Changes:`, `**done**`, `- first`.
 * Printed raw — which is what a stream of characters does — the operator reads
 * punctuation instead of the answer, and that is the part of the screen that makes
 * it look like a log rather than a reply.
 *
 * So a line is *classified*, then its inline marks are turned into ink. Deliberately
 * small: headings, emphasis, inline code, links, lists with checkboxes, quotes, rules
 * and fenced code. Anything it does not recognise is printed exactly as written,
 * because a renderer that eats unknown input is how a report silently loses a number.
 */
import { bold, cyan, dim, plain, row, rule, type Segment } from "./rows.ts";

/** One blank row, or nothing at all — the caller decides how many blanks to keep. */
const BLANK: Segment[] = [];

const SPAN =
  /(?<strong>\*\*[^*]+\*\*|__[^_]+__)|(?<strike>~~[^~]+~~)|(?<code>`[^`]+`)|(?<link>\[[^\]]+\]\([^)]*\))|(?<em>\*[^*\s][^*]*\*)|(?<ital>_[^_\s][^_]*)_/g;

/** Inline marks become tones; the text between them is left exactly as written. */
export function inline(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  SPAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPAN.exec(text))) {
    if (match.index > last) out.push(plain(text.slice(last, match.index)));
    const raw = match[0];
    const groups = match.groups ?? {};
    if (groups.strong) out.push(bold(raw.slice(2, -2)));
    else if (groups.strike) out.push(dim(raw.slice(2, -2)));
    else if (groups.code) out.push(cyan(raw.slice(1, -1)));
    else if (groups.link) {
      const parts = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(raw);
      out.push(plain(parts?.[1] ?? raw));
      if (parts?.[2]) out.push(dim(` (${parts[2]})`));
    } else if (groups.em || groups.ital) out.push(plain(raw.slice(1, -1)));
    last = match.index + raw.length;
  }
  if (last < text.length) out.push(plain(text.slice(last)));
  return out;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.+)$/;
const NUMBERED = /^(\s*)(\d{1,3})[.)]\s+(.+)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LINE_RULE = /^\s*(?:[-*_]\s*){3,}$/;

const CHECKED = /^\[x\]\s+(.*)$/i;
const UNCHECKED = /^\[\s?\]\s+(.*)$/;

/** A list item's own lead-in, with any task box folded into the bullet. */
function bulletFor(raw: string): { mark: string; rest: string } {
  const checked = CHECKED.exec(raw);
  if (checked) return { mark: "☑ ", rest: checked[1] ?? "" };
  const unchecked = UNCHECKED.exec(raw);
  if (unchecked) return { mark: "☐ ", rest: unchecked[1] ?? "" };
  return { mark: "• ", rest: raw };
}

export interface Markdown {
  /** Rows for one source line. An empty array is a blank row; a line never yields more than one. */
  row(line: string): Segment[];
  /** Whether a fence is still open — the caller ends the block on it if the run did not. */
  insideFence(): boolean;
}

/**
 * A line-at-a-time renderer, because a model streams: the state that matters is
 * whether a code fence is still open when the next chunk lands.
 */
export function createMarkdown(): Markdown {
  let fence = false;
  return {
    insideFence: () => fence,
    row(line: string): Segment[] {
      if (FENCE.test(line)) {
        fence = !fence;
        return BLANK;
      }
      if (fence) return row(dim("    "), plain(line));

      const heading = HEADING.exec(line);
      if (heading) return row(bold(inline(heading[2] ?? "").map((part) => part.text).join("")));

      if (LINE_RULE.test(line)) return row(rule("─".repeat(24)));

      const quote = QUOTE.exec(line);
      if (quote) return row(dim("│ "), ...inline(quote[1] ?? ""));

      const numbered = NUMBERED.exec(line);
      if (numbered) {
        const [, indent = "", number = "", rest = ""] = numbered;
        return row(dim(`${indent}${number}. `), ...inline(rest));
      }

      const bullet = BULLET.exec(line);
      if (bullet) {
        const [, indent = "", rest = ""] = bullet;
        const { mark, rest: text } = bulletFor(rest);
        return row(dim(indent + mark), ...inline(text));
      }

      return row(...inline(line));
    },
  };
}

/** One whole block at a time: for the final report and anything not streamed. */
export function markdownRows(text: string): Segment[][] {
  const md = createMarkdown();
  const out: Segment[][] = [];
  for (const line of text.split("\n")) out.push(md.row(line));
  return out;
}
