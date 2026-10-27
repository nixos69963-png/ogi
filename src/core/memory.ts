/**
 * The operator's standing instructions.
 *
 * Claude Code reads CLAUDE.md at the start of every run; the rest of the trade has
 * settled on AGENTS.md. This reads both, plus a user-level file, and puts them in
 * the brief ahead of the task. The point is not to remember everything — it is to
 * stop asking the operator the same question on every run.
 *
 * Two rules keep it useful. Nearest file first, because a project's rules beat a
 * machine's. And a cap on the whole bundle: a wall of text is not context, it is a
 * reason for the model to skim.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MemorySource {
  /** Where it was read from, as the operator writes it. */
  path: string;
  text: string;
  chars: number;
  truncated: boolean;
}

/** One file may not take the whole context; the bundle may not take twice that. */
const MAX_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 24_000;

/** `AGENT_HOME` moves the user-level half, which is what a test or a portable install needs. */
export function userAgentHome(): string {
  return process.env.AGENT_HOME?.trim() || path.join(os.homedir(), ".agent");
}

/**
 * Project files live beside the work; the user file lives with the tool. Both
 * spellings are read: AGENT.md is ours, AGENTS.md is what other agents read too.
 */
export function memoryPaths(workspace: string): string[] {
  return [
    path.join(workspace, "AGENTS.md"),
    path.join(workspace, "AGENT.md"),
    path.join(userAgentHome(), "AGENT.md"),
  ];
}

export function loadMemory(workspace: string): MemorySource[] {
  const out: MemorySource[] = [];
  let total = 0;
  for (const file of memoryPaths(workspace)) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8").trim();
    } catch {
      continue;
    }
    if (!text) continue;
    let truncated = false;
    if (text.length > MAX_FILE_CHARS) {
      text = text.slice(0, MAX_FILE_CHARS).trimEnd();
      truncated = true;
    }
    if (total + text.length > MAX_TOTAL_CHARS) {
      const room = MAX_TOTAL_CHARS - total;
      if (room < 400) break;
      text = text.slice(0, room).trimEnd();
      truncated = true;
    }
    total += text.length;
    out.push({ path: file, text, chars: text.length, truncated });
  }
  return out;
}

/**
 * The block that goes into the system brief. It says who wrote it and where it
 * stops: the operator's instructions shape the work, never the harness's floor.
 */
export function memoryBrief(sources: MemorySource[]): string {
  if (!sources.length) return "";
  const blocks = sources.map((source) => `From ${source.path}${source.truncated ? " (cut to fit)" : ""}:\n${source.text}`);
  return [
    "## Standing instructions (written by the operator)",
    "Follow these unless they conflict with the boundaries above — those are not negotiable.",
    ...blocks,
  ].join("\n\n");
}

/** One line per file, for `/memory`. */
export function memorySummary(sources: MemorySource[]): string[] {
  if (!sources.length) return ["no standing instructions yet — /init writes a starter AGENT.md"];
  return sources.map((source) => `${source.path} — ${source.chars.toLocaleString()} chars${source.truncated ? " (cut to fit)" : ""}`);
}

/**
 * The deterministic starter behind `/init`. It cannot describe the project the way
 * the model could, so it records the facts a tool can prove — the name, how it is
 * run, how it is checked — and leaves the opinions to the operator.
 */
export function starterMemory(workspace: string): string {
  let name = path.basename(workspace);
  let description = "";
  let scripts: [string, string][] = [];
  try {
    const pkg = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8")) as {
      name?: unknown;
      description?: unknown;
      scripts?: Record<string, unknown>;
    };
    if (typeof pkg.name === "string" && pkg.name.trim()) name = pkg.name.trim();
    if (typeof pkg.description === "string") description = pkg.description.trim();
    if (pkg.scripts && typeof pkg.scripts === "object") {
      scripts = Object.entries(pkg.scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .slice(0, 10);
    }
  } catch {
    /* no manifest: a starter with the folder's name is still better than nothing */
  }
  const timing = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`;
  const lines = [
    `# ${name} — working notes for the agent`,
    "",
    "This file is read at the start of every run. Keep it short: facts the agent cannot",
    "learn faster with a tool, and rules it would otherwise get wrong.",
    "",
    "## Project",
    `- ${description || name}`,
    `- runtime: ${timing}`,
    "",
  ];
  if (scripts.length) {
    lines.push("## Commands", ...scripts.map(([key, command]) => `- ${key}: ${command}`), "");
  }
  lines.push(
    "## Rules",
    "- ",
    "",
    "## Layout",
    "- ",
    "",
  );
  return lines.join("\n");
}

/** `/init`: never overwrite a file the operator already wrote. */
export function initMemory(workspace: string): { ok: boolean; path: string; created: boolean; error?: string } {
  const file = path.join(workspace, "AGENT.md");
  if (existsSync(file)) return { ok: true, path: file, created: false };
  try {
    writeFileSync(file, starterMemory(workspace), "utf8");
    return { ok: true, path: file, created: true };
  } catch (cause) {
    return { ok: false, path: file, created: false, error: (cause as Error).message };
  }
}
