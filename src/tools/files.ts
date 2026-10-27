/**
 * File tools: read, write, edit, list, move, remove.
 *
 * Three things every one of them does, in this order: pass the path through the
 * guard, take a backup before overwriting anything, and report in workspace-relative
 * terms so the transcript never learns more about the machine than it needs.
 *
 * edit_file is str_replace, not a diff engine: the model names the exact text it
 * saw in read_file, the tool counts the occurrences, and an ambiguous match is an
 * error that lists what it found. Guessing which of four matches was meant is how
 * agents silently corrupt files.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { snapshot } from "#guard/backup.ts";
import { irreplaceable } from "#guard/approval.ts";
import { clip } from "#core/history.ts";
import { diffCounts, diffRows, unifiedDiff, type DiffRow } from "#ui/diff.ts";
import type { ToolContext, ToolResult, ToolSpec } from "#core/types.ts";
import { bool, enumerate, err, num, obj, ok, relativeTo, requireField, resolvePath, str, tool } from "./define.ts";

/**
 * What a write actually did, as a number and as the lines themselves. The count
 * comes from the same diff that is drawn, so the "+1 −0" in the terminal and the
 * block under it cannot disagree. The rows are for the operator's screen only:
 * the model's copy of the result stays one line long.
 */
function editEvidence(before: string, after: string, file: string): { added: number; removed: number; diff: DiffRow[]; patch: string } {
  const rows = diffRows(before, after, { context: 3, maxRows: Number.MAX_SAFE_INTEGER });
  const { added, removed } = diffCounts(rows);
  const cap = 26;
  const shown = rows.length > cap ? [...rows.slice(0, cap), { marker: "…" as const, oldNo: null, newNo: null, text: `${rows.length - cap} more line(s) not shown` }] : rows;
  return { added, removed, diff: shown, patch: unifiedDiff(before, after, { file }) };
}

/** Above this, a preview costs more than it tells. The write still happens; it just arrives unpreviewed. */
const PREVIEW_MAX_BYTES = 200_000;

/** The bytes a write will land: CRLF folded, one trailing newline. The preview uses this, so it cannot disagree with the write. */
function writtenContent(content: string): string {
  const text = content.replace(/\r\n/g, "\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** What is on disk now, or "" when it does not exist or cannot be read. */
function currentText(ctx: ToolContext, raw: unknown): string {
  const target = resolvePath(ctx, raw, "read");
  if (!target.ok || !existsSync(target.path)) return "";
  try {
    return readFileSync(target.path, "utf8");
  } catch {
    return "";
  }
}

/**
 * The patch an approval is answered against: the file as it stands, the
 * replacement applied in memory, and the difference between them. Nothing is
 * written and nothing is guessed — if the text would not match, there is no
 * preview to show, and the operator sees the summary alone.
 */
function previewPatch(ctx: ToolContext, raw: unknown, before: string, after: string): string | undefined {
  const target = resolvePath(ctx, raw, "read");
  if (!target.ok) return undefined;
  if (before.length > PREVIEW_MAX_BYTES) return undefined;
  if (before === after) return undefined;
  const file = relativeTo(ctx, target.path);
  const patch = unifiedDiff(before, after, { file });
  return patch || undefined;
}

/**
 * The floor a tier cannot wave through: a path that is not the project's own, and
 * — when the call would take a file away — a file the machine cannot re-create
 * from what it already has.
 */
function gateFor(target: ReturnType<typeof resolvePath>, removed: boolean): string | null {
  if (!target.ok) return null;
  if (!target.inside) return "it changes something outside the project folder";
  return removed ? irreplaceable(target.path) : null;
}

const BINARY_HINTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".7z", ".mp3", ".mp4", ".mov", ".woff", ".woff2", ".ttf", ".exe", ".dll", ".node", ".sqlite", ".db"];
function isBinaryLike(file: string): boolean {
  return BINARY_HINTS.includes(path.extname(file).toLowerCase());
}

/** Ensures the parent directory exists, because a write tool that fails on that is a tax. */
function ensureParent(file: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export const readFile = tool({
  name: "read_file",
  description:
    "Read a text file inside the workspace. Returns line-numbered text. Use offset/limit for large files; " +
    "never read a whole build artefact or lockfile. Refuses secret files and binary files.",
  effect: "read",
  inputSchema: obj({
    path: str("File path, relative to the workspace."),
    offset: num("1-based line to start from. Default 1."),
    limit: num("Maximum lines to return. Default 400, maximum 2000."),
  }, ["path"]),
  describe: (input) => ({ summary: `read ${String(input.path ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    // A URL arrives here often enough to be worth one line: the path is not wrong,
    // it belongs to a different tool.
    const asked = String(input.path ?? "").trim();
    if (/^(https?|file):\/\//i.test(asked)) {
      return err(`"${asked.slice(0, 80)}" is an address, not a file. web_fetch reads a page's text; browser_open opens the page itself.`, { hint: "read_file takes a workspace-relative path." });
    }
    const target = resolvePath(ctx, input.path, "read");
    if (!target.ok) return err(target.error);
    if (!existsSync(target.path)) return err(`${relativeTo(ctx, target.path)} does not exist.`, { suggestions: siblings(ctx, target.path) });
    const stat = statSync(target.path);
    if (stat.isDirectory()) return err(`${relativeTo(ctx, target.path)} is a directory. Use list_dir.`);
    if (isBinaryLike(target.path)) return err(`${relativeTo(ctx, target.path)} is binary (${stat.size} bytes); read_file is for text.`);
    if (stat.size > 4_000_000) return err(`${relativeTo(ctx, target.path)} is ${(stat.size / 1e6).toFixed(1)} MB. Use grep with a pattern, or read a line range.`);

    const raw = readFileSync(target.path, "utf8");
    const lines = raw.split(/\r?\n/);
    const from = Math.max(1, Number(input.offset ?? 1) || 1);
    const wanted = Math.min(2000, Math.max(1, Number(input.limit ?? 400) || 400));
    const slice = lines.slice(from - 1, from - 1 + wanted);
    const numbered = slice.map((line, i) => `${from + i}\t${line}`).join("\n");
    const shown = numbered.slice(0, ctx.config.maxObserveChars);
    const body =
      `${relativeTo(ctx, target.path)} — ${lines.length} lines, ${stat.size} bytes` +
      (from > 1 || lines.length > slice.length ? ` (showing ${from}-${from + slice.length - 1})` : "") +
      `\n${shown}` +
      (numbered.length > shown.length ? `\n…[clipped: ${numbered.length - shown.length} more chars]` : "") +
      (lines.length > from - 1 + slice.length ? `\n…[${lines.length - (from - 1 + slice.length)} more lines; call read_file with offset=${from + slice.length}]` : "");
    return ok(body, { path: target.path, lines: lines.length });
  },
});

/** Names in the same directory that the model probably meant, best first. */
function siblings(ctx: ToolContext, missing: string): string[] {
  const dir = path.dirname(missing);
  if (!existsSync(dir)) return [];
  const base = path.basename(missing).toLowerCase();
  const stem = base.split(".")[0] ?? base;
  const ext = path.extname(base);
  const ranked = readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .map((name) => {
      const lower = name.toLowerCase();
      const otherStem = lower.split(".")[0] ?? lower;
      let score = 0;
      if (stem.length >= 2) {
        if (lower.startsWith(stem)) score += 3;
        else if (lower.includes(stem) || stem.includes(otherStem)) score += 2;
      }
      if (ext && path.extname(lower) === ext) score += 1;
      return { name, score };
    })
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8);
  return ranked.map((entry) => relativeTo(ctx, path.join(dir, entry.name)));
}

export const writeFile = tool({
  name: "write_file",
  description:
    "Create or overwrite a text file inside the workspace. Parent directories are created. " +
    "An existing file is backed up to .agent/backups first. Prefer edit_file for a small change to a file that exists.",
  effect: "write",
  inputSchema: obj({
    path: str("File path, relative to the workspace."),
    content: str("Full new contents. This replaces the file."),
  }, ["path", "content"]),
  describe: (input, ctx) => {
    const before = currentText(ctx, input.path);
    const after = typeof input.content === "string" ? writtenContent(input.content) : "";
    return {
      summary: `write ${String(input.path ?? "?")}`,
      patch: previewPatch(ctx, input.path, before, after),
      hard: gateFor(resolvePath(ctx, input.path, "write"), false) ?? undefined,
    };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const target = resolvePath(ctx, input.path, "write");
    if (!target.ok) return err(target.error);
    const contentField = requireField<string>(input, "content");
    if (!contentField.ok) return err(contentField.error);
    if (existsSync(target.path) && !statSync(target.path).isFile()) return err(`${relativeTo(ctx, target.path)} is not a regular file.`);

    const previous = existsSync(target.path) ? readFileSync(target.path, "utf8") : "";
    const backup = snapshot(ctx.workspace, target.path, "before write_file");
    ensureParent(target.path);
    const text = contentField.value.replace(/\r\n/g, "\n");
    const written = writtenContent(contentField.value);
    writeFileSync(target.path, written, "utf8");
    const bytes = statSync(target.path).size;
    const delta = editEvidence(previous, written, relativeTo(ctx, target.path));
    ctx.log({ at: Date.now(), turn: ctx.turn, tool: "write_file", effect: "write", args: { path: relativeTo(ctx, target.path) }, ok: true, chars: text.length, approved: "auto", ms: 0 });
    return ok(`${backup ? "Updated" : "Created"} ${relativeTo(ctx, target.path)} — +${delta.added} −${delta.removed}, ${bytes} bytes${backup ? ` (previous copy: ${backup.id})` : ""}.`, {
      path: target.path,
      backup: backup?.id ?? null,
      added: delta.added,
      removed: delta.removed,
      diff: delta.diff,
      patch: delta.patch,
    });
  },
});

export const editFile = tool({
  name: "edit_file",
  description:
    "Replace exact text in a file. old_text must match the file byte-for-byte (copy it from read_file, keep the indentation). " +
    "Use replace_all=true only when you mean every occurrence. The file is backed up before it changes.",
  effect: "write",
  inputSchema: obj({
    path: str("File path, relative to the workspace."),
    old_text: str("The exact current text to replace."),
    new_text: str("The text to put in its place."),
    replace_all: bool("Replace every occurrence instead of requiring a unique match."),
  }, ["path", "old_text", "new_text"]),
  describe: (input, ctx) => {
    const before = currentText(ctx, input.path);
    const oldText = typeof input.old_text === "string" ? input.old_text : "";
    const newText = typeof input.new_text === "string" ? input.new_text : "";
    const after = before && oldText ? (input.replace_all ? before.split(oldText).join(newText) : before.replace(oldText, newText)) : before;
    return {
      summary: `edit ${String(input.path ?? "?")}`,
      patch: previewPatch(ctx, input.path, before, after),
      hard: gateFor(resolvePath(ctx, input.path, "write"), false) ?? undefined,
    };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const target = resolvePath(ctx, input.path, "write");
    if (!target.ok) return err(target.error);
    if (!existsSync(target.path)) return err(`${relativeTo(ctx, target.path)} does not exist. Use write_file to create it.`);
    const oldText = requireField<string>(input, "old_text");
    const newText = requireField<string>(input, "new_text");
    if (!oldText.ok) return err(oldText.error);
    if (!newText.ok) return err(newText.error);
    if (oldText.value === newText.value) return err("old_text and new_text are identical; nothing would change.");

    const original = readFileSync(target.path, "utf8");
    const occurrences = countOccurrences(original, oldText.value);
    if (occurrences === 0) return err(`No exact match in ${relativeTo(ctx, target.path)}. Re-read the file and copy the text including indentation.`, { near: nearestLines(original, oldText.value) });
    if (occurrences > 1 && !input.replace_all) {
      return err(`${oldText.value.slice(0, 60)} appears ${occurrences} times in ${relativeTo(ctx, target.path)}. Give a longer old_text that is unique, or set replace_all=true.`, { occurrences });
    }

    const updated = input.replace_all ? original.split(oldText.value).join(newText.value) : original.replace(oldText.value, newText.value);
    const backup = snapshot(ctx.workspace, target.path, "before edit_file");
    writeFileSync(target.path, updated, "utf8");
    const delta = editEvidence(original, updated, relativeTo(ctx, target.path));
    return ok(
      `Edited ${relativeTo(ctx, target.path)} — ${occurrences} occurrence${occurrences === 1 ? "" : "s"} replaced, +${delta.added} −${delta.removed}${backup ? ` (previous copy: ${backup.id})` : ""}.`,
      { path: target.path, backup: backup?.id ?? null, occurrences, added: delta.added, removed: delta.removed, diff: delta.diff, patch: delta.patch },
    );
  },
});

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** When the match fails, show the closest thing in the file. This saves a turn. */
function nearestLines(text: string, needle: string): string {
  const key = needle.trim().slice(0, 24).toLowerCase();
  if (!key) return "";
  const lines = text.split(/\r?\n/);
  const hit = lines.findIndex((line) => line.toLowerCase().includes(key));
  if (hit === -1) return lines.slice(0, 6).join("\n");
  return lines.slice(Math.max(0, hit - 2), hit + 4).map((l, i) => `${hit - 1 + i}\t${l}`).join("\n");
}

export const listDir = tool({
  name: "list_dir",
  description: "List one directory level: names with sizes, and [dir] for directories. Depth is capped on purpose — use glob for structure.",
  effect: "read",
  inputSchema: obj({
    path: str("Directory, relative to the workspace. Default is the workspace root."),
    sort: enumerate("Ordering. Default name.", ["name", "mtime", "size"] as const),
  }),
  describe: (input) => ({ summary: `list ${String(input.path ?? ".")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    const target = resolvePath(ctx, input.path ?? ".", "read");
    if (!target.ok) return err(target.error);
    if (!existsSync(target.path)) return err(`${relativeTo(ctx, target.path)} does not exist.`);
    if (!lstatSync(target.path).isDirectory()) return err(`${relativeTo(ctx, target.path)} is not a directory.`);
    const sort = input.sort === "mtime" || input.sort === "size" ? input.sort : "name";

    const entries = readdirSync(target.path, { withFileTypes: true }).map((dirent) => {
      const full = path.join(target.path, dirent.name);
      let size = 0;
      let mtime = 0;
      try {
        const s = statSync(full);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        /* broken symlink: still list it */
      }
      return { name: dirent.name, dir: dirent.isDirectory(), size, mtime, full };
    });
    entries.sort((a, b) => (a.dir === b.dir ? (sort === "mtime" ? b.mtime - a.mtime : sort === "size" ? b.size - a.size : a.name.localeCompare(b.name)) : a.dir ? -1 : 1));

    const shown = entries.slice(0, 240);
    const body = shown.map((e) => (e.dir ? `${e.name}/` : `${e.name}  ${e.size}`)).join("\n");
    return ok(
      `${relativeTo(ctx, target.path) || "."} — ${entries.length} entries${entries.length > shown.length ? ` (showing ${shown.length})` : ""}\n${clip(body, ctx.config.maxObserveChars)}`,
      { path: target.path, count: entries.length },
    );
  },
});

export const movePath = tool({
  name: "move_path",
  description: "Rename or move a file or directory inside the workspace. Refuses to overwrite an existing target.",
  effect: "write",
  inputSchema: obj({ from: str("Current path."), to: str("New path.") }, ["from", "to"]),
  describe: (input, ctx) => ({
    summary: `move ${String(input.from ?? "?")} → ${String(input.to ?? "?")}`,
    hard: gateFor(resolvePath(ctx, input.from, "write"), true) ?? undefined,
  }),
  async execute(input, ctx): Promise<ToolResult> {
    const from = resolvePath(ctx, input.from, "write");
    const to = resolvePath(ctx, input.to, "write");
    if (!from.ok) return err(from.error);
    if (!to.ok) return err(to.error);
    if (!existsSync(from.path)) return err(`${relativeTo(ctx, from.path)} does not exist.`);
    if (existsSync(to.path)) return err(`${relativeTo(ctx, to.path)} already exists; nothing was moved.`);
    ensureParent(to.path);
    renameSync(from.path, to.path);
    return ok(`Moved ${relativeTo(ctx, from.path)} → ${relativeTo(ctx, to.path)}.`, { from: from.path, to: to.path });
  },
});

export const removePath = tool({
  name: "remove_path",
  description: "Delete one file or one empty directory inside the workspace. Recursive deletion is refused — that is the operator's call, not a tool's.",
  effect: "write",
  inputSchema: obj({ path: str("Path to delete.") }, ["path"]),
  describe: (input, ctx) => ({
    summary: `delete ${String(input.path ?? "?")}`,
    risky: "deleting a file is not undone by the harness unless it was backed up first",
    hard: gateFor(resolvePath(ctx, input.path, "write"), true) ?? undefined,
  }),
  async execute(input, ctx): Promise<ToolResult> {
    const target = resolvePath(ctx, input.path, "write");
    if (!target.ok) return err(target.error);
    if (!existsSync(target.path)) return err(`${relativeTo(ctx, target.path)} does not exist.`);
    const stat = lstatSync(target.path);
    if (stat.isDirectory()) {
      const kids = readdirSync(target.path);
      if (kids.length) return err(`${relativeTo(ctx, target.path)} is not empty (${kids.length} entries). Move it or delete its contents first.`);
      rmSync(target.path, { recursive: false });
      return ok(`Removed empty directory ${relativeTo(ctx, target.path)}.`);
    }
    const backup = snapshot(ctx.workspace, target.path, "before remove_path");
    rmSync(target.path, { force: true });
    return ok(`Deleted ${relativeTo(ctx, target.path)}${backup ? `; copy kept as ${backup.id}` : ""}.`, { backup: backup?.id ?? null });
  },
});

export const FILE_TOOLS = [readFile, writeFile, editFile, listDir, movePath, removePath] as ToolSpec[];

/** Re-exported so search tools share the same file walk rules. */
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".agent", ".cache", "out", "coverage", ".turbo"]);
export function walk(root: string, rel: string, depth: number, accept: (p: string) => boolean, out: string[], cap: number): void {
  if (out.length >= cap) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of entries) {
    if (out.length >= cap) return;
    const full = path.join(root, dirent.name);
    // Forward slashes in every reported path: the transcript must not learn the host separator.
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      if (depth > 0) walk(full, childRel, depth - 1, accept, out, cap);
    } else if (accept(full)) {
      out.push(childRel);
    }
  }
}
