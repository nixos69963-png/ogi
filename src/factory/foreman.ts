/**
 * The foreman: the line that runs stations instead of one long conversation.
 *
 * Why this exists rather than one big prompt: a single run carries every file it
 * ever read, so by turn forty the model reasons through a pile of old observations
 * and the operator has stopped reading. Here the task is planned once as typed
 * stations, and each station starts from a clean transcript holding only its goal,
 * its acceptance items, and the artefacts of the stations before it. The work is
 * the same; the context is a fraction, and every hand-over can be checked.
 *
 * Three rules keep it honest:
 *   1. The foreman cannot do the work. Its tool list is submit_plan plus the two
 *      control calls — nothing that touches the machine.
 *   2. A station is not done because it said so. It is done when its artefact
 *      validates and review passes. Two review rounds, then it is marked failed.
 *   3. Nothing ships by assertion. The gate compares the plan, the artefacts on
 *      disk and the action log, and names the station that is short.
 */
import { randomUUID } from "node:crypto";
import { budgetSpentNote, createBudget, isExpired, type Budget } from "#core/budget.ts";
import { run as runLoop } from "#core/loop.ts";
import type { AskOptions, AssistantTurn } from "#core/provider.ts";
import type { AgentEvent, ApprovalAnswer, ApprovalRequest, AppConfig, Message, ToolSpec } from "#core/types.ts";
import { readLog } from "#guard/log.ts";
import { makeSubmitPlanTool, makeWriteArtifactTool, type CurrentStation } from "#tools/factory.ts";
import { buildTools, toolMap } from "#tools/index.ts";
import { artifactDigest, readArtifact, shipGate, type Gate } from "#factory/artifacts.ts";
import { contractErrors, foremanBrief, repairNote, reviewerBrief, shipNote, stationBrief } from "#factory/briefs.ts";
import {
  loadPlan,
  planSummary,
  progress,
  savePlan,
  stationBudget,
  toolsFor,
  updateStation,
  type PlanDoc,
  type Station,
} from "#factory/plan.ts";
import { checkArtifact, MAX_REVIEW_ROUNDS, MAX_STATIONS, STATION_KINDS, type StationKind } from "#factory/schemas.ts";

export interface FactoryOptions {
  config: AppConfig;
  task: string;
  budget?: Budget | null;
  attended?: boolean;
  onEvent?: (event: AgentEvent) => void;
  confirm?: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
  ask?: (question: string, options: string[]) => Promise<string | null>;
  signal?: AbortSignal;
  transport?: (cfg: AppConfig, options: AskOptions) => Promise<AssistantTurn>;
  /** Pick up the plan already on disk instead of planning again. */
  resume?: boolean;
}

export interface FactoryOutcome {
  plan: PlanDoc | null;
  gate: Gate;
  report: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  stopped: string | null;
  denials: number;
}

/** The planner gets a quarter of the clock at most; a foreman that over-thinks is a stalled line. */
const PLAN_FRACTION = 0.25;
const PLAN_TURNS = 16;
const REVIEW_TURNS = 12;

type Shared = Pick<FactoryOptions, "config" | "attended" | "onEvent" | "confirm" | "ask" | "signal" | "transport">;

export async function runFactory(opts: FactoryOptions): Promise<FactoryOutcome> {
  const startedAt = Date.now();
  const cfg = opts.config;
  const workspace = cfg.workspace;
  const emit = opts.onEvent ?? (() => {});
  const attended = opts.attended ?? Boolean(process.stdin.isTTY);
  const global = opts.budget === undefined ? createBudget(cfg.budgetMinutes) : opts.budget ?? createBudget(null);
  const runId = randomUUID().slice(0, 8);
  const registry = toolMap(buildTools());
  const shared: Shared = { config: cfg, attended, onEvent: emit, confirm: opts.confirm, ask: opts.ask, signal: opts.signal, transport: opts.transport };

  const totals = { turns: 0, tokensIn: 0, tokensOut: 0, denials: 0 };
  let stopped: string | null = null;

  /** Which station a `write_artifact` call belongs to, set the moment it runs. */
  const target: { current: CurrentStation | null } = { current: null };
  const writeArtifactTool = makeWriteArtifactTool({ workspace, station: () => target.current });

  const finish = (plan: PlanDoc | null, text: string): FactoryOutcome => ({
    plan,
    gate: plan ? shipGate(workspace, plan, readLog(workspace, 3_000)) : { ok: false, reasons: [text], evidence: [] },
    report: text,
    turns: totals.turns,
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    ms: Date.now() - startedAt,
    stopped,
    denials: totals.denials,
  });

  /**
   * One planner run, with a continuation if it talked instead of submitting.
   * Only submit_plan, finish and request_input are advertised: the foreman has no
   * way to touch a file even if it decides to try.
   */
  async function planLine(): Promise<PlanDoc | null> {
    let captured: PlanDoc | null = null;
    const submit = makeSubmitPlanTool({
      workspace,
      runId,
      task: opts.task,
      budgetMinutes: global.minutes ?? null,
      onPlan: (plan) => {
        captured = plan;
      },
    });
    const tools: ToolSpec[] = [submit, registry.get("finish"), registry.get("request_input")].filter((t): t is ToolSpec => Boolean(t));
    const brief = foremanBrief({ task: opts.task, workspace, budgetMinutes: global.minutes ?? null, model: cfg.model });

    let outcome = await runLoop({ ...shared, task: opts.task, tools, systemExtra: brief, budget: planBudget(global) });
    totals.turns += outcome.turns;
    totals.tokensIn += outcome.tokensIn;
    totals.tokensOut += outcome.tokensOut;
    totals.denials += outcome.denied;
    if (captured) return captured;
    if (outcome.stopped && /operator/.test(outcome.stopped)) {
      stopped = outcome.stopped;
      return null;
    }

    const nudge = `[harness] No line was registered. Call submit_plan now with acceptance and 1-${MAX_STATIONS} stations, then finish.`;
    outcome = await runLoop({ ...shared, task: "", messages: [...outcome.messages, { role: "user", content: nudge }], tools, budget: planBudget(global) });
    totals.turns += outcome.turns;
    totals.tokensIn += outcome.tokensIn;
    totals.tokensOut += outcome.tokensOut;
    totals.denials += outcome.denied;
    if (!captured && outcome.stopped) stopped = outcome.stopped;
    return captured;
  }

  // 1 — the plan: resumed from disk, or spoken by the foreman.
  let plan: PlanDoc | null = opts.resume ? loadPlan(workspace) : null;
  if (plan) {
    const where = progress(plan);
    emit({ type: "station", station: "line", stage: "resumed", summary: `${where.done}/${where.total} accepted; continuing at the first unfinished station.` });
  } else {
    plan = await planLine();
    if (!plan) {
      return finish(null, `The foreman produced no line, so nothing was executed. ${stopped ? `(last state: ${stopped})` : "Rephrase the task with what done means, or run it as a normal task."}`);
    }
    emit({ type: "station", station: "line", stage: "planned", summary: `${plan.stations.length} station(s): ${plan.stations.map((s) => `${s.id} ${s.kind}`).join(", ")}` });
  }

  if (opts.task.trim()) plan.task = opts.task.trim();
  ensureVerifier(plan, workspace);
  emit({ type: "plan", steps: plan.stations.map((s) => `${s.id} ${s.kind}: ${s.title}`) });

  // 2 — the line, one station at a time, in plan order.
  for (;;) {
    if (opts.signal?.aborted) {
      stopped = "stopped by the operator";
      break;
    }
    if (isExpired(global, Date.now())) {
      stopped = budgetSpentNote(global);
      break;
    }
    const station = plan.stations.find((s) => s.state === "pending" || s.state === "blocked");
    if (!station) break;

    const upstream = plan.stations.filter((s) => s.state === "done" && s.id !== station.id).map((s) => artifactDigest(s, workspace));
    const brief = stationBrief({ plan, station, tools: toolsFor(station.kind), upstream, attended });
    target.current = { id: station.id, kind: station.kind };
    updateStation(workspace, plan, station.id, { state: "running" });
    emit({ type: "station", station: `${station.id} ${station.kind}`, stage: station.title, summary: station.goal });

    let messages = await runStationWork(station, brief, null, stationBudget(global, plan));

    if (stopped && /operator/.test(stopped)) {
      updateStation(workspace, plan, station.id, { state: "blocked" });
      target.current = null;
      break;
    }

    let review = await reviewStation(station);
    let rounds = 1;
    while (review.verdict === "revise" && rounds < MAX_REVIEW_ROUNDS && !stopped) {
      emit({ type: "station", station: `${station.id} ${station.kind}`, stage: `repair round ${rounds}`, summary: review.problems.join(" · ").slice(0, 300) });
      messages = await runStationWork(station, null, { resume: messages, note: repairNote(review.problems) }, stationBudget(global, plan));
      review = await reviewStation(station);
      rounds += 1;
    }

    updateStation(workspace, plan, station.id, {
      review: { verdict: review.verdict === "pass" ? "pass" : "revise", rounds, problems: review.problems },
      state: review.verdict === "pass" ? "done" : "failed",
      artifact: readArtifact(workspace, station.id) === null ? null : `${station.id}.json`,
    });
    emit({
      type: "station",
      station: `${station.id} ${station.kind}`,
      stage: review.verdict === "pass" ? "done" : "failed",
      summary: review.verdict === "pass" ? `artefact accepted after ${rounds} review round(s).` : `not accepted: ${review.problems.join(" · ").slice(0, 300)}`,
    });
    target.current = null;
  }

  savePlan(workspace, plan);
  const gate = shipGate(workspace, plan, readLog(workspace, 3_000));
  emit({
    type: "station",
    station: "line",
    stage: gate.ok ? "shippable" : "held",
    summary: gate.ok ? `${plan.stations.length} station(s) accepted.` : gate.reasons[0] ?? "the gate closed the line",
  });
  return finish(plan, buildReport(plan, gate, stopped));

  /** A station run, fresh or repaired. Returns its transcript for the next round. */
  async function runStationWork(station: Station, brief: string | null, repair: { resume: Message[]; note: string } | null, budget: Budget): Promise<Message[]> {
    // Set here, not only before the first round: the review turn leaves
    // `target.current` as its own reviewer id, and a repair round that inherited
    // it would validate and store the station's artefact as a review.
    target.current = { id: station.id, kind: station.kind };
    const allowed = new Set(toolsFor(station.kind));
    const tools: ToolSpec[] = [...buildTools().filter((spec) => allowed.has(spec.name)), writeArtifactTool];
    const outcome = await runLoop(
      repair
        ? { ...shared, task: "", messages: [...repair.resume, { role: "user", content: `${repair.note}\nCarry on from where you are; do not repeat what is already verified.` }], tools, budget }
        : { ...shared, task: stationTask(station), systemExtra: brief ?? "", tools, budget },
    );
    totals.turns += outcome.turns;
    totals.tokensIn += outcome.tokensIn;
    totals.tokensOut += outcome.tokensOut;
    totals.denials += outcome.denied;
    updateStation(workspace, plan!, station.id, {
      turns: station.turns + outcome.turns,
      tokensIn: station.tokensIn + outcome.tokensIn,
      tokensOut: station.tokensOut + outcome.tokensOut,
      ms: station.ms + outcome.ms,
      report: outcome.text.slice(0, 400),
    });
    if (outcome.stopped && /operator/.test(outcome.stopped)) stopped = outcome.stopped;
    return outcome.messages;
  }

  /** The gauge for one station: read-only, one verdict artefact, no fixes. */
  async function reviewStation(station: Station): Promise<{ verdict: "pass" | "revise"; problems: string[] }> {
    const workspaceOfRun = cfg.workspace;
    const value = readArtifact(workspaceOfRun, station.id);
    if (value === null) {
      return { verdict: "revise", problems: [`No artefact exists for ${station.id}. Call write_artifact with the ${station.kind} shape before finishing.`] };
    }
    const checked = checkArtifact(station.kind, value);
    if (!checked.ok) return { verdict: "revise", problems: [contractErrors(station.kind, checked.errors)] };

    const allowed = new Set(toolsFor("reviewer"));
    const tools: ToolSpec[] = [...buildTools().filter((spec) => allowed.has(spec.name)), writeArtifactTool];
    const reviewId: CurrentStation = { id: `${station.id}-r`, kind: "reviewer" };
    target.current = reviewId;
    const outcome = await runLoop({
      ...shared,
      task: reviewerBrief(station, JSON.stringify(value, null, 1)),
      tools,
      systemExtra: `You are the review gauge for station ${station.id} (${station.kind}). Judge the artefact in front of you against the acceptance items and nothing else.`,
      budget: reviewBudget(global),
    });
    totals.turns += outcome.turns;
    totals.tokensIn += outcome.tokensIn;
    totals.tokensOut += outcome.tokensOut;
    totals.denials += outcome.denied;

    const record = (readArtifact(workspaceOfRun, reviewId.id) ?? {}) as Record<string, unknown>;
    const problems = Array.isArray(record.problems) ? (record.problems as unknown[]).map((p) => String(p)).filter(Boolean) : [];
    if (record.verdict === "pass") return { verdict: "pass", problems: [] };
    if (record.verdict === "revise") {
      return { verdict: "revise", problems: problems.length ? problems : [String(record.instructions ?? "The artefact does not satisfy every acceptance item.")] };
    }
    return { verdict: "revise", problems: [`The review wrote no verdict (${reviewId.id} is missing or unreadable). State pass, or list what is missing and say revise.`] };
  }
}

/** How a station is told its own job, in the user slot of a fresh transcript. */
function stationTask(station: Station): string {
  return `${station.goal}\n\nAcceptance for this station:\n${station.accepts.map((a, i) => `${i + 1}. ${a}`).join("\n")}`;
}

function planBudget(global: Budget): Budget {
  if (global.minutes == null || global.deadlineAt == null) {
    return { minutes: null, maxTurns: PLAN_TURNS, startedAt: Date.now(), deadlineAt: null, nudges: 0 };
  }
  const left = Math.max(30_000, global.deadlineAt - Date.now());
  const minutes = Math.max(0.5, Math.min(global.minutes * PLAN_FRACTION, left / 60_000 / 3));
  return { minutes, maxTurns: PLAN_TURNS, startedAt: Date.now(), deadlineAt: Date.now() + Math.min(minutes * 60_000, left), nudges: 0 };
}

function reviewBudget(global: Budget): Budget {
  if (global.minutes == null || global.deadlineAt == null) {
    return { minutes: null, maxTurns: REVIEW_TURNS, startedAt: Date.now(), deadlineAt: null, nudges: 0 };
  }
  const left = Math.max(30_000, global.deadlineAt - Date.now());
  const minutes = Math.max(0.5, Math.min(global.minutes / 8, left / 60_000 / 4));
  return { minutes, maxTurns: REVIEW_TURNS, startedAt: Date.now(), deadlineAt: Date.now() + Math.min(minutes * 60_000, left), nudges: 0 };
}

/**
 * The line always ends with a check the operator can read. A foreman that plans
 * only builders ships unverified work, so the harness adds the verifier rather
 * than arguing with it.
 */
export function ensureVerifier(plan: PlanDoc, workspace: string): void {
  if (plan.stations.some((s) => s.kind === "verifier")) return;
  const index = plan.stations.length + 1;
  plan.stations.push({
    id: `s${index}`,
    kind: "verifier",
    title: "Verify the acceptance list",
    goal: "Check each acceptance criterion of the task with a command or a read, and report every one with its evidence.",
    accepts: plan.acceptance.slice(0, 6),
    state: "pending",
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    ms: 0,
    artifact: null,
    report: "",
    review: { verdict: null, rounds: 0, problems: [] },
  });
  savePlan(workspace, plan);
}

function buildReport(plan: PlanDoc, gate: Gate, stopped: string | null): string {
  const where = progress(plan);
  const lines = [
    `Line: ${where.done}/${where.total} station(s) accepted${where.failed ? `, ${where.failed} failed` : ""}${where.open ? `, ${where.open} open` : ""}.`,
    planSummary(plan),
    "",
    shipNote({ ok: gate.ok, reasons: gate.reasons, evidence: gate.evidence }),
  ];
  if (stopped) lines.push("", `Stopped: ${stopped}`);
  if (!gate.ok) {
    lines.push("", "To continue: `agent factory \"<the same task>\" --resume` starts at the first unfinished station. `agent backups` then `agent undo <path>` takes a change back.");
  }
  return lines.join("\n");
}

export type { StationKind, Gate };
export { STATION_KINDS };
