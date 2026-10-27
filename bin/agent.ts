#!/usr/bin/env bun
/**
 * agent — the command line.
 *
 * Two ways in: a REPL for working alongside the agent, and `agent do "task"` for a
 * single unattended run you can put in a script. `do` is deliberately the strict
 * mode: nobody is watching, so outward actions are refused and writes need --yes.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBudget, formatBudget } from "#core/budget.ts";
import { APPROVAL_LEVELS, describeConfig, isCloudModel, readConfig, TIER_LINE } from "#core/config.ts";
import { run as runAgent } from "#core/loop.ts";
import { runFactory } from "#factory/foreman.ts";
import { listModels, ProviderError } from "#core/provider.ts";
import { listBackups, restore } from "#guard/backup.ts";
import { readLog } from "#guard/log.ts";
import { browserHint, closeBrowser, findChrome } from "#browser/cdp.ts";
import { closeAllShells, findBash } from "#tools/shell.ts";
import { workspaceExists } from "#guard/path_guard.ts";
import type { AppConfig, ApprovalLevel } from "#core/types.ts";
import { buildTools } from "#tools/index.ts";
import { loadMcpConfig, maskEntry, readServerFile, serverFile, validateServerEntry, writeServerFile, type McpServerConfig } from "#mcp/config.ts";
import { connectServer } from "#mcp/client.ts";
import { McpHub } from "#mcp/hub.ts";
import { approveServer, isTrusted, projectTrustBypass, revokeServer } from "#mcp/trust.ts";
import { loadPlugins } from "#core/plugins.ts";
import { userAgentHome } from "#core/memory.ts";
import { redact } from "#guard/redact.ts";
import { startRepl } from "#ui/repl.ts";
import { line, setTitle, style } from "#ui/terminal.ts";

const USAGE = `agent — a local working agent on your own machine

  agent                      talk to it (full screen; @<path> hands over a file)
  agent do "task"            one unattended run, then exit
  agent factory "task"       run the task through the factory line
  agent models               what this ollama daemon can run
  agent config               the settings the agent resolved
  agent doctor               check the machine before the first run
  agent log [n]              recent actions it took
  agent backups              files it can put back
  agent undo <path|id>       put one back
  agent mcp list             configured MCP servers and whether they may run
  agent mcp add <name> -- <command> [args...]
                             add a stdio server (user scope; --project for this repo)
  agent mcp add-json <name> '<json>' [--project]
  agent mcp get <name>       the entry with secrets masked
  agent mcp test <name>      connect now and list its tools
  agent mcp approve <name>   approve a project server's current entry
  agent mcp remove <name>    delete a server entry (not one a plugin supplies)
  agent plugin list          plugins found in ~/.agent/plugins and .agent/plugins
  agent plugin add <path>    install a plugin folder (user scope; --project for this repo)

options
  -w, --workspace <dir>      project to work in            (default: cwd)
  -m, --model <name>         ollama model                  (default: $AGENT_MODEL)
  -b, --budget <min|until>   working time for the run
  -y, --yes                  run the routine work unasked  (outward still asks)
      --approve <tier>       ask · auto · full             (see agent config)
      --full-access          the same as --approve full: every write in the
                             project runs; the system, an irreplaceable file and
                             anything another person would see still stop there
      --classic              the scrolling line UI instead of the full screen
      --tui                  insist on the full screen here
      --json                 machine-readable result for ` + "`do` and `factory`" + `
      --file <path>          read the task from a file
      --resume               factory: continue the line in .factory/plan.json
  --project                  mcp/plugin: act on this workspace instead of your home
  -t, --transport <kind>     mcp add: stdio, http or sse
  --url <url>                mcp add: the URL of an http or sse server
  -e, --env KEY=VALUE        mcp add: an environment variable (repeatable)
  -H, --header KEY: VALUE    mcp add: a request header (repeatable)
  --allow <tool[,tool]>      mcp add: tools that run without asking (repeatable)
  --timeout <seconds>        mcp add: per-call timeout (default 120)
  --                         mcp add: everything after this is the command line
  -h, --help                 this text
`;

interface McpFlags {
  transport?: "stdio" | "http" | "sse";
  url?: string;
  env: string[];
  headers: string[];
  allow: string[];
  timeoutSeconds?: number;
}

interface Cli {
  command: string;
  task: string;
  /** The non-flag words, kept as argv entries: an MCP command line must not be re-joined. */
  args: string[];
  scope: "user" | "project";
  mcpFlags: McpFlags;
  overrides: Partial<AppConfig>;
  json: boolean;
  resume: boolean;
  help: boolean;
  classic: boolean;
  tui: boolean;
}

function parseArgs(argv: string[]): Cli {
  const rest: string[] = [];
  const overrides: Partial<AppConfig> = {};
  let command = "chat";
  let json = false;
  let resume = false;
  let help = false;
  let classic = false;
  let tui = false;
  let taskFile = "";
  let scope: "user" | "project" = "user";
  const mcpFlags: McpFlags = { env: [], headers: [], allow: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
      case "help":
        help = true;
        break;
      case "-w":
      case "--workspace":
        overrides.workspace = path.resolve(next());
        break;
      case "-m":
      case "--model":
        overrides.model = next();
        break;
      case "-b":
      case "--budget": {
        // One value, read once: calling next() twice here ate the following flag.
        const value = next();
        if (/^(until|done|0)$/i.test(value)) overrides.budgetMinutes = null;
        else {
          const minutes = Number(value);
          if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`-b needs a number of minutes or "until", got "${value}".`);
          overrides.budgetMinutes = minutes;
        }
        break;
      }
      case "-y":
      case "--yes":
        overrides.approvalLevel = "auto";
        break;
      case "--approve": {
        const tier = next();
        if (!APPROVAL_LEVELS.has(tier)) throw new Error(`--approve takes ask, auto or full — not "${tier}".`);
        overrides.approvalLevel = tier as ApprovalLevel;
        break;
      }
      case "--full-access":
        overrides.approvalLevel = "full";
        break;
      case "--json":
        json = true;
        break;
      case "--classic":
        classic = true;
        break;
      case "--tui":
        tui = true;
        break;
      case "--file":
        taskFile = next();
        break;
      case "--resume":
        resume = true;
        break;
      case "--project":
        scope = "project";
        break;
      case "-t":
      case "--transport": {
        const kind = next();
        if (kind !== "stdio" && kind !== "http" && kind !== "sse") throw new Error(`--transport takes stdio, http or sse — not "${kind}".`);
        mcpFlags.transport = kind;
        break;
      }
      case "--url":
        mcpFlags.url = next();
        break;
      case "-e":
      case "--env":
        mcpFlags.env.push(next());
        break;
      case "-H":
      case "--header":
        mcpFlags.headers.push(next());
        break;
      case "--allow":
        mcpFlags.allow.push(next());
        break;
      case "--timeout": {
        const seconds = Number(next());
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout takes a positive number of seconds.");
        mcpFlags.timeoutSeconds = seconds;
        break;
      }
      case "--":
        // Everything after this belongs to a command the CLI does not parse.
        rest.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        if (arg === "do" || arg === "factory" || arg === "chat" || arg === "models" || arg === "config" || arg === "doctor" || arg === "log" || arg === "backups" || arg === "undo" || arg === "mcp" || arg === "plugin") {
          command = arg;
        } else if (arg.startsWith("-")) {
          throw new Error(`Unknown option ${arg}. Run \`agent --help\`.`);
        } else rest.push(arg);
    }
  }

  let task = rest.join(" ").trim();
  if (taskFile) task = readFileSync(taskFile, "utf8").trim();
  return { command, task, args: rest, scope, mcpFlags, overrides, json, resume, help, classic, tui };
}

function budgetMinutes(overrides: Partial<AppConfig>): number | null {
  return overrides.budgetMinutes ?? readConfig().budgetMinutes;
}

async function commandDo(config: AppConfig, task: string, json: boolean): Promise<number> {
  if (!task) {
    line(`${style.red("agent do")} needs a task. \`agent do "add a --json flag to the parser"\``);
    return 2;
  }
  // `do` prints no prompt and takes no answer, on a terminal or anywhere else. The
  // run has no one to ask, so a step that was held back stays held back.
  const attended = false;
  const budget = createBudget(config.budgetMinutes);
  // MCP servers are external tools: connecting them is part of starting the run,
  // and the status is printed so a missing tool is never a silent mystery.
  const hub = new McpHub(config.workspace);
  await hub.start();
  const tools = [...buildTools(), ...hub.specs()];
  const mcpBrief = hub.promptBrief();
  if (!json && hub.statuses().length) {
    line(style.dim(hub.summary()));
    for (const warning of hub.warnings()) line(style.dim(`! ${warning}`));
    for (const status of hub.statuses()) {
      if (status.state === "failed") line(style.red(`! ${status.config.name}: ${status.error}`));
    }
  }
  try {
    if (json) {
      const outcome = await runAgent({ config, task, tools, budget, attended, ...(mcpBrief ? { systemExtra: mcpBrief } : {}), onEvent: () => {} });
      process.stdout.write(`${JSON.stringify({ text: outcome.text, turns: outcome.turns, tokens: outcome.tokensIn + outcome.tokensOut, stopped: outcome.stopped, denied: outcome.denied }, null, 2)}\n`);
      return outcome.stopped && !outcome.text ? 1 : 0;
    }
    const renderer = (await import("#ui/render.ts")).createRenderer({ showThinking: process.env.AGENT_SHOW_THINKING === "1" });
    line(style.dim(`› ${task.slice(0, 200)}`));
    line(style.dim(`${describeConfig(config)} · unattended: ${!attended}`));
    const outcome = await runAgent({ config, task, tools, budget, attended, ...(mcpBrief ? { systemExtra: mcpBrief } : {}), onEvent: renderer });
    renderer.finish();
    if (!renderer.sawText() && outcome.text) line(outcome.text);
    line(style.dim(`— ${outcome.turns} turns · ${outcome.tokensIn + outcome.tokensOut} tokens · ${(outcome.ms / 1000).toFixed(1)}s${outcome.stopped ? ` · ${outcome.stopped}` : ""}`));
    return outcome.stopped && !outcome.text ? 1 : 0;
  } finally {
    // A spawned Chrome and the persistent bash session would each keep this
    // process alive forever, and both are the agent's own to put away.
    await hub.stop();
    closeAllShells();
    closeBrowser();
  }
}

/**
 * The factory line. `do` is one agent carrying one transcript; this plans the task
 * as typed stations, gives each station its own transcript and tool list, and ends
 * at a gate. Exit code 1 means the gate held, so a script can branch on it.
 */
async function commandFactory(config: AppConfig, task: string, json: boolean, resume: boolean): Promise<number> {
  if (!task && !resume) {
    line(`${style.red("agent factory")} needs a task, or --resume. \`agent factory "add a --json flag to the parser"\``);
    return 2;
  }
  // The line is a build: each station gets its own transcript and no channel back
  // to a person, so it runs the way `do` does.
  const attended = false;
  const budget = createBudget(config.budgetMinutes);
  try {
    if (json) {
      const outcome = await runFactory({ config, task, budget, attended, resume, onEvent: () => {} });
      process.stdout.write(
        `${JSON.stringify(
          {
            report: outcome.report,
            gate: outcome.gate,
            plan: outcome.plan,
            turns: outcome.turns,
            tokens: outcome.tokensIn + outcome.tokensOut,
            stopped: outcome.stopped,
            denied: outcome.denials,
          },
          null,
          2,
        )}\n`,
      );
      return outcome.gate.ok ? 0 : 1;
    }
    const renderer = (await import("#ui/render.ts")).createRenderer({ showThinking: process.env.AGENT_SHOW_THINKING === "1" });
    line(style.dim(`› factory: ${(task || "(resuming the line on disk)").slice(0, 200)}`));
    line(style.dim(`${describeConfig(config)} · unattended: ${!attended}`));
    const outcome = await runFactory({ config, task, budget, attended, resume, onEvent: renderer });
    renderer.finish();
    line("");
    line(outcome.report);
    line(
      style.dim(
        `— ${outcome.turns} turns · ${outcome.tokensIn + outcome.tokensOut} tokens · ${(outcome.ms / 1000).toFixed(1)}s · ${outcome.gate.ok ? "gate passed" : "gate held"}`,
      ),
    );
    return outcome.gate.ok ? 0 : 1;
  } finally {
    // A spawned Chrome and the persistent bash session would each keep this
    // process alive forever, and both are the agent's own to put away.
    closeAllShells();
    closeBrowser();
  }
}

async function commandModels(config: AppConfig): Promise<number> {
  try {
    const models = await listModels(config);
    if (!models.length) {
      line("The daemon is running but has no model. Pull one:");
      line(`  ollama pull ${config.model}`);
      return 0;
    }
    for (const model of models) {
      const marker = model.name === config.model ? style.green("→") : " ";
      line(`${marker} ${style.bold(model.name.padEnd(30))} ${style.dim(model.cloud ? "cloud (billed per token)" : `${model.sizeGb} GB local`)}`);
    }
    line(style.dim(`\n${models.length} models · ${config.baseUrl}`));
    return 0;
  } catch (cause) {
    const error = cause as ProviderError;
    line(`${style.red("!")} ${error.message}`);
    if (error.hint) line(style.dim(error.hint));
    return 1;
  }
}

async function commandDoctor(config: AppConfig): Promise<number> {
  const bash = findBash();
  const ollama = spawnSync("ollama", ["--version"], { encoding: "utf8" });
  let served: { name: string; cloud: boolean }[] = [];
  let reachable = false;
  try {
    served = await listModels(config);
    reachable = true;
  } catch {
    reachable = false;
  }
  const have = served.some((model) => model.name === config.model || model.name.startsWith(`${config.model}:`));
  const chrome = findChrome();

  const checks: [string, boolean, string][] = [
    ["runtime", true, `bun ${process.versions.bun ?? "?"} · node ${process.version}`],
    ["workspace", workspaceExists(config.workspace).ok, config.workspace],
    ["git bash", bash !== null, bash ?? "install Git for Windows, or set AGENT_BASH to bash.exe"],
    ["ollama cli", ollama.status === 0, (ollama.stdout ?? "").trim() || "ollama not on PATH"],
    ["daemon", reachable, reachable ? `${config.baseUrl} · ${served.length} models` : `${config.baseUrl} is not answering — run: ollama serve`],
    [
      "model",
      have || isCloudModel(config.model),
      have
        ? `${config.model}${isCloudModel(config.model) ? " (billed by the provider)" : " (local)"}`
        : isCloudModel(config.model)
          ? `${config.model} · cloud tier — /api/tags does not list it, so this check cannot prove it; the first call reaches the provider`
          : `${config.model} is not here${reachable ? ` — pull it: ollama pull ${config.model}` : ""}`,
    ],
    ["chrome", chrome !== null, chrome ? browserHint(config.workspace) : "no Chrome found — browser tools stay off (set AGENT_BROWSER_EXECUTABLE)"],
    [
      "github",
      Boolean(config.githubToken),
      `${config.githubToken ? "token set — writes possible, still gated" : "no token — reads only, 60/hour"}` +
        ` · ${config.githubRepo ? `default repo ${config.githubRepo}` : "no default repo — run inside a git checkout or pass repo:"}`,
    ],
    ["approvals", config.approvals, `tier "${config.approvalLevel}" — ${TIER_LINE[config.approvalLevel]}`],
  ];

  line(style.bold("doctor"));
  let problems = 0;
  for (const [name, passed, detail] of checks) {
    line(`  ${passed ? style.green("✓") : style.red("✗")} ${style.bold(name.padEnd(15))} ${style.dim(detail)}`);
    if (!passed) problems += 1;
  }
  if (problems) line(style.dim(`\n${problems} thing(s) to fix. Until you do, the matching tools stay off or reduced.`));
  else line(style.dim("\nready."));
  return problems ? 1 : 0;
}

function commandLog(config: AppConfig, limit: number): number {
  const entries = readLog(config.workspace, limit);
  if (!entries.length) {
    line("No actions logged yet. The log lives at .agent/log/<date>.jsonl and is written by every tool call.");
    return 0;
  }
  for (const entry of entries) {
    const time = new Date(entry.at).toLocaleString();
    line(`${style.dim(time)}  ${style.bold((entry.tool ?? entry.kind ?? "note").padEnd(16))} ${entry.ok === false ? style.red("✗") : style.green("✓")} ${style.dim(entry.error ?? `${entry.chars ?? entry.text ?? ""}`)}`);
  }
  return 0;
}

function commandBackups(config: AppConfig): number {
  const entries = listBackups(config.workspace, 40);
  if (!entries.length) {
    line("No backups yet. Every write_file/edit_file copies the previous bytes to .agent/backups first.");
    return 0;
  }
  for (const entry of entries) {
    line(`${style.dim(entry.id)}  ${path.relative(config.workspace, entry.target)}  ${style.dim(`${entry.bytes} bytes · ${entry.reason}`)}`);
  }
  return 0;
}

function commandUndo(config: AppConfig, target: string): number {
  if (!target) {
    line("usage: agent undo <path or backup id>   (see `agent backups`)");
    return 2;
  }
  const result = restore(config.workspace, target);
  line(result.ok ? `${style.green("✓")} ${result.message}` : `${style.red("!")} ${result.error}`);
  return result.ok ? 0 : 1;
}

/**
 * The talk-to-it path: the full screen when the terminal can hold one, the
 * scrolling line UI otherwise. `--classic` always takes the line, `--tui` always
 * asks for the screen — and if the screen cannot start, this says so and falls
 * back instead of leaving the operator with nothing.
 */
async function commandChat(config: AppConfig, task: string, flags: { classic: boolean; tui: boolean }): Promise<void> {
  // A conversation outlives one task, so the servers stay connected for as long
  // as the screen does and go away with it.
  const hub = new McpHub(config.workspace);
  await hub.start();
  if (hub.statuses().length) {
    line(style.dim(hub.summary()));
    for (const warning of hub.warnings()) line(style.yellow(`! ${warning}`));
    for (const error of hub.errors()) line(style.yellow(`! ${error}`));
  }
  const blocked = flags.classic || process.env.AGENT_CLASSIC === "1" || process.env.NO_TUI === "1";
  if (!blocked) {
    const tui = await import("#tui/app.ts");
    if (flags.tui || tui.tuiPossible()) {
      try {
        await tui.startTui({
          config,
          task: task || undefined,
          mcp: hub,
          showThinking: process.env.AGENT_SHOW_THINKING === "1",
          onExit: () => {
            void hub.stop();
            closeAllShells();
            closeBrowser();
          },
        });
        return;
      } catch (cause) {
        line(style.dim(`full screen unavailable (${(cause as Error).message}) — using the line UI`));
      }
    }
  }
  startRepl({ config, task: task || undefined, mcp: hub });
}

// ─── agent mcp / agent plugin ────────────────────────────────────────────────

const MCP_USAGE = `agent mcp list
agent mcp add <name> [--transport stdio|http|sse] [--url <url>] [-e KEY=VALUE] [-H "Name: value"] [--allow tool] [--timeout seconds] [--project] -- <command> [args...]
agent mcp add-json <name> '<json>' [--project]
agent mcp get <name>
agent mcp test <name>
agent mcp approve <name>
agent mcp remove <name> [--project]`;

function pairs(values: string[], kind: "env" | "header"): { ok: true; map: Record<string, string> } | { ok: false; error: string } {
  const map: Record<string, string> = {};
  for (const raw of values) {
    const at = raw.indexOf(kind === "env" ? "=" : ":");
    if (at <= 0) {
      return { ok: false, error: kind === "env" ? `--env takes KEY=VALUE, got "${raw}"` : `--header takes "Name: value", got "${raw}"` };
    }
    map[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
  }
  return { ok: true, map };
}

function serverState(server: McpServerConfig): string {
  if (server.disabled) return "disabled";
  if (server.origin === "user" || projectTrustBypass() || isTrusted(server)) return "trusted";
  return "pending";
}

function whereOf(config: AppConfig, source: string): string {
  const relative = path.relative(config.workspace, source);
  return relative && !relative.startsWith("..") ? relative : source;
}

function mcpList(config: AppConfig): number {
  const loaded = loadMcpConfig(config.workspace);
  if (!loaded.servers.length) {
    line(style.dim("no MCP servers configured"));
  } else {
    for (const server of loaded.servers) {
      const state = serverState(server);
      const painted = state === "trusted" ? style.green(state) : state === "pending" ? style.yellow(state) : style.dim(state);
      const where = server.plugin ? `plugin:${server.plugin}` : whereOf(config, server.source);
      line(`${style.bold(server.name.padEnd(28))} ${painted.padEnd(17)} ${style.dim(`${server.type.padEnd(6)} ${where}`)}`);
    }
  }
  for (const warning of loaded.warnings) line(style.dim(`! ${warning}`));
  for (const error of loaded.errors) line(style.red(`! ${error}`));
  return loaded.errors.length ? 1 : 0;
}

async function mcpAdd(config: AppConfig, cli: Cli, name: string | undefined, tail: string[]): Promise<number> {
  if (!name) {
    line(style.dim(MCP_USAGE));
    return 2;
  }
  const file = serverFile(config.workspace, cli.scope);
  const current = readServerFile(file);
  if (!current.ok) {
    line(style.red(`! ${current.error}`));
    return 1;
  }
  if (current.value.servers[name]) {
    line(style.red(`! "${name}" already exists in ${file} — remove it first`));
    return 1;
  }

  const wanted = cli.mcpFlags.transport ?? (cli.mcpFlags.url ? "http" : "stdio");
  if (wanted === "stdio" && cli.mcpFlags.url) {
    line(style.red("! --url is for http or sse servers; a stdio server takes a command after --"));
    return 2;
  }
  if (wanted !== "stdio" && tail.length) {
    line(style.red("! an http or sse server takes --url, not a command"));
    return 2;
  }
  if (wanted === "stdio" && !tail.length) {
    line(style.red("! a stdio server needs a command: agent mcp add <name> -- <command> [args...]"));
    return 2;
  }
  if (wanted !== "stdio" && !cli.mcpFlags.url) {
    line(style.red("! an http or sse server needs --url"));
    return 2;
  }

  const entry: Record<string, unknown> = wanted === "stdio"
    ? { type: "stdio", command: tail[0], args: tail.slice(1) }
    : { type: wanted, url: cli.mcpFlags.url };
  const env = pairs(cli.mcpFlags.env, "env");
  if (!env.ok) {
    line(style.red(`! ${env.error}`));
    return 2;
  }
  const headers = pairs(cli.mcpFlags.headers, "header");
  if (!headers.ok) {
    line(style.red(`! ${headers.error}`));
    return 2;
  }
  if (Object.keys(env.map).length) entry.env = env.map;
  if (Object.keys(headers.map).length) entry.headers = headers.map;
  if (cli.mcpFlags.allow.length) {
    entry.allow = cli.mcpFlags.allow.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  }
  if (cli.mcpFlags.timeoutSeconds) entry.timeout_ms = Math.round(cli.mcpFlags.timeoutSeconds * 1_000);

  const checked = validateServerEntry(name, entry, cli.scope);
  if (!checked.ok) {
    line(style.red(`! ${checked.error}`));
    return 2;
  }
  for (const warning of checked.warnings) line(style.dim(`! ${warning}`));
  current.value.servers[name] = entry;
  writeServerFile(current.value);
  line(`${style.green("✓")} wrote ${name} to ${file}`);
  if (cli.scope === "project") {
    line(style.dim(`  project servers do not run until approved: agent mcp approve ${name}`));
  }
  return 0;
}

function mcpAddJson(config: AppConfig, cli: Cli, name: string | undefined, tail: string[]): number {
  if (!name || !tail.length) {
    line(style.dim("usage: agent mcp add-json <name> '<json>' [--project]"));
    return 2;
  }
  let entry: unknown;
  try {
    entry = JSON.parse(tail.join(" "));
  } catch (cause) {
    line(style.red(`! the JSON did not parse: ${(cause as Error).message}`));
    return 2;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    line(style.red("! the entry must be a JSON object"));
    return 2;
  }
  const file = serverFile(config.workspace, cli.scope);
  const current = readServerFile(file);
  if (!current.ok) {
    line(style.red(`! ${current.error}`));
    return 1;
  }
  if (current.value.servers[name]) {
    line(style.red(`! "${name}" already exists in ${file} — remove it first`));
    return 1;
  }
  const checked = validateServerEntry(name, entry as Record<string, unknown>, cli.scope);
  if (!checked.ok) {
    line(style.red(`! ${checked.error}`));
    return 2;
  }
  for (const warning of checked.warnings) line(style.dim(`! ${warning}`));
  current.value.servers[name] = entry;
  writeServerFile(current.value);
  line(`${style.green("✓")} wrote ${name} to ${file}`);
  if (cli.scope === "project") line(style.dim(`  project servers do not run until approved: agent mcp approve ${name}`));
  return 0;
}

function mcpGet(config: AppConfig, name: string | undefined): number {
  if (!name) {
    line(style.dim("usage: agent mcp get <name>"));
    return 2;
  }
  const loaded = loadMcpConfig(config.workspace);
  const server = loaded.servers.find((entry) => entry.name === name);
  if (!server) {
    line(style.red(`! there is no MCP server named "${name}"`));
    for (const error of loaded.errors) line(style.dim(`  ${error}`));
    return 1;
  }
  const raw: Record<string, unknown> = {
    type: server.type,
    ...(server.command ? { command: server.command } : {}),
    args: server.args,
    ...(server.url ? { url: server.url } : {}),
    env: server.env,
    headers: server.headers,
    allow: server.allow,
    timeout_ms: server.timeoutMs,
    disabled: server.disabled,
  };
  line(style.dim(`${serverState(server)} · ${whereOf(config, server.source)}`));
  line(redact(JSON.stringify(maskEntry(raw), null, 2)).text);
  return 0;
}

function mcpRemove(config: AppConfig, cli: Cli, name: string | undefined): number {
  if (!name) {
    line(style.dim("usage: agent mcp remove <name> [--project]"));
    return 2;
  }
  const file = serverFile(config.workspace, cli.scope);
  const current = readServerFile(file);
  if (!current.ok) {
    line(style.red(`! ${current.error}`));
    return 1;
  }
  if (!current.value.servers[name]) {
    const other = loadMcpConfig(config.workspace).servers.find((server) => server.name === name);
    if (other?.scope === "plugin") {
      line(style.red(`! "${name}" comes from plugin "${other.plugin}"; remove or disable it in the plugin instead`));
      return 1;
    }
    line(style.red(`! "${name}" is not in ${file}`));
    if (other) line(style.dim(`  it is in the ${other.scope} scope — add ${other.scope === "project" ? "--project" : "(no flag)"} to remove it`));
    return 1;
  }
  delete current.value.servers[name];
  writeServerFile(current.value);
  revokeServer(name);
  line(`${style.green("✓")} removed ${name} from ${file}`);
  return 0;
}

function mcpApprove(config: AppConfig, name: string | undefined): number {
  if (!name) {
    line(style.dim("usage: agent mcp approve <name>"));
    return 2;
  }
  const loaded = loadMcpConfig(config.workspace);
  const server = loaded.servers.find((entry) => entry.name === name);
  if (!server) {
    line(style.red(`! there is no MCP server named "${name}"`));
    return 1;
  }
  if (server.origin === "user") {
    line(style.dim(`"${name}" is in a user file, so it is already trusted`));
    return 0;
  }
  if (projectTrustBypass()) {
    line(style.dim("project trust is bypassed (AGENT_MCP_TRUST_PROJECT), so nothing needs approving"));
    return 0;
  }
  const fingerprint = approveServer(server);
  line(`${style.green("✓")} approved ${name} (${fingerprint.slice(0, 12)}…) — it runs from the next connection`);
  return 0;
}

async function mcpTest(config: AppConfig, name: string | undefined): Promise<number> {
  if (!name) {
    line(style.dim("usage: agent mcp test <name>"));
    return 2;
  }
  const loaded = loadMcpConfig(config.workspace);
  const server = loaded.servers.find((entry) => entry.name === name);
  if (!server) {
    line(style.red(`! there is no MCP server named "${name}"`));
    return 1;
  }
  if (server.disabled) {
    line(style.red(`! "${name}" is disabled in its config`));
    return 1;
  }
  if (server.origin === "project" && !projectTrustBypass() && !isTrusted(server)) {
    line(style.red(`! "${name}" is a project server that has not been approved: agent mcp approve ${name}`));
    return 1;
  }
  try {
    const client = await connectServer(server, { timeoutMs: Math.min(server.timeoutMs, 30_000) });
    try {
      line(`${style.green("✓")} ${client.serverInfo.name} v${client.serverInfo.version} · ${client.protocolVersion} · ${client.tools.length} tools`);
      for (const tool of client.tools) {
        const flags = tool.readOnly ? " · read-only hint" : tool.destructive ? " · destructive hint" : "";
        line(`  ${style.bold(tool.name.padEnd(24))} ${style.dim(`${(tool.description.split(".")[0] ?? tool.description).slice(0, 70)}${flags}`)}`);
      }
      if (!client.tools.length) line(style.dim("  the server advertises no tools"));
    } finally {
      await client.close();
    }
    return 0;
  } catch (cause) {
    line(style.red(`! ${name}: ${(cause as Error).message}`));
    return 1;
  }
}

async function commandMcp(config: AppConfig, cli: Cli): Promise<number> {
  const [action, name, ...tail] = cli.args;
  switch (action) {
    case undefined:
    case "list":
      return mcpList(config);
    case "add":
      return mcpAdd(config, cli, name, tail);
    case "add-json":
      return mcpAddJson(config, cli, name, tail);
    case "get":
      return mcpGet(config, name);
    case "remove":
    case "rm":
      return mcpRemove(config, cli, name);
    case "approve":
      return mcpApprove(config, name);
    case "test":
      return mcpTest(config, name);
    default:
      line(style.red(`! unknown mcp action "${action}"`));
      line(style.dim(MCP_USAGE));
      return 2;
  }
}

const PLUGIN_USAGE = `agent plugin list
agent plugin add <path> [--project]`;

function pluginList(config: AppConfig): number {
  const plugins = loadPlugins(config.workspace);
  if (!plugins.length) {
    line(style.dim("no plugins found — put one in ~/.agent/plugins/<name> (user) or .agent/plugins/<name> (project)"));
    return 0;
  }
  for (const plugin of plugins) {
    const parts = [
      `${plugin.commands.length} command${plugin.commands.length === 1 ? "" : "s"}`,
      `${Object.keys(plugin.mcpServers).length} mcp server${Object.keys(plugin.mcpServers).length === 1 ? "" : "s"}`,
    ];
    line(`${style.bold(plugin.name.padEnd(24))} ${style.dim(`${plugin.scope.padEnd(8)} ${parts.join(" · ")}`)}`);
    if (plugin.description) line(style.dim(`  ${plugin.description}`));
    for (const command of plugin.commands) line(style.dim(`  /${command.name}`));
  }
  for (const error of plugins.flatMap((plugin) => plugin.errors)) line(style.dim(`! ${error}`));
  return 0;
}

function pluginAdd(config: AppConfig, cli: Cli, target: string | undefined): number {
  if (!target) {
    line(style.dim(PLUGIN_USAGE));
    return 2;
  }
  const source = path.resolve(target);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    line(style.red(`! ${source} is not a directory`));
    return 1;
  }
  const manifestFile = [path.join(source, "plugin.json"), path.join(source, ".claude-plugin", "plugin.json")].find((file) => existsSync(file));
  if (!manifestFile && !existsSync(path.join(source, "commands")) && !existsSync(path.join(source, "mcp.json"))) {
    line(style.red("! that folder has no plugin.json, commands/ or mcp.json"));
    return 1;
  }
  let manifest: Record<string, unknown> = {};
  if (manifestFile) {
    try {
      const parsed = JSON.parse(readFileSync(manifestFile, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
    } catch (cause) {
      line(style.red(`! plugin.json did not parse: ${(cause as Error).message}`));
      return 1;
    }
  }
  const declared = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const name = declared || path.basename(source);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    line(style.red(`! "${name}" is not a usable plugin name; use letters, digits, dash or underscore`));
    return 1;
  }
  const root = cli.scope === "user" ? path.join(userAgentHome(), "plugins") : path.join(config.workspace, ".agent", "plugins");
  const destination = path.join(root, name);
  if (existsSync(destination)) {
    line(style.red(`! ${destination} already exists — remove it first`));
    return 1;
  }
  try {
    cpSync(source, destination, {
      recursive: true,
      filter: (from) => {
        const base = path.basename(from);
        return base !== "node_modules" && base !== ".git";
      },
    });
  } catch (cause) {
    line(style.red(`! could not copy the plugin: ${(cause as Error).message}`));
    return 1;
  }
  line(`${style.green("✓")} installed ${name} in ${destination}`);
  line(style.dim(`  its commands appear as /${name}:<command> from the next session`));
  if (cli.scope === "project" && manifest.mcpServers) {
    line(style.dim("  its MCP servers are project entries and wait for approval: agent mcp list"));
  }
  return 0;
}

async function commandPlugin(config: AppConfig, cli: Cli): Promise<number> {
  const [action, target] = cli.args;
  switch (action) {
    case undefined:
    case "list":
      return pluginList(config);
    case "add":
      return pluginAdd(config, cli, target);
    default:
      line(style.red(`! unknown plugin action "${action}"`));
      line(style.dim(PLUGIN_USAGE));
      return 2;
  }
}

async function main(): Promise<void> {
  let cli: Cli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (cause) {
    line(`${style.red("!")} ${(cause as Error).message}`);
    process.exitCode = 2;
    return;
  }

  if (cli.help) {
    process.stdout.write(USAGE);
    return;
  }

  // The tab says what is running, in plain text: no icon, no emoji.
  setTitle("agent");

  const config = readConfig(process.cwd(), { ...cli.overrides, budgetMinutes: budgetMinutes(cli.overrides) });
  const guard = workspaceExists(config.workspace);
  if (!guard.ok && cli.command !== "doctor") {
    line(`${style.red("!")} ${guard.error}`);
    process.exitCode = 1;
    return;
  }

  // A shortcut or a terminal profile can open in the agent's own checkout by
  // accident; without a word, the next run edits the agent instead of a project.
  const installRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const settle = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  if (settle(config.workspace) === settle(installRoot)) {
    line(style.dim("note: this is the agent's own folder — run from your project, or pass -w <dir>"));
  }

  switch (cli.command) {
    case "chat":
      await commandChat(config, cli.task, { classic: cli.classic, tui: cli.tui });
      return;
    case "do":
      process.exitCode = await commandDo(config, cli.task, cli.json);
      return;
    case "factory":
      process.exitCode = await commandFactory(config, cli.task, cli.json, cli.resume);
      return;
    case "models":
      process.exitCode = await commandModels(config);
      return;
    case "config":
      line(describeConfig(config));
      line(style.dim(`budget ${formatBudget(config.budgetMinutes)} · observe cap ${config.maxObserveChars} chars · context ${config.contextTokens} tokens`));
      line(style.dim(`outside workspace ${config.allowOutside ? "allowed" : "refused"} · secrets ${config.allowSecrets ? "allowed" : "refused"} · approvals ${config.approvalLevel} — ${TIER_LINE[config.approvalLevel]}`));
      line(style.dim(`github ${config.githubRepo ?? (config.githubToken ? "token set" : "not configured")}`));
      return;
    case "doctor":
      process.exitCode = await commandDoctor(config);
      return;
    case "log":
      process.exitCode = commandLog(config, Number(cli.task) || 30);
      return;
    case "backups":
      process.exitCode = commandBackups(config);
      return;
    case "undo":
      process.exitCode = commandUndo(config, cli.task);
      return;
    case "mcp":
      process.exitCode = await commandMcp(config, cli);
      return;
    case "plugin":
      process.exitCode = await commandPlugin(config, cli);
      return;
    default:
      process.stdout.write(USAGE);
  }
}

void main();
