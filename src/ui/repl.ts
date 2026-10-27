/**
 * The REPL: one prompt, two owners.
 *
 * The same stdin serves the operator typing a task and the agent asking permission,
 * so input is routed: while a run is live an incoming line answers a pending
 * approval if there is one, and is otherwise queued as steering for the next turn.
 * Ctrl+C stops the run; a second Ctrl+C at an idle prompt exits.
 *
 * The transcript is saved under .agent/session.json, so closing the terminal does
 * not end the work — /resume puts it back.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createBudget, formatBudget, rebaseBudget, type Budget } from "#core/budget.ts";
import { expandCommand, loadCommands, matchCommand, type CustomCommand } from "#core/commands.ts";
import { compact, estimateHistory } from "#core/history.ts";
import { describeConfig, isCloudModel, parseApprovalLevel, readConfig, TIER_LINE } from "#core/config.ts";
import { initMemory, loadMemory, memorySummary } from "#core/memory.ts";
import { run as runAgent } from "#core/loop.ts";
import { runFactory } from "#factory/foreman.ts";
import { loadPlan, planSummary, progress } from "#factory/plan.ts";
import { shipGate } from "#factory/artifacts.ts";
import { listModels, ProviderError } from "#core/provider.ts";
import { listBackups, restore } from "#guard/backup.ts";
import { AGENT_DIR, readLog } from "#guard/log.ts";
import { injectMentions, mentionNotice } from "#guard/mentions.ts";
import type { AgentEvent, AppConfig, ApprovalRequest, Message, ToolSpec } from "#core/types.ts";
import { buildTools } from "#tools/index.ts";
import { formatStatuses, type McpHub } from "#mcp/hub.ts";
import { parseAdd } from "#mcp/setup.ts";
import { closeAllShells } from "#tools/shell.ts";
import { closeBrowser } from "#browser/cdp.ts";
import { createLineEditor, type PaletteEntry } from "./input.ts";
import { closeKeyHub, pickable } from "./keys.ts";
import { createRenderer } from "./render.ts";
import { choose } from "./select.ts";
import { line, rule, style, write } from "./terminal.ts";

const SESSION_FILE = "session.json";

function sessionPath(workspace: string): string {
  return path.join(workspace, AGENT_DIR, SESSION_FILE);
}

export function loadSession(config: AppConfig): Message[] {
  const file = sessionPath(config.workspace);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { messages?: Message[]; savedAt?: number };
    if (!Array.isArray(parsed.messages)) return [];
    if (parsed.savedAt && Date.now() - parsed.savedAt > 12 * 3600_000) return [];
    return parsed.messages.filter((m) => m && typeof m.content === "string" && ["system", "user", "assistant", "tool"].includes(m.role));
  } catch {
    return [];
  }
}

export function saveSession(config: AppConfig, messages: Message[]): void {
  const dir = path.join(config.workspace, AGENT_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(sessionPath(config.workspace), JSON.stringify({ savedAt: Date.now(), messages }), "utf8");
  } catch {
    /* a session that cannot be saved is still a working session */
  }
}

export const HELP: [string, string][] = [
  ["<text>", "give the agent a task"],
  ["@<path>", "in a task: put that file or directory in the model's context first"],
  ["/help", "show this list"],
  ["/stop", "stop the run in flight (Ctrl+C does the same)"],
  ["/factory <task>", "run the task through the factory line instead of one transcript"],
  ["/line", "the factory plan on disk: station states, review verdicts, gate"],
  ["/line resume", "continue that plan at the first unfinished station"],
  ["/model <name>", "switch model for this session"],
  ["/budget <m|until>", "working time, e.g. /budget 30 or /budget until"],
  ["/tools", "list the tools this build has"],
  ["/mcp", "MCP servers: list, remove, approve, restart"],
  ["/mcp add", "attach a server: /mcp add <name> -- <command> [args...] · or --url <url> for http/sse"],
  ["/memory", "the standing instructions loaded for this workspace (AGENT.md, AGENTS.md)"],
  ["/init", "write a starter AGENT.md from the project's own facts"],
  ["/log [n]", "recent actions, read from .agent/log"],
  ["/backups", "what can be restored"],
  ["/undo <path|id>", "restore a file from its last backup"],
  ["/approve [ask|auto|full]", "how much runs unasked: ask · auto (routine writes) · full (every write in the project; outward and the system still ask)"],
  ["/resume", "load the saved transcript back"],
  ["/clear", "start a new transcript (the saved one stays)"],
  ["/compact", "condense the transcript now"],
  ["/models", "what this ollama daemon can run"],
  ["/config", "show what the agent resolved at startup"],
  ["/exit", "quit (Ctrl+D too)"],
];

/** The `/` list under the prompt: the same commands `/help` prints. */
export const PALETTE: PaletteEntry[] = HELP.filter(([name]) => name.startsWith("/")).map(([command, description]) => ({
  command,
  description,
}));

export interface ReplOptions {
  config?: AppConfig;
  tools?: ToolSpec[];
  /** MCP servers already connected by the entry point. */
  mcp?: McpHub;
  /** Run one task immediately, then stay open. */
  task?: string;
}

export function startRepl(options: ReplOptions = {}): void {
  let config = options.config ?? readConfig();
  const baseTools = options.tools ?? buildTools();
  let tools: ToolSpec[] = [...baseTools, ...(options.mcp?.specs() ?? [])];
  const refreshTools = (): void => {
    tools = [...baseTools, ...(options.mcp?.specs() ?? [])];
  };
  let budget: Budget | null = createBudget(config.budgetMinutes);
  let messages: Message[] = loadSession(config);
  let commands: CustomCommand[] = loadCommands(config.workspace);

  let controller: AbortController | null = null;
  let pendingApproval: ((answer: "yes" | "no" | "always") => void) | null = null;
  let queue: string[] = [];
  let busy = false;
  let ctrlCount = 0;
  let quitting = false;

  /**
   * A terminal gets keys, a highlighted palette and a picker; a pipe gets the old
   * line reader, because a scripted run answers with text, not with arrow keys.
   */
  const interactive = pickable();
  const rl = interactive
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: style.green("› ") });
  const editor = interactive
    ? createLineEditor({
        palette: PALETTE.concat(commands.map((command) => ({ command: `/${command.name}`, description: `${command.description} (${command.scope})` }))),
        onCtrlC: () => interrupt(),
      })
    : null;

  line(rule("agent", style.bold));
  line(describeConfig(config));
  line(
    style.dim(
      `${tools.length} tools · ${messages.length ? `resumed ${messages.length} messages (/clear for a new transcript)` : "new transcript"} · / for commands · Ctrl+C stops a run`,
    ),
  );

  /** Read the next line, however this session reads lines. */
  function next(): void {
    if (quitting) return;
    if (!editor) {
      rl?.prompt();
      return;
    }
    void editor.read().then((text) => {
      if (text === null) {
        shutdown();
        return;
      }
      handle(text);
      next();
    });
  }

  function interrupt(): void {
    if (controller) {
      controller.abort(new Error("stopped by operator"));
      line(style.yellow("■ stopping the run… the transcript and the files stay as they are"));
      ctrlCount = 0;
      return;
    }
    ctrlCount += 1;
    if (ctrlCount >= 2) {
      shutdown();
      return;
    }
    line(style.dim("(press Ctrl+C again to exit, or /exit)"));
  }

  function shutdown(): void {
    if (quitting) return;
    quitting = true;
    controller?.abort(new Error("exiting"));
    editor?.stop();
    closeKeyHub();
    rl?.close();
    void options.mcp?.stop();
    closeAllShells();
    // Only puts away the Chrome this session launched; one the operator was
    // already using is left running.
    closeBrowser();
    line(style.dim("bye"));
    process.exit(0);
  }

  const askApproval = async (request: ApprovalRequest): Promise<"yes" | "no" | "always"> => {
    const caution = request.hard ?? request.risky;
    const why = caution
      ? `${request.hard ? "this is asked at every level: " : "caution: "}${caution}`
      : null;
    if (editor) {
      const answer = await choose<"yes" | "no" | "always">({
        title: `${request.tool} ${style.dim(`(${request.effect})`)}`,
        body: why ? [request.summary, why] : [request.summary],
        question: "Do you want to proceed?",
        choices: [
          { label: "Yes", value: "yes" },
          { label: "Yes, and do not ask again for this tool this run", value: "always" },
          { label: "No — leave it undone", value: "no" },
        ],
        footer: "↑↓ move · Enter select · Esc says no",
      });
      // A cancelled picker is a refusal. Silence has never meant permission here.
      return answer?.value ?? "no";
    }
    return new Promise((resolve) => {
      pendingApproval = resolve;
      line("");
      line(`${style.yellow("!")} ${style.bold(request.tool)} ${style.dim(`(${request.effect})`)} — ${request.summary}`);
      if (why) line(`  ${style.red(why)}`);
      write(style.dim("  allow? [y]es / [n]o / [a]lways this run > "));
    });
  };

  /** The model's question, put to the person with the same picker. */
  const askQuestion = async (question: string, options: string[]): Promise<string | null> => {
    if (!editor) return null; // nobody is watching a pipe: the run stops and says what it needs
    const answer = await choose<string>({
      title: "The agent needs to know something",
      body: [question],
      question: options.length ? "Which one?" : "Your answer",
      choices: options.map((option) => ({ label: option, value: option })),
      allowType: true,
      footer: "↑↓ move · Enter select · type to answer · Esc stops the run",
    });
    return answer?.value?.trim() ? answer.value.trim() : null;
  };

  async function executeTask(task: string): Promise<void> {
    if (busy) {
      queue.push(task);
      line(style.dim(`queued as steering (${queue.length}) — runs after the current one`));
      return;
    }
    busy = true;
    // "@src/app.py" is the operator handing over a file; say what became context.
    const mentioned = injectMentions(task, { workspace: config.workspace, allowOutside: config.allowOutside, allowSecrets: config.allowSecrets });
    const notice = mentionNotice(mentioned);
    if (notice) line(style.dim(notice));
    controller = new AbortController();
    const renderer = createRenderer({ showThinking: process.env.AGENT_SHOW_THINKING === "1" });
    const onEvent = (event: AgentEvent): void => renderer(event);
    try {
      const outcome = await runAgent({
        config,
        task: mentioned.text,
        tools,
        budget,
        messages: messages.length ? messages : undefined,
        signal: controller.signal,
        // The operator answers from the input line whether the terminal is real or
        // the lines are piped, so this run always has someone to ask.
        attended: true,
        confirm: askApproval,
        ask: askQuestion,
        ...(options.mcp?.promptBrief() ? { systemExtra: options.mcp.promptBrief() } : {}),
        onEvent,
      });
      renderer.finish();
      messages = outcome.messages;
      saveSession(config, messages);
      if (!renderer.sawText() && outcome.text) line(outcome.text);
      line(
        style.dim(
          `— ${outcome.turns} turns · ${outcome.tokensIn + outcome.tokensOut} tokens · ${(outcome.ms / 1000).toFixed(1)}s` +
            `${outcome.stopped ? ` · ${outcome.stopped}` : ""}${outcome.denied ? ` · ${outcome.denied} declined` : ""}`,
        ),
      );
    } catch (cause) {
      renderer.finish();
      const error = cause as Error;
      if (error instanceof ProviderError) line(`${style.red("!")} ${error.message}${error.hint ? `\n${style.dim(error.hint)}` : ""}`);
      else line(`${style.red("!")} ${error.message}`);
    } finally {
      busy = false;
      controller = null;
      pendingApproval = null;
      const queued = queue.shift();
      if (queued) {
        line(style.dim(`now running the queued task: ${queued.slice(0, 80)}`));
        void executeTask(queued);
      } else if (!editor) {
        // A terminal keeps its prompt live while a run prints; a pipe has to hand
        // stdin back to readline, which stopped reading when the run started.
        rl?.prompt();
      }
    }
  }

  /**
   * The factory line inside the REPL. It carries its own budget and never merges
   * into the chat transcript: a station's history is its own, and the operator
   * reads the gate at the end instead of forty turns of tool results.
   */
  async function executeLine(task: string, resume: boolean): Promise<void> {
    if (busy) {
      line(style.dim("a run is already in flight — /stop first"));
      return;
    }
    if (!task && !resume) {
      line(style.dim("usage: /factory <task>   |   /line resume"));
      return;
    }
    busy = true;
    const mentioned = injectMentions(task ?? "", { workspace: config.workspace, allowOutside: config.allowOutside, allowSecrets: config.allowSecrets });
    const notice = mentionNotice(mentioned);
    if (notice) line(style.dim(notice));
    controller = new AbortController();
    const renderer = createRenderer({ showThinking: process.env.AGENT_SHOW_THINKING === "1" });
    try {
      const outcome = await runFactory({
        config,
        task: mentioned.text,
        resume,
        budget: createBudget(config.budgetMinutes),
        signal: controller.signal,
        attended: true,
        confirm: askApproval,
        ask: askQuestion,
        onEvent: (event) => renderer(event),
      });
      renderer.finish();
      line("");
      line(outcome.report);
      line(
        style.dim(
          `— ${outcome.turns} turns · ${outcome.tokensIn + outcome.tokensOut} tokens · ${(outcome.ms / 1000).toFixed(1)}s · ${outcome.gate.ok ? "gate passed" : "gate held"}` +
            `${outcome.denials ? ` · ${outcome.denials} declined` : ""}`,
        ),
      );
    } catch (cause) {
      renderer.finish();
      line(`${style.red("!")} ${(cause as Error).message}`);
    } finally {
      busy = false;
      controller = null;
      pendingApproval = null;
      if (!editor) rl?.prompt();
    }
  }

  function showLine(arg: string): void {
    if (/^(resume|continue)$/i.test(arg)) {
      void executeLine("", true);
      return;
    }
    const plan = loadPlan(config.workspace);
    if (!plan) {
      line(style.dim("no line on disk — /factory <task> starts one"));
      return;
    }
    const where = progress(plan);
    line(`${style.bold(plan.task.slice(0, 120))}`);
    line(style.dim(`${where.done}/${where.total} accepted${where.failed ? `, ${where.failed} failed` : ""} · .factory/plan.json`));
    line(planSummary(plan));
    const gate = shipGate(config.workspace, plan, readLog(config.workspace, 3_000));
    line(gate.ok ? style.green("gate: pass") : `${style.red("gate: held")}\n${gate.reasons.map((r) => `  x ${r}`).join("\n")}`);
  }

  /** One line of operator input, however it arrived. */
  async function handleMcp(arg: string): Promise<void> {
    const hub = options.mcp;
    if (!hub) {
      line(style.dim("MCP is not active in this session"));
      return;
    }
    const raw = arg.trim();
    const at = raw.search(/\s/);
    const action = at < 0 ? raw : raw.slice(0, at);
    const rest = at < 0 ? "" : raw.slice(at + 1).trim();
    if (!action) {
      line(style.bold(hub.summary()));
      for (const entry of formatStatuses(hub.statuses())) line(style.dim(`  ${entry}`));
      for (const warning of hub.warnings()) line(style.dim(`  ${warning}`));
      line(style.dim("  add: /mcp add <name> -- <command> [args...] · remove: /mcp remove <name>"));
      return;
    }
    if (action === "add") {
      const parsed = parseAdd(rest);
      if (!parsed.ok) {
        line(`${style.red("!")} ${parsed.error}`);
        return;
      }
      const result = await hub.add(parsed.command.name, parsed.command.entry, parsed.command.scope);
      line(result.ok ? `${style.green("✓")} ${result.message}` : `${style.red("!")} ${result.message}`);
      refreshTools();
      return;
    }
    if (action === "remove" || action === "rm") {
      if (!rest) {
        line(style.dim("usage: /mcp remove <server>"));
        return;
      }
      const result = await hub.remove(rest);
      line(result.ok ? `${style.green("✓")} ${result.message}` : `${style.red("!")} ${result.message}`);
      refreshTools();
      return;
    }
    if (action === "approve" || action === "restart") {
      if (action === "approve" && !rest) {
        line(style.dim("usage: /mcp approve <server>"));
        return;
      }
      const result = action === "approve" ? await hub.approve(rest) : await hub.restart(rest || undefined);
      line(result.ok ? `${style.green("✓")} ${result.message}` : `${style.red("!")} ${result.message}`);
      refreshTools();
      return;
    }
    line(style.dim("usage: /mcp · /mcp add <name> -- <command> · /mcp remove <server> · /mcp approve <server> · /mcp restart [server]"));
  }

  function handle(text: string): void {
    const input = text.trim();

    if (pendingApproval) {
      const answer: "yes" | "no" | "always" = /^(y|yes)$/i.test(input) ? "yes" : /^a(lways)?$/i.test(input) ? "always" : "no";
      const resolve = pendingApproval;
      pendingApproval = null;
      line(style.dim(`  → ${answer}`));
      resolve(answer);
      return;
    }

    if (!input) return;

    if (!input.startsWith("/")) {
      if (busy) {
        queue.push(input);
        line(style.dim(`queued as steering (${queue.length}). /stop ends the run first.`));
        return;
      }
      void executeTask(input);
      return;
    }

    const [command, ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (command) {
      case "exit":
      case "quit":
      case "q":
        shutdown();
        return;
      case "stop":
        if (controller) {
          controller.abort(new Error("stopped by operator"));
          line(style.yellow("stopping the run…"));
        } else line(style.dim("nothing is running"));
        break;
      case "factory":
        void executeLine(arg, false);
        return;
      case "line":
        showLine(arg);
        break;
      case "help":
        for (const [name, description] of HELP) line(`  ${style.bold(name.padEnd(18))} ${style.dim(description)}`);
        if (commands.length) {
          line(style.dim("  custom"));
          for (const entry of commands) line(`  ${style.bold(`/${entry.name}`.padEnd(18))} ${style.dim(`${entry.description} (${entry.scope})`)}`);
        }
        break;
      case "memory":
        for (const entry of memorySummary(loadMemory(config.workspace))) line(style.dim(entry));
        break;
      case "init": {
        const made = initMemory(config.workspace);
        if (!made.ok) line(`${style.red("!")} ${made.error}`);
        else line(`${style.green("✓")} ${made.created ? `wrote ${made.path} — fill in the rules` : `${made.path} already exists`}`);
        break;
      }
      case "model":
        if (!arg) line(style.dim(`current model: ${config.model}`));
        else {
          config = { ...config, model: arg };
          line(`${style.green("✓")} model → ${config.model} ${style.dim(isCloudModel(arg) ? "(billed by the provider)" : "(local)")}`);
        }
        break;
      case "budget": {
        const until = !arg || /^(until|done|0)$/i.test(arg);
        const minutes = until ? 0 : Number(arg);
        if (!until && (!Number.isFinite(minutes) || minutes <= 0)) {
          line(style.dim("usage: /budget 30   |   /budget until"));
          break;
        }
        budget = rebaseBudget(budget, until ? null : minutes);
        line(`${style.green("✓")} working time → ${formatBudget(budget.minutes)} (${budget.maxTurns} turns)`);
        break;
      }
      case "tools":
        for (const spec of tools) line(`  ${style.bold(spec.name.padEnd(18))} ${style.dim(`${spec.effect} · ${spec.description.split(".")[0]}.`)}`);
        break;
      case "mcp":
        void handleMcp(arg);
        break;
      case "log": {
        const entries = readLog(config.workspace, Number(arg) || 20);
        if (!entries.length) line(style.dim("no log yet — the first run writes it"));
        for (const entry of entries) {
          const time = new Date(entry.at).toLocaleTimeString();
          const label = entry.tool ?? entry.kind ?? "note";
          const detail = entry.error ?? `${entry.chars ?? entry.text ?? ""}`;
          line(`  ${style.dim(time)} ${style.bold(label.padEnd(16))} ${entry.ok === false ? style.red("✗") : style.green("✓")} ${style.dim(String(detail).slice(0, 90))}`);
        }
        break;
      }
      case "backups": {
        const entries = listBackups(config.workspace, 20);
        if (!entries.length) line(style.dim("no backups yet — a write creates the first one"));
        for (const entry of entries) line(`  ${style.dim(entry.id)} ${path.relative(config.workspace, entry.target)} ${style.dim(`(${entry.reason})`)}`);
        break;
      }
      case "undo": {
        if (!arg) {
          line(style.dim("usage: /undo <path or backup id>"));
          break;
        }
        const result = restore(config.workspace, arg);
        line(result.ok ? `${style.green("✓")} ${result.message}` : `${style.red("!")} ${result.error}`);
        break;
      }
      case "approve": {
        let tier: "ask" | "auto" | "full";
        if (!arg) tier = config.approvalLevel;
        else {
          const named = parseApprovalLevel(arg);
          if (!named) {
            line(`${style.red("!")} not a tier: ${arg} — ask, auto or full`);
            break;
          }
          tier = named;
        }
        config = { ...config, approvalLevel: tier, approvals: tier === "ask" };
        line(`${style.green("✓")} approvals ${tier} — ${TIER_LINE[tier]}`);
        break;
      }
      case "resume": {
        const loaded = loadSession(config);
        messages = loaded.length ? loaded : messages;
        line(loaded.length ? `${style.green("✓")} loaded ${loaded.length} messages` : style.dim("nothing saved"));
        break;
      }
      case "clear":
        messages = [];
        line(style.dim("new transcript (the saved one is still on disk; /resume brings it back)"));
        break;
      case "compact": {
        const result = compact(messages, 12);
        messages = result.messages;
        line(result.condensed ? `${style.green("✓")} condensed ${result.condensed} messages, ~${result.savedTokens} tokens saved` : style.dim("nothing worth condensing yet"));
        break;
      }
      case "workspace":
        config = { ...config, workspace: path.resolve(arg || config.workspace) };
        commands = loadCommands(config.workspace);
        line(`${style.green("✓")} workspace → ${config.workspace}`);
        break;
      case "models":
        listModels(config)
          .then((models) => {
            if (!models.length) line(style.dim("the daemon reports no models. Pull one: ollama pull <name>"));
            for (const model of models) line(`  ${style.bold(model.name.padEnd(30))} ${style.dim(model.cloud ? "cloud (billed)" : `${model.sizeGb} GB local`)}`);
          })
          .catch((cause) => line(`${style.red("!")} ${(cause as Error).message}`));
        break;
      case "config":
        line(describeConfig(config));
        line(style.dim(`context ${config.contextTokens} tokens · compact at ${Math.round(config.compactAtPercent * 100)}% · transcript ≈${estimateHistory(messages)} tokens now`));
        line(style.dim(`outside workspace: ${config.allowOutside ? "allowed" : "refused"} · secret files: ${config.allowSecrets ? "allowed" : "refused"}`));
        break;
      default: {
        const custom = matchCommand(input, commands);
        if (custom) {
          void executeTask(expandCommand(custom.command, custom.args));
          break;
        }
        line(style.dim(`unknown command /${command} — /help`));
      }
    }
  }

  if (rl) {
    rl.on("line", (text) => handle(text));
    rl.on("SIGINT", () => interrupt());
    rl.once("close", () => shutdown());
  }

  if (options.task) void executeTask(options.task);
  next();
}
