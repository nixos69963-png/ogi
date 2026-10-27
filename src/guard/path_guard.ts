/**
 * Path guard: one rule, applied everywhere a path enters the agent.
 *
 * The workspace is the boundary. Anything outside it is refused with a message
 * that says what to do, unless the boundary is deliberately turned off. Secret
 * files are refused even inside it, because reading one hands it to the model and
 * the model here may be a billed cloud endpoint.
 *
 * The model writes Git-Bash-style paths as often as Windows ones, so `/c/...`
 * and `C:\...` are the same path here. Symlinks are resolved before the boundary
 * is checked, so a link inside the workspace cannot smuggle a file outside it.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";

export interface PathPolicy {
  workspace: string;
  allowOutside: boolean;
  allowSecrets: boolean;
  /** Where a relative path is resolved from. Defaults to the workspace. */
  cwd?: string;
}

export type PathDecision = { ok: true; path: string; inside: boolean } | { ok: false; error: string };

/** `/c/Users/PC/x` and `/C/x` → `C:\Users\PC\x`; `~/x` → the home directory. */
export function normalizeInput(raw: string): string {
  let out = raw.trim().replace(/^["']|["']$/g, "");
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    out = path.join(os.homedir(), out.slice(1).replace(/^[/\\]/, ""));
  }
  if (IS_WINDOWS) {
    const m = /^\/([a-zA-Z])(?:\/|\\)(.*)$/.exec(out);
    if (m) out = `${m[1]!.toUpperCase()}:\\${m[2]!.replace(/\//g, "\\")}`;
    const d = /^\/([a-zA-Z]:)(?:\/|\\)?(.*)$/.exec(out);
    if (d) out = `${d[1]!.toUpperCase()}\\${d[2]!.replace(/\//g, "\\")}`;
  }
  return out.replace(/[\\/]+$/, "") || out;
}

export function isInside(workspace: string, target: string): boolean {
  const ws = IS_WINDOWS ? workspace.toLowerCase() : workspace;
  const tg = IS_WINDOWS ? target.toLowerCase() : target;
  const rel = path.relative(ws, tg);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const SECRET_NAMES = [
  /\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|[\\/])id_(rsa|ecdsa|ed25519|dsa)(\.pub)?$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])credentials(\.json|\.xml)?$/i,
  /(^|[\\/])\.aws[\\/](credentials|config)$/i,
  /(^|[\\/])sockets\.db$/i,
  /(^|[\\/])login data$/i,
];

export function isSensitiveFile(absolutePath: string): boolean {
  const normal = absolutePath.replace(/\\/g, "/");
  // .env.example and .env.sample carry no secrets and are meant to be read.
  if (/\.(example|sample|template|dist)$/i.test(normal)) return false;
  return SECRET_NAMES.some((re) => re.test(normal));
}

/** Realpath of the deepest existing ancestor, so a not-yet-created file is still checked. */
function canonical(absolutePath: string): string {
  let cursor = absolutePath;
  const tail: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  let base = cursor;
  try {
    base = realpathSync(cursor);
  } catch {
    /* keep the lexical path */
  }
  return tail.length ? path.join(base, ...tail) : base;
}

function describe(workspace: string, target: string): string {
  if (IS_WINDOWS) return target.toLowerCase().startsWith(workspace.toLowerCase().slice(0, 3)) ? target : target;
  return target;
}

export function guardPath(policy: PathPolicy, raw: string, intent: "read" | "write" | "run" = "read"): PathDecision {
  const workspace = canonical(path.resolve(policy.workspace));
  if (!raw || !raw.trim()) return { ok: false, error: "An empty path was given. Use a path relative to the workspace." };

  const input = normalizeInput(raw);
  const lexical = path.isAbsolute(input) ? path.resolve(input) : path.resolve(policy.cwd ?? workspace, input);
  const resolved = canonical(lexical);
  const inside = isInside(workspace, resolved);

  if (!inside && !policy.allowOutside) {
    return {
      ok: false,
      error:
        `"${describe(workspace, resolved)}" is outside the workspace (${workspace}). ` +
        `Work relative to it, or set AGENT_ALLOW_OUTSIDE=true when you really mean to touch that path.`,
    };
  }
  if (!inside) {
    if (!existsSync(path.dirname(resolved))) {
      return { ok: false, error: `The directory for "${resolved}" does not exist. Create it first or choose another path.` };
    }
  }
  if (!policy.allowSecrets && (intent === "read" || intent === "write") && isSensitiveFile(resolved)) {
    return {
      ok: false,
      error:
        `"${path.basename(resolved)}" is on the secret deny list, and ${intent === "read" ? "a read sends its contents to the model" : "a write would overwrite a credential"}. ` +
        `Set AGENT_ALLOW_SECRETS=true to override, or ask the human to open it.`,
    };
  }
  if (resolved.toLowerCase().startsWith(workspace.toLowerCase() + path.sep + path.sep)) {
    return { ok: false, error: `Double separator in "${resolved}". Give one clean path.` };
  }
  return { ok: true, path: resolved, inside };
}

/** For shell tools: does this command string name a path the guard would refuse? */
export function guardCommand(policy: PathPolicy, command: string): PathDecision {
  const candidates = [...command.matchAll(/(["']?)([A-Za-z]:\\\\?[^"'`\s]+|\/[A-Za-z]\/[^"'`\s]+|~\/[^"'`\s]+|\.\/[^"'`\s]+)/g)];
  for (const match of candidates) {
    const raw = match[2];
    if (!raw) continue;
    const decision = guardPath(policy, raw, "run");
    if (!decision.ok && /outside the workspace/.test(decision.error)) return decision;
  }
  return { ok: true, path: command, inside: true };
}

/** A readable label for logs and prompts: workspace-relative when it can be. */
export function displayPath(workspace: string, target: string): string {
  const relative = path.relative(workspace, target);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.replace(/\\/g, "/");
  return target;
}

export function workspaceExists(workspace: string): { ok: boolean; error?: string } {
  if (!existsSync(workspace)) return { ok: false, error: `Workspace ${workspace} does not exist. Pass --workspace <dir> or create it.` };
  const stat = lstatSync(workspace);
  if (!stat.isDirectory()) return { ok: false, error: `Workspace ${workspace} is not a directory.` };
  return { ok: true };
}
