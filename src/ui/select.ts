/**
 * A question with buttons.
 *
 * Typing `y` at a prompt is fine; being shown the three answers and moving a
 * cursor between them is better, because the operator reads the options instead
 * of remembering the key map. This is the picker behind an approval and behind
 * the agent's own `request_input` question.
 *
 * It draws the block, waits for keys through the shared hub, and redraws in
 * place — so the screen never scrolls while a choice is being made. When stdin
 * is not a terminal (a pipe, a script, `agent do`) the hub says so and the
 * caller falls back to reading a line, which is what a scripted run expects.
 */
import { keyHub, pickable } from "./keys.ts";
import { raw, style, width } from "./terminal.ts";

export interface Choice<T = string> {
  label: string;
  /** Shown indented under the label, if present. */
  detail?: string;
  value: T;
}

export interface PickRequest<T = string> {
  /** The heading, e.g. `Bash command` or the agent's question. */
  title: string;
  /** Facts the operator needs before answering: the command, the file, the reason. */
  body?: string[];
  /** The line above the list. Defaults to "Choose one". */
  question?: string;
  choices: Choice<T>[];
  /** Adds a "Type something." row and accepts free text as the answer. */
  allowType?: boolean;
  /** The label of the typed row. */
  typeLabel?: string;
  /** Keys other than the defaults, e.g. `a` to approve every write this run. */
  footer?: string;
}

export interface PickAnswer<T = string> {
  value: T;
  label: string;
  /** Set when the answer was typed rather than picked. */
  typed?: string;
  index: number;
}

const DEFAULT_FOOTER = "↑↓ move · Enter select · Esc cancel";

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Where the cursor is, and what has been typed if the answer is free text. */
export interface PickState {
  index: number;
  typing: boolean;
  typed: string;
}

/**
 * The block, as rows. Separate from the drawing so a test can read what an
 * operator would see — the numbering, which row has the cursor, the typed row and
 * the key map — without a terminal.
 */
export function pickRows(request: PickRequest<unknown>, state: PickState): string[] {
  const out: string[] = [`${style.yellow("!")} ${style.bold(request.title)}`];
  for (const body of request.body ?? []) out.push(`  ${style.dim(body)}`);
  out.push("");
  out.push(`  ${request.question ?? "Choose one"}`);
  request.choices.forEach((choice, i) => {
    const on = i === state.index && !state.typing;
    const cursor = on ? style.green("> ") : "  ";
    const label = on ? style.bold(choice.label) : choice.label;
    out.push(`  ${cursor}${style.dim(`${i + 1}.`)} ${label}`);
    if (choice.detail) out.push(`      ${style.dim(choice.detail)}`);
  });
  if (request.allowType) {
    const on = state.index === request.choices.length || state.typing;
    const cursor = on ? style.green("> ") : "  ";
    const text = state.typing ? `${request.typeLabel ?? "Type something."} ${style.green(state.typed)}` : style.dim(request.typeLabel ?? "Type something.");
    out.push(`  ${cursor}${style.dim(`${request.choices.length + 1}.`)} ${text}`);
  }
  out.push("");
  out.push(`  ${style.dim(request.footer ?? DEFAULT_FOOTER)}`);
  return out.map((row) => clip(row, Math.max(40, width())));
}

/**
 * Ask, wait, resolve. `null` means cancelled — Esc or Ctrl+C — which the caller
 * must treat as "no", never as "yes".
 */
export function choose<T = string>(request: PickRequest<T>): Promise<PickAnswer<T> | null> {
  const hub = keyHub();
  if (!pickable()) return Promise.resolve(null);

  return new Promise<PickAnswer<T> | null>((resolve) => {
    const rows = request.choices.length + (request.allowType ? 1 : 0);
    const state: PickState = { index: 0, typing: false, typed: "" };
    let printed = 0;
    let done = false;

    const finish = (answer: PickAnswer<T> | null) => {
      if (done) return;
      done = true;
      // Erase the block while it still owns those rows, print the answer that
      // replaced it, then hand the bottom of the screen back — so the prompt
      // redraws *under* the answer instead of over it.
      if (printed > 0) raw(`\r\x1b[${printed}A\x1b[J`);
      raw(`${style.dim(`  → ${answer ? answer.label : "cancelled"}`)}\n`);
      release();
      resolve(answer);
    };

    const draw = () => {
      const lines = pickRows(request, state);
      if (printed > 0) raw(`\r\x1b[${printed}A`);
      raw("\x1b[J");
      raw(`${lines.join("\n")}\n`);
      printed = lines.length;
    };

    const answerAt = (i: number): PickAnswer<T> | null => {
      const choice = request.choices[i];
      if (!choice) return null;
      return { value: choice.value, label: choice.label, index: i };
    };

    const release = hub.take((key) => {
      if (key.name === "up" || key.name === "down") {
        state.typing = false;
        const delta = key.name === "up" ? -1 : 1;
        state.index = (state.index + delta + rows) % rows;
      } else if (key.name === "escape" || key.name === "ctrl-c") {
        finish(null);
        return;
      } else if (key.name === "enter") {
        if (state.typing || state.index === request.choices.length) {
          // Enter on the typed row with nothing typed is a cancel, not an empty answer.
          const text = state.typed.trim();
          finish(text ? { value: text as unknown as T, label: text, typed: text, index: state.index } : null);
          return;
        }
        finish(answerAt(state.index) ?? null);
        return;
      } else if (key.name === "backspace") {
        state.typed = state.typed.slice(0, -1);
      } else if (key.name === "char" && key.char) {
        const digit = Number(key.char);
        if (!state.typing && Number.isInteger(digit) && digit >= 1 && digit <= rows) {
          if (digit === request.choices.length + 1 && request.allowType) {
            state.typing = true;
            state.index = digit - 1;
          } else {
            finish(answerAt(digit - 1) ?? null);
            return;
          }
        } else {
          state.typing = true;
          state.index = request.choices.length;
          state.typed += key.char;
        }
      }
      draw();
    });
    draw();
  });
}
