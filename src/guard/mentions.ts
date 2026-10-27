/**
 * `@path` in the operator's message becomes context, not a round trip.
 *
 * "fix the bug in @src/app.py" is one sentence and one file. Without this the
 * model spends two or three tool calls discovering the same file, and the
 * operator watches it guess. So the token is resolved here, read through the
 * same path policy as every other read — workspace containment, secret deny
 * list — and appended to the task as a bounded block.
 *
 * The bounds are the point: a 4000-line file injected whole is a run that dies
 * of its own context, and a directory is listed rather than read. What was
 * injected, what was refused and what does not exist come back as a report, so
 * the operator sees what the model actually got instead of assuming it.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { guardPath, type PathPolicy } from "./path_guard.ts";

/** `@` must start a word, and the token must look like a path, not a name at someone. */
const TOKEN = /(?:^|[\s([{<>,;:])@([\w.+\-/\\]+(?::[\\/][\w.+\-/\\]+)?)/g;

const MAX_FILE_LINES = 300;
const MAX_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 40_000;
const MAX_DIR_ENTRIES = 60;

export interface InjectedFile {
  path: string;
  kind: "file" | "dir";
  /** Lines of the file, or entries of the directory. */
  count: number;
  truncated: boolean;
}

export interface MentionReport {
  /** The task as the model should receive it: what was typed, plus the blocks. */
  text: string;
  injected: InjectedFile[];
  /** Refused by the path policy, or unreadable — with the reason the operator needs. */
  blocked: { token: string; reason: string }[];
  /** Tokens that looked like paths but are not there. */
  missing: string[];
}

export interface MentionLimits {
  maxFileLines?: number;
  maxFileChars?: number;
  maxTotalChars?: number;
}

/** A name at someone (`@alice`) is not a broken path; a slash or a dot says it was meant as one. */
function looksLikePath(token: string): boolean {
  return token.includes("/") || token.includes("\\") || token.includes(".") || token.startsWith("@");
}

function looksBinary(text: string): boolean {
  const head = text.slice(0, 8000);
  return head.includes("\u0000");
}

function listDirectory(absolute: string): string {
  let entries: string[];
  try {
    entries = readdirSync(absolute, { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
  } catch {
    return "[not readable]";
  }
  entries.sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b));
  const shown = entries.slice(0, MAX_DIR_ENTRIES).map((name) => {
    if (name.endsWith("/")) return `  DIR   ${name}`;
    const size = safeSize(path.join(absolute, name));
    return `  FILE  ${name.padEnd(38)}${size == null ? "" : `${size}B`}`;
  });
  if (entries.length > MAX_DIR_ENTRIES) shown.push(`  … ${entries.length - MAX_DIR_ENTRIES} more`);
  return shown.join("\n");
}

function safeSize(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * Resolve every `@token` in what the operator typed and append the contents the
 * policy allows. The typed text is never rewritten — the tokens stay, so the
 * transcript still reads the way it was written and the model can tell which
 * file the person meant when the block below says something different.
 */
export function injectMentions(input: string, policy: PathPolicy, limits: MentionLimits = {}): MentionReport {
  const maxLines = limits.maxFileLines ?? MAX_FILE_LINES;
  const maxChars = limits.maxFileChars ?? MAX_FILE_CHARS;
  const maxTotal = limits.maxTotalChars ?? MAX_TOTAL_CHARS;

  const report: MentionReport = { text: input, injected: [], blocked: [], missing: [] };
  const tokens: string[] = [];
  for (const match of input.matchAll(TOKEN)) {
    const token = match[1];
    if (token && !tokens.includes(token)) tokens.push(token);
  }
  if (!tokens.length) return report;

  const blocks: string[] = [];
  let used = 0;

  for (const token of tokens) {
    const raw = token.replace(/^@/, "");
    const target = guardPath(policy, raw, "read");
    if (!target.ok) {
      report.blocked.push({ token, reason: target.error });
      continue;
    }
    if (!existsSync(target.path)) {
      if (looksLikePath(raw)) report.missing.push(token);
      continue;
    }

    const shown = path.relative(policy.workspace, target.path).replace(/\\/g, "/") || raw;
    let kind: "file" | "dir";
    try {
      kind = lstatSync(target.path).isDirectory() ? "dir" : "file";
    } catch {
      report.blocked.push({ token, reason: "it is a link or special file; not injected." });
      continue;
    }

    if (kind === "dir") {
      const listing = listDirectory(target.path);
      const count = listing.split("\n").length;
      const block = `<injected_dir path="${shown}">\n${listing}\n</injected_dir>`;
      if (used + block.length > maxTotal) {
        report.blocked.push({ token, reason: "the injection budget for this message is full." });
        continue;
      }
      used += block.length;
      blocks.push(block);
      report.injected.push({ path: shown, kind, count, truncated: count >= MAX_DIR_ENTRIES });
      continue;
    }

    let content: string;
    try {
      content = readFileSync(target.path, "utf8");
    } catch (cause) {
      report.blocked.push({ token, reason: `could not be read: ${(cause as Error).message}` });
      continue;
    }
    if (looksBinary(content)) {
      report.blocked.push({ token, reason: "looks like a binary file; its bytes would not help the model." });
      continue;
    }

    const text = content.replace(/\r\n/g, "\n");
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const body = lines.join("\n");
    const kept = lines.slice(0, maxLines).join("\n");
    const clipped = kept.length > maxChars ? kept.slice(0, maxChars) : kept;
    const truncated = lines.length > maxLines || clipped.length < body.length;
    const block = `<injected_file path="${shown}" lines="${lines.length}"${truncated ? ` truncated="true"` : ""}>\n${clipped}\n</injected_file>`;
    if (used + block.length > maxTotal) {
      report.blocked.push({ token, reason: "the injection budget for this message is full." });
      continue;
    }
    used += block.length;
    blocks.push(block);
    report.injected.push({ path: shown, kind, count: lines.length, truncated });
  }

  if (blocks.length) report.text = `${input}\n\n${blocks.join("\n\n")}`;
  return report;
}

/** One line telling the operator what the model actually got, or null when nothing was mentioned. */
export function mentionNotice(report: MentionReport): string | null {
  const parts: string[] = [];
  if (report.injected.length) {
    parts.push(
      report.injected
        .map((entry) => `${entry.path}${entry.kind === "dir" ? "/" : ` (${entry.count} lines${entry.truncated ? ", shortened" : ""})`}`)
        .join(", "),
    );
  }
  if (report.missing.length) parts.push(`not found: ${report.missing.join(", ")}`);
  if (report.blocked.length) parts.push(`refused: ${report.blocked.map((entry) => entry.token).join(", ")}`);
  if (!parts.length) return null;
  return `injected ${parts.join(" · ")}`;
}

/**
 * What the picker should offer while the operator types. Returns the token
 * start and the query when the cursor sits inside an `@…`, else null, so the
 * caller can tell "typing a word" from "choosing a file".
 */
export function activeMention(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const boundary = at === 0 || /[\s([{<>,;:]/.test(before[at - 1] ?? "");
  if (!boundary) return null;
  const query = before.slice(at + 1);
  if (/[\s]/.test(query)) return null;
  return { start: at, query };
}

export interface FileIndex {
  paths(): string[];
  complete(query: string, limit?: number): string[];
}

const SKIP = new Set(["node_modules", ".git", ".agent", ".factory", "dist", "build", "out", "coverage", "__pycache__", ".venv", "venv"]);

/**
 * The workspace's files, walked once and reused for the ttl. Deep enough for a
 * repo, capped so a huge tree cannot turn a keystroke into a pause, and skipping
 * the directories no one means to mention.
 */
export function createFileIndex(workspace: string, options: { cap?: number; ttlMs?: number } = {}): FileIndex {
  const cap = options.cap ?? 6000;
  const ttl = options.ttlMs ?? 30_000;
  let cache: string[] = [];
  let builtAt = 0;

  const build = () => {
    const out: string[] = [];
    const step = (dir: string, rel: string, depth: number) => {
      if (out.length >= cap || depth > 12) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= cap) return;
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
          step(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
        } else if (entry.isFile()) {
          out.push(rel ? `${rel}/${entry.name}` : entry.name);
        }
      }
    };
    step(workspace, "", 0);
    out.sort();
    cache = out;
    builtAt = Date.now();
  };

  const paths = () => {
    if (!cache.length || Date.now() - builtAt > ttl) build();
    return cache;
  };

  return {
    paths,
    complete(query, limit = 12) {
      const needle = query.toLowerCase().replace(/\\/g, "/");
      const scored = paths()
        .filter((p) => (needle ? p.toLowerCase().includes(needle) : true))
        .map((p) => {
          const base = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
          const rank = !needle ? 3 : base.startsWith(needle) ? 0 : p.toLowerCase().startsWith(needle) ? 1 : base.includes(needle) ? 2 : 3;
          return { p, rank, length: p.length };
        })
        .sort((a, b) => a.rank - b.rank || a.length - b.length);
      return scored.slice(0, limit).map((entry) => entry.p);
    },
  };
}
