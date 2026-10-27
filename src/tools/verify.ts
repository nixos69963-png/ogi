/**
 * verify — one call that runs the project's own gate.
 *
 * The agent's brief already tells it to verify. The expensive part was never the
 * instruction; it was the model reconstructing, every run, which command counts as
 * proof and then reading three raw logs. This tool knows the project's declared
 * checks — `check` when the manifest has one, otherwise typecheck, lint and test —
 * runs them one after another, and returns a compact pass/fail report with only
 * the first errors of the first failing step.
 *
 * It runs the scripts the operator already wrote, not commands chosen by the model.
 * That is what makes it a shortcut rather than a second, quieter shell.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ToolResult } from "#core/types.ts";
import { commandGate } from "#guard/approval.ts";
import { err, obj, num, ok, tool } from "./define.ts";

export interface CheckStep {
  /** How the operator names it: `check`, `typecheck`, `pytest`. */
  label: string;
  /** The command as a person would type it, for the transcript and the log. */
  display: string;
  file: string;
  args: string[];
  shell: boolean;
  /** The script body, so the approval gate sees what will actually run. */
  body: string;
}

const MAX_STEPS = 4;
const MAX_ERRORS = 15;
const DEFAULT_TIMEOUT_S = 180;
const MAX_TIMEOUT_S = 600;

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The scripts worth running, in the order that fails fastest. */
function scriptNames(scripts: Record<string, unknown>): string[] {
  const names = Object.keys(scripts).filter((name) => /^[A-Za-z0-9:_-]{1,64}$/.test(name));
  if (names.includes("check")) return ["check"];
  return ["typecheck", "lint", "test"].filter((name) => names.includes(name));
}

export function discoverChecks(workspace: string): CheckStep[] {
  const bun = Boolean(process.versions.bun);
  const steps: CheckStep[] = [];
  const pkgFile = path.join(workspace, "package.json");
  const pkg = existsSync(pkgFile) ? readJson(pkgFile) : null;
  const scripts = (pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}) as Record<string, unknown>;
  for (const name of scriptNames(scripts).slice(0, MAX_STEPS)) {
    const body = typeof scripts[name] === "string" ? (scripts[name] as string) : "";
    steps.push({
      label: name,
      display: `${bun ? "bun" : "npm"} run ${name}`,
      file: bun ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", name],
      shell: !bun && process.platform === "win32",
      body,
    });
  }
  if (steps.length) return steps;

  // No scripts to trust: fall back to the ecosystem's own check, one command each.
  const add = (label: string, display: string, file: string, args: string[]): void => {
    steps.push({ label, display, file, args, shell: false, body: display });
  };
  if (existsSync(path.join(workspace, "tsconfig.json"))) {
    const tsc = ["node_modules/typescript/bin/tsc", "../node_modules/typescript/bin/tsc"]
      .map((relative) => path.resolve(workspace, relative))
      .find((candidate) => existsSync(candidate));
    if (tsc) add("typecheck", "tsc --noEmit", process.execPath, [tsc, "--noEmit"]);
  }
  if (existsSync(path.join(workspace, "pyproject.toml")) || existsSync(path.join(workspace, "pytest.ini"))) add("pytest", "python -m pytest -q", "python", ["-m", "pytest", "-q"]);
  else if (existsSync(path.join(workspace, "Cargo.toml"))) add("cargo", "cargo check", "cargo", ["check"]);
  else if (existsSync(path.join(workspace, "go.mod"))) add("go", "go build ./...", "go", ["build", "./..."]);
  return steps.slice(0, MAX_STEPS);
}

/** The gate that no tier may wave through, read from the bodies of the scripts. */
export function checkGate(steps: CheckStep[]): { risky?: string; hard?: string } {
  let risky: string | undefined;
  let hard: string | undefined;
  for (const step of steps) {
    const gate = commandGate(step.body);
    hard ??= gate.hard;
    risky ??= gate.risky;
  }
  return { ...(risky ? { risky } : {}), ...(hard ? { hard } : {}) };
}

// ─── reading the logs ────────────────────────────────────────────────────────

const ANSI = /\u001b\[[0-9;]*m/g;

/** tsc: `src/x.ts(12,4): error TS2322: ...`, the one format worth naming. */
const TSC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

/** Lines that are a failure, without the noise around them. */
export function parseDiagnostics(output: string): { errors: string[]; summary: string[] } {
  const clean = output.replace(ANSI, "");
  const lines = clean.split(/\r?\n/);
  const errors: string[] = [];
  const summary: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trimEnd();
    const tsc = TSC.exec(line.trim());
    if (tsc) {
      errors.push(`${tsc[1]}:${tsc[2]}:${tsc[3]} ${tsc[4]}: ${tsc[5]}`);
      continue;
    }
    if (/^\(fail\)\s+/.test(line)) {
      errors.push(line.replace(/^\(fail\)\s+/, "fail: "));
      continue;
    }
    if (/^(?:FAILED|ERROR)\s+/.test(line)) {
      errors.push(line);
      continue;
    }
    const compact = line.trim();
    if (/^(?:\d+\s+pass|\d+\s+fail|tests?\s+\d+|Test Files\s+\d+|=+\s*\d+ (?:passed|failed))/.test(compact)) {
      summary.push(compact.replace(/\s+/g, " ").slice(0, 120));
      continue;
    }
    if (/\berror\b|\b✗\b|^error(?:\[E\d+\])?:/.test(compact) && !/^warning\b/.test(compact)) {
      errors.push(compact.slice(0, 220));
    }
  }
  // The same message repeated by a watcher or a retry is one message.
  return { errors: [...new Set(errors)].slice(0, MAX_ERRORS), summary: [...new Set(summary)].slice(-3) };
}

// ─── running one step ────────────────────────────────────────────────────────

interface StepRun {
  code: number | null;
  output: string;
  ms: number;
  timedOut: boolean;
  stopped: boolean;
  spawnError: string | null;
}

function runStep(step: CheckStep, workspace: string, timeoutMs: number, signal: AbortSignal): Promise<StepRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(step.file, step.args, {
        cwd: workspace,
        shell: step.shell,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        windowsHide: true,
      });
    } catch (cause) {
      resolve({ code: null, output: "", ms: 0, timedOut, stopped, spawnError: (cause as Error).message });
      return;
    }
    const finish = (code: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ code, output, ms: Date.now() - started, timedOut, stopped, spawnError });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const onAbort = (): void => {
      stopped = true;
      child.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const collect = (chunk: Buffer): void => {
      if (output.length < 8_000_000) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (cause) => finish(null, cause.message));
    child.on("close", (code) => finish(code, null));
  });
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

// ─── the tool ────────────────────────────────────────────────────────────────

export const verify = tool({
  name: "verify",
  description:
    "Run the project's own checks and come back with a short verdict. It runs the `check` script when package.json has one, " +
    "otherwise typecheck, lint and test; with no scripts it falls back to tsc, pytest, cargo or go. Read the report before " +
    "calling finish: this is the evidence step. Empty arguments are enough.",
  effect: "write",
  inputSchema: obj({
    timeout_seconds: num(`Per check. Default ${DEFAULT_TIMEOUT_S}, maximum ${MAX_TIMEOUT_S}.`),
  }, []),
  describe: (_input, ctx) => {
    const steps = discoverChecks(ctx.workspace);
    const gate = checkGate(steps);
    const summary = steps.length ? `verify: ${steps.map((step) => step.display).join(" then ")}` : "verify: no checks found";
    return { summary: summary.slice(0, 140), ...gate };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const steps = discoverChecks(ctx.workspace);
    if (!steps.length) {
      return err(
        "No checks found: package.json has no check/typecheck/lint/test script, and there is no tsconfig, pyproject, Cargo.toml or go.mod. " +
          "Run the proof with run_command, or add a `check` script to package.json.",
      );
    }
    const requested = Number(input.timeout_seconds ?? DEFAULT_TIMEOUT_S);
    const timeoutMs = Math.min(MAX_TIMEOUT_S, Math.max(10, Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_S)) * 1000;

    const report: string[] = [];
    let failures = 0;
    let stopped = false;
    for (const step of steps) {
      if (ctx.signal.aborted) {
        stopped = true;
        report.push(`- ${step.label}: not run (stopped)`);
        break;
      }
      const run = await runStep(step, ctx.workspace, timeoutMs, ctx.signal);
      const passed = run.code === 0 && !run.timedOut && !run.stopped && !run.spawnError;
      if (!passed) failures += 1;
      const why = run.spawnError ?? (run.timedOut ? `timed out after ${timeoutMs / 1000}s` : run.stopped ? "stopped" : `exit ${run.code ?? "?"}`);
      report.push(`${passed ? "✓" : "✗"} ${step.label} — ${step.display} · ${why} · ${seconds(run.ms)}`);
      const parsed = parseDiagnostics(run.output);
      if (parsed.summary.length) report.push(`  ${parsed.summary.join(" · ")}`);
      if (!passed) {
        for (const line of parsed.errors) report.push(`  ${line}`);
        const tail = run.output.replace(ANSI, "").trim().split(/\r?\n/).filter(Boolean).slice(-3);
        if (!parsed.errors.length && tail.length) report.push(...tail.map((line) => `  ${line.slice(0, 220)}`));
      }
      if (run.stopped || ctx.signal.aborted) {
        stopped = true;
        break;
      }
    }

    const verdict = failures === 0 ? "all checks pass" : `${failures} of ${steps.length} check(s) failed`;
    const body = `verify — ${verdict}\n${report.join("\n")}`;
    const content = body.length > 8_000 ? `${body.slice(0, 8_000)}\n(...clipped)` : body;
    return failures === 0 && !stopped ? ok(content, { steps: steps.length, failures }) : err(content, { steps: steps.length, failures });
  },
});
