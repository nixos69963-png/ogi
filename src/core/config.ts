/**
 * Configuration: .env, then real environment, then these defaults.
 *
 * There is no dotenv dependency and no hidden precedence: readConfig() is the
 * only place a setting is resolved, and every setting it reads is documented in
 * .env.example. A wrong value fails loudly at startup rather than surprising the
 * agent mid-run.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig, ApprovalLevel } from "#core/types.ts";

export const DEFAULT_MODEL = "gemma4:31b-cloud";
export const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

/** The words `AGENT_APPROVAL_LEVEL` accepts; anything else is not a tier and gets ignored. */
export const APPROVAL_LEVELS = new Set<string>(["ask", "auto", "full"]);

/**
 * What `/approve <word>` and the environment accept: the three tiers, plus the old
 * on/off. Null means it is not a tier at all, so the caller can say so rather than
 * quietly picking one.
 */
export function parseApprovalLevel(word: string): ApprovalLevel | null {
  const value = word.trim().toLowerCase();
  if (value === "on") return "ask";
  if (value === "off") return "auto";
  return APPROVAL_LEVELS.has(value) ? (value as ApprovalLevel) : null;
}

/** One line per tier, so the terminal and the full screen describe it the same way. */
export const TIER_LINE: Record<ApprovalLevel, string> = {
  ask: "asks before every write and every outward step",
  auto: "runs routine writes and plain commands; asks for anything risky, outward or reaching the machine",
  full: "runs every write inside the project; the system itself, a file that cannot be re-created and anything outward still ask",
};

/** Turns are derived from the clock at 8 per minute, bounded like the app does. */
export const TURNS_PER_MINUTE = 8;
export const MIN_TURNS = 80;
export const MAX_TURNS = 1600;

export interface Overrides extends Partial<AppConfig> {}

/**
 * Parses the KEY=VALUE lines of a .env file. Deliberately dumb: no interpolation,
 * no exports keyword, no shell semantics — a config file that can run code is a
 * bug waiting for a hostile value.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function fromFile(cwd: string): Record<string, string> {
  for (const candidate of [path.join(cwd, ".env"), path.join(cwd, "..", ".env")]) {
    if (existsSync(candidate)) {
      try {
        return parseEnv(readFileSync(candidate, "utf8"));
      } catch {
        return {};
      }
    }
  }
  return {};
}

export function readConfig(cwd: string = process.cwd(), overrides: Overrides = {}): AppConfig {
  const file = fromFile(cwd);
  const pick = (key: string): string | undefined =>
    process.env[key] ?? file[key] ?? undefined;

  const workspace = path.resolve(overrides.workspace ?? pick("AGENT_WORKSPACE") ?? cwd);
  const budgetMinutes = (() => {
    if (overrides.budgetMinutes !== undefined) return overrides.budgetMinutes;
    const raw = pick("AGENT_BUDGET_MINUTES");
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  })();

  const maxTurns =
    overrides.maxTurns ??
    (budgetMinutes == null
      ? MIN_TURNS
      : Math.min(MAX_TURNS, Math.max(MIN_TURNS, Math.round(budgetMinutes * TURNS_PER_MINUTE))));

  const contextTokens = Number(overrides.contextTokens ?? pick("AGENT_CONTEXT_TOKENS") ?? 60_000);
  const asked = overrides.approvals ?? (pick("AGENT_APPROVALS") ?? "on") !== "off";
  // The tier is the switch now; `approvals` is the same door, kept because everything
  // already reads it. An unrecognised name stays the safest tier rather than the
  // fastest one.
  const named = pick("AGENT_APPROVAL_LEVEL");
  const approvalLevel: ApprovalLevel =
    overrides.approvalLevel ?? (named && APPROVAL_LEVELS.has(named) ? (named as ApprovalLevel) : asked ? "ask" : "auto");

  return {
    baseUrl: (overrides.baseUrl ?? pick("OLLAMA_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: overrides.model ?? pick("AGENT_MODEL") ?? DEFAULT_MODEL,
    workspace,
    allowOutside: overrides.allowOutside ?? pick("AGENT_ALLOW_OUTSIDE") === "true",
    allowSecrets: overrides.allowSecrets ?? pick("AGENT_ALLOW_SECRETS") === "true",
    budgetMinutes,
    maxTurns,
    maxObserveChars: Number(overrides.maxObserveChars ?? pick("AGENT_MAX_OBSERVE_CHARS") ?? 12_000),
    contextTokens: Number.isFinite(contextTokens) && contextTokens > 2_000 ? contextTokens : 60_000,
    compactAtPercent: Number(overrides.compactAtPercent ?? pick("AGENT_COMPACT_AT_PERCENT") ?? 0.75),
    approvals: approvalLevel === "ask",
    approvalLevel,
    githubToken: overrides.githubToken ?? pick("GITHUB_TOKEN") ?? null,
    githubRepo: overrides.githubRepo ?? pick("GITHUB_REPO") ?? null,
  };
}

/** A `:cloud` or `-cloud` tag is Ollama's billed tier, not a model on this machine. */
export function isCloudModel(model: string): boolean {
  return /(?:^|[:_-])cloud$/i.test(model);
}

/** A short, honest startup line — the model name is the first thing to get wrong. */
export function describeConfig(c: AppConfig): string {
  const budget = c.budgetMinutes == null ? "until done" : `${c.budgetMinutes} min`;
  const local = isCloudModel(c.model) ? "cloud (billed)" : "local";
  return `${c.model} [${local}] · ${budget} / ${c.maxTurns} turns · ${c.workspace} · approvals ${c.approvalLevel}`;
}
