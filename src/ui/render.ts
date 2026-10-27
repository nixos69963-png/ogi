/**
 * Rendering: what the operator sees while a run is live.
 *
 * The contract is short — show the plan, show each call and its outcome, show the
 * model's own text, and never show harness chatter. `[harness]` budget notes,
 * stuck warnings and compaction are history-only; they exist to keep the run on
 * track, not to be read.
 *
 * The shape is the one a person reads a terminal in: a bullet for the call, the
 * call written the way you would say it out loud, and the answer under it.
 *
 *   ● Read(file_path: "src/core/config.ts")
 *     ⌄ ✓ 0.0s · 214 chars
 *
 *   ● Update(src/core/config.ts)
 *     ⌄ ✓ 0.2s · +4 −1 · 91 chars
 *      80    const DEFAULT_MODEL = "gemma4:31b-cloud";
 *      81 +  const DEFAULT_MODEL = "qwen3:0.6b";
 *
 * A file that changed is shown as a diff, not as a claim about a diff, because
 * "+1 −0" for what was meant to be a two-line edit is exactly the mistake worth
 * catching with your own eyes. The wait is the frightening part, so a dim line
 * ticks while the model thinks or a command runs — what it is doing, for how
 * long, and how to stop it — and it is erased before anything real prints.
 */
import { formatTimeLeft } from "#core/budget.ts";
import type { DiffRow } from "#ui/diff.ts";
import type { AgentEvent } from "#core/types.ts";
import { line, rule, status, statusWritable, style, width } from "./terminal.ts";

export interface Renderer {
  (event: AgentEvent): void;
  /** The run must end on a fresh line even if it ended mid-sentence. */
  finish(): void;
  sawText(): boolean;
}

export interface Verb {  /** Display name, in the calling shape: `Read(file_path: "x")`. */
  label: string;
  color: (text: string) => string;
  /** The argument that names what is being acted on. */
  subject?: string;
  /** How that argument is spelled to the operator, when it differs from the key. */
  as?: string;
  /** Quote the subject, the way a code editor shows a path. */
  quote?: boolean;
}

const VERBS: Record<string, Verb> = {
  plan_update: { label: "Plan", color: style.cyan, subject: "steps" },
  finish: { label: "Report", color: style.bold },
  request_input: { label: "Ask", color: style.yellow, subject: "question" },
  write_artifact: { label: "Handoff", color: style.magenta },
  read_file: { label: "Read", color: style.blue, subject: "path", as: "file_path", quote: true },
  write_file: { label: "Write", color: style.green, subject: "path", as: "file_path", quote: true },
  edit_file: { label: "Update", color: style.yellow, subject: "path" },
  list_dir: { label: "List", color: style.grey, subject: "path", as: "dir" },
  move_path: { label: "Move", color: style.yellow, subject: "from" },
  remove_path: { label: "Delete", color: style.red, subject: "path" },
  glob: { label: "Find", color: style.cyan, subject: "pattern", quote: true },
  grep: { label: "Search", color: style.cyan, subject: "pattern", quote: true },
  run_command: { label: "Bash", color: style.magenta, subject: "command" },
  run_background: { label: "Bash", color: style.magenta, subject: "command" },
  proc_output: { label: "Output", color: style.grey, subject: "id" },
  proc_list: { label: "Jobs", color: style.grey },
  stop_process: { label: "Stop", color: style.red, subject: "id" },
  web_fetch: { label: "Fetch", color: style.blue, subject: "url" },
  browser_open: { label: "Browser", color: style.blue, subject: "url", as: "open" },
  browser_state: { label: "Browser", color: style.blue, subject: "action", as: "look" },
  browser_extract: { label: "Browser", color: style.blue, subject: "goal", as: "extract" },
  browser_scroll: { label: "Browser", color: style.blue, subject: "amount", as: "scroll" },
  browser_click: { label: "Browser", color: style.yellow, subject: "index", as: "click" },
  browser_type: { label: "Browser", color: style.yellow, subject: "text", as: "type", quote: true },
  browser_press: { label: "Browser", color: style.yellow, subject: "key", as: "key", quote: true },
  browser_select: { label: "Browser", color: style.yellow, subject: "option", as: "choose" },
  browser_tab: { label: "Browser", color: style.blue, subject: "action", as: "tab" },
  browser_history: { label: "Browser", color: style.blue, subject: "action", as: "history" },
  browser_screenshot: { label: "Screenshot", color: style.blue, subject: "path" },
  browser_close: { label: "Close", color: style.grey },
  github_issue: { label: "GitHub", color: style.blue, subject: "number", as: "issue" },
  github_issues: { label: "GitHub", color: style.blue, subject: "state", as: "issues" },
  github_ci: { label: "CI", color: style.blue, subject: "ref" },
  github_comment: { label: "GitHub", color: style.yellow, subject: "number", as: "comment" },
  github_pr: { label: "GitHub", color: style.green, subject: "title", as: "pr", quote: true },
  github_push: { label: "Push", color: style.green, subject: "branch" },
};

/** Exported for the full-screen UI: one table of verbs, two painters. */
export function verbFor(name: string): Verb {
  return VERBS[name] ?? { label: name.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase()).slice(0, 14), color: style.grey };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `file_path: "src/app.ts"` — the argument, spelled the way the operator thinks about it. */
export function subjectOf(args: Record<string, unknown>, verb: Verb): string {
  const keys = Object.keys(args);
  const key = verb.subject && args[verb.subject] !== undefined ? verb.subject : keys[0];
  if (!key) return "";
  const value = args[key];
  // A list is shown as a count: the bullet names the call, the block under it is
  // where the items belong.
  if (Array.isArray(value)) return `${value.length} ${key.replace(/_/g, " ")}`;
  const text = oneLine(typeof value === "string" ? value : JSON.stringify(value ?? ""), 64);
  const shown = verb.quote ? `"${text}"` : text;
  return verb.as ? `${verb.as}: ${shown}` : shown;
}

export function restCount(args: Record<string, unknown>, verb: Verb): number {
  const key = verb.subject && args[verb.subject] !== undefined ? verb.subject : Object.keys(args)[0];
  return Object.keys(args).filter((k) => k !== key).length;
}

const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const TICK_MS = 100;

/** One number column, then the marker, then the line. `⌄` is the block under a bullet. */
function diffLine(row: DiffRow, numberWidth: number): string {
  const number = row.newNo ?? row.oldNo;
  const gutter = `   ${number == null ? "".padStart(numberWidth) : String(number).padStart(numberWidth)} `;
  if (row.marker === "…") return `${style.grey(`${gutter}… ${row.text}`)}`;
  const mark = row.marker === "+" ? style.green("+") : row.marker === "-" ? style.red("-") : style.dim(row.marker);
  const text = row.marker === "+" ? style.green(row.text) : row.marker === "-" ? style.red(row.text) : style.dim(row.text);
  return `${style.dim(gutter)}${mark} ${text}`;
}

export function createRenderer(options: { quiet?: boolean; showThinking?: boolean; sink?: (text: string) => void } = {}): Renderer {
  const quiet = options.quiet === true;
  const sink = options.sink;
  const show = (text: string) => (sink ? sink(`\r${text}`) : status(text));

  let plan: string[] = [];
  let sawText = false;
  let pending = "";
  let phase = "";
  let since = 0;
  let frame = 0;
  let statusShown = "";
  let hideResult = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** A real line always erases the live line first, or the two print over each other. */
  const clearStatus = () => {
    if (!statusShown) return;
    statusShown = "";
    show("");
  };

  const print = (text: string) => {
    clearStatus();
    if (sink) sink(`${text}\n`);
    else line(text);
  };

  /** A run that shows nothing for 20 seconds looks broken, so it shows time instead. */
  const drawStatus = () => {
    if (quiet) return;
    if (!phase) {
      clearStatus();
      return;
    }
    if (!sink && !statusWritable()) return;
    const seconds = ((Date.now() - since) / 1000).toFixed(1);
    const text = `${SPINNER[frame % SPINNER.length]} ${phase} · ${seconds}s · Ctrl+C stops`;
    statusShown = text;
    show(oneLine(text, width() - 1));
    frame += 1;
  };

  /** Only a real terminal gets the timer; a sink is fed one line per event, which a test can read. */
  const startTicking = () => {
    if (timer || sink || quiet || !statusWritable()) return;
    timer = setInterval(drawStatus, TICK_MS);
  };

  const stopTicking = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const closeText = () => {
    if (pending) {
      print(pending);
      pending = "";
    }
    phase = "";
    clearStatus();
    stopTicking();
  };

  const setPhase = (text: string) => {
    phase = text;
    since = Date.now();
    startTicking();
    drawStatus();
  };

  const render = (event: AgentEvent): void => {
    if (quiet && event.type !== "done" && event.type !== "stopped") return;
    switch (event.type) {
      case "thinking": {
        // The reasoning text is opt-in: it is the model's draft, not its report.
        const draft = options.showThinking === true && event.text ? ` ${style.dim(oneLine(event.text, 60))}` : "";
        setPhase(`thinking${draft}`);
        break;
      }
      case "assistant": {
        if (!event.text) break;
        sawText = true;
        phase = "";
        pending += event.text;
        for (;;) {
          const cut = pending.indexOf("\n");
          if (cut === -1) break;
          print(pending.slice(0, cut));
          pending = pending.slice(cut + 1);
        }
        break;
      }
      case "plan": {
        closeText();
        plan = event.steps;
        print(rule("plan", style.cyan));
        for (const [index, step] of event.steps.entries()) print(`  ${style.dim(String(index + 1))}. ${step}`);
        break;
      }
      case "tool-call": {
        closeText();
        // `finish` is not an action: its text is the report, and the caller prints it once.
        if (event.name === "finish") {
          hideResult = true;
          break;
        }
        const verb = verbFor(event.name);
        const subject = subjectOf(event.args, verb);
        const rest = restCount(event.args, verb);
        const extra = rest ? ` ${style.dim(`+${rest}`)}` : "";
        print(`${style.green("●")} ${verb.color(verb.label)}(${subject || style.dim("…")})${extra}`);
        setPhase(`${verb.label.toLowerCase()}${subject ? ` ${oneLine(subject, 40)}` : ""}`);
        break;
      }
      case "tool-result": {
        if (hideResult) {
          hideResult = false;
          break;
        }
        const data = (event.data ?? {}) as Record<string, unknown>;
        const mark = event.ok ? style.green("✓") : style.red("✗");
        const bits: string[] = [`${(event.ms / 1000).toFixed(1)}s`];
        const diff = Array.isArray(data.diff) ? (data.diff as DiffRow[]) : [];
        if (event.ok && (data.added !== undefined || data.removed !== undefined)) {
          const added = Number(data.added ?? 0);
          const removed = Number(data.removed ?? 0);
          bits.push(`${style.green(`+${added}`)} ${style.red(`−${removed}`)}`);
        }
        if (event.ok) bits.push(`${event.chars} chars`);
        print(`  ${style.dim("⌄")} ${mark} ${bits.join(style.dim(" · "))}${event.error ? ` ${style.red(oneLine(event.error, width() - 24))}` : ""}`);
        if (diff.length) {
          const numberWidth = Math.max(2, ...diff.map((row) => String(row.newNo ?? row.oldNo ?? 0).length));
          for (const row of diff) print(diffLine(row, numberWidth));
        }
        setPhase("thinking");
        break;
      }
      case "approval": {
        // The prompt is the only thing that should be on screen while a person reads it.
        phase = "";
        clearStatus();
        stopTicking();
        break;
      }
      case "station": {
        closeText();
        print(`${style.magenta("●")} ${style.bold(event.station)} ${style.dim(event.stage)}`);
        print(`  ${style.dim("⌄")} ${style.dim(oneLine(event.summary, width() - 6))}`);
        setPhase(`${event.station} ${event.stage}`);
        break;
      }
      case "stopped": {
        closeText();
        print(`${style.yellow("■")} ${event.reason}`);
        break;
      }
      case "done": {
        closeText();
        if (plan.length) {
          print(rule("plan as finished", style.grey));
          for (const [index, step] of plan.entries()) print(`  ${style.dim(`${index + 1}.`)} ${oneLine(step, width() - 6)}`);
        }
        break;
      }
    }
  };

  return Object.assign(render, {
    finish: closeText,
    sawText: () => sawText,
  }) as Renderer;
}

/** The one-line timer the REPL can print alongside a live run. */
export function timeLeftLabel(ms: number | null): string {
  return ms == null ? "no budget" : `${formatTimeLeft(ms)} left`;
}
