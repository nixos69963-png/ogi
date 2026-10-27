/**
 * Station contracts: what each station must hand over, written down.
 *
 * The factory line only beats a single long run because every hand-over is a
 * typed artefact rather than "the model said it was done". A scout that produced
 * no findings, or a verifier whose verdict is one word, fails schema validation
 * at the gate and gets one repair turn — the way a real line stops at a failed
 * gauge instead of shipping the part.
 *
 * Plan validation is here too, so the foreman's own output is checked against
 * the same kind of rules it enforces on everyone below it.
 */
import { validate } from "#core/schemas.ts";
import type { JsonSchema } from "#core/types.ts";

/** Kinds the foreman may schedule. `reviewer` is the harness's own, never planned. */
export const STATION_KINDS = ["scout", "builder", "verifier"] as const;
export type StationKind = (typeof STATION_KINDS)[number] | "reviewer";

/** Six stations is already a long line; more is the model inventing work. */
export const MAX_STATIONS = 6;
/** Two review rounds, then the station is marked failed and the line moves on. */
export const MAX_REVIEW_ROUNDS = 2;

function str(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: "string", description, ...extra };
}

function listOf(items: JsonSchema, description: string): JsonSchema {
  return { type: "array", description, items, minItems: 1 };
}

/** A list that may legitimately be empty — "no risks", "nothing left open". */
function anyList(items: JsonSchema, description: string): JsonSchema {
  return { type: "array", description, items };
}

function verdict(description: string): JsonSchema {
  return str(description, { enum: ["pass", "fail"] });
}

export const ARTIFACT_CONTRACTS: Record<StationKind, JsonSchema> = {
  scout: {
    type: "object",
    description: "What is actually there, before anything is changed.",
    required: ["findings", "files", "next"],
    additionalProperties: false,
    properties: {
      findings: listOf(str("One fact learned from a real file or command."), "Observed facts, each tied to something you read."),
      files: {
        type: "array",
        description: "Files that matter for the goal, with one line each on why.",
        minItems: 1,
        items: {
          type: "object",
          required: ["path", "why"],
          additionalProperties: false,
          properties: { path: str("Workspace-relative path."), why: str("Why it matters.") },
        },
      },
      risks: anyList(str("One risk."), "What could make the plan wrong. Empty if none."),
      next: str("The single most useful action for the station after you."),
    },
  },
  builder: {
    type: "object",
    description: "What you changed and how you know it took.",
    required: ["changed", "how_verified"],
    additionalProperties: false,
    properties: {
      changed: {
        type: "array",
        description: "Each file or process you touched.",
        minItems: 1,
        items: {
          type: "object",
          required: ["path", "what"],
          additionalProperties: false,
          properties: { path: str("Workspace-relative path."), what: str("What is different now.") },
        },
      },
      how_verified: str("The command you ran or the file you re-read that proves the change is real."),
      open: anyList(str("One unfinished point."), "Anything deliberately left undone. Empty if none."),
    },
  },
  verifier: {
    type: "object",
    description: "An independent check, with the evidence for each item.",
    required: ["verdict", "checks"],
    additionalProperties: false,
    properties: {
      verdict: verdict("pass only if every check below passed."),
      checks: {
        type: "array",
        description: "Each acceptance item, tested separately.",
        minItems: 1,
        items: {
          type: "object",
          required: ["name", "evidence", "ok"],
          additionalProperties: false,
          properties: {
            name: str("What was checked."),
            evidence: str("The exact output or file content that answers it."),
            ok: { type: "boolean", description: "Did this check pass?" },
          },
        },
      },
      notes: str("Anything the line should know. Optional."),
    },
  },
  reviewer: {
    type: "object",
    description: "The gauge reading for one station's artefact.",
    required: ["verdict", "problems", "instructions"],
    additionalProperties: false,
    properties: {
      verdict: { type: "string", description: "pass, or revise with concrete instructions.", enum: ["pass", "revise"] },
      problems: anyList(str("One problem, stated as what is missing."), "Empty when the verdict is pass."),
      instructions: str("What the station must do differently. Say \"none\" if the verdict is pass."),
    },
  },
};

export const PLAN_SCHEMA: JsonSchema = {
  type: "object",
  required: ["acceptance", "stations"],
  additionalProperties: false,
  properties: {
    acceptance: listOf(str("One observable condition the finished work must meet."), "What 'done' means, in terms a verifier can check."),
    stations: {
      type: "array",
      minItems: 1,
      maxItems: MAX_STATIONS,
      description: "The line, in order. Each station is one job with one artefact.",
      items: {
        type: "object",
        required: ["kind", "title", "goal", "accepts"],
        additionalProperties: false,
        properties: {
          kind: str("Station type.", { enum: [...STATION_KINDS] }),
          title: str("Under five words, what this station does."),
          goal: str("One imperative sentence. It must be possible to tell whether it happened."),
          accepts: listOf(str("One item this station is judged against."), "What this station must satisfy."),
        },
      },
    },
  },
};

export type ContractCheck = { ok: true; value: unknown } | { ok: false; errors: string[] };

export function checkArtifact(kind: StationKind, value: unknown): ContractCheck {
  const result = validate(ARTIFACT_CONTRACTS[kind], value);
  return result.ok ? { ok: true, value: result.value } : { ok: false, errors: result.errors };
}

export function checkPlan(args: unknown): ContractCheck {
  return validate(PLAN_SCHEMA, args) as ContractCheck;
}

/** `problems: [""]` passes the shape but means nothing; the gate reads these. */
export function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export function verdictOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const verdict = (value as Record<string, unknown>).verdict;
  return typeof verdict === "string" ? verdict : null;
}
