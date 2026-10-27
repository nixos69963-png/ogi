/**
 * A research subagent: a second run, with its own transcript, that answers one
 * question and brings back only the answer.
 *
 * This is the part of Claude Code's Agent tool that earns its keep, without the
 * part that can fork a whole project. The subagent reads and searches; it cannot
 * write, run a command, or ask a person. That is not a policy the prompt asks it
 * to follow — it is the tool list it is given. A run that cannot write cannot
 * surprise the operator, and a report that comes back in one message costs a
 * fraction of the transcript it replaced.
 */
import { createBudget, MAX_BUDGET_NUDGES } from "#core/budget.ts";
import { run as runAgent } from "#core/loop.ts";
import { ask, type AskOptions, type AssistantTurn } from "#core/provider.ts";
import type { AppConfig, ToolSpec } from "#core/types.ts";

export interface ResearchOptions {
  config: AppConfig;
  task: string;
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** The provider call, injectable so the subagent is testable without a model. */
  transport?: (cfg: AppConfig, options: AskOptions) => Promise<AssistantTurn>;
  minutes?: number;
}

export interface ResearchResult {
  text: string;
  turns: number;
  tokens: number;
  stopped: string | null;
}

const BRIEF = [
  "You are a research subagent working for the operator's agent.",
  "Your one job is the question in the user message. Nobody will answer a question back,",
  "so do not ask one; if a fact is missing, say where you looked and that it was not there.",
  "",
  "Rules for this run:",
  "- Read before you conclude. Search with glob/grep, then read only the files that matter.",
  "- You cannot write a file, run a command, or change the browser: those tools are not here.",
  "- The planning step in the brief above does not apply to you; you have no plan tool.",
  "- Answer with findings and file:line references. Quote at most three short lines in total.",
  "- Keep it under sixty lines. The parent agent needs the conclusion, not your journey.",
].join("\n");

export async function research(opts: ResearchOptions): Promise<ResearchResult> {
  // A "turn" here is one model call: the parent's loop counts tool rounds, but a
  // research report is judged by how much talking it took.
  let calls = 0;
  const transport = opts.transport ?? ask;
  const counted = (cfg: AppConfig, options: AskOptions): Promise<AssistantTurn> => {
    calls += 1;
    return transport(cfg, options);
  };
  const outcome = await runAgent({
    config: opts.config,
    task: opts.task,
    tools: opts.tools,
    systemExtra: BRIEF,
    // The clock still applies, but not the parent's "keep working" floor: a
    // subagent answers once, and a second call only repeats the question.
    budget: { ...createBudget(opts.minutes ?? 4), nudges: MAX_BUDGET_NUDGES },
    attended: false,
    signal: opts.signal,
    transport: counted,
    onEvent: () => {},
  });
  return {
    text: outcome.text,
    turns: calls,
    tokens: outcome.tokensIn + outcome.tokensOut,
    stopped: outcome.stopped,
  };
}
