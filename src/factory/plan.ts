/**
 * The plan document: one file, the whole line.
 *
 * `.factory/plan.json` is written before the first station runs and after every
 * state change, which is what makes the two hard promises real — *stop the agent
 * immediately* and *restore work after a failure*. A run that dies at station
 * three leaves a file that says exactly that, and `agent factory --resume` starts
 * at four with the earlier artefacts still on disk.
 *
 * The tools each kind gets are decided here, not by the model. A scout cannot
 * write. A reviewer cannot run a command. Narrowing the tool list is the cheapest
 * way to keep a station's head in one place, and it costs no tokens.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { turnsFor, type Budget } from "#core/budget.ts";
import { FACTORY_DIR } from "#guard/log.ts";
import { BROWSER_OBSERVE } from "#tools/browser.ts";
import { GITHUB_READS, GITHUB_WRITES } from "#tools/github.ts";
import { MAX_STATIONS, STATION_KINDS, textList, type StationKind } from "./schemas.ts";

export type StationState = "pending" | "running" | "done" | "failed" | "blocked";

export interface Review {
  verdict: "pass" | "revise" | null;
  rounds: number;
  problems: string[];
}

export interface Station {
  id: string;
  kind: StationKind;
  title: string;
  goal: string;
  accepts: string[];
  state: StationState;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  /** Artefact file name under .factory/artifacts, once it validates. */
  artifact: string | null;
  report: string;
  review: Review;
}

export interface PlanDoc {
  version: 1;
  runId: string;
  task: string;
  /** What the finished work must satisfy, checked by the ship gate. */
  acceptance: string[];
  createdAt: number;
  updatedAt: number;
  budgetMinutes: number | null;
  stations: Station[];
}

const CONTROL = ["plan_update", "finish", "request_input"];
const READ = ["read_file", "list_dir", "glob", "grep"];
const WRITE = ["write_file", "edit_file", "move_path", "remove_path"];
const SHELL = ["run_command", "run_background", "proc_output", "proc_list", "stop_process"];

/**
 * Every station also gets `write_artifact`; it is how it hands off.
 *
 * The scout and the verifier may look at a page — a documentation site or an app
 * that needs scripting to show anything is a real part of the ground they survey.
 * They get the reading half of the browser group only: opening and extracting are
 * `read`, like web_fetch, so an unattended line can use them. There is no click
 * and no type here, because a station must not change what a site holds.
 *
 * GitHub is split the same way. Every station may read an issue or what CI said;
 * only the builder may comment, open a pull request or push — and those are
 * `outward`, so an unattended line is refused and an attended one asks a person.
 */
export const STATION_TOOLS: Record<StationKind, string[]> = {
  scout: [...CONTROL, ...READ, "web_fetch", ...BROWSER_OBSERVE, ...GITHUB_READS],
  builder: [...CONTROL, ...READ, ...WRITE, "run_command", "web_fetch", ...GITHUB_READS, ...GITHUB_WRITES],
  verifier: [...CONTROL, ...READ, ...SHELL, "web_fetch", ...BROWSER_OBSERVE, ...GITHUB_READS],
  reviewer: [...CONTROL, ...READ],
};

export function toolsFor(kind: StationKind): string[] {
  return [...(STATION_TOOLS[kind] ?? STATION_TOOLS.scout), "write_artifact"];
}

export function isStationKind(value: unknown): value is StationKind {
  return typeof value === "string" && (STATION_KINDS as readonly string[]).includes(value);
}

export function factoryDir(workspace: string): string {
  const dir = path.join(workspace, FACTORY_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function planFile(workspace: string): string {
  return path.join(factoryDir(workspace), "plan.json");
}

/** Turn the foreman's validated plan into the document the line runs against. */
export function buildPlan(input: {
  runId: string;
  task: string;
  acceptance: unknown[];
  stations: unknown[];
  budgetMinutes: number | null;
}): PlanDoc {
  const now = Date.now();
  const stations: Station[] = [];
  input.stations.slice(0, MAX_STATIONS).forEach((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const kind = isStationKind(entry.kind) ? entry.kind : "builder";
    stations.push({
      id: `s${index + 1}`,
      kind,
      title: String(entry.title ?? `${kind} ${index + 1}`).slice(0, 80),
      goal: String(entry.goal ?? "").slice(0, 600),
      accepts: textList(entry.accepts).slice(0, 8),
      state: "pending",
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      ms: 0,
      artifact: null,
      report: "",
      review: { verdict: null, rounds: 0, problems: [] },
    });
  });
  return {
    version: 1,
    runId: input.runId,
    task: input.task.trim(),
    acceptance: textList(input.acceptance).slice(0, 10),
    createdAt: now,
    updatedAt: now,
    budgetMinutes: input.budgetMinutes,
    stations,
  };
}

export function savePlan(workspace: string, plan: PlanDoc): void {
  plan.updatedAt = Date.now();
  try {
    writeFileSync(planFile(workspace), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  } catch {
    /* a read-only workspace must not kill a live line; the in-memory plan still drives it */
  }
}

export function loadPlan(workspace: string): PlanDoc | null {
  const file = planFile(workspace);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PlanDoc;
    if (parsed?.version !== 1 || !Array.isArray(parsed.stations)) return null;
    // A run that died mid-station leaves it "running": nothing was verified, so start it again.
    for (const station of parsed.stations) if (station.state === "running") station.state = "pending";
    return parsed;
  } catch {
    return null;
  }
}

export function updateStation(workspace: string, plan: PlanDoc, id: string, patch: Partial<Station>): Station | null {
  const station = plan.stations.find((s) => s.id === id);
  if (!station) return null;
  Object.assign(station, patch);
  savePlan(workspace, plan);
  return station;
}

/** Next station that still needs work, in line order. */
export function nextStation(plan: PlanDoc): Station | null {
  return plan.stations.find((s) => s.state === "pending" || s.state === "blocked") ?? null;
}

export function progress(plan: PlanDoc): { done: number; failed: number; open: number; total: number } {
  const done = plan.stations.filter((s) => s.state === "done").length;
  const failed = plan.stations.filter((s) => s.state === "failed").length;
  return { done, failed, open: plan.stations.length - done - failed, total: plan.stations.length };
}

export function plannedVerifierPassed(plan: PlanDoc): boolean {
  const verifiers = plan.stations.filter((s) => s.kind === "verifier");
  if (!verifiers.length) return false;
  return verifiers.every((s) => s.state === "done" && s.review.verdict === "pass");
}

/**
 * One station's slice of the clock. The line shares a single deadline, so a
 * station's budget is its share of the time that is actually left — it can never
 * be given minutes the run no longer has.
 */
export function stationBudget(global: Budget, plan: PlanDoc, now: number = Date.now()): Budget {
  const open = Math.max(1, plan.stations.filter((s) => s.state === "pending" || s.state === "blocked").length);
  if (global.minutes == null || global.deadlineAt == null) {
    return { minutes: null, maxTurns: Math.max(12, Math.floor(global.maxTurns / open)), startedAt: now, deadlineAt: null, nudges: 0 };
  }
  const left = Math.max(0, global.deadlineAt - now);
  const minutes = Math.max(0.5, left / 60_000 / open);
  return {
    minutes,
    maxTurns: Math.max(12, turnsFor(minutes)),
    startedAt: now,
    deadlineAt: now + Math.min(minutes * 60_000, left),
    nudges: 0,
  };
}

/** The line as the operator reads it: one line per station, state first. */
export function planSummary(plan: PlanDoc): string {
  const mark: Record<StationState, string> = { pending: "·", running: ">", done: "+", failed: "x", blocked: "!" };
  return plan.stations
    .map((s) => `${mark[s.state]} ${s.id} ${s.kind} — ${s.title}${s.review.verdict ? ` [review ${s.review.verdict}]` : ""}${s.turns ? ` (${s.turns} turns)` : ""}`)
    .join("\n");
}
