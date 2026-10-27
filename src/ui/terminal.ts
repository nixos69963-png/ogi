/**
 * Terminal primitives, with no dependency.
 *
 * Colour is a convenience, never a requirement: everything degrades to plain text
 * when the stream is not a TTY or NO_COLOR is set, which is what makes piping the
 * agent into a file or a test readable.
 */
const enabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.AGENT_FORCE_COLOR === "1") return true;
  return Boolean(process.stdout.isTTY);
})();

function wrap(code: string, reset: string): (text: string) => string {
  return (text: string) => (enabled ? `\u001b[${code}m${text}\u001b[${reset}m` : text);
}

export const style = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  italic: wrap("3", "23"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  grey: wrap("90", "39"),
  inverse: wrap("7", "27"),
};

export function width(): number {
  return Math.max(40, Math.min(140, process.stdout.columns ?? 80));
}

/** The tab's name, plain text and nothing else. A terminal without tabs ignores it. */
export function setTitle(text: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\u001b]0;${text}\u0007`);
}

export function rule(label: string, color: (s: string) => string = style.grey): string {
  const head = ` ${label} `;
  const fill = "─".repeat(Math.max(0, width() - head.length - 2));
  return color(`─${head}${fill}`);
}

export function write(text: string): void {
  around(() => process.stdout.write(text));
}

export function line(text = ""): void {
  around(() => process.stdout.write(`${text}\n`));
}

/** Writing without the anchor: the prompt line and the picker draw themselves. */
export function raw(text: string): void {
  process.stdout.write(text);
}

/**
 * The bottom of the screen, from the terminal's point of view. Everything printed
 * with `write`/`line`/`status` lands *above* it, so the line you are typing stays
 * at the bottom instead of being scrolled away or overwritten mid-word.
 *
 * The ticking line is part of that block rather than a separate row: a redraw that
 * only knew about the prompt would print the timer over half-typed text.
 */
interface Anchor {
  hide(): void;
  show(): void;
}

let anchor: Anchor | null = null;
let liveRow = "";
/** Non-zero while a picker owns the bottom of the screen and the prompt stands down. */
let borrowed = 0;

export function setPromptAnchor(next: Anchor | null): void {
  anchor = next;
}

/** The ticking line, so the block under it can redraw it as its own first row. */
export function liveRowText(): string {
  return liveRow;
}

/** Silence the prompt block while a picker draws, and put it back afterwards. */
export function borrowScreen(): () => void {
  borrowed += 1;
  anchor?.hide();
  let given = false;
  return () => {
    if (given) return;
    given = true;
    borrowed = Math.max(0, borrowed - 1);
    if (borrowed === 0) anchor?.show();
  };
}

function around<T>(fn: () => T): T {
  if (!anchor || borrowed) return fn();
  anchor.hide();
  const value = fn();
  anchor.show();
  return value;
}

/** One short status line the REPL can overwrite; blank when not a TTY. */
export function status(text: string): void {
  if (!enabled) return;
  if (text === liveRow) return;
  liveRow = text;
  if (anchor && !borrowed) {
    // Redraw the whole block: the timer moves to just above the prompt instead of
    // stamping over whatever is on the row it happens to land on.
    anchor.hide();
    anchor.show();
    return;
  }
  if (borrowed) return;
  process.stdout.write(text ? `\r\u001b[K${style.dim(text.slice(0, width() - 1))}` : "\r\u001b[K");
}

/** Whether an in-place line is possible at all — a pipe gets nothing but the report. */
export function statusWritable(): boolean {
  return enabled;
}

