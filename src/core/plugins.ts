/**
 * Plugins, in the shape Claude Code already uses.
 *
 * A plugin is a folder with a manifest (`.claude-plugin/plugin.json` or
 * `plugin.json`) that can carry prompt commands and MCP servers. Those are the two
 * things this CLI can run without inventing a second runtime: a command is text
 * for the model, and an MCP server is a process or a URL that speaks a protocol
 * we already implement. Skills, hooks and output styles are deliberately not
 * pretended: an unsupported key is reported, not silently ignored.
 *
 * User plugins live under the agent's home and are trusted; project plugins live
 * in the project and wait for the operator, exactly like a project `.mcp.json`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { userAgentHome } from "#core/memory.ts";
import { AGENT_DIR } from "#guard/log.ts";

export type PluginScope = "user" | "project";

export interface PluginCommandFile {
  name: string;
  file: string;
  scope: PluginScope;
  plugin: string;
}

export interface PluginInfo {
  name: string;
  description: string;
  scope: PluginScope;
  root: string;
  manifest: string;
  commands: PluginCommandFile[];
  /** The raw entries, exactly as the manifest wrote them; the MCP loader validates. */
  mcpServers: Record<string, unknown>;
  errors: string[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COMMAND_NAME = /^[a-z0-9][a-z0-9_:-]{0,63}$/i;
const MAX_COMMAND_DEPTH = 3;

const SUPPORTED_KEYS = new Set(["name", "version", "description", "author", "homepage", "repository", "license", "keywords", "commands", "mcpServers", "dependencies"]);
const UNSUPPORTED_KEYS = ["agents", "skills", "hooks", "outputStyles", "lspServers", "channels", "userConfig"];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (cause) {
    return { ok: false, error: (cause as Error).message };
  }
}

export function pluginDirs(workspace: string): { dir: string; scope: PluginScope }[] {
  return [
    { dir: path.join(userAgentHome(), "plugins"), scope: "user" },
    { dir: path.join(workspace, AGENT_DIR, "plugins"), scope: "project" },
  ];
}

function manifestFile(root: string): string | null {
  for (const candidate of [path.join(root, "plugin.json"), path.join(root, ".claude-plugin", "plugin.json")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** `commands/review.md` under plugin `pdf` becomes `/pdf:review`. */
function commandFiles(root: string, plugin: string, scope: PluginScope): { commands: PluginCommandFile[]; errors: string[] } {
  const dir = path.join(root, "commands");
  if (!existsSync(dir)) return { commands: [], errors: [] };
  const commands: PluginCommandFile[] = [];
  const errors: string[] = [];

  function walk(current: string, depth: number): void {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch (cause) {
      errors.push(`${plugin}: cannot read ${current}: ${(cause as Error).message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = path.join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < MAX_COMMAND_DEPTH) walk(full, depth + 1);
        continue;
      }
      if (!entry.toLowerCase().endsWith(".md")) continue;
      const relative = path.relative(dir, full).replace(/\\/g, "/").replace(/\.md$/i, "");
      const parts = relative
        .split("/")
        .map((part) => part.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""))
        .filter(Boolean);
      if (!parts.length) continue;
      const name = `${plugin}:${parts.join(":")}`;
      if (!COMMAND_NAME.test(name)) {
        errors.push(`${plugin}: command "${relative}" has a name the prompt cannot call; rename it`);
        continue;
      }
      commands.push({ name, file: full, scope, plugin });
    }
  }

  walk(dir, 0);
  return { commands, errors };
}

/** Inline servers, a relative JSON path, or an array of either. */
function collectServers(raw: unknown, root: string, plugin: string, errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const take = (value: unknown, where: string): void => {
    if (isObject(value)) {
      const map = isObject(value.mcpServers) ? value.mcpServers : value;
      for (const [name, entry] of Object.entries(map)) {
        if (!isObject(entry)) {
          errors.push(`${plugin}: ${where} server "${name}" is not an object`);
          continue;
        }
        out[name] = entry;
      }
      return;
    }
    if (typeof value === "string") {
      const file = path.resolve(root, value);
      if (!existsSync(file)) {
        errors.push(`${plugin}: ${where} points at ${value}, which does not exist`);
        return;
      }
      const parsed = readJson(file);
      if (!parsed.ok) {
        errors.push(`${plugin}: cannot read ${value}: ${parsed.error}`);
        return;
      }
      take(parsed.value, where);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) take(item, where);
      return;
    }
    errors.push(`${plugin}: ${where} must be an object, a JSON path or an array of them`);
  };

  if (raw !== undefined) take(raw, "mcpServers");
  for (const fallback of [path.join(root, "mcp.json"), path.join(root, ".mcp.json")]) {
    if (!existsSync(fallback)) continue;
    const parsed = readJson(fallback);
    if (!parsed.ok) {
      errors.push(`${plugin}: cannot read ${path.basename(fallback)}: ${parsed.error}`);
      continue;
    }
    take(parsed.value, path.basename(fallback));
  }
  return out;
}

export function loadPlugins(workspace: string): PluginInfo[] {
  const found: PluginInfo[] = [];
  for (const { dir, scope } of pluginDirs(workspace)) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const root = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(root).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      const manifestPath = manifestFile(root);
      const hasCommands = existsSync(path.join(root, "commands"));
      const hasServers = existsSync(path.join(root, "mcp.json")) || existsSync(path.join(root, ".mcp.json"));
      if (!manifestPath && !hasCommands && !hasServers) continue;

      let manifest: Record<string, unknown> = {};
      const errors: string[] = [];
      if (manifestPath) {
        const parsed = readJson(manifestPath);
        if (!parsed.ok) {
          errors.push(`plugin.json: ${parsed.error}`);
        } else if (!isObject(parsed.value)) {
          errors.push("plugin.json must be an object");
        } else {
          manifest = parsed.value;
        }
      }

      const rawName = typeof manifest.name === "string" ? manifest.name.trim() : "";
      const name = NAME.test(rawName) ? rawName : entry;
      if (!NAME.test(name)) {
        errors.push(`plugin folder "${entry}" is not a usable name; use letters, digits, dash or underscore`);
        continue;
      }
      if (rawName && !NAME.test(rawName)) {
        errors.push(`plugin.json name "${rawName}" is not usable; falling back to the folder name "${entry}"`);
      }
      for (const key of UNSUPPORTED_KEYS) {
        if (manifest[key] !== undefined) errors.push(`${name}: "${key}" is not supported by this CLI; its commands and MCP servers are loaded, nothing else`);
      }
      for (const key of Object.keys(manifest)) {
        if (!SUPPORTED_KEYS.has(key)) errors.push(`${name}: ignoring unknown key "${key}"`);
      }

      const commands = commandFiles(root, name, scope);
      errors.push(...commands.errors);
      const servers = collectServers(manifest.mcpServers, root, name, errors);
      found.push({
        name,
        description: typeof manifest.description === "string" ? manifest.description : "",
        scope,
        root,
        manifest: manifestPath ?? path.join(root, "plugin.json"),
        commands: commands.commands,
        mcpServers: servers,
        errors,
      });
    }
  }
  return found;
}

/** A plugin command is a command file like any other; this only reads its text. */
export function readPluginCommand(file: PluginCommandFile): string {
  return readFileSync(file.file, "utf8").trim();
}
