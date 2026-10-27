/**
 * MCP configuration, read the way Claude Code writes it.
 *
 * Files are searched from general to specific:
 *   ~/.agent/mcp.json          user servers; the operator wrote them, so trusted
 *   user plugins               ~/.agent/plugins/<plugin>/
 *   <workspace>/.mcp.json      project servers; they wait for approval
 *   <workspace>/.agent/mcp.json
 *   project plugins            <workspace>/.agent/plugins/<plugin>/
 *
 * A project file is just text in a repository. Connecting one runs a command or
 * opens a URL chosen by whoever wrote that repository, so project servers do not
 * run until the operator approves their exact fingerprint (src/mcp/trust.ts).
 * Editing the command, args, env, URL or headers makes them pending again.
 *
 * `${VAR}` and `${VAR:-default}` are expanded in command, args, env values, URL
 * and headers. A missing variable is left literally in place and reported, never
 * silently turned into an empty string that changes what the command means.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userAgentHome } from "#core/memory.ts";
import { loadPlugins } from "#core/plugins.ts";
import { AGENT_DIR } from "#guard/log.ts";

export type McpScope = "user" | "project" | "plugin";
export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  name: string;
  scope: McpScope;
  /** Where the trust decision comes from: a user file is trusted, a project file is not. */
  origin: "user" | "project";
  source: string;
  plugin?: string;
  type: McpTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  /** Tool names (or `*`) the operator allows without a prompt. */
  allow: string[];
  timeoutMs: number;
  disabled: boolean;
}

export interface LoadedMcp {
  servers: McpServerConfig[];
  errors: string[];
  warnings: string[];
  files: string[];
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mcpDisabled(): boolean {
  return /^(0|false|off)$/i.test(process.env.AGENT_MCP ?? "");
}

function expand(value: string, where: string, warnings: string[]): string {
  return value.replace(VAR, (_whole, name: string, fallback: string | undefined) => {
    const found = process.env[name];
    if (found !== undefined) return found;
    if (fallback !== undefined) return fallback;
    warnings.push(`${where}: \${${name}} is not set; the literal is passed through`);
    return `\${${name}}`;
  });
}

function stringMap(value: unknown, where: string, warnings: string[], errors: string[], expandValues: boolean): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value)) {
    errors.push(`${where} must be an object of string values`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      errors.push(`${where}.${key} must be a string`);
      continue;
    }
    out[key] = expandValues ? expand(raw, `${where}.${key}`, warnings) : raw;
  }
  return out;
}

interface Meta {
  name: string;
  scope: McpScope;
  origin: "user" | "project";
  source: string;
  plugin?: string;
}

function normalize(raw: Record<string, unknown>, meta: Meta, warnings: string[]): { ok: true; server: McpServerConfig } | { ok: false; error: string } {
  const where = `${meta.source} · ${meta.name}`;
  const errors: string[] = [];
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const declared = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";

  if (declared && !["stdio", "http", "sse"].includes(declared)) {
    return {
      ok: false,
      error: `${where}: transport "${declared}" is not supported; use stdio, http or sse${declared === "ws" ? " (WebSocket MCP servers are not implemented)" : ""}`,
    };
  }
  const type: McpTransport = (declared as McpTransport) || (command ? "stdio" : url ? "http" : "stdio");

  if (type === "stdio" && !command) return { ok: false, error: `${where}: a stdio server needs "command"` };
  if (type !== "stdio" && !url) return { ok: false, error: `${where}: an ${type} server needs "url"` };
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: `${where}: url must be http or https, not ${parsed.protocol}` };
      }
    } catch {
      return { ok: false, error: `${where}: url "${url}" is not a valid URL` };
    }
  }

  let args: string[] = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args)) errors.push(`${where}: args must be an array of strings`);
    else {
      for (const arg of raw.args) {
        if (typeof arg !== "string") errors.push(`${where}: every arg must be a string`);
        else args.push(expand(arg, `${where} args`, warnings));
      }
    }
  }

  const env = stringMap(raw.env, `${where} env`, warnings, errors, true);
  const headers = stringMap(raw.headers, `${where} headers`, warnings, errors, true);
  let allow: string[] = [];
  if (raw.allow !== undefined) {
    if (typeof raw.allow === "string") allow = raw.allow.split(",").map((entry) => entry.trim()).filter(Boolean);
    else if (Array.isArray(raw.allow)) allow = raw.allow.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
    else errors.push(`${where}: allow must be a tool name, a comma-separated string, or an array of names`);
  }

  const requested = Number(raw.timeout_ms ?? raw.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requested) ? Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.round(requested))) : DEFAULT_TIMEOUT_MS;

  if (errors.length) return { ok: false, error: errors.join("; ") };

  return {
    ok: true,
    server: {
      ...meta,
      type,
      ...(command ? { command: expand(command, `${where} command`, warnings) } : {}),
      args,
      env,
      ...(url ? { url: expand(url, `${where} url`, warnings) } : {}),
      headers,
      allow,
      timeoutMs,
      disabled: raw.disabled === true || raw.enabled === false,
    },
  };
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (cause) {
    return { ok: false, error: (cause as Error).message };
  }
}

function collectFile(file: string, scope: McpScope, origin: "user" | "project", plugin: string | undefined, out: LoadedMcp): void {
  if (!existsSync(file)) return;
  out.files.push(file);
  const parsed = readJson(file);
  if (!parsed.ok) {
    out.errors.push(`${file}: ${parsed.error}`);
    return;
  }
  if (!isObject(parsed.value)) {
    out.errors.push(`${file}: the file must be an object with an "mcpServers" map`);
    return;
  }
  const map = isObject(parsed.value.mcpServers) ? parsed.value.mcpServers : isObject(parsed.value.servers) ? parsed.value.servers : null;
  if (!map) {
    out.errors.push(`${file}: no "mcpServers" object`);
    return;
  }
  for (const [name, entry] of Object.entries(map)) {
    if (!SERVER_NAME.test(name)) {
      out.errors.push(`${file}: server name "${name}" is not usable; letters, digits, dot, dash, underscore and colon only`);
      continue;
    }
    if (plugin) {
      const qualified = `plugin:${plugin}:${name}`;
      if (!SERVER_NAME.test(qualified)) {
        out.errors.push(`${file}: plugin server "${qualified}" is too long or has an unusable name`);
        continue;
      }
    }
    if (!isObject(entry)) {
      out.errors.push(`${file}: server "${name}" must be an object`);
      continue;
    }
    const normalized = normalize(entry, { name: plugin ? `plugin:${plugin}:${name}` : name, scope, origin, source: file, ...(plugin ? { plugin } : {}) }, out.warnings);
    if (!normalized.ok) {
      out.errors.push(normalized.error);
      continue;
    }
    const previous = out.servers.find((server) => server.name === normalized.server.name);
    if (previous) out.warnings.push(`mcp server "${normalized.server.name}" from ${previous.source} is overridden by ${file}`);
    out.servers = out.servers.filter((server) => server.name !== normalized.server.name);
    out.servers.push(normalized.server);
  }
}

export function loadMcpConfig(workspace: string): LoadedMcp {
  const out: LoadedMcp = { servers: [], errors: [], warnings: [], files: [] };
  if (mcpDisabled()) {
    out.warnings.push("MCP is off (AGENT_MCP=0)");
    return out;
  }

  collectFile(path.join(userAgentHome(), "mcp.json"), "user", "user", undefined, out);

  for (const plugin of loadPlugins(workspace)) {
    out.errors.push(...plugin.errors);
    if (!Object.keys(plugin.mcpServers).length) continue;
    const source = plugin.manifest;
    out.files.push(source);
    for (const [name, entry] of Object.entries(plugin.mcpServers)) {
      if (!isObject(entry)) {
        out.errors.push(`${source}: plugin server "${name}" must be an object`);
        continue;
      }
      const qualified = `plugin:${plugin.name}:${name}`;
      if (!SERVER_NAME.test(qualified)) {
        out.errors.push(`${source}: plugin server "${qualified}" has an unusable name`);
        continue;
      }
      const normalized = normalize(entry, { name: qualified, scope: "plugin", origin: plugin.scope, source, plugin: plugin.name }, out.warnings);
      if (!normalized.ok) {
        out.errors.push(normalized.error);
        continue;
      }
      const previous = out.servers.find((server) => server.name === qualified);
      if (previous) out.warnings.push(`mcp server "${qualified}" from ${previous.source} is overridden by ${source}`);
      out.servers = out.servers.filter((server) => server.name !== qualified);
      out.servers.push(normalized.server);
    }
  }

  collectFile(path.join(workspace, ".mcp.json"), "project", "project", undefined, out);
  collectFile(path.join(workspace, AGENT_DIR, "mcp.json"), "project", "project", undefined, out);

  out.servers.sort((a, b) => a.name.localeCompare(b.name));
  out.warnings = [...new Set(out.warnings)];
  out.errors = [...new Set(out.errors)];
  return out;
}

// ─── editing, for `agent mcp add/remove` ─────────────────────────────────────

/** Validate an entry the CLI is about to write, without touching a file. */
export function validateServerEntry(
  name: string,
  entry: Record<string, unknown>,
  scope: "user" | "project" = "user",
): { ok: true; server: McpServerConfig; warnings: string[] } | { ok: false; error: string } {
  if (!SERVER_NAME.test(name)) {
    return { ok: false, error: `"${name}" is not a usable server name; letters, digits, dot, dash, underscore and colon only` };
  }
  const warnings: string[] = [];
  const normalized = normalize(
    entry,
    { name, scope, origin: scope === "user" ? "user" : "project", source: "the command line" },
    warnings,
  );
  return normalized.ok ? { ok: true, server: normalized.server, warnings } : normalized;
}

export interface ServerFile {
  file: string;
  root: Record<string, unknown>;
  servers: Record<string, unknown>;
}

export function serverFile(workspace: string, scope: "user" | "project"): string {
  return scope === "user" ? path.join(userAgentHome(), "mcp.json") : path.join(workspace, ".mcp.json");
}

export function readServerFile(file: string): { ok: true; value: ServerFile } | { ok: false; error: string } {
  if (!existsSync(file)) return { ok: true, value: { file, root: {}, servers: {} } };
  const parsed = readJson(file);
  if (!parsed.ok) return { ok: false, error: `${file}: ${parsed.error}` };
  if (!isObject(parsed.value)) return { ok: false, error: `${file}: must contain a JSON object` };
  const servers = isObject(parsed.value.mcpServers) ? parsed.value.mcpServers : {};
  return { ok: true, value: { file, root: parsed.value, servers } };
}

export function writeServerFile(value: ServerFile): void {
  mkdirSync(path.dirname(value.file), { recursive: true });
  const next = { ...value.root, mcpServers: value.servers };
  writeFileSync(value.file, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** A config entry with secrets left out, for `agent mcp get`. */
export function maskEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const mask = (value: unknown): Record<string, string> | undefined => {
    if (!isObject(value)) return undefined;
    return Object.fromEntries(Object.keys(value).map((key) => [key, "***"]));
  };
  return {
    ...(typeof entry.type === "string" ? { type: entry.type } : {}),
    ...(typeof entry.command === "string" ? { command: entry.command } : {}),
    ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
    ...(typeof entry.url === "string" ? { url: entry.url } : {}),
    ...(mask(entry.env) ? { env: mask(entry.env) } : {}),
    ...(mask(entry.headers) ? { headers: mask(entry.headers) } : {}),
    ...(entry.allow !== undefined ? { allow: entry.allow } : {}),
    ...(entry.disabled === true ? { disabled: true } : {}),
  };
}
