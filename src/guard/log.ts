/**
 * The action log.
 *
 * Every tool call is written as one JSON line under <workspace>/.agent/log/. It is
 * the record of what the agent actually did, which is what you read after a run
 * you did not watch — so arguments are redacted before they land, and a failure is
 * stored with the same care as a success.
 *
 * Backups and undo are kept here too, because "restore work after a crash" is only
 * true if the run wrote down what it changed first.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { LogEvent } from "#core/types.ts";
import { redact, redactArgs } from "./redact.ts";

export const AGENT_DIR = ".agent";
export const LOG_DIR = path.join(AGENT_DIR, "log");
export const BACKUP_DIR = path.join(AGENT_DIR, "backups");
export const FACTORY_DIR = ".factory";

export interface RunLog {
  file: string;
  events: LogEvent[];
  write(event: LogEvent): void;
  note(kind: string, text: string): void;
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** Opens (never truncates) today's log. A broken disk degrades to memory-only. */
export function openRunLog(workspace: string, runId: string): RunLog {
  const dir = ensureDir(path.join(workspace, LOG_DIR));
  const file = path.join(dir, `${stamp(new Date())}.jsonl`);
  const events: LogEvent[] = [];

  const append = (line: string): void => {
    try {
      appendFileSync(file, `${line}\n`, "utf8");
    } catch {
      /* the in-memory copy is still complete; the run must not die on a log */
    }
  };

  return {
    file,
    events,
    write(event) {
      events.push(event);
      append(
        JSON.stringify({
          ...event,
          run: runId,
          args: redactArgs(event.args),
          ...(event.error ? { error: redact(event.error).text } : {}),
        }),
      );
    },
    note(kind, text) {
      append(JSON.stringify({ at: Date.now(), run: runId, kind, text: redact(text).text }));
    },
  };
}

export interface LogLine {
  at: number;
  turn?: number;
  tool?: string;
  effect?: string;
  /** Redacted before it landed, so a path survives here but a credential does not. */
  args?: Record<string, unknown>;
  ok?: boolean;
  chars?: number;
  ms?: number;
  error?: string;
  kind?: string;
  text?: string;
  run?: string;
}

export function readLog(workspace: string, limit = 40): LogLine[] {
  const dir = path.join(workspace, LOG_DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, m: statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const lines: LogLine[] = [];
  for (const entry of files) {
    const text = readFileSync(path.join(dir, entry.f), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw) as LogLine);
      } catch {
        /* a half-written line at the tail is expected after a crash */
      }
    }
    if (lines.length >= limit) break;
  }
  return lines.slice(-limit);
}
