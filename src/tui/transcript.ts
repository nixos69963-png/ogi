/**
 * Agent events → transcript rows.
 *
 * The shape the reference screen uses, expressed as data so a full-screen renderer
 * can put it in a scrolling box:
 *
 *   ● Update(web/src/pages/ProjectPage.tsx)
 *     ⎿  ✓ 0.2s · +3 −1 · 91 chars
 *       86          <h1>{project.name}</h1>
 *      89 -         <h1>{project.title}</h1>
 *      89 +         <h1>{project.name}</h1>
 *
 * A call is a green bullet and a bold white name; whatever it produced hangs under
 * it on a `⎿` connector in the quiet colour, and a block is separated from the one
 * before it, because four calls stacked flush read as one wall of text. The verb
 * table comes from `src/ui/render.ts`, so the two UIs cannot describe the same call
 * two different ways — only the colours differ, and those are the screen's to choose.
 */
import type { AgentEvent } from "#core/types.ts";
import type { DiffRow } from "#ui/diff.ts";
import { subjectOf, verbFor, restCount } from "#ui/render.ts";
import { bold, dim, green, grey, magenta, plain, red, row, yellow, type Segment, type Tone } from "./rows.ts";
import { createMarkdown } from "./markdown.ts";
import { patchRows } from "./patch.ts";

export interface TranscriptHooks {
  row(parts: Segment[]): void;
  status(text: string): void;
  /** One blank row here, so a new block does not start flush against the last one. */
  gap?(): void;
}

export interface Transcript {
  push(event: AgentEvent): void;
  /** The run ended mid-sentence; whatever is buffered becomes a row. */
  finish(): void;
  /** Whether the model said anything the operator has already read. */
  sawText(): boolean;
}

function seg(tone: Tone, text: string): Segment {
  return { tone, text };
}

function flat(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function createTranscript(hooks: TranscriptHooks, options: { showThinking?: boolean } = {}): Transcript {
  const md = createMarkdown();
  let plan: string[] = [];
  let pending = "";
  let sawText = false;
  let hideResult = false;
  /** Whether the model's prose is on screen right now — a block, not a stream. */
  let proseOpen = false;

  const emitTextLine = (line: string): void => {
    if (!proseOpen) {
      hooks.gap?.();
      proseOpen = true;
    }
    hooks.row(md.row(line.replace(/\r$/, "")));
  };

  const flushText = (): void => {
    if (!pending) return;
    emitTextLine(pending);
    pending = "";
  };

  const closeText = (): void => {
    flushText();
    proseOpen = false;
    hooks.status("");
  };

  const push = (event: AgentEvent): void => {
    switch (event.type) {
      case "thinking": {
        // The reasoning text is the model's draft, not its report: opt-in, and one line.
        const draft = options.showThinking === true && event.text ? ` ${flat(event.text, 48)}` : "";
        hooks.status(`thinking${draft}`);
        break;
      }
      case "assistant": {
        if (!event.text) break;
        sawText = true;
        hooks.status("");
        pending += event.text;
        for (;;) {
          const cut = pending.indexOf("\n");
          if (cut === -1) break;
          emitTextLine(pending.slice(0, cut));
          pending = pending.slice(cut + 1);
        }
        break;
      }
      case "plan": {
        closeText();
        plan = event.steps;
        hooks.gap?.();
        hooks.row(row(bold("plan"), dim(` ${event.steps.length} steps`)));
        for (const [index, step] of event.steps.entries()) hooks.row(row(dim(`  ${index + 1}. `), plain(step)));
        break;
      }
      case "tool-call": {
        closeText();
        // `finish` is not an action: its text is the report, printed once by the caller.
        if (event.name === "finish") {
          hideResult = true;
          break;
        }
        const verb = verbFor(event.name);
        const subject = subjectOf(event.args, verb);
        const rest = restCount(event.args, verb);
        hooks.gap?.();
        hooks.row(
          row(
            green("● "),
            bold(`${verb.label}(${subject || "…"})`),
            rest > 0 ? dim(` +${rest}`) : null,
          ),
        );
        hooks.status(`${verb.label.toLowerCase()}${subject ? ` ${flat(subject, 40)}` : ""}`);
        break;
      }
      case "tool-result": {
        if (hideResult) {
          hideResult = false;
          break;
        }
        const data = (event.data ?? {}) as Record<string, unknown>;
        const diff = Array.isArray(data.diff) ? (data.diff as DiffRow[]) : [];
        const added = Number(data.added ?? 0);
        const removed = Number(data.removed ?? 0);
        const bits: Segment[] = [dim(`${(event.ms / 1000).toFixed(1)}s`)];
        if (event.ok && (data.added !== undefined || data.removed !== undefined)) {
          bits.push(dim(" · "), green(`+${added}`), plain(" "), red(`−${removed}`));
        }
        if (event.ok) bits.push(dim(` · ${event.chars} chars`));
        hooks.row(row(dim("  ⎿  "), event.ok ? green("✓") : red("✗"), plain(" "), ...bits, event.error ? seg("red", ` ${flat(event.error, 60)}`) : null));
        if (diff.length) for (const parts of patchRows(diff, "unified", 0, "  ")) hooks.row(parts);
        hooks.status("thinking");
        break;
      }
      case "approval": {
        // The overlay is the only thing worth reading while a person decides.
        hooks.status("");
        break;
      }
      case "station": {
        closeText();
        hooks.gap?.();
        hooks.row(row(magenta("● "), bold(event.station), dim(` ${event.stage}`)));
        hooks.row(row(dim(`  ⎿  ${flat(event.summary, 100)}`)));
        hooks.status(`${event.station} ${event.stage}`);
        break;
      }
      case "stopped": {
        closeText();
        hooks.gap?.();
        hooks.row(row(yellow("■ "), plain(event.reason)));
        break;
      }
      case "done": {
        closeText();
        if (plan.length) {
          hooks.gap?.();
          hooks.row(row(grey("plan as finished")));
          for (const [index, step] of plan.entries()) hooks.row(row(dim(`  ${index + 1}. `), plain(flat(step, 100))));
        }
        break;
      }
    }
  };

  return { push, finish: closeText, sawText: () => sawText };
}
