/**
 * Which MCP servers may run.
 *
 * A server entry in a user file was written by the operator, so it runs. An entry
 * in a project file — `.mcp.json` beside someone else's code — was written by
 * whoever wrote that repository, and connecting it runs their command with this
 * user's rights. It waits until the operator approves that exact entry.
 *
 * Approval is a fingerprint, not a filename: changing the command, an argument, an
 * environment value, the URL, a header or the allow-list makes the server pending
 * again, because the thing that was approved is no longer the thing that would run.
 * The file is `~/.agent/mcp-trust.json`, mode 0600, and holds no secrets.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userAgentHome } from "#core/memory.ts";
import type { McpServerConfig } from "./config.ts";

export interface TrustEntry {
  fingerprint: string;
  approvedAt: string;
}

interface TrustFile {
  version: number;
  servers: Record<string, TrustEntry>;
}

const VERSION = 1;

export function trustFile(): string {
  return path.join(userAgentHome(), "mcp-trust.json");
}

/** The stable part of a server entry: everything that decides what it may do. */
export function serverFingerprint(server: McpServerConfig): string {
  const material = JSON.stringify({
    name: server.name,
    type: server.type,
    command: server.command ?? null,
    args: server.args,
    env: sorted(server.env),
    url: server.url ?? null,
    headers: sorted(server.headers),
    allow: [...server.allow].sort(),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 20);
}

function sorted(map: Record<string, string>): [string, string][] {
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
}

function read(): TrustFile {
  const file = trustFile();
  if (!existsSync(file)) return { version: VERSION, servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TrustFile>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.servers !== "object" || !parsed.servers) {
      return { version: VERSION, servers: {} };
    }
    const servers: Record<string, TrustEntry> = {};
    for (const [name, entry] of Object.entries(parsed.servers)) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<TrustEntry>;
      if (typeof candidate.fingerprint === "string") {
        servers[name] = { fingerprint: candidate.fingerprint, approvedAt: typeof candidate.approvedAt === "string" ? candidate.approvedAt : "" };
      }
    }
    return { version: VERSION, servers };
  } catch {
    // A corrupt trust file must not become a blanket yes, nor stop the agent:
    // the servers it named simply become pending again.
    return { version: VERSION, servers: {} };
  }
}

function write(value: TrustFile): void {
  const file = trustFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** `AGENT_MCP_TRUST_PROJECT=1` is the operator saying "run project servers without asking". */
export function projectTrustBypass(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.AGENT_MCP_TRUST_PROJECT ?? "");
}

/** Whether this exact server entry may start. */
export function isTrusted(server: McpServerConfig): boolean {
  if (server.origin === "user") return true;
  return read().servers[server.name]?.fingerprint === serverFingerprint(server);
}

/** Record approval for the entry as it is now. Returns the stored fingerprint. */
export function approveServer(server: McpServerConfig): string {
  const value = read();
  const fingerprint = serverFingerprint(server);
  value.servers[server.name] = { fingerprint, approvedAt: new Date().toISOString() };
  write(value);
  return fingerprint;
}

export function revokeServer(name: string): boolean {
  const value = read();
  if (!value.servers[name]) return false;
  delete value.servers[name];
  write(value);
  return true;
}

/** For `agent mcp list`: name → fingerprint the operator approved. */
export function approvedFingerprints(): Record<string, string> {
  return Object.fromEntries(Object.entries(read().servers).map(([name, entry]) => [name, entry.fingerprint]));
}
