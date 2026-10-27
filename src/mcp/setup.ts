/**
 * `/mcp add`, read the way a command line is read.
 *
 * The in-session form is deliberately the same shape as `agent mcp add`: a name,
 * flags, then `--` and the command the server should run. A quote-aware splitter
 * is the only syntax it understands, because an MCP command line pasted from a
 * README must mean the same thing here as it does in a shell.
 */
import type { McpServerConfig } from "./config.ts";

export type AddScope = "user" | "project";

export interface AddCommand {
  name: string;
  entry: Record<string, unknown>;
  scope: AddScope;
}

export type Parsed = { ok: true; command: AddCommand } | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Split on whitespace, but keep a quoted argument together. */
export function tokenize(line: string): { ok: true; words: string[] } | { ok: false; error: string } {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && quote === '"' && i + 1 < line.length) {
        const next = line[i + 1]!;
        if (next === '"' || next === "\\") {
          word += next;
          i += 1;
          continue;
        }
      }
      word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length && /[\s"'\\]/.test(line[i + 1]!)) {
      word += line[i + 1]!;
      i += 1;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    word += ch;
    started = true;
  }
  if (quote) return { ok: false, error: "a quote is still open; close it and try again" };
  if (started) words.push(word);
  return { ok: true, words };
}

function pair(raw: string, kind: "env" | "header"): { ok: true; key: string; value: string } | { ok: false; error: string } {
  const at = raw.indexOf(kind === "env" ? "=" : ":");
  if (at <= 0) {
    return { ok: false, error: kind === "env" ? `--env takes KEY=VALUE, got "${raw}"` : `--header takes "Name: value", got "${raw}"` };
  }
  const key = raw.slice(0, at).trim();
  const value = raw.slice(at + 1).trim();
  if (!key) return { ok: false, error: `the ${kind === "env" ? "variable" : "header"} name is empty` };
  return { ok: true, key, value };
}

function fromJson(name: string, text: string): Parsed {
  let entry: unknown;
  try {
    entry = JSON.parse(text);
  } catch (cause) {
    return { ok: false, error: `the JSON did not parse: ${(cause as Error).message}` };
  }
  if (!isObject(entry)) return { ok: false, error: "the JSON must be one object, like {\"command\":\"npx\",\"args\":[\"-y\",\"pkg\"]}" };
  return { ok: true, command: { name, entry, scope: "user" } };
}

export function parseAdd(line: string): Parsed {
  const text = line.trim();
  if (!text) {
    return {
      ok: false,
      error: "usage: /mcp add <name> -- <command> [args...]   ·   /mcp add <name> --url <url> [--transport http|sse]",
    };
  }

  // A pasted JSON entry is one argument, even when it contains spaces.
  const json = /^(\S+)\s+(\{[\s\S]*\})\s*$/.exec(text);
  if (json) return fromJson(json[1]!, json[2]!);

  const tokens = tokenize(text);
  if (!tokens.ok) return tokens;
  const words = tokens.words;
  const name = words.shift();
  if (!name) return { ok: false, error: "give the server a name" };
  if (words.length === 1 && words[0]!.startsWith("{")) return fromJson(name, words[0]!);

  let scope: AddScope = "user";
  let transport: "stdio" | "http" | "sse" | undefined;
  let url = "";
  let timeoutMs: number | undefined;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const allow: string[] = [];
  let from = -1;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const value = (): string | null => (i + 1 < words.length ? words[++i]! : null);
    if (word === "--") {
      from = i + 1;
      break;
    }
    switch (word) {
      case "--project":
        scope = "project";
        break;
      case "-t":
      case "--transport": {
        const kind = value();
        if (kind !== "stdio" && kind !== "http" && kind !== "sse") {
          return { ok: false, error: `--transport takes stdio, http or sse — not "${kind ?? ""}"` };
        }
        transport = kind;
        break;
      }
      case "--url": {
        const found = value();
        if (!found) return { ok: false, error: "--url needs a URL" };
        url = found;
        break;
      }
      case "-e":
      case "--env": {
        const raw = value();
        if (raw === null) return { ok: false, error: "--env needs KEY=VALUE" };
        const parsed = pair(raw, "env");
        if (!parsed.ok) return parsed;
        env[parsed.key] = parsed.value;
        break;
      }
      case "-H":
      case "--header": {
        const raw = value();
        if (raw === null) return { ok: false, error: `--header needs "Name: value"` };
        const parsed = pair(raw, "header");
        if (!parsed.ok) return parsed;
        headers[parsed.key] = parsed.value;
        break;
      }
      case "--allow": {
        const raw = value();
        if (!raw) return { ok: false, error: "--allow needs a tool name" };
        allow.push(...raw.split(",").map((entry) => entry.trim()).filter(Boolean));
        break;
      }
      case "--timeout": {
        const raw = value();
        const seconds = Number(raw);
        if (raw === null || !Number.isFinite(seconds) || seconds <= 0) {
          return { ok: false, error: "--timeout takes a positive number of seconds" };
        }
        timeoutMs = Math.round(seconds * 1_000);
        break;
      }
      default:
        if (word.startsWith("-")) return { ok: false, error: `unknown option "${word}"` };
        // A bare word is the start of a stdio command; everything after it is argv.
        from = i;
        i = words.length;
        break;
    }
  }

  const entry: Record<string, unknown> = {};
  if (transport && transport !== "stdio" || url) {
    if (!url) return { ok: false, error: "an http or sse server needs --url" };
    if (from >= 0) return { ok: false, error: "an http or sse server takes --url, not a command" };
    if (transport === "stdio") return { ok: false, error: "a stdio server takes a command after --, not --url" };
    entry.type = transport ?? "http";
    entry.url = url;
    if (Object.keys(headers).length) entry.headers = headers;
  } else {
    if (from < 0 || from >= words.length) {
      return { ok: false, error: "a stdio server needs a command: /mcp add <name> -- <command> [args...]" };
    }
    entry.type = "stdio";
    entry.command = words[from]!;
    entry.args = words.slice(from + 1);
  }
  if (Object.keys(env).length) entry.env = env;
  if (allow.length) entry.allow = allow;
  if (timeoutMs !== undefined) entry.timeout_ms = timeoutMs;

  return { ok: true, command: { name, entry, scope } };
}

/** The shape the hub needs; kept here so a test can build one without a socket. */
export interface AddResult {
  ok: boolean;
  message: string;
  server?: McpServerConfig;
}
