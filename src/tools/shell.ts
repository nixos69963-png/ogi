/**
 * Shell: one persistent Git Bash session per workspace, plus background processes.
 *
 * Persistent rather than one-shot because `cd` and `export` are the point: an agent
 * that loses the working directory after every command re-runs its setup forever
 * and pays for every repetition. State lives in a real bash process; the sentinel
 * echoed after each command is what tells us where one command's output ends.
 *
 * A command that desyncs the session — an unclosed quote, a heredoc that never
 * ends — is met by a timeout that kills the session and starts a clean one on the
 * next call. The output collected so far is still returned: losing a session must
 * never mean losing the work.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clip } from "#core/history.ts";
import type { ToolContext, ToolResult, ToolSpec } from "#core/types.ts";
import { commandGate } from "#guard/approval.ts";
import { AGENT_DIR } from "#guard/log.ts";
import { err, num, obj, ok, str, tool } from "./define.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Absolute Windows path → the /c/... form bash speaks. */
export function toBashPath(absolute: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  if (process.platform === "win32" && m) return `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`;
  return absolute.replace(/\\/g, "/");
}

/** /c/... → absolute native path; anything else resolves against the workspace. */
export function fromBashPath(p: string, workspace: string): string {
  const trimmed = p.trim();
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(trimmed);
  if (process.platform === "win32" && m) return `${m[1]!.toUpperCase()}:\\${m[2]!.replace(/\//g, "\\")}`;
  if (trimmed.startsWith("/")) return trimmed;
  return path.resolve(workspace, trimmed);
}

/** The POSIX shells, for the platform that is not Windows. */
const POSIX_BASH = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"];

/**
 * Every place a bash could be on this machine, most likely first.
 *
 * Git for Windows in Program Files is the expected one, but a *portable* git — an
 * editor's bundled copy, scoop, chocolatey — is just as good a shell and lives
 * somewhere nobody can guess. So the roots are read from the environment, and a
 * `git.exe` found on PATH contributes its own install root: `<root>\cmd\git.exe`
 * means the shell is at `<root>\bin\bash.exe`.
 */
export function bashCandidates(): string[] {
  const env = process.env;
  const home = env.USERPROFILE ?? env.HOME ?? "";
  const found: string[] = [];
  if (process.platform === "win32") {
    const roots = [
      env.ProgramFiles ?? "C:\\Program Files",
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : "",
      env.ChocolateyInstall ?? "",
      home ? path.join(home, "scoop", "apps", "git", "current") : "",
      home ? path.join(home, ".qoder", "bin", "git") : "",
    ].filter(Boolean);
    for (const root of roots) found.push(path.join(root, "bin", "bash.exe"), path.join(root, "usr", "bin", "bash.exe"));
  } else {
    found.push(...POSIX_BASH);
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    found.push(path.join(dir, process.platform === "win32" ? "bash.exe" : "bash"));
    if (process.platform === "win32" && existsSync(path.join(dir, "git.exe"))) {
      const root = path.dirname(dir);
      found.push(path.join(root, "bin", "bash.exe"), path.join(root, "usr", "bin", "bash.exe"));
    }
  }
  return found;
}

/** Never falls back to cmd.exe: a different shell means different commands. */
export function findBash(): string | null {
  const fromEnv = process.env.AGENT_BASH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of bashCandidates()) if (existsSync(candidate)) return candidate;
  return null;
}

/** What the operator is told when no shell was found: where it looked, and the way out. */
export function bashMissingHint(): string {
  const looked = [...new Set(bashCandidates())].slice(0, 8).join(" · ");
  return `Looked in: ${looked}. Install Git for Windows, or set AGENT_BASH to any bash.exe — a portable git's bin\\bash.exe is enough.`;
}

export class ShellUnavailable extends Error {
  constructor(message: string, readonly hint: string) {
    super(message);
    this.name = "ShellUnavailable";
  }
}

export interface ShellRun {
  output: string;
  code: number;
  cwd: string;
  timedOut: boolean;
  ms: number;
}

interface Pending {
  id: number;
  started: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (run: ShellRun) => void;
}

const DONE_RE = /@@AGENT_DONE (\d+) (-?\d+) (.*?)@@\r?\n/;

export class ShellSession {
  private child: ChildProcess | null = null;
  private buffer = "";
  private sequence = 0;
  private pending: Pending | null = null;
  cwd: string;

  constructor(
    readonly workspace: string,
    private readonly env: Record<string, string> = {},
  ) {
    this.cwd = workspace;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  private start(): void {
    const bash = findBash();
    if (!bash) {
      throw new ShellUnavailable(
        "No Git Bash found, and the shell tool needs it.",
        bashMissingHint(),
      );
    }
    const child = spawn(bash, ["--noprofile", "--norc"], {
      cwd: this.workspace,
      env: { ...process.env, ...this.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", AGENT_CLI: "1", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => this.feed(chunk));
    }
    const dead = () => {
      this.child = null;
      const stray = normalise(this.buffer);
      this.buffer = "";
      this.release(stray ? `${stray}\n[the shell process exited]` : "[the shell process exited]", -1);
    };
    child.on("exit", dead);
    child.on("error", dead);
    child.stdin?.on("error", dead);
    // One stream, in order, so the model sees output the way a terminal does.
    this.write("exec 2>&1\n");
    this.write(`cd ${quote(this.workspace)} 2>/dev/null || true\n`);
  }

  private write(line: string): void {
    if (!this.child) this.start();
    this.child?.stdin?.write(line);
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    if (!this.pending) {
      if (this.buffer.length > 200_000) this.buffer = this.buffer.slice(-100_000);
      return;
    }
    const match = DONE_RE.exec(this.buffer);
    if (!match) return;
    if (Number(match[1]) !== this.pending.id) {
      this.buffer = this.buffer.slice(match.index + match[0].length);
      return;
    }
    const output = this.buffer.slice(0, match.index);
    this.buffer = this.buffer.slice(match.index + match[0].length);
    const reported = (match[3] ?? "").trim();
    if (reported) this.cwd = fromBashPath(reported, this.workspace);
    this.release(normalise(output), Number(match[2]));
  }

  private release(output: string, code: number): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve({ output, code, cwd: this.cwd, timedOut: false, ms: Date.now() - pending.started });
  }

  run(command: string, timeoutMs: number, cwd?: string): Promise<ShellRun> {
    const id = ++this.sequence;
    return new Promise<ShellRun>((resolve) => {
      if (this.pending) {
        resolve({ output: "(the shell is still busy with an earlier command; nothing was run)", code: -1, cwd: this.cwd, timedOut: false, ms: 0 });
        return;
      }
      try {
        if (!this.alive) this.start();
      } catch (cause) {
        const error = cause as ShellUnavailable;
        resolve({ output: `${error.message}\n${error.hint}`, code: -1, cwd: this.cwd, timedOut: false, ms: 0 });
        return;
      }
      const started = Date.now();
      const timer = setTimeout(() => {
        if (!this.pending || this.pending.id !== id) return;
        const flushed = normalise(this.buffer);
        this.pending = null;
        this.kill();
        this.buffer = "";
        resolve({
          output: `${flushed}\n[timed out after ${Math.round(timeoutMs / 1000)}s; the session was killed and restarts clean on the next command]`,
          code: -1,
          cwd: this.cwd,
          timedOut: true,
          ms: Date.now() - started,
        });
      }, timeoutMs);
      this.pending = { id, started, timer, resolve };
      const target = cwd ? fromBashPath(cwd, this.workspace) : this.cwd;
      this.write(
        [
          `cd ${quote(target)} || echo "[cannot enter ${target}]"`,
          "{",
          command.replace(/\r\n/g, "\n"),
          "}",
          "__agent_ec=$?",
          `printf '@@AGENT_DONE ${id} %s %s@@\\n' "$__agent_ec" "$(pwd -P)"`,
          "",
        ].join("\n"),
      );
    });
  }

  kill(): void {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      /* already gone */
    }
  }

  close(): void {
    this.kill();
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.buffer = "";
  }
}

/** Single quotes, with the inner-quote dance. Nothing here is interpolated twice. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

const sessions = new Map<string, ShellSession>();

export function getShell(workspace: string, env: Record<string, string> = {}): ShellSession {
  const key = path.resolve(workspace);
  let session = sessions.get(key);
  if (!session) {
    session = new ShellSession(key, env);
    sessions.set(key, session);
  }
  return session;
}

export function closeShell(workspace: string): void {
  const key = path.resolve(workspace);
  sessions.get(key)?.close();
  sessions.delete(key);
}

export function closeAllShells(): void {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

function label(workspace: string, dir: string): string {
  const rel = path.relative(workspace, dir);
  return rel === "" ? "." : rel.startsWith("..") ? dir : rel;
}

/** Formats a run the way the model should read it: where, what came back, what it cost. */
function present(ctx: ToolContext, run: ShellRun, command: string): ToolResult {
  const head = `[exit ${run.code}] ${label(ctx.workspace, run.cwd)} · ${(run.ms / 1000).toFixed(1)}s`;
  const body = run.output.trim();
  const shown = clip(body || "(no output)", ctx.config.maxObserveChars);
  const tail =
    run.code === 0
      ? ""
      : `\n[command failed] Read the output above and fix the cause. If this was a missing tool or module, install it; if the path was wrong, correct it.`;
  if (!body && run.code === 0) return ok(`${head}\n(no output — the command succeeded quietly).`, { code: 0, cwd: run.cwd });
  return ok(`${head}\n$ ${command.slice(0, 400)}\n${shown}${tail}`, { code: run.code, cwd: run.cwd, timedOut: run.timedOut });
}

/**
 * A command that carries a secret in a URL is refused before it runs.
 *
 * `git push https://ghp_xxx@github.com/o/r` is the habit this agent has to break:
 * the token then sits in the shell history, in the action log, in `ps`, in the
 * remote URL written into .git/config, and in every backup of all of that. GitHub
 * reads a token from the environment instead — see github_push.
 */
export function credentialInUrl(command: string): string | null {
  // The shape of the answer matters as much as the catch: it is quoted back to the
  // model, so it names the offender with the secret already taken out.
  const url = /\b(https?|git|ssh):\/\/[^\s/@]*:[^\s/@]+@([^\s/]+)/i.exec(command);
  if (url) return `${url[1]}://***@${url[2]}`;
  const bare = /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_-]{16,}/.exec(command);
  return bare ? `a GitHub token (${bare[1]}_…)` : null;
}

export const runCommand = tool({
  name: "run_command",
  description:
    "Run a shell command in Git Bash. The session is persistent: cd and export carry over to the next call. " +
    "stdout and stderr arrive merged, in order. Returns the exit code. Use timeout_seconds for anything that may hang; " +
    "use run_background for a server you intend to keep running.",
  effect: "write",
  inputSchema: obj(
    {
      command: str("The command, in bash syntax. One focused command beats a chain."),
      cwd: str("Directory to run in, absolute or workspace-relative. Default: where the session already is."),
      timeout_seconds: num("Default 120, maximum 600."),
    },
    ["command"],
  ),
  describe: (input) => {
    const command = String(input.command ?? "");
    const first = command.split("\n")[0] ?? "";
    // What a command must be asked about is a gate, not a caution: a tier cannot
    // wave through the machine it reaches or the file it deletes for good.
    const gate = commandGate(command);
    return { summary: `run: ${first.slice(0, 120)}`, risky: gate.risky, hard: gate.hard };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const command = String(input.command ?? "").trim();
    if (!command) return err("run_command needs a non-empty command.");
    const leaked = credentialInUrl(command);
    if (leaked) return err(`Refused: that command carries a credential in it (${leaked}).`, { hint: "A secret in a command line is logged, visible in the process list and saved into .git/config. GitHub tools read GITHUB_TOKEN from the environment; for a push use github_push." });
    const seconds = Number(input.timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000);
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, (Number.isFinite(seconds) ? seconds : 120) * 1000));
    const session = getShell(ctx.workspace);
    const run = await session.run(command, timeoutMs, typeof input.cwd === "string" ? input.cwd : undefined);
    if (ctx.signal.aborted) return err("Stopped by the operator before the command finished.");
    return present(ctx, run, command);
  },
});

// ─── background processes ────────────────────────────────────────────────────

interface Job {
  id: string;
  command: string;
  cwd: string;
  log: string;
  pid: number;
  startedAt: number;
  child?: ChildProcess;
}

const jobs = new Map<string, Job>();

function procDir(workspace: string): string {
  const dir = path.join(workspace, AGENT_DIR, "procs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function loadJobs(workspace: string): void {
  if (jobs.size) return;
  const dir = procDir(workspace);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Job;
      job.child = undefined;
      jobs.set(job.id, job);
    } catch {
      /* a torn meta file is not worth a crash */
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const runBackground = tool({
  name: "run_background",
  description:
    "Start a long-running command (a dev server, a watcher) without waiting for it. Output accumulates in a log you read with proc_output. " +
    "Stop it with stop_process. The process survives this session because its output is on disk.",
  effect: "write",
  inputSchema: obj(
    {
      command: str("Command to keep running."),
      cwd: str("Directory to run in."),
    },
    ["command"],
  ),
  describe: (input) => {
    const command = String(input.command ?? "");
    const gate = commandGate(command);
    // A background job is the same command with nobody watching its output.
    return { summary: `start in background: ${command.slice(0, 100)}`, risky: gate.risky, hard: gate.hard };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const command = String(input.command ?? "").trim();
    if (!command) return err("run_background needs a command.");
    // Kept on disk in .agent/procs/<id>.json, so a secret here would be stored twice.
    const leaked = credentialInUrl(command);
    if (leaked) return err(`Refused: that command carries a credential in it (${leaked}), and a background job is written to disk.`, { hint: "read the secret from the environment inside the command instead: \"$MY_TOKEN\"." });
    const bash = findBash();
    if (!bash) return err("No Git Bash found, and a background job needs it to start.", { hint: bashMissingHint() });
    loadJobs(ctx.workspace);
    const id = `p${Date.now().toString(36)}`;
    const cwd = typeof input.cwd === "string" ? fromBashPath(input.cwd, ctx.workspace) : ctx.workspace;
    const log = path.join(procDir(ctx.workspace), `${id}.log`);
    const fd = openSync(log, "a");
    const child = spawn(bash, ["--noprofile", "--norc", "-c", command], {
      cwd,
      env: { ...process.env, LANG: "C.UTF-8" },
      stdio: ["ignore", fd, fd],
      detached: true,
      windowsHide: true,
    });
    const job: Job = { id, command, cwd, log, pid: child.pid ?? -1, startedAt: Date.now(), child };
    jobs.set(id, job);
    writeFileSync(path.join(procDir(ctx.workspace), `${id}.json`), JSON.stringify({ ...job, child: undefined }), "utf8");
    child.unref();
    return ok(`Started ${id} in ${label(ctx.workspace, cwd)} (pid ${job.pid}). Output log: ${label(ctx.workspace, log)}. Read it with proc_output("${id}"); stop it with stop_process("${id}").`, { id, pid: job.pid });
  },
});

export const procOutput = tool({
  name: "proc_output",
  description: "Read the tail of a background process log, and say whether the process is still alive.",
  effect: "read",
  inputSchema: obj({ id: str("Process id from run_background."), lines: num("Tail length, default 80.") }, ["id"]),
  describe: (input) => ({ summary: `read output of ${String(input.id ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    loadJobs(ctx.workspace);
    const id = String(input.id ?? "");
    const job = jobs.get(id);
    if (!job) return err(`No process ${id}. Started this session? ids are listed by proc_list.`);
    if (!existsSync(job.log)) return ok(`${id} has produced no output yet (alive: ${pidAlive(job.pid)}).`, { alive: pidAlive(job.pid) });
    const wanted = Math.min(500, Math.max(1, Number(input.lines ?? 80) || 80));
    const text = normalise(readFileSync(job.log, "utf8"));
    const tail = text.split("\n").slice(-wanted).join("\n");
    return ok(`${id} ${pidAlive(job.pid) ? "running" : "exited"} · ${text.split("\n").length} lines logged\n${clip(tail, ctx.config.maxObserveChars)}`, {
      alive: pidAlive(job.pid),
    });
  },
});

export const procList = tool({
  name: "proc_list",
  description: "List background processes started by this agent, alive or not.",
  effect: "read",
  inputSchema: obj({}),
  async execute(_input, ctx): Promise<ToolResult> {
    loadJobs(ctx.workspace);
    if (!jobs.size) return ok("No background processes.");
    const rows = [...jobs.values()].map((job) => {
      const bytes = existsSync(job.log) ? statSync(job.log).size : 0;
      return `${job.id} ${pidAlive(job.pid) ? "running" : "exited "} pid ${job.pid} · ${bytes} bytes · ${label(ctx.workspace, job.cwd)} · ${job.command.slice(0, 60)}`;
    });
    return ok(rows.join("\n"), { count: rows.length });
  },
});

export const stopProcess = tool({
  name: "stop_process",
  description: "Stop a background process the agent started. Kills its whole tree on Windows.",
  effect: "write",
  inputSchema: obj({ id: str("Process id from run_background or proc_list.") }, ["id"]),
  describe: (input) => ({ summary: `stop ${String(input.id ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    loadJobs(ctx.workspace);
    const id = String(input.id ?? "");
    const job = jobs.get(id);
    if (!job) return err(`No process ${id}.`);
    if (!pidAlive(job.pid)) return ok(`${id} was already stopped.`);
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/T", "/PID", String(job.pid)], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        job.child?.kill("SIGTERM");
        process.kill(job.pid, "SIGTERM");
      } catch {
        /* not ours to kill */
      }
    }
    return ok(`Sent a kill to ${id} (pid ${job.pid}); its log stays at ${label(ctx.workspace, job.log)}.`, { id });
  },
});

export const SHELL_TOOLS: ToolSpec[] = [runCommand, runBackground, procOutput, procList, stopProcess];
