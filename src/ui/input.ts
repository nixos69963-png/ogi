/**
 * The prompt line, with a palette.
 *
 * readline gives back a finished line and nothing else, which is why the slash
 * commands used to be a wall of text you had to remember. This owns the keystrokes
 * instead: typing `/` filters the command list under the prompt, arrows move
 * through it, Tab completes, Enter runs what is on the line. Up and down are
 * history when you are not choosing a command.
 *
 * Two rules keep it honest with the rest of the screen. The block it draws — the
 * ticking line, the prompt, the palette — is erased and redrawn whole, never
 * patched, so nothing that printed over it can leave debris. And it registers
 * itself as the terminal's prompt anchor: everything the run prints lands *above*
 * the block, which is what lets you type while a task is in flight without a
 * spinner stamping over half-typed text.
 */
import { keyHub, type Key } from "./keys.ts";
import { liveRowText, raw, setPromptAnchor, style, width } from "./terminal.ts";

/** How many commands fit under the prompt before you have to type to narrow it. */
const PALETTE_ROWS = 12;

export interface PaletteEntry {
  /** What you type, including the slash. */
  command: string;
  description: string;
}

export interface LineEditor {
  /** Resolves on Enter with the trimmed text; null means the session should end. */
  read(): Promise<string | null>;
  /** Get off the screen and stop taking keys. */
  stop(): void;
}

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

function visible(text: string): number {
  return text.replace(ANSI, "").length;
}

/** What `/` narrows the list to: every command, or the ones starting with the letters typed. */
export function paletteFilter(palette: PaletteEntry[], buffer: string): PaletteEntry[] {
  if (!buffer.startsWith("/")) return [];
  const needle = buffer.slice(1).trim().toLowerCase();
  if (!needle) return palette;
  return palette.filter((entry) => entry.command.slice(1).toLowerCase().startsWith(needle));
}

/**
 * The command list, as rows: the word you type in one column, what it does in the
 * next, and a cursor on the row Enter would run. Split out so a test can read the
 * palette without a terminal.
 */
export function paletteRows(list: PaletteEntry[], chosen: number, room: number): string[] {
  const slice = list.slice(0, PALETTE_ROWS);
  if (!slice.length) return [];
  const nameWidth = Math.min(22, Math.max(...slice.map((entry) => entry.command.length)) + 2);
  const out: string[] = [];
  for (const [i, entry] of slice.entries()) {
    const on = i === chosen;
    const cursor = on ? style.green("> ") : "  ";
    const name = on ? style.bold(entry.command.padEnd(nameWidth)) : entry.command.padEnd(nameWidth);
    out.push(`  ${cursor}${name}${style.dim(entry.description.slice(0, Math.max(10, room - nameWidth - 6)))}`);
  }
  const hidden = list.length - slice.length;
  const keys = hidden > 0 ? `↑↓ choose · Tab complete · Enter run · ${hidden} more · Esc hide` : "↑↓ choose · Tab complete · Enter run · Esc hide";
  out.push(`  ${style.dim(keys)}`);
  return out;
}

export function createLineEditor(
  options: { prompt?: string; palette?: PaletteEntry[]; onCtrlC?: () => void } = {},
): LineEditor {
  const prompt = options.prompt ?? style.green("› ");
  const palette = options.palette ?? [];
  const hub = keyHub();
  const history: string[] = [];
  let historyAt = -1;

  let buffer = "";
  let chosen = 0;
  let shown = false; // palette hidden until the first `/`
  let recalled = false; // the line is a history entry, not something typed
  let printed = 0;
  let promptRow = 0;
  let resolver: ((value: string | null) => void) | null = null;

  const matches = () => paletteFilter(palette, buffer);

  function rows(): string[] {
    const live = liveRowText();
    // The ticking line sits directly above the prompt, and both are part of one
    // redrawn block: two separate owners of adjacent rows is how a cursor lands
    // inside someone else's text.
    const out = live ? [live, `${prompt}${buffer}`] : [`${prompt}${buffer}`];
    promptRow = live ? 1 : 0;
    if (shown && !buffer.includes(" ")) out.push(...paletteRows(matches(), chosen, width()));
    return out;
  }

  const draw = () => {
    const lines = rows();
    if (printed > 0) raw(`\r\x1b[${printed}A`);
    raw("\x1b[J");
    raw(`${lines.join("\n")}\n`);
    printed = lines.length;
    // Back up to the prompt row, then one column past the text, so the caret is
    // where the operator is typing even with the palette open below it.
    const back = printed - 1 - promptRow;
    if (back > 0) raw(`\x1b[${back}A`);
    raw(`\r\x1b[${Math.min(visible(prompt) + buffer.length, width() - 1)}C`);
  };

  const erase = () => {
    if (printed > 0) raw(`\r\x1b[${printed}A`);
    raw("\x1b[J");
    printed = 0;
  };

  const submit = (text: string) => {
    const value = text.trim();
    if (value) history.unshift(value);
    if (history.length > 50) history.length = 50;
    historyAt = -1;
    buffer = "";
    shown = false;
    recalled = false;
    erase();
    // The line you typed stays on screen as what was said; the next read() puts a
    // fresh prompt under it.
    raw(`${prompt}${style.bold(value)}\n`);
    resolver?.(value);
    resolver = null;
  };

  const complete = () => {
    const list = matches();
    const entry = list[chosen] ?? list[0];
    if (!entry) return;
    buffer = `${entry.command} `;
    shown = false;
    recalled = false;
    draw();
  };

  const onKey = (key: Key) => {
    const list = matches();
    const listing = list.length > 0 && !buffer.includes(" ");
    if (key.name === "ctrl-c") {
      // The line is abandoned, whatever the caller does with the interrupt: a
      // half-typed task must not be sitting there when the prompt comes back.
      buffer = "";
      shown = false;
      chosen = 0;
      erase();
      options.onCtrlC?.();
      return;
    }
    if (key.name === "ctrl-d") {
      if (buffer) return;
      erase();
      resolver?.(null);
      resolver = null;
      return;
    }
    if (key.name === "ctrl-u") {
      buffer = "";
      shown = false;
    } else if (key.name === "escape") {
      if (shown) shown = false;
      else buffer = "";
    } else if (key.name === "backspace") {
      buffer = buffer.slice(0, -1);
      shown = buffer.startsWith("/");
      chosen = 0;
    } else if (key.name === "tab") {
      if (listing) complete();
    } else if (key.name === "up" || key.name === "down") {
      const delta = key.name === "up" ? -1 : 1;
      if (listing) {
        shown = true;
        chosen = (chosen + delta + list.length) % list.length;
      } else if (recalled || !buffer) {
        // Up means older, newest-first: the line the operator is writing sits one
        // step below the most recent task.
        historyAt = key.name === "up" ? Math.min(historyAt + 1, history.length - 1) : Math.max(historyAt - 1, -1);
        const entry = historyAt >= 0 ? (history[historyAt] ?? "") : "";
        buffer = entry;
        recalled = entry !== "";
        shown = buffer.startsWith("/");
        chosen = 0;
      }
    } else if (key.name === "enter") {
      if (listing && shown && buffer === "/") {
        // Enter on a bare `/` list runs the highlighted command, the way Tab completes it.
        buffer = list[chosen]?.command ?? "";
        submit(buffer);
        return;
      }
      submit(buffer);
      return;
    } else if (key.name === "char" && key.char) {
      buffer += key.char;
      shown = buffer.startsWith("/");
      historyAt = -1;
      chosen = 0;
    }
    draw();
  };

  return {
    read() {
      return new Promise<string | null>((resolve) => {
        resolver = resolve;
        buffer = "";
        shown = false;
        chosen = 0;
        hub.setResident(onKey);
        setPromptAnchor({ hide: erase, show: draw });
        draw();
      });
    },
    stop() {
      hub.setResident(null);
      setPromptAnchor(null);
      erase();
    },
  };
}
