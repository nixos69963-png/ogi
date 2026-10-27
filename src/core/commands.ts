/**
 * Custom slash commands, the way every agent CLI eventually grows them.
 *
 * A command is a markdown file: the body is the prompt, `$ARGUMENTS` is where the
 * operator's words go. There is no template language beyond that on purpose — a
 * prompt with a programming language in it is a prompt nobody debugs.
 *
 * Project commands live under `.agent/commands`; user commands under the agent's
 * home. A project command with the same name wins, because the closer file knows
 * more about the work.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { userAgentHome } from "#core/memory.ts";
import { loadPlugins, readPluginCommand } from "#core/plugins.ts";
import { AGENT_DIR } from "#guard/log.ts";

export interface CustomCommand {
  name: string;
  description: string;
  body: string;
  source: string;
  scope: "project" | "user";
}

/** A command name is a filename, so it is held to what a filename can safely be. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** A plugin command is namespaced by its plugin, and the colon is part of the name. */
const PLUGIN_NAME = /^[a-z0-9][a-z0-9_:-]{0,63}$/i;
const MAX_BODY_CHARS = 16_000;

export function commandDirs(workspace: string): { dir: string; scope: "project" | "user" }[] {
  return [
    { dir: path.join(userAgentHome(), "commands"), scope: "user" },
    { dir: path.join(workspace, AGENT_DIR, "commands"), scope: "project" },
  ];
}

/**
 * A leading markdown heading is the command's title, not part of its prompt:
 * the palette reads it as the description and the model never sees it.
 */
function split(body: string): { description: string; prompt: string } {
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim());
  const first = (index >= 0 ? lines[index] : "") ?? "";
  const flat = first.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  const description = flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
  if (/^#{1,6}\s+\S/.test(first.trim())) {
    lines.splice(index, 1);
    const prompt = lines.join("\n").trim();
    return { description, prompt: prompt || description };
  }
  return { description, prompt: body };
}

export function loadCommands(workspace: string): CustomCommand[] {
  const found = new Map<string, CustomCommand>();
  for (const { dir, scope } of commandDirs(workspace)) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const file of names) {
      if (!file.toLowerCase().endsWith(".md")) continue;
      const name = file.slice(0, -3).toLowerCase();
      if (!NAME.test(name)) continue;
      let raw: string;
      try {
        raw = readFileSync(path.join(dir, file), "utf8").trim();
      } catch {
        continue;
      }
      if (!raw) continue;
      let { description, prompt } = split(raw);
      if (prompt.length > MAX_BODY_CHARS) prompt = `${prompt.slice(0, MAX_BODY_CHARS).trimEnd()}\n\n(...cut to fit)`;
      // Later wins: the loop reads the user directory first, the project second.
      found.set(name, { name, description, body: prompt, source: path.join(dir, file), scope });
    }
  }

  // Plugin commands are markdown files too, called as `/plugin:name`. They sit
  // after the directories because a project's own command should win a collision,
  // and loadPlugins already orders user plugins before project ones.
  for (const plugin of loadPlugins(workspace)) {
    for (const entry of plugin.commands) {
      if (!PLUGIN_NAME.test(entry.name) || found.has(entry.name)) continue;
      let raw: string;
      try {
        raw = readPluginCommand(entry).trim();
      } catch {
        continue;
      }
      if (!raw) continue;
      let { description, prompt } = split(raw);
      if (prompt.length > MAX_BODY_CHARS) prompt = `${prompt.slice(0, MAX_BODY_CHARS).trimEnd()}\n\n(...cut to fit)`;
      found.set(entry.name, { name: entry.name, description, body: prompt, source: entry.file, scope: entry.scope });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `/name and the rest` → the command and its arguments, or null when it is not one. */
export function matchCommand(input: string, commands: CustomCommand[]): { command: CustomCommand; args: string } | null {
  const match = /^\/([a-z0-9][a-z0-9_:-]*)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  if (!match) return null;
  const command = commands.find((entry) => entry.name === match[1]!.toLowerCase());
  return command ? { command, args: (match[2] ?? "").trim() } : null;
}

/**
 * `$1`…`$9` take one word each; `$ARGUMENTS` takes the line. With no placeholder
 * at all the arguments are appended, so a command can be written either way.
 */
export function expandCommand(command: CustomCommand, args: string): string {
  const words = args ? args.split(/\s+/) : [];
  let body = command.body.replace(/\$([1-9])/g, (whole, index: string) => words[Number(index) - 1] ?? whole);
  if (body.includes("$ARGUMENTS")) body = body.replaceAll("$ARGUMENTS", args);
  else if (args) body = `${body}\n\nArguments: ${args}`;
  return body;
}
