/**
 * Artefacts and the ship gate.
 *
 * A station hands off by writing `.factory/artifacts/<id>.json` through
 * `write_artifact`, which validates the payload against its contract before it
 * touches disk, plus a `.md` copy a person can read without a parser. The gate at
 * the end of the line then reads those files rather than trusting the transcript:
 * a station is only done if its artefact exists, matches its contract, and the
 * files it claims to have changed are ones the log says were touched.
 *
 * That last check is the one that matters after a bad run. A model that says
 * "created src/login.ts" while the log holds no such call does not pass a gate
 * that looks at both.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FACTORY_DIR } from "#guard/log.ts";
import type { LogLine } from "#guard/log.ts";
import { checkArtifact, textList, type StationKind } from "./schemas.ts";
import type { PlanDoc, Station } from "./plan.ts";

export function artifactsDir(workspace: string): string {
  const dir = path.join(workspace, FACTORY_DIR, "artifacts");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function artifactBase(stationId: string): string {
  return `${/[^A-Za-z0-9._-]/.test(stationId) ? "station" : stationId}.json`;
}

export function artifactPath(workspace: string, stationId: string): string {
  return path.join(artifactsDir(workspace), artifactBase(stationId));
}

export function readArtifact(workspace: string, stationId: string): unknown | null {
  const file = artifactPath(workspace, stationId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export interface WrittenArtifact {
  file: string;
  markdown: string;
  bytes: number;
}

/** Assumes the payload already validated — `write_artifact` does that first. */
export function writeArtifact(workspace: string, stationId: string, kind: StationKind, value: unknown): WrittenArtifact {
  const file = artifactPath(workspace, stationId);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(file, json, "utf8");
  const markdown = artifactPath(workspace, stationId).replace(/\.json$/, ".md");
  writeFileSync(markdown, render(kind, String(stationId), value), "utf8");
  return { file, markdown, bytes: Buffer.byteLength(json) };
}

/** Human-readable twin of the JSON: what a person reads when the run is over. */
export function render(kind: StationKind, stationId: string, value: unknown): string {
  const record = (value ?? {}) as Record<string, unknown>;
  const out: string[] = [`# ${stationId} · ${kind}`, ""];
  const push = (label: string, items: string[]): void => {
    if (!items.length) return;
    out.push(`## ${label}`, ...items.map((item) => `- ${item}`), "");
  };
  if (typeof record.goal === "string") out.push(record.goal, "");
  if (typeof record.next === "string") out.push(`**Next:** ${record.next}`, "");
  if (typeof record.how_verified === "string") out.push(`**Verified by:** ${record.how_verified}`, "");
  if (typeof record.verdict === "string") out.push(`**Verdict:** ${record.verdict}`, "");
  if (typeof record.instructions === "string") out.push(`**Instructions:** ${record.instructions}`, "");
  if (typeof record.notes === "string") out.push(`**Notes:** ${record.notes}`, "");
  if (Array.isArray(record.files)) push("Files", (record.files as unknown[]).map(fileLine("path", "why")));
  if (Array.isArray(record.changed)) push("Changed", (record.changed as unknown[]).map(fileLine("path", "what")));
  if (Array.isArray(record.findings)) push("Findings", textList(record.findings));
  if (Array.isArray(record.risks)) push("Risks", textList(record.risks));
  if (Array.isArray(record.open)) push("Open", textList(record.open));
  if (Array.isArray(record.problems)) push("Problems", textList(record.problems));
  if (Array.isArray(record.checks))
    push(
      "Checks",
      (record.checks as unknown[]).map((check) => {
        const c = (check ?? {}) as Record<string, unknown>;
        return `${c.ok ? "✓" : "✗"} ${String(c.name ?? "check")} — ${String(c.evidence ?? "no evidence given")}`;
      }),
    );
  return `${out.join("\n").trim()}\n`;
}

function fileLine(key: string, second: string): (value: unknown) => string {
  return (value) => {
    const entry = (value ?? {}) as Record<string, unknown>;
    return `${String(entry[key] ?? "?")} — ${String(entry[second] ?? "")}`.trimEnd();
  };
}

export interface Gate {
  ok: boolean;
  reasons: string[];
  evidence: string[];
}

/**
 * The only thing that turns a finished line into finished work.
 *
 * Each rule adds a reason instead of throwing, so a blocked ship tells the
 * operator which station to look at rather than failing with one word.
 */
export function shipGate(workspace: string, plan: PlanDoc, log: LogLine[] = []): Gate {
  const reasons: string[] = [];
  const evidence: string[] = [];

  if (!plan.acceptance.length) reasons.push("The plan carries no acceptance criteria, so nothing can be shipped against it.");

  const unfinished = plan.stations.filter((s) => s.state !== "done");
  for (const station of unfinished) reasons.push(`${station.id} ${station.kind} "${station.title}" is ${station.state}, not done.`);

  for (const station of plan.stations) {
    if (station.state !== "done") continue;
    const value = readArtifact(workspace, station.id);
    if (value === null) {
      reasons.push(`${station.id} has no artefact on disk (${artifactBase(station.id)}).`);
      continue;
    }
    const checked = checkArtifact(station.kind, value);
    if (!checked.ok) {
      reasons.push(`${station.id} breaks its ${station.kind} contract: ${checked.errors.join("; ")}`);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (station.kind === "verifier" && record.verdict !== "pass") {
      reasons.push(`${station.id} verified the work and returned "${String(record.verdict)}".`);
      continue;
    }
    if (station.kind === "verifier" && Array.isArray(record.checks)) {
      const failed = (record.checks as unknown[]).filter((c) => (c as Record<string, unknown>)?.ok !== true).length;
      if (failed) reasons.push(`${station.id} reports ${failed} failed check(s) even though its verdict says pass.`);
    }
    if (station.review.verdict !== "pass") reasons.push(`${station.id} never passed review (${station.review.rounds} round(s), verdict ${station.review.verdict ?? "none"}).`);
    evidence.push(`${station.id} ${station.kind}: artefact valid, ${station.turns} turns, review passed.`);
  }

  const touched = new Set(
    log
      .filter((line) => line.ok && ["write_file", "edit_file", "move_path", "remove_path"].includes(String(line.tool ?? "")))
      .map((line) => String(((line.args ?? {}) as Record<string, unknown>).path ?? ((line.args ?? {}) as Record<string, unknown>).to ?? "")),
  );
  for (const station of plan.stations) {
    if (station.kind !== "builder" || station.state !== "done") continue;
    const value = readArtifact(workspace, station.id) as Record<string, unknown> | null;
    const claimed = Array.isArray(value?.changed) ? (value!.changed as unknown[]).map((c) => String((c as Record<string, unknown>)?.path ?? "")) : [];
    if (!claimed.length) continue;
    const missing = claimed.filter((file) => !touched.has(file) && !existsSync(path.join(workspace, file)));
    if (missing.length) reasons.push(`${station.id} claims to have changed ${missing.join(", ")}, but neither the log nor the disk agrees.`);
    else if (claimed.length) evidence.push(`${station.id} claims ${claimed.length} change(s); all present in the log or on disk.`);
  }

  const verifiers = plan.stations.filter((s) => s.kind === "verifier" && s.state === "done");
  if (!verifiers.length) reasons.push("No verifier station completed, so the work was never checked independently.");

  return { ok: reasons.length === 0, reasons, evidence };
}

/** Compact block for the final report and for the station brief of the next one. */
export function artifactDigest(station: Station, workspace: string, maxChars = 900): string {
  const value = readArtifact(workspace, station.id);
  if (value === null) return `${station.id}: no artefact.`;
  const text = JSON.stringify(value, null, 1);
  return `${station.id} (${station.kind}) artefact:\n${text.length > maxChars ? `${text.slice(0, maxChars)}…` : text}`;
}
