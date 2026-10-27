/**
 * The loop: think, plan, act, verify — until the work is done or the time is spent.
 *
 * This file is the whole agent. Everything else is either a tool, a guard, or a
 * renderer. Four rules give it its shape:
 *
 * 1. Nothing reaches the machine except through a tool, and every tool call is
 *    validated, gated by effect, and logged before it is executed.
 * 2. A tool result is an observation: it is clipped on the way into history, and
 *    history is condensed when it approaches the context window. That is the
 *    difference between a run that costs a cent and one that costs an afternoon.
 * 3. The budget is a ceiling and a floor. An unfinished task with unspent time
 *    gets nudged — internally, in a message the operator never sees, at most twice.
 * 4. Repetition is failure. The same call with the same arguments three times stops
 *    the run instead of burning the remaining budget on it.
 */
import { randomUUID } from "node:crypto";
import {
  budgetSpentNote,
  createBudget,
  formatTimeLeft,
  isExpired,
  takeBudgetNudge,
  timeLeftMs,
  type Budget,
} from "#core/budget.ts";
import { clip, maybeCompact } from "#core/history.ts";
import { ask, ProviderError, type AskOptions, type AssistantTurn, type ProviderTool } from "#core/provider.ts";
import { stuckNote, systemPrompt, wrapUpNote } from "#core/prompt.ts";
import { validate } from "#core/schemas.ts";
import type {
  AgentEvent,
  ApprovalAnswer,
  ApprovalRequest,
  AppConfig,
  Message,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "#core/types.ts";
import { createApprover, type Approver } from "#guard/approval.ts";
import { displayPath } from "#guard/path_guard.ts";
import { openRunLog } from "#guard/log.ts";
import { redact } from "#guard/redact.ts";
import { buildTools, providerTools, toolMap } from "#tools/index.ts";

const STUCK_LIMIT = 3;
const MAX_STUCK_NOTES = 2;
const WRAP_UP_FRACTION = 0.15;

export interface RunOptions {
  config: AppConfig;
  task: string;
  tools?: ToolSpec[];
  /** Extra instructions appended to the system brief — the factory line lives here. */
  systemExtra?: string;
  budget?: Budget | null;
  attended?: boolean;
  onEvent?: (event: AgentEvent) => void;
  confirm?: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
  /**
   * The model's question to the operator, answered by a person rather than a tool.
   * With no one to ask, `request_input` ends the run the way it always has; with a
   * REPL in front of the operator, the answer goes back into the transcript and the
   * run continues.
   */
  ask?: (question: string, options: string[]) => Promise<string | null>;
  /** Resume a previous run with its transcript. */
  messages?: Message[];
  signal?: AbortSignal;
  /** Overrides the advertised model for one run (a station may want a smaller brain). */
  model?: string;
  temperature?: number;
  /**
   * The provider call. Injectable so the loop's own rules — gating, the budget
   * floor, stuck detection, compaction — are testable without a model and without
   * spending a token. Nothing else needs it.
   */
  transport?: (cfg: AppConfig, options: AskOptions) => Promise<AssistantTurn>;
}

export interface RunOutcome {
  text: string;
  turns: number;
  messages: Message[];
  tokensIn: number;
  tokensOut: number;
  stopped: string | null;
  plan: string[];
  denied: number;
  ms: number;
}

export async function run(opts: RunOptions): Promise<RunOutcome> {
  const startedAt = Date.now();
  const cfg = opts.config;
  const specs = opts.tools ?? buildTools();
  const byName = toolMap(specs);
  const wire: ProviderTool[] = providerTools(specs);
  const budget = opts.budget === undefined ? createBudget(cfg.budgetMinutes) : opts.budget ?? createBudget(null);
  const attended = opts.attended ?? Boolean(process.stdin.isTTY);
  const emit = opts.onEvent ?? (() => {});
  const runId = randomUUID().slice(0, 8);
  const log = openRunLog(cfg.workspace, runId);

  const askHuman = async (request: ApprovalRequest): Promise<ApprovalAnswer> => {
    if (!opts.confirm) {
      // Nobody to ask. Everything the tier waves through is waved through by policy
      // before it reaches here, so what is left is what was held back on purpose —
      // and a held-back step never becomes a silent yes because no one is watching.
      return "no" as ApprovalAnswer;
    }
    // The answer takes as long as it takes, and a ticking status line printing
    // over "allow? [y]es" makes the REPL impossible to read.
    emit({ type: "approval", name: request.tool, effect: request.effect, summary: request.summary });
    return opts.confirm(request);
  };
  const approver: Approver = createApprover({ level: cfg.approvalLevel, attended, confirm: askHuman });

  const messages: Message[] = opts.messages?.length
    ? [...opts.messages]
    : [
        { role: "system", content: systemPrompt({ config: cfg, tools: specs.map((s) => s.name), budgetLabel: budgetLabel(budget) }) },
      ];
  if (opts.systemExtra) {
    const last = messages[0];
    if (last?.role === "system") last.content = `${last.content}\n\n${opts.systemExtra}`;
  }
  if (opts.task.trim()) messages.push({ role: "user", content: opts.task.trim() });

  let turns = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let finalText = "";
  let stopped: string | null = null;
  let plan: string[] = [];
  let denied = 0;
  const repetition = new Map<string, number>();
  let stuckNotes = 0;
  let wrapUpGiven = false;
  let finished = false;

  const controller = new AbortController();
  const transport = opts.transport ?? ask;
  const forwardAbort = () => controller.abort(new Error("stopped by operator"));
  opts.signal?.addEventListener("abort", forwardAbort);

  try {
    while (!finished) {
      if (opts.signal?.aborted || controller.signal.aborted) {
        stopped = "stopped by the operator";
        emit({ type: "stopped", reason: stopped, turns });
        break;
      }
      if (isExpired(budget, Date.now())) {
        stopped = budgetSpentNote(budget);
        emit({ type: "stopped", reason: stopped, turns });
        break;
      }
      if (turns >= budget.maxTurns) {
        stopped = budgetSpentNote(budget);
        emit({ type: "stopped", reason: stopped, turns });
        break;
      }

      const compaction = maybeCompact(messages, { contextTokens: cfg.contextTokens, compactAtPercent: cfg.compactAtPercent });
      if (compaction.condensed) {
        log.note("compacted", `condensed ${compaction.condensed} messages, saved ~${compaction.savedTokens} tokens`);
        messages.splice(0, messages.length, ...compaction.messages);
      }

      const answer = await transport(cfg, {
        model: opts.model ?? cfg.model,
        messages,
        tools: wire,
        signal: controller.signal,
        temperature: opts.temperature,
        onDelta: (text) => emit({ type: "assistant", text }),
        onThinking: (text) => emit({ type: "thinking", text }),
      });
      tokensIn += answer.usage.inputTokens;
      tokensOut += answer.usage.outputTokens;

      if (!answer.toolCalls.length) {
        finalText = answer.content.trim() || finalText;
        const nudge = takeBudgetNudge(budget);
        if (nudge) {
          messages.push({ role: "assistant", content: answer.content });
          messages.push({ role: "user", content: nudge });
          log.note("nudge", `budget floor spoke (${budget.nudges}/${2})`);
          turns += 1;
          continue;
        }
        if (answer.content.trim()) {
          messages.push({ role: "assistant", content: answer.content });
        }
        break;
      }

      messages.push({ role: "assistant", content: answer.content ?? "", tool_calls: answer.toolCalls });
      turns += 1;

      for (const call of answer.toolCalls) {
        if (finished) break;
        const result = await executeCall(call, {
          cfg,
          byName,
          approver,
          log,
          emit,
          turn: turns,
          attended,
          repetition,
          runId,
          signal: controller.signal,
        });
        messages.push(result.message);
        if (result.plan) plan = result.plan;
        if (result.finish) {
          finalText = result.finishText;
          finished = true;
        }
        if (result.ask) {
          // A question is only a stop when there is no one to answer it.
          emit({ type: "approval", name: "request_input", effect: "compute", summary: result.ask });
          const answer = opts.ask ? await opts.ask(result.ask, result.askOptions ?? []) : null;
          if (answer) {
            messages.push({ role: "user", content: `The operator answered: ${answer}. Continue with that in mind.` });
          } else {
            stopped = `asking the operator: ${result.ask}`;
            emit({ type: "stopped", reason: stopped, turns });
            finished = true;
          }
        }
        if (result.denied) denied += 1;
        if (result.stuckNote) {
          stuckNotes += 1;
          if (stuckNotes > MAX_STUCK_NOTES) {
            stopped = `stopped: ${call.name} repeated without progress`;
            emit({ type: "stopped", reason: stopped, turns });
            finished = true;
          } else {
            messages.push({ role: "user", content: result.stuckNote });
          }
        }
      }

      const left = timeLeftMs(budget);
      if (!wrapUpGiven && left != null && budget.minutes != null && left < budget.minutes * 60_000 * WRAP_UP_FRACTION) {
        wrapUpGiven = true;
        messages.push({ role: "user", content: wrapUpNote() });
      }
    }
  } catch (cause) {
    const error = cause as Error;
    if (error instanceof ProviderError) {
      stopped = error.message + (error.hint ? `\n${error.hint}` : "");
    } else if (controller.signal.aborted) {
      stopped = "stopped by the operator";
    } else {
      stopped = `run failed: ${error.message}`;
    }
    emit({ type: "stopped", reason: stopped, turns });
  } finally {
    opts.signal?.removeEventListener("abort", forwardAbort);
    log.note("run-end", `turns ${turns} · in ${tokensIn} / out ${tokensOut} tokens · ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${stopped ?? "finished"}`);
  }

  const text = finalText || stopped || "(the model returned nothing)";
  emit({ type: "done", text, turns, tokensIn, tokensOut });
  return { text, turns, messages, tokensIn, tokensOut, stopped, plan, denied, ms: Date.now() - startedAt };
}

interface CallEnv {
  cfg: AppConfig;
  byName: Map<string, ToolSpec>;
  approver: Approver;
  log: ReturnType<typeof openRunLog>;
  emit: (event: AgentEvent) => void;
  turn: number;
  attended: boolean;
  repetition: Map<string, number>;
  runId: string;
  signal: AbortSignal;
}

interface CallResult {
  message: Message;
  plan?: string[];
  finish?: boolean;
  finishText: string;
  ask?: string;
  askOptions?: string[];
  denied?: boolean;
  stuckNote?: string;
}

async function executeCall(call: ToolCall, env: CallEnv): Promise<CallResult> {
  const { cfg, byName, approver, log, emit, turn } = env;
  const base = { role: "tool" as const, content: "", tool_call_id: call.id, name: call.name };
  const args = (call.arguments ?? {}) as Record<string, unknown>;

  const spec = byName.get(call.name);
  if (!spec) {
    const known = [...byName.keys()];
    const close = known.filter((name) => name.includes(call.name.slice(0, 4))).slice(0, 4);
    const message = `There is no tool named "${call.name}". Available: ${known.join(", ")}.${close.length ? ` Did you mean ${close.join(" or ")}?` : ""}`;
    emit({ type: "tool-result", turn, name: call.name, ok: false, chars: message.length, ms: 0, error: "unknown tool" });
    return { message: { ...base, content: message }, finishText: "" };
  }

  // Same call, same arguments, again: that is not progress, that is a loop.
  const signature = `${call.name}:${stable(args)}`;
  const times = (env.repetition.get(signature) ?? 0) + 1;
  env.repetition.set(signature, times);

  const checked = validate(spec.inputSchema, args);
  if (!checked.ok) {
    const message = `Bad arguments for ${call.name}: ${checked.errors.join("; ")}. Call it again with a valid shape.`;
    emit({ type: "tool-result", turn, name: call.name, ok: false, chars: message.length, ms: 0, error: "invalid arguments" });
    log.write({ at: Date.now(), turn, tool: call.name, effect: spec.effect, args, ok: false, chars: 0, approved: "auto", ms: 0, error: "invalid arguments" });
    return { message: { ...base, content: message }, finishText: "" };
  }

  if (times >= STUCK_LIMIT) {
    return {
      message: { ...base, content: `${call.name} was already called ${times - 1} times with exactly these arguments.` },
      finishText: "",
      stuckNote: stuckNote({ name: call.name, count: times }),
    };
  }

  // Built once: `describe` may need to read the file it is about to change in
  // order to show the diff before it happens, not after.
  const context: ToolContext = {
    workspace: cfg.workspace,
    config: cfg,
    log: (event) => log.write(event),
    confirm: async (request) => ((await approver.decide(request)).allowed ? "yes" : "no"),
    signal: env.signal,
    attended: env.attended,
    turn,
    display: (absolute) => displayPath(cfg.workspace, absolute),
  };

  const described = spec.describe?.(args as never, context) ?? { summary: `${call.name}(${shortArgs(args)})` };
  const decision = await approver.decide({
    tool: call.name,
    effect: spec.effect,
    summary: described.summary,
    risky: described.risky,
    patch: described.patch,
    hard: described.hard,
    autoAllow: described.autoAllow,
  });
  if (!decision.allowed) {
    // The refused call still gets its own line: a `denied` printed under whatever
    // bullet came before it does not tell the operator which step was held back.
    emit({ type: "tool-call", turn, name: call.name, args });
    emit({ type: "tool-result", turn, name: call.name, ok: false, chars: 0, ms: 0, error: "denied" });
    log.write({ at: Date.now(), turn, tool: call.name, effect: spec.effect, args, ok: false, chars: 0, approved: false, ms: 0, error: decision.reason });
    return {
      message: { ...base, content: `Not allowed: ${decision.reason}. Do not retry this call. Report what you have and what the operator must decide.` },
      finishText: "",
      denied: true,
    };
  }

  emit({ type: "tool-call", turn, name: call.name, args });
  const started = Date.now();

  let result: ToolResult;
  try {
    result = await spec.execute(args, context);
  } catch (cause) {
    const error = cause as Error;
    result = { ok: false, error: `${call.name} threw: ${error.message}`, content: `${call.name} threw: ${error.message}` };
  }
  const ms = Date.now() - started;

  const raw = result.ok ? (result.content ?? "(ok, no output)") : `ERROR: ${result.error ?? result.content ?? "failed"}`;
  const cleaned = redact(raw).text;
  const content = clip(cleaned, cfg.maxObserveChars);
  log.write({
    at: Date.now(),
    turn,
    tool: call.name,
    effect: spec.effect,
    args,
    ok: result.ok,
    chars: content.length,
    approved: decision.allowed === true ? decision.approvedBy : "auto",
    ms,
    ...(result.ok ? {} : { error: result.error }),
  });
  emit({ type: "tool-result", turn, name: call.name, ok: result.ok, chars: content.length, ms, data: result.data, ...(result.ok ? {} : { error: result.error }) });

  const data = (result.data ?? {}) as Record<string, unknown>;
  if (call.name === "plan_update" && Array.isArray(data.steps)) return { message: { ...base, content }, finishText: "", plan: data.steps as string[] };
  if (call.name === "finish" && result.ok) return { message: { ...base, content }, finishText: String(data.summary ?? content), finish: true };
  if (call.name === "request_input")
    return {
      message: { ...base, content },
      finishText: "",
      ask: String(data.question ?? described.summary),
      askOptions: Array.isArray(data.options) ? (data.options as unknown[]).map((s) => String(s)) : [],
    };
  return { message: { ...base, content }, finishText: "" };
}

function stable(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "object" && v !== null ? sortKeys(v as Record<string, unknown>) : v));
  } catch {
    return String(value);
  }
}

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value as unknown as T;
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = (value as Record<string, unknown>)[key];
  return out as unknown as T;
}

function shortArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value.slice(0, 40) : String(value).slice(0, 40)}`)
    .join(", ")
    .slice(0, 160);
}

export function budgetLabel(budget: Budget): string {
  if (budget.minutes == null) return `- No time budget: finish the task, or stop when it is genuinely blocked.`;
  const left = formatTimeLeft(timeLeftMs(budget));
  return `- Working budget: ${budget.minutes} min (${budget.maxTurns} turns). At the start there were ${left} left; when it runs out the harness stops the run.`;
}
