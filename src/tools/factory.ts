/**
 * Factory tools: the two calls that exist only to move a line forward.
 *
 * `submit_plan` is how the foreman speaks — one validated plan, nothing else, so
 * it cannot drift into doing the work. `write_artifact` is how a station hands
 * over: the payload is checked against its contract here, and a mismatch comes
 * back as a tool error the model can act on, instead of a bad file the gate has
 * to discover four stations later.
 *
 * Both write only into `.factory/`, the line's own records, so both are `compute`:
 * a station that cannot hand over is a stalled line, and an unattended run gains
 * nothing from being stopped at the hand-over. The writes that matter — your files
 * — still go through the approval gate.
 *
 * Both are built bound to the current run, which is why they are factories rather
 * than plain exports: the loop must never be able to reach a stale station.
 */
import type { ToolResult, ToolSpec } from "#core/types.ts";
import { err, ok, tool } from "./define.ts";
import { writeArtifact } from "#factory/artifacts.ts";
import { buildPlan, savePlan, type PlanDoc } from "#factory/plan.ts";
import { checkArtifact, checkPlan, MAX_STATIONS, PLAN_SCHEMA, STATION_KINDS, type StationKind } from "#factory/schemas.ts";
import { contractErrors, contractHint } from "#factory/briefs.ts";

export function makeSubmitPlanTool(input: {
  workspace: string;
  runId: string;
  task: string;
  budgetMinutes: number | null;
  onPlan(plan: PlanDoc): void;
}): ToolSpec {
  return tool({
    name: "submit_plan",
    description:
      "Hand the work line to the harness: acceptance criteria plus 1-6 stations (scout/builder/verifier), each with a goal and its own acceptance items. " +
      "Call it once. Nothing is executed by this call — it only registers the line.",
    effect: "compute",
    inputSchema: PLAN_SCHEMA,
    describe: (args) => {
      const acceptance = Array.isArray(args.acceptance) ? args.acceptance : [];
      const stations = Array.isArray(args.stations) ? args.stations : [];
      return { summary: `plan ${stations.length} station(s) for ${String(acceptance[0] ?? "").slice(0, 60)}` };
    },
    async execute(args): Promise<ToolResult> {
      const checked = checkPlan(args);
      if (!checked.ok) return err(`Plan rejected: ${checked.errors.join("; ")}. Call submit_plan again with the shape { ${contractHintFields()} }.`);
      const record = args as Record<string, unknown>;
      const stations = Array.isArray(record.stations) ? record.stations : [];
      if (!stations.length) return err("Plan rejected: no stations. One station means the task is not a line — just do it in a normal run.");
      if (stations.length > MAX_STATIONS) return err(`Plan rejected: ${stations.length} stations, maximum ${MAX_STATIONS}. Merge steps.`);
      const plan = buildPlan({
        runId: input.runId,
        task: input.task,
        acceptance: Array.isArray(record.acceptance) ? record.acceptance : [],
        stations,
        budgetMinutes: input.budgetMinutes,
      });
      savePlan(input.workspace, plan);
      input.onPlan(plan);
      return ok(
        `Line registered: ${plan.stations.length} station(s).\n${plan.stations.map((s) => `  ${s.id} ${s.kind} — ${s.title}`).join("\n")}\n` +
          `Acceptance: ${plan.acceptance.join(" | ").slice(0, 400)}\nNothing has been executed yet.`,
        { runId: plan.runId, stations: plan.stations.length },
      );
    },
  });
}

/** The one-line shape the foreman is told to fix its plan towards. */
function contractHintFields(): string {
  return Object.entries((PLAN_SCHEMA as Record<string, Record<string, unknown>>).properties as Record<string, Record<string, unknown>>)
    .map(([key, schema]) => `${key}: ${String(schema.type ?? "array")}`)
    .join(", ");
}

export interface CurrentStation {
  id: string;
  kind: StationKind;
}

export function makeWriteArtifactTool(input: { workspace: string; station: () => CurrentStation | null }): ToolSpec {
  return tool({
    name: "write_artifact",
    description:
      "Hand this station over as a typed artefact. The payload must match the station's contract exactly — the harness validates it before it is stored. " +
      "Call it once when the work is done and verified; the gate reads this file, not your summary.",
    effect: "compute",
    inputSchema: {
      type: "object",
      description: "The station's hand-over. Fields depend on the kind; see the brief.",
      additionalProperties: true,
    },
    describe: () => {
      const station = input.station();
      return { summary: `write the ${station?.kind ?? "station"} artefact for ${station?.id ?? "the current station"}` };
    },
    async execute(args): Promise<ToolResult> {
      const station = input.station();
      if (!station) return err("write_artifact is only available while a station is running.");
      const checked = checkArtifact(station.kind, args);
      if (!checked.ok) return err(contractErrors(station.kind, checked.errors));
      const written = writeArtifact(input.workspace, station.id, station.kind, checked.value);
      return ok(
        `Artefact stored: ${station.id} (${station.kind}) → ${written.bytes} bytes at ${artifactLabel(input.workspace, written.file)}. ` +
          `You may call finish now.`,
        { file: written.file, kind: station.kind, contract: contractHint(station.kind) },
      );
    },
  });
}

function artifactLabel(workspace: string, file: string): string {
  const rel = file.startsWith(workspace) ? file.slice(workspace.length).replace(/^[\\/]+/, "") : file;
  return rel.split(/[\\/]/).join("/");
}

/** Kinds the foreman may schedule, exported so the REPL can list them. */
export const SCHEDULABLE_KINDS = [...STATION_KINDS];
