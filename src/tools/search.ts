/**
 * Search tools: glob and grep.
 *
 * These exist so the model never has a reason to read a whole tree. A cheap,
 * capped, path-filtered search is the single biggest token saving in a local
 * agent: one grep answers what twenty read_file calls would.
 *
 * node_modules, .git and build output are skipped, as they are in every tool here.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { clip } from "#core/history.ts";
import type { ToolResult, ToolSpec } from "#core/types.ts";
import { bool, err, num, obj, ok, relativeTo, requireField, resolvePath, str, tool } from "./define.ts";
import { walk } from "./files.ts";

const MAX_FILES_SCANNED = 6000;
const TEXTISH = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".md", ".mdx", ".txt", ".yml", ".yaml", ".toml", ".ini",
  ".css", ".scss", ".html", ".xml", ".svg", ".sql", ".sh", ".bash", ".ps1", ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".env.example", ".gitignore", ".dockerfile", ".tf", ".vue", ".svelte", ".prisma",
]);

function looksText(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  if (ext === "") return true;
  if (TEXTISH.has(ext)) return true;
  return ![".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".mp3", ".mp4", ".exe", ".dll", ".node", ".woff", ".woff2", ".ttf"].includes(ext);
}

// Builds a matcher from a glob: **, *, ?, {a,b} and plain names.
function toRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const skipSlash = pattern[i + 2] === "/" || pattern[i + 2] === "\\";
        out += skipSlash ? "(?:[^/\\\\]+/)*" : ".*";
        i += skipSlash ? 3 : 2;
        continue;
      }
      out += "[^/\\\\]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/\\\\]";
      i += 1;
      continue;
    }
    if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        const alts = pattern.slice(i + 1, close).split(",").map((s) => escapeFor(s.trim()));
        out += `(?:${alts.join("|")})`;
        i = close + 1;
        continue;
      }
    }
    if (ch === "[" || ch === "]") {
      out += ch;
      i += 1;
      continue;
    }
    out += escapeFor(ch);
    i += 1;
  }
  return new RegExp(`^${out}$`, "i");
}

function escapeFor(text: string): string {
  return text.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\//g, "[/\\\\]");
}

export const globFiles = tool({
  name: "glob",
  description:
    "Find files by path pattern, e.g. 'src/**/*.ts' or 'tests/*.py'. Skips node_modules, .git and build output. " +
    "Returns up to 200 relative paths — use it instead of listing directories recursively.",
  effect: "read",
  inputSchema: obj({
    pattern: str("Glob, relative to the workspace root."),
    limit: num("Max results, default 200."),
  }, ["pattern"]),
  describe: (input) => ({ summary: `find files matching ${String(input.pattern ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    const patternField = requireField<string>(input, "pattern");
    if (!patternField.ok) return err(patternField.error);
    const pattern = patternField.value.replace(/^\.?([\/\\])?/, "");
    const files: string[] = [];
    walk(ctx.workspace, "", 40, () => true, files, MAX_FILES_SCANNED);
    const re = toRegExp(pattern);
    const matched = files.filter((f) => re.test(f.replace(/\\/g, "/")) || re.test(f));
    const limit = Math.min(500, Math.max(1, Number(input.limit ?? 200) || 200));
    if (!matched.length) return ok(`glob("${patternField.value}") found nothing in ${relativeTo(ctx, ctx.workspace) || "."}. ${hintFor(matched, files, patternField.value)}`, { count: 0 });
    const shown = matched.slice(0, limit);
    return ok(
      `${shown.length}${matched.length > shown.length ? ` of ${matched.length}` : ""} file${matched.length === 1 ? "" : "s"} matching ${patternField.value}:\n${shown.join("\n")}`,
      { count: matched.length, files: shown },
    );
  },
});

function hintFor(_matched: string[], scanned: string[], pattern: string): string {
  const ext = path.extname(pattern);
  if (ext) {
    const sameExt = scanned.filter((f) => f.toLowerCase().endsWith(ext.toLowerCase())).slice(0, 5);
    if (sameExt.length) return `Nothing matched the path, but files with ${ext} exist: ${sameExt.join(", ")}.`;
  }
  return `The search saw ${scanned.length} files in total.`;
}

export const grepFiles = tool({
  name: "grep",
  description:
    "Search file contents for a regular expression (or a literal with fixed_string=true). Returns file:line:text. " +
    "Use path_glob to narrow. This is how you find things without reading everything.",
  effect: "read",
  inputSchema: obj({
    pattern: str("Regular expression, JavaScript syntax."),
    path: str("File or directory to search. Default: the workspace."),
    path_glob: str("Only search paths matching this glob, e.g. 'src/**/*.ts'."),
    case_sensitive: bool("Default false."),
    fixed_string: bool("Treat pattern as a literal string."),
    context: num("Lines before and after each hit, 0-5. Default 0."),
    limit: num("Max matches, default 60."),
  }, ["pattern"]),
  describe: (input) => ({ summary: `search for ${String(input.pattern ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    const patternField = requireField<string>(input, "pattern");
    if (!patternField.ok) return err(patternField.error);
    const root = resolvePath(ctx, input.path ?? ".", "read");
    if (!root.ok) return err(root.error);

    let flags = input.case_sensitive ? "" : "i";
    let source = patternField.value;
    if (input.fixed_string) source = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re: RegExp;
    try {
      re = new RegExp(source, flags);
    } catch (cause) {
      return err(`Invalid pattern ${patternField.value}: ${String(cause)}. Escape regex metacharacters or set fixed_string=true.`);
    }

    const files: string[] = [];
    if (statSync(root.path).isFile()) files.push(relativeTo(ctx, root.path));
    else walk(root.path, "", 40, (p) => looksText(p) && statSafe(p), files, MAX_FILES_SCANNED);

    const globRe = input.path_glob ? toRegExp(String(input.path_glob).replace(/^\.?([\/\\])?/, "")) : null;
    const scoped = globRe ? files.filter((f) => globRe.test(f.replace(/\\/g, "/"))) : files;
    const context = Math.min(5, Math.max(0, Number(input.context ?? 0) || 0));
    const limit = Math.min(300, Math.max(1, Number(input.limit ?? 60) || 60));

    const hits: string[] = [];
    let scanned = 0;
    for (const rel of scoped) {
      if (hits.length >= limit) break;
      const abs = path.join(ctx.workspace, rel);
      if (!existsSync(abs)) continue;
      const size = statSyncSafe(abs);
      if (size === null || size > 2_000_000) continue;
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      scanned += 1;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        re.lastIndex = 0;
        if (!re.test(line)) continue;
        if (context === 0) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 220)}`);
        else {
          const from = Math.max(0, i - context);
          const to = Math.min(lines.length - 1, i + context);
          const block = lines.slice(from, to + 1).map((l, k) => `${from + k + 1} | ${l.slice(0, 220)}`).join("\n");
          hits.push(`${rel}:${i + 1}:\n${block}`);
        }
        if (hits.length >= limit) break;
      }
    }

    if (!hits.length) {
      return ok(
        `No match for ${patternField.value} in ${scoped.length} file${scoped.length === 1 ? "" : "s"} under ${relativeTo(ctx, root.path) || "."}.` +
          (scoped.length === 0 ? " Nothing searchable was found there — check the path with list_dir." : " Try a shorter pattern, case_sensitive=false, or a wider path."),
        { count: 0, filesScanned: scanned },
      );
    }
    const body = hits.join("\n");
    return ok(
      `${hits.length}${hits.length >= limit ? `+` : ""} match${hits.length === 1 ? "" : "es"} of ${patternField.value} (${scanned} files searched):\n${clip(body, ctx.config.maxObserveChars)}`,
      { count: hits.length, filesScanned: scanned },
    );
  },
});

function statSafe(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function statSyncSafe(p: string): number | null {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

export const SEARCH_TOOLS = [globFiles, grepFiles] as ToolSpec[];
