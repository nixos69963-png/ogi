/**
 * The words each role on the line gets.
 *
 * A station is not told "do the task well". It is told what it is for, what it
 * must hand over, which tools it has, and to stop when its own piece is done.
 * That is the whole trick behind the factory: a narrow brief makes a small
 * transcript, and a small transcript is what keeps thirty turns from turning into
 * three hundred.
 *
 * These are briefs, not guarantees — the tool list is enforced in plan.ts and the
 * artefact shape in schemas.ts.
 */
import { formatBudget } from "#core/budget.ts";
import { ARTIFACT_CONTRACTS, type StationKind } from "./schemas.ts";
import type { PlanDoc, Station } from "./plan.ts";

/**
 * The type of one schema node, in as few words as possible.
 *
 * A list has to say what its items are: the first live line burned two repair
 * rounds sending `files: ["src/app.ts"]` because the hint stopped at "list" and the
 * contract wanted objects.
 */
function typeOf(value: unknown, depth = 0): string {
  const schema = (value ?? {}) as Record<string, unknown>;
  const type = String(schema.type ?? "string");
  if (depth > 2) return type;
  if (Array.isArray(schema.enum)) return `${type} (${(schema.enum as unknown[]).join(" | ")})`;
  if (type === "array") return `list of ${typeOf(schema.items, depth + 1)}`;
  if (type === "object") {
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const fields = Object.entries(props).map(([key, child]) => `${required.has(key) ? key : `${key}?`}: ${typeOf(child, depth + 1)}`);
    return fields.length ? `{ ${fields.join(", ")} }` : "object";
  }
  return type;
}

/** The shape of the artefact, in as few tokens as a schema can be put. */
export function contractHint(kind: StationKind): string {
  const contract = ARTIFACT_CONTRACTS[kind] as Record<string, unknown>;
  const props = (contract.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(contract.required) ? (contract.required as string[]) : []);
  return Object.entries(props)
    .map(([key, schema]) => `${required.has(key) ? key : `${key}?`}: ${typeOf(schema)}`)
    .join(", ");
}

export function foremanBrief(input: { task: string; workspace: string; budgetMinutes: number | null; model: string }): string {
  return [
    "You are the foreman of a short work line. You do not do the work.",
    "Your only job is to break the task into stations that each end in one written artefact, then stop.",
    "",
    "## How to plan",
    "- 2 to 5 stations, in the order they must happen. Never more than 6.",
    "- A scout reads and reports; it changes nothing. Start with one when the ground is unknown.",
    "- A builder makes the change. One builder per coherent change — not one per file.",
    "- End with a verifier that checks the acceptance list with commands and reads.",
    "- Every station gets 1-3 acceptance items, each observable: a file that exists, a command that",
    "  exits 0, output that contains something.",
    "- Do not invent stations to fill space. A task that needs two needs two.",
    "",
    "## Rules",
    "- Call submit_plan exactly once, then finish. Planning again after the line starts is not your job.",
    "- Acceptance criteria describe the finished task, not the plan. Write them so a verifier can",
    "  test them without asking you what you meant.",
    "- Never write a file, run a command or fetch anything: you have no tools for that, and you are",
    "  not supposed to need them.",
    "",
    `Task: ${input.task}`,
    `Workspace: ${input.workspace} · model ${input.model} · line budget ${formatBudget(input.budgetMinutes)}`,
  ].join("\n");
}

export function stationBrief(input: { plan: PlanDoc; station: Station; tools: string[]; upstream: string[]; attended: boolean; repair?: string }): string {
  const { station } = input;
  const lines = [
    `You are station ${station.id} on a work line: ${station.kind}. Your title: ${station.title}.`,
    "The line runs one station at a time. You do one job, hand over an artefact, and stop.",
    "",
    "## This station",
    `Goal: ${station.goal}`,
    "Acceptance for this station:",
    ...station.accepts.map((item, i) => `  ${i + 1}. ${item}`),
    ...(input.upstream.length ? ["", "## What the stations before you handed over", ...input.upstream.map((block) => split(block))] : []),
    "",
    "## Hand-over",
    `Call write_artifact before finish. Shape: { ${contractHint(station.kind)} }`,
    "Values must be things you actually observed or did — a file you read, a command you ran.",
    "The artefact is validated against this shape; a payload that does not match comes back to you.",
    "",
    "## Tools you have",
    `Only these: ${input.tools.join(", ")}. Anything else does not exist for you.`,
    station.kind === "scout" || station.kind === "reviewer"
      ? "You are read-only: no writes, no commands that change state."
      : input.attended
        ? "Writes are shown to the operator when approvals are on; keep them minimal and reversible."
        : // A refused write retried three times is a station that never hands over.
          "Nobody is watching this run: a write is refused unless it was started with --yes. If one is refused, do not retry it — say so in the artefact and finish.",
    "",
    "## How to work",
    "- plan_update once with 2-4 steps for this station only, then work them.",
    "- grep/find before reading whole files. Do not paste a file into the transcript.",
    "- Verify your own claim with one tool call before write_artifact, and put that evidence in it.",
    "- finish as soon as the artefact is written. The next station is not your problem.",
    "- If you are genuinely blocked, call request_input once. Do not guess past a missing fact.",
    ...(input.repair ? ["", "## This is a repair round", input.repair] : []),
  ];
  return lines.join("\n");
}

export function reviewerBrief(station: Station, artifactJson: string): string {
  return [
    `You are the gauge on station ${station.id} (${station.kind}). You do not fix anything.`,
    "Read the artefact below and decide whether it satisfies the station's acceptance items.",
    "",
    "## Acceptance",
    ...station.accepts.map((item, i) => `  ${i + 1}. ${item}`),
    "",
    "## Artefact",
    artifactJson.slice(0, 4_000),
    "",
    "## Rules",
    "- pass only if every acceptance item is answered by something in the artefact that could be checked.",
    "- revise when something is missing, vague, or claims a change with no evidence — and say exactly what",
    '  to add, in the order the station should do it. "instructions" must be executable by that station.',
    "- You have no write or command tools. Open a file with read_file if the artefact cites one.",
    // The station briefs spell their shape out and lost most of their rejected rounds;
    // the gauge was the last one guessing at it.
    `- Call write_artifact once with the verdict, then finish. Shape: { ${contractHint("reviewer")} }`,
    "- A pass still needs problems: [] and instructions: \"none\" — a verdict with no fields is rejected.",
  ].join("\n");
}

/** The note that sends a station back for its revise round. */
export function repairNote(problems: string[]): string {
  return `${problems.map((p) => `- ${p}`).join("\n")}\nFix only these. Re-verify, then call write_artifact again with the corrected artefact.`;
}

/** What an invalid artefact payload is told back — with the shape, so one round is enough. */
export function contractErrors(kind: StationKind, errors: string[]): string {
  return `Your artefact did not match the ${kind} contract: ${errors.join("; ")}. Call write_artifact again with exactly this shape: { ${contractHint(kind)} }`;
}

export function shipNote(input: { ok: boolean; reasons: string[]; evidence: string[] }): string {
  if (input.ok) {
    return ["Ship gate: PASS.", ...input.evidence.map((line) => `  · ${line}`)].join("\n");
  }
  return ["Ship gate: NOT PASSED.", ...input.reasons.map((line) => `  x ${line}`)].join("\n");
}

function split(block: string): string {
  return block
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
