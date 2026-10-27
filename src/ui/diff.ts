/**
 * The diff an operator reads instead of trusting.
 *
 * "Edited notes/list.md — +1 −0" is a claim. This is the proof: the lines that
 * changed, the lines around them, and the real line numbers, so a wrong edit is
 * visible without opening the file.
 *
 * Common prefix and suffix are trimmed first, which is what an edit in the middle
 * of a file actually is, and the small middle that is left goes through an LCS.
 * A rewrite of a huge file is not worth the quadratic table, so past a size cap
 * it is reported as a block replacement — which is also the honest answer.
 */

export interface DiffRow {
  /** `+` added, `-` removed, ` ` unchanged context, `…` skipped between hunks. */
  marker: "+" | "-" | " " | "…";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffOptions {
  /** Unchanged lines kept around each change. */
  context?: number;
  /** Hard cap on what gets drawn; the rest is summarised in one row. */
  maxRows?: number;
}

const CELL_CAP = 4_000_000;

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Longest-common-subsequence table walk, on the middles only. */
function lcsOps(before: string[], after: string[]): DiffRow[] {
  const n = before.length;
  const m = after.length;
  if (n * m > CELL_CAP) {
    return [
      ...before.map((text, i) => ({ marker: "-" as const, oldNo: i + 1, newNo: null, text })),
      ...after.map((text, i) => ({ marker: "+" as const, oldNo: null, newNo: i + 1, text })),
    ];
  }
  // dp[i][j] = length of the common subsequence of before[i..] and after[j..].
  const dp: Uint32Array[] = [];
  for (let i = n; i >= 0; i -= 1) {
    const row = new Uint32Array(m + 1);
    if (i < n) {
      const below = dp[dp.length - 1]!;
      for (let j = m - 1; j >= 0; j -= 1) {
        row[j] = before[i] === after[j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
      }
    }
    dp.push(row);
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 0;
  let newNo = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      oldNo += 1;
      newNo += 1;
      rows.push({ marker: " ", oldNo, newNo, text: before[i]! });
      i += 1;
      j += 1;
    } else if (dp[n - i - 1]![j]! >= dp[n - i]![j + 1]!) {
      // Prefer dropping from `before` first, so a change reads as - then +.
      oldNo += 1;
      i += 1;
      rows.push({ marker: "-", oldNo, newNo: null, text: before[i - 1]! });
    } else {
      newNo += 1;
      j += 1;
      rows.push({ marker: "+", oldNo: null, newNo, text: after[j - 1]! });
    }
  }
  while (i < n) {
    oldNo += 1;
    i += 1;
    rows.push({ marker: "-", oldNo, newNo: null, text: before[i - 1]! });
  }
  while (j < m) {
    newNo += 1;
    j += 1;
    rows.push({ marker: "+", oldNo: null, newNo, text: after[j - 1]! });
  }
  return rows;
}

/** Keep the changed rows plus `context` unchanged ones either side of each. */
function hunks(rows: DiffRow[], context: number): DiffRow[] {
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.marker === " ") return;
    for (let offset = -context; offset <= context; offset += 1) {
      const at = index + offset;
      if (at >= 0 && at < rows.length) keep.add(at);
    }
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    if (!keep.has(index)) {
      skipped += 1;
      return;
    }
    if (skipped > 0) {
      out.push({ marker: "…", oldNo: null, newNo: null, text: `${skipped} unchanged line(s)` });
      skipped = 0;
    }
    out.push(row);
  });
  if (skipped > 0) out.push({ marker: "…", oldNo: null, newNo: null, text: `${skipped} unchanged line(s)` });
  return out;
}

/** Every row of the change, nothing collapsed — the patch is built from this. */
function buildRows(before: string, after: string): DiffRow[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i += 1) rows.push({ marker: " ", oldNo: i + 1, newNo: i + 1, text: a[i]! });
  rows.push(...lcsOps(a.slice(start, endA), b.slice(start, endB)).map((row) => ({
    ...row,
    oldNo: row.oldNo === null ? null : row.oldNo + start,
    newNo: row.newNo === null ? null : row.newNo + start,
  })));
  for (let i = 0; i < a.length - endA; i += 1) {
    rows.push({ marker: " ", oldNo: endA + i + 1, newNo: endB + i + 1, text: a[endA + i]! });
  }
  return rows;
}

/** Rows for the operator: what changed, with the numbers a person can jump to. */
export function diffRows(before: string, after: string, options: DiffOptions = {}): DiffRow[] {
  const context = options.context ?? 2;
  const maxRows = options.maxRows ?? 40;
  const kept = hunks(buildRows(before, after), context);
  if (kept.length <= maxRows) return kept;
  const shown = kept.slice(0, maxRows);
  shown.push({ marker: "…", oldNo: null, newNo: null, text: `${kept.length - maxRows} more line(s) not shown` });
  return shown;
}

export interface PatchOptions {
  /** Unchanged lines kept around each change, the way `git diff` does. */
  context?: number;
  /** The name in the `--- a/` and `+++ b/` headers. */
  file?: string;
  /** Hunk bodies stop being added past this many rows, so a huge rewrite stays cheap. */
  maxLines?: number;
}
/**
 * The same change as a real unified diff, because a diff viewer wants a patch
 * and not a claim about one. This is what makes an approval show the lines that
 * would change *before* anything is written.
 *
 * Hunks are cut from the full row list with `context` unchanged lines either
 * side, exactly like `git diff`; a change with no room for context still gets a
 * header, which is what a parser needs to place it.
 */
export function unifiedDiff(before: string, after: string, options: PatchOptions = {}): string {
  const context = options.context ?? 3;
  const maxLines = options.maxLines ?? 400;
  const rows = buildRows(before, after);
  if (!rows.length) return "";

  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.marker === " ") return;
    for (let offset = -context; offset <= context; offset += 1) {
      const at = index + offset;
      if (at >= 0 && at < rows.length) keep.add(at);
    }
  });

  const name = options.file ?? "file";
  const out: string[] = [`--- a/${name}`, `+++ b/${name}`];
  let budget = maxLines;

  for (let index = 0; index < rows.length && budget > 0; index += 1) {
    if (!keep.has(index)) continue;
    let end = index;
    while (end + 1 < rows.length && keep.has(end + 1) && end - index + 1 < budget) end += 1;
    const group = rows.slice(index, end + 1);
    index = end;

    const oldRows = group.filter((row) => row.marker !== "+");
    const newRows = group.filter((row) => row.marker !== "-");
    const oldStart = oldRows.length ? (oldRows[0]!.oldNo ?? 1) : Math.max(1, (group[0]!.oldNo ?? 1));
    const newStart = newRows.length ? (newRows[0]!.newNo ?? 1) : Math.max(1, (group[0]!.newNo ?? 1));
    out.push(`@@ -${oldStart},${oldRows.length} +${newStart},${newRows.length} @@`);
    for (const row of group) out.push(`${row.marker}${row.text}`);
    budget -= group.length;
  }
  return out.join("\n");
}

/**
 * A patch read back into rows.
 *
 * An approval carries its change as one unified-diff string, because that is what
 * a diff viewer and a test both want. The full-screen pane lays that patch out
 * itself, so it needs the rows again — and the numbers it shows have to be the
 * numbers the patch was written with, not numbers counted a second way.
 */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      // A second hunk is a gap the operator should see, not a seamless continuation.
      if (rows.length) rows.push({ marker: "…", oldNo: null, newNo: null, text: "" });
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (!line || line.startsWith("---") || line.startsWith("+++") || line.startsWith("\\")) continue;
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") rows.push({ marker: "+", oldNo: null, newNo: newNo, text });
    else if (marker === "-") rows.push({ marker: "-", oldNo: oldNo, newNo: null, text });
    else if (marker === " ") rows.push({ marker: " ", oldNo: oldNo, newNo: newNo, text });
    else continue;
    if (marker !== "+") oldNo += 1;
    if (marker !== "-") newNo += 1;
  }
  return rows;
}

/** The name a patch was written against — the file it is about to change. */
export function patchFile(patch: string): string | null {
  const added = /^\+\+\+ b\/(.+)$/m.exec(patch);
  if (added?.[1]) return added[1];
  const removed = /^--- a\/(.+)$/.exec(patch);
  return removed?.[1] ?? null;
}

/** +n / −n, counted the same way the rows are. */
export function diffCounts(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.marker === "+") added += 1;
    else if (row.marker === "-") removed += 1;
  }
  return { added, removed };
}
