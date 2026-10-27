/**
 * The delegate tool: hand a question to a read-only subagent.
 *
 * It exists because the main transcript is expensive property. A sweep of forty
 * files to answer "where is the approval tier read" should leave one paragraph
 * behind, not forty tool results. The subagent gets its own budget and its own
 * history, and the parent keeps the answer.
 */
import { research } from "#core/subagent.ts";
import type { ToolResult, ToolSpec } from "#core/types.ts";
import { BROWSER_TOOLS } from "./browser.ts";
import { finish } from "./control.ts";
import { err, obj, ok, str, tool } from "./define.ts";
import { FILE_TOOLS } from "./files.ts";
import { SEARCH_TOOLS } from "./search.ts";
import { WEB_TOOLS } from "./web.ts";

/** Reading is the whole job. Anything that writes the project, runs a command or
 *  presses a page is deliberately absent, so "read-only" is the tool list, not a
 *  promise in a prompt. */
const READ_ONLY = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "web_fetch",
  "browser_open",
  "browser_state",
  "browser_extract",
  "browser_scroll",
  "browser_history",
]);

export function researchTools(): ToolSpec[] {
  return [...FILE_TOOLS, ...SEARCH_TOOLS, ...WEB_TOOLS, ...BROWSER_TOOLS, finish].filter((spec) => READ_ONLY.has(spec.name));
}

/** A subagent report is an answer, not a second transcript. */
const MAX_REPORT_CHARS = 6_000;

export const delegate = tool({
  name: "delegate",
  description:
    "Hand one focused research question to a read-only subagent with its own context. Use it to sweep a repo, " +
    "trace where something is defined, or read several pages, without filling this transcript with raw results. " +
    "It cannot write files, run commands or click: it reads files and pages only. Returns a short report with file:line evidence.",
  effect: "compute",
  inputSchema: obj({
    task: str("One question to answer, phrased as work: where X is defined, how Y is wired, what Z documents."),
    focus: str("Optional: paths, names or pages the subagent should start from."),
  }, ["task"]),
  describe: (input) => ({ summary: `research: ${String(input.task ?? "").slice(0, 110)}` }),
  async execute(input, ctx): Promise<ToolResult> {
    const task = String(input.task ?? "").trim();
    if (!task) return err("delegate needs a task.");
    const focus = String(input.focus ?? "").trim();
    const question = focus ? `${task}\n\nStart with: ${focus}` : task;
    let result;
    try {
      result = await research({ config: ctx.config, task: question, tools: researchTools(), signal: ctx.signal });
    } catch (cause) {
      return err(`The research run failed: ${(cause as Error).message}. Do the work directly instead.`);
    }
    const text = result.text.trim();
    if (!text) return err(`The research run returned nothing${result.stopped ? ` (${result.stopped})` : ""}. Do the work directly instead.`);
    const clipped = text.length > MAX_REPORT_CHARS ? `${text.slice(0, MAX_REPORT_CHARS).trimEnd()}\n(...cut at ${MAX_REPORT_CHARS} chars; ask a narrower question if you need more)` : text;
    const stopped = result.stopped ? `\nstopped: ${result.stopped}` : "";
    return ok(`Research report — ${result.turns} turns · ${result.tokens} tokens${stopped}\n\n${clipped}`, {
      turns: result.turns,
      tokens: result.tokens,
      stopped: result.stopped,
    });
  },
});
