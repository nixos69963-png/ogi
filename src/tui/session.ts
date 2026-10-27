/**
 * The command brain behind the full-screen UI.
 *
 * `src/ui/repl.ts` grew its commands around a stream of lines: every command
 * *prints* as it goes, and a line of stdin is either an answer or a task. A
 * renderer that owns the whole screen does neither — it repaints, and a keypress
 * belongs to whichever pane has the keyboard. So the semantics live here, one
 * command per case, and hand up rows, a status phase, and two questions the screen
 * answers with an overlay.
 *
 * What stays out of this file on purpose: painting, keys, and any decision about
 * whether an action is allowed. The loop and the effect policy still decide that.
 * The session only carries a person's answer, and it never infers one from silence.
 */
import path from "node:path";
import { createBudget, formatBudget, rebaseBudget, type Budget } from "#core/budget.ts";
import { expandCommand, loadCommands, matchCommand, type CustomCommand } from "#core/commands.ts";
import { describeConfig, isCloudModel, parseApprovalLevel, readConfig, TIER_LINE } from "#core/config.ts";
import { compact, estimateHistory } from "#core/history.ts";
import { initMemory, loadMemory, memorySummary } from "#core/memory.ts";
import { run as runAgent } from "#core/loop.ts";
import { listModels, ProviderError, type AskOptions, type AssistantTurn } from "#core/provider.ts";
import { runFactory } from "#factory/foreman.ts";
import { loadPlan, planSummary, progress } from "#factory/plan.ts";
import { shipGate } from "#factory/artifacts.ts";
import { listBackups, restore } from "#guard/backup.ts";
import { readLog } from "#guard/log.ts";
import { injectMentions, mentionNotice } from "#guard/mentions.ts";
import { buildTools } from "#tools/index.ts";
import { formatStatuses, type McpHub } from "#mcp/hub.ts";
import { parseAdd } from "#mcp/setup.ts";
import { closeAllShells } from "#tools/shell.ts";
import { closeBrowser } from "#browser/cdp.ts";
import { HELP, loadSession, saveSession } from "#ui/repl.ts";
import type { AgentEvent, AppConfig, ApprovalAnswer, ApprovalRequest, Message, ToolSpec } from "#core/types.ts";
import { createTranscript } from "./transcript.ts";
import { markdownRows } from "./markdown.ts";
import { bold, dim, plain, row, simple, yellow, type Segment } from "./rows.ts";

export interface SessionHooks {
  /** One finished transcript row. */
  row(parts: Segment[]): void;
  /** One blank row, asked for at the start of a block so the blocks do not run together. */
  gap?(): void;
  /** What the agent is doing right now. Empty means idle: the timer stops. */
  status(text: string): void;
  /** May I? The screen answers; a refusal is a normal outcome. */
  approve(request: ApprovalRequest): Promise<ApprovalAnswer>;
  /** The model needs something a person knows. `null` means it does not get it. */
  ask(question: string, options: string[]): Promise<string | null>;
  /** A run started or ended, so the prompt can change what a bare line means. */
  busy?(busy: boolean): void;
  /** Stopped: any question still on the screen is answered "no" and cleared. */
  interrupted?(): void;
  /** Something the footer shows changed: model, budget, transcript size. */
  changed?(): void;
  /** `/exit` and the second Ctrl+C. The UI owns teardown; this only asks for it. */
  quit?(): void;
}

export interface SessionOptions {
  config?: AppConfig;
  tools?: ToolSpec[];
  /** External tools from MCP; their specs are added to the built-in set. */
  mcp?: McpHub;
  hooks: SessionHooks;
  /** The model's draft line on the status row, when the operator wants to read it. */
  showThinking?: boolean;
  /**
   * The provider call, injectable for the same reason it is in the loop: the whole
   * screen can then be proven against a script instead of a live model.
   */
  transport?: (cfg: AppConfig, options: AskOptions) => Promise<AssistantTurn>;
}

export interface SessionState {
  config: AppConfig;
  busy: boolean;
  messages: number;
  contextTokens: number;
  turns: number;
  tokens: number;
  ms: number;
  budget: string;
  queued: number;
}

export interface Session {
  /** A line of operator input: a task, steering, or a `/command`. */
  submit(text: string): void;
  /** Ctrl+C: stop the run in flight, and say so; idle, this is the first half of an exit. */
  interrupt(): void;
  state(): SessionState;
  /** The things this process opened and would otherwise leak. */
  dispose(): void;
}

export function createSession(options: SessionOptions): Session {
  const hooks = options.hooks;
  let config = options.config ?? readConfig();
  const baseTools = options.tools ?? buildTools();
  let tools: ToolSpec[] = [...baseTools, ...(options.mcp?.specs() ?? [])];
  const refreshTools = (): void => {
    tools = [...baseTools, ...(options.mcp?.specs() ?? [])];
  };
  let commands: CustomCommand[] = loadCommands(config.workspace);
  let budget: Budget | null = createBudget(config.budgetMinutes);
  let messages: Message[] = loadSession(config);

  let controller: AbortController | null = null;
  let queue: string[] = [];
  let busy = false;
  let ctrlCount = 0;
  let last = { turns: 0, tokens: 0, ms: 0 };

  /** Prose the operator reads, not markup they have to decode: a plain line goes
   *  through the markdown renderer, so a report's titles and points are on screen. */
  const say = (text: string, tone: "plain" | "dim" | "bold" | "red" | "yellow" | "green" | "cyan" = "plain"): void => {
    if (tone !== "plain") {
      for (const line of String(text).split("\n")) hooks.row(simple(line, tone));
      return;
    }
    for (const parts of markdownRows(text)) hooks.row(parts);
  };

  function setBusy(next: boolean): void {
    busy = next;
    hooks.busy?.(next);
    if (!next) hooks.status("");
  }

  /** Ends the run in flight, if there is one. Returns whether there was. */
  function stopRun(): boolean {
    if (!controller) return false;
    controller.abort(new Error("stopped by operator"));
    // A pane still waiting would hold the run open after it was stopped.
    hooks.interrupted?.();
    hooks.row(row(yellow("■"), dim(" stopping the run… the files and the transcript stay as they are")));
    return true;
  }

  function interrupt(): void {
    if (stopRun()) {
      ctrlCount = 0;
      return;
    }
    ctrlCount += 1;
    if (ctrlCount >= 2) {
      hooks.quit?.();
      return;
    }
    hooks.row(row(dim("(Ctrl+C again to quit, or /exit)")));
  }

  async function executeTask(task: string): Promise<void> {
    if (busy) {
      queue.push(task);
      hooks.row(row(dim(`queued as steering (${queue.length}) — runs after the current one`)));
      return;
    }
    setBusy(true);
    // "@src/app.py" is the operator handing over a file; the notice is what became context.
    const mentioned = injectMentions(task, { workspace: config.workspace, allowOutside: config.allowOutside, allowSecrets: config.allowSecrets });
    const notice = mentionNotice(mentioned);
    if (notice) hooks.row(row(dim(notice)));
    controller = new AbortController();
    const transcript = createTranscript(hooks, { showThinking: options.showThinking });
    try {
      const outcome = await runAgent({
        config,
        task: mentioned.text,
        tools,
        // This screen only exists because a person is at a keyboard, so the run is
        // attended even where stdin cannot say so itself.
        attended: true,
        budget,
        messages: messages.length ? messages : undefined,
        signal: controller.signal,
        confirm: hooks.approve,
        ask: hooks.ask,
        transport: options.transport,
        ...(options.mcp?.promptBrief() ? { systemExtra: options.mcp.promptBrief() } : {}),
        onEvent: (event: AgentEvent) => transcript.push(event),
      });
      transcript.finish();
      messages = outcome.messages;
      saveSession(config, messages);
      last = { turns: outcome.turns, tokens: outcome.tokensIn + outcome.tokensOut, ms: outcome.ms };
      if (!transcript.sawText() && outcome.text) say(outcome.text);
      hooks.row(
        row(
          dim("— "),
          dim(`${outcome.turns} turns · ${outcome.tokensIn + outcome.tokensOut} tokens · ${(outcome.ms / 1000).toFixed(1)}s`),
          ...(outcome.stopped ? [dim(" · "), yellow(outcome.stopped)] : []),
          ...(outcome.denied ? [dim(" · "), yellow(`${outcome.denied} declined`)] : []),
        ),
      );
    } catch (cause) {
      transcript.finish();
      if (cause instanceof ProviderError) {
        hooks.row(row(simple("! ", "red"), simple(cause.message, "yellow")));
        if (cause.hint) say(cause.hint, "dim");
      } else say((cause as Error).message, "red");
    } finally {
      controller = null;
      setBusy(false);
      hooks.changed?.();
      const queued = queue.shift();
      if (queued) {
        hooks.row(row(dim(`now running the queued task: ${queued.slice(0, 80)}`)));
        void executeTask(queued);
      }
    }
  }

  /**
   * The factory line. It keeps its own budget and never merges into the chat
   * transcript — a station's history is its own, and the operator reads the gate
   * at the end instead of forty turns of tool results.
   */
  async function executeLine(task: string, resume: boolean): Promise<void> {
    if (busy) {
      hooks.row(row(dim("a run is already in flight — stop it first")));
      return;
    }
    if (!task && !resume) {
      hooks.row(row(dim("usage: /factory <task>   |   /line resume")));
      return;
    }
    setBusy(true);
    const mentioned = injectMentions(task, { workspace: config.workspace, allowOutside: config.allowOutside, allowSecrets: config.allowSecrets });
    const notice = mentionNotice(mentioned);
    if (notice) hooks.row(row(dim(notice)));
    controller = new AbortController();
    const transcript = createTranscript(hooks, { showThinking: options.showThinking });
    try {
      const outcome = await runFactory({
        config,
        task: mentioned.text,
        attended: true,
        resume,
        budget: createBudget(config.budgetMinutes),
        signal: controller.signal,
        confirm: hooks.approve,
        ask: hooks.ask,
        transport: options.transport,
        onEvent: (event: AgentEvent) => transcript.push(event),
      });
      transcript.finish();
      last = { turns: outcome.turns, tokens: outcome.tokensIn + outcome.tokensOut, ms: outcome.ms };
      say("");
      say(outcome.report);
      hooks.row(
        row(
          dim("— "),
          dim(`${outcome.turns} turns · ${outcome.tokensIn + outcome.tokensOut} tokens · ${(outcome.ms / 1000).toFixed(1)}s · `),
          outcome.gate.ok ? bold("gate passed") : yellow("gate held"),
          ...(outcome.denials ? [dim(` · ${outcome.denials} declined`)] : []),
        ),
      );
    } catch (cause) {
      transcript.finish();
      say((cause as Error).message, "red");
    } finally {
      controller = null;
      setBusy(false);
      hooks.changed?.();
    }
  }

  function showLine(arg: string): void {
    if (/^(resume|continue)$/i.test(arg)) {
      void executeLine("", true);
      return;
    }
    const plan = loadPlan(config.workspace);
    if (!plan) {
      say("no line on disk — /factory <task> starts one", "dim");
      return;
    }
    const where = progress(plan);
    hooks.row(row(bold(plan.task.slice(0, 120))));
    say(`${where.done}/${where.total} accepted${where.failed ? `, ${where.failed} failed` : ""} · .factory/plan.json`, "dim");
    for (const line of planSummary(plan).split("\n")) {
      const mark = line.slice(0, 1);
      hooks.row(row(mark === "+" ? dim("+ ") : mark === "x" ? simple("x ", "red")[0]! : dim("  "), simple(line.slice(2), mark === "x" ? "red" : "plain")));
    }
    const gate = shipGate(config.workspace, plan, readLog(config.workspace, 3_000));
    if (gate.ok) say("gate: pass", "green");
    else {
      say("gate: held", "yellow");
      for (const reason of gate.reasons) hooks.row(row(dim("  x "), simple(reason, "yellow")));
    }
  }

  async function handleMcp(arg: string): Promise<void> {
    const hub = options.mcp;
    if (!hub) {
      say("MCP is not active in this session", "dim");
      return;
    }
    const raw = arg.trim();
    const at = raw.search(/\s/);
    const action = at < 0 ? raw : raw.slice(0, at);
    const rest = at < 0 ? "" : raw.slice(at + 1).trim();
    if (!action) {
      hooks.row(row(bold("MCP "), dim(hub.summary().replace(/^MCP: /, ""))));
      for (const entry of formatStatuses(hub.statuses())) hooks.row(row(dim(`  ${entry}`)));
      for (const warning of hub.warnings()) hooks.row(row(dim(`  ${warning}`)));
      hooks.row(row(dim("  add: /mcp add <name> -- <command> [args...] · remove: /mcp remove <name>")));
      return;
    }
    if (action === "add") {
      const parsed = parseAdd(rest);
      if (!parsed.ok) {
        say(parsed.error, "red");
        return;
      }
      const result = await hub.add(parsed.command.name, parsed.command.entry, parsed.command.scope);
      hooks.row(result.ok ? row(simple("✓ ", "green"), plain(result.message)) : row(simple("! ", "red"), simple(result.message, "red")));
      refreshTools();
      hooks.changed?.();
      return;
    }
    if (action === "remove" || action === "rm") {
      if (!rest) {
        say("usage: /mcp remove <server>", "dim");
        return;
      }
      const result = await hub.remove(rest);
      hooks.row(result.ok ? row(simple("✓ ", "green"), plain(result.message)) : row(simple("! ", "red"), simple(result.message, "red")));
      refreshTools();
      hooks.changed?.();
      return;
    }
    if (action === "approve" || action === "restart") {
      if (action === "approve" && !rest) {
        say("usage: /mcp approve <server>", "dim");
        return;
      }
      const result = action === "approve" ? await hub.approve(rest) : await hub.restart(rest || undefined);
      hooks.row(result.ok ? row(simple("✓ ", "green"), plain(result.message)) : row(simple("! ", "red"), simple(result.message, "red")));
      refreshTools();
      hooks.changed?.();
      return;
    }
    say("usage: /mcp · /mcp add <name> -- <command> · /mcp remove <server> · /mcp approve <server> · /mcp restart [server]", "dim");
  }

  function submit(text: string): void {
    const input = text.trim();
    if (!input) return;

    if (!input.startsWith("/")) {
      if (busy) {
        queue.push(input);
        hooks.row(row(dim(`queued as steering (${queue.length}). Stop the run first to change what it is doing.`)));
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
        hooks.quit?.();
        return;
      case "stop":
        if (!stopRun()) say("nothing is running", "dim");
        break;
      case "factory":
        void executeLine(arg, false);
        return;
      case "line":
        showLine(arg);
        break;
      case "help":
        for (const [name, description] of HELP) hooks.row(row(bold(name.padEnd(18)), dim(` ${description}`)));
        if (commands.length) {
          hooks.row(row(dim("custom")));
          for (const command of commands) hooks.row(row(bold(`/${command.name}`.padEnd(18)), dim(` ${command.description} (${command.scope})`)));
        }
        break;
      case "memory":
        for (const entry of memorySummary(loadMemory(config.workspace))) hooks.row(row(dim(entry)));
        break;
      case "init": {
        const made = initMemory(config.workspace);
        hooks.row(
          made.ok
            ? row(simple("✓ ", "green"), dim(made.created ? `wrote ${made.path} — fill in the rules` : `${made.path} already exists`))
            : row(simple("! ", "red"), simple(String(made.error), "red")),
        );
        break;
      }
      case "model":
        if (!arg) say(`current model: ${config.model}`, "dim");
        else {
          config = { ...config, model: arg };
          hooks.row(row(simple("✓ ", "green"), dim(`model → ${config.model} (${isCloudModel(arg) ? "billed by the provider" : "local"})`)));
        }
        hooks.changed?.();
        break;
      case "budget": {
        const until = !arg || /^(until|done|0)$/i.test(arg);
        const minutes = until ? 0 : Number(arg);
        if (!until && (!Number.isFinite(minutes) || minutes <= 0)) {
          say("usage: /budget 30   |   /budget until", "dim");
          break;
        }
        budget = rebaseBudget(budget, until ? null : minutes);
        hooks.row(row(simple("✓ ", "green"), dim(`working time → ${formatBudget(budget.minutes)} (${budget.maxTurns} turns)`)));
        hooks.changed?.();
        break;
      }
      case "tools":
        for (const spec of tools) hooks.row(row(bold(spec.name.padEnd(18)), dim(` ${spec.effect} · ${spec.description.split(".")[0]}.`)));
        break;
      case "mcp":
        void handleMcp(arg);
        break;
      case "log": {
        const entries = readLog(config.workspace, Number(arg) || 20);
        if (!entries.length) say("no log yet — the first run writes it", "dim");
        for (const entry of entries) {
          const time = new Date(entry.at).toLocaleTimeString();
          const label = entry.tool ?? entry.kind ?? "note";
          const detail = entry.error ?? `${entry.chars ?? entry.text ?? ""}`;
          hooks.row(
            row(
              dim(`${time} `),
              bold(String(label).padEnd(16)),
              entry.ok === false ? simple(" ✗ ", "red") : simple(" ✓ ", "green"),
              dim(String(detail).slice(0, 90)),
            ),
          );
        }
        break;
      }
      case "backups": {
        const entries = listBackups(config.workspace, 20);
        if (!entries.length) say("no backups yet — a write creates the first one", "dim");
        for (const entry of entries) {
          hooks.row(row(dim(entry.id), plain(` ${path.relative(config.workspace, entry.target)}`), dim(` (${entry.reason})`)));
        }
        break;
      }
      case "undo": {
        if (!arg) {
          say("usage: /undo <path or backup id>", "dim");
          break;
        }
        const result = restore(config.workspace, arg);
        hooks.row(result.ok ? row(simple("✓ ", "green"), plain(result.message)) : row(simple("! ", "red"), simple(String(result.error), "red")));
        hooks.changed?.();
        break;
      }
      case "approve": {
        // A bare `/approve` reports the tier instead of moving to the next one.
        let tier: "ask" | "auto" | "full";
        if (!arg) tier = config.approvalLevel;
        else {
          const named = parseApprovalLevel(arg);
          if (!named) {
            say(`not a tier: ${arg} — ask, auto or full`, "red");
            break;
          }
          tier = named;
        }
        config = { ...config, approvalLevel: tier, approvals: tier === "ask" };
        hooks.row(row(simple("✓ ", "green"), dim(`approvals ${tier} — ${TIER_LINE[tier]}`)));
        hooks.changed?.();
        break;
      }
      case "resume": {
        const loaded = loadSession(config);
        messages = loaded.length ? loaded : messages;
        hooks.row(loaded.length ? row(simple("✓ ", "green"), dim(`loaded ${loaded.length} messages`)) : row(dim("nothing saved")));
        hooks.changed?.();
        break;
      }
      case "clear":
        messages = [];
        say("new transcript (the saved one is still on disk; /resume brings it back)", "dim");
        hooks.changed?.();
        break;
      case "compact": {
        const result = compact(messages, 12);
        messages = result.messages;
        hooks.row(
          result.condensed
            ? row(simple("✓ ", "green"), dim(`condensed ${result.condensed} messages, ~${result.savedTokens} tokens saved`))
            : row(dim("nothing worth condensing yet")),
        );
        hooks.changed?.();
        break;
      }
      case "workspace":
        config = { ...config, workspace: path.resolve(arg || config.workspace) };
        commands = loadCommands(config.workspace);
        hooks.row(row(simple("✓ ", "green"), dim(`workspace → ${config.workspace}`)));
        hooks.changed?.();
        break;
      case "models":
        listModels(config)
          .then((models) => {
            if (!models.length) say("the daemon reports no models. Pull one: ollama pull <name>", "dim");
            for (const model of models) {
              hooks.row(row(bold(model.name.padEnd(30)), dim(` ${model.cloud ? "cloud (billed)" : `${model.sizeGb} GB local`}`)));
            }
          })
          .catch((cause: Error) => say(cause.message, "red"));
        break;
      case "config":
        say(describeConfig(config));
        say(`context ${config.contextTokens} tokens · compact at ${Math.round(config.compactAtPercent * 100)}% · transcript ≈${estimateHistory(messages)} tokens now`, "dim");
        say(`outside workspace: ${config.allowOutside ? "allowed" : "refused"} · secret files: ${config.allowSecrets ? "allowed" : "refused"}`, "dim");
        break;
      default: {
        const custom = matchCommand(input, commands);
        if (custom) {
          void executeTask(expandCommand(custom.command, custom.args));
          return;
        }
        hooks.row(row(dim(`unknown command /${command} — /help`)));
      }
    }
  }

  return {
    submit,
    interrupt,
    state: () => ({
      config,
      busy,
      messages: messages.length,
      contextTokens: estimateHistory(messages),
      turns: last.turns,
      tokens: last.tokens,
      ms: last.ms,
      budget: formatBudget(budget?.minutes ?? null),
      queued: queue.length,
    }),
    dispose() {
      controller?.abort(new Error("exiting"));
      closeAllShells();
      // Only puts away the Chrome this session launched; one the operator was
      // already using is left running.
      closeBrowser();
    },
  };
}
