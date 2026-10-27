/**
 * Control tools: the three calls that are about the run rather than the machine.
 *
 * plan_update exists because the operator asked for it: a model that draws its
 * mind map before it moves wastes far fewer tokens than one that improvises each
 * turn. It is cheap, it is not gated, and the loop renders it as a checklist so a
 * long run stays legible to a human watching the end of it.
 *
 * finish ends the run — no more tool calls, no more narration. request_input is
 * the honest exit when a required fact is missing: ask, instead of inventing.
 */
import type { ToolResult } from "#core/types.ts";
import { arr, err, obj, ok, str, tool } from "./define.ts";

export interface PlanState {
  steps: string[];
  updatedBy: string;
}

export const planUpdate = tool({
  name: "plan_update",
  description:
    "Set or replace your step list for this task. 2-6 steps, each an action you can verify. " +
    "Call it once at the start and again only when the plan genuinely changes — not every turn.",
  effect: "compute",
  inputSchema: obj({
    steps: arr("Ordered steps. Short imperatives.", str("One step.")),
    note: str("Optional: why the plan changed."),
  }, ["steps"]),
  describe: (input) => ({ summary: `plan with ${Array.isArray(input.steps) ? input.steps.length : 0} steps` }),
  async execute(input): Promise<ToolResult> {
    const steps = Array.isArray(input.steps) ? input.steps.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!steps.length) return err("plan_update needs at least one step.");
    if (steps.length > 12) return err("Twelve steps maximum. A plan this long is a different task.");
    return ok(`Plan set (${steps.length} steps):\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}${input.note ? `\nnote: ${String(input.note).slice(0, 200)}` : ""}`, {
      steps,
    });
  },
});

export const finish = tool({
  name: "finish",
  description:
    "End the run. Give what changed, how you verified it, and what is still open. This is the last thing you do — do not call it until the work is actually done.",
  effect: "compute",
  inputSchema: obj({
    summary: str("What you did, in up to five lines. Results, not intentions."),
    verified: str("Which tool output proves it (a command you ran, a file you re-read)."),
    open: arr("Anything not done, each as one line. Empty if none.", str("One open item.")),
  }, ["summary", "verified"]),
  describe: () => ({ summary: "finish the run" }),
  async execute(input): Promise<ToolResult> {
    const summary = String(input.summary ?? "").trim();
    const verified = String(input.verified ?? "").trim();
    if (!summary) return err("finish needs a summary of what changed.");
    if (!verified) return err("finish needs the evidence: say how you verified it, or keep working.");
    const open = Array.isArray(input.open) ? input.open.map((s) => String(s).trim()).filter(Boolean) : [];
    return ok(
      `Run closed.\n${summary}\nverified: ${verified}${open.length ? `\nstill open:\n${open.map((s) => `- ${s}`).join("\n")}` : ""}`,
      { summary, verified, open },
    );
  },
});

export const requestInput = tool({
  name: "request_input",
  description:
    "Stop and ask the operator one question you cannot answer with a tool. Use it for a decision only they can make " +
    "(which file, which name, whether to spend money), not for things you could look up.",
  effect: "compute",
  inputSchema: obj({
    question: str("One question."),
    options: arr("Optional short choices the operator can pick from.", str("One option.")),
  }, ["question"]),
  describe: (input) => ({ summary: `ask: ${String(input.question ?? "").slice(0, 90)}` }),
  async execute(input): Promise<ToolResult> {
    const question = String(input.question ?? "").trim();
    if (!question) return err("request_input needs a question.");
    return err(`Asking the operator instead of continuing: ${question}`, {
      question,
      options: Array.isArray(input.options) ? input.options.map((s) => String(s)) : [],
    });
  },
});
