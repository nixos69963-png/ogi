/**
 * A patch, drawn the way the reference agent draws one.
 *
 * `patch_file.py` prints a change as a gutter of right-aligned line numbers, a
 * marker, and the line itself on a dark green or dark red ground — with two
 * unchanged lines around each change and `…` where a hunk was skipped. That is the
 * shape a person scans for "what did it actually touch", so this screen uses it in
 * both places a patch appears: under a finished call in the transcript, and inside
 * the review pane before anything is written.
 *
 * One row builder, two callers: the transcript has all the width it wants and wraps,
 * the pane has a fixed screen and so also has a split view.
 */
import type { DiffRow } from "#ui/diff.ts";
import { addedLine, dim, green, red, removedLine, row, type Segment } from "./rows.ts";

export type PatchView = "unified" | "split";

/** The reference gives every line four columns; a big file takes more. */
const GUTTER_MIN = 4;

export function numberWidth(rows: DiffRow[]): number {
  let widest = GUTTER_MIN;
  for (const line of rows) {
    const number = line.newNo ?? line.oldNo;
    if (number != null) widest = Math.max(widest, String(number).length);
  }
  return widest;
}

function gutterFor(line: DiffRow, width: number, indent: string): string {
  const number = line.newNo ?? line.oldNo;
  return `${indent}${number == null ? "".padStart(width) : String(number).padStart(width)} `;
}

/** `   12 - const x = 1` — number, marker, and the change on its own ground. */
export function patchRow(line: DiffRow, width: number, indent = ""): Segment[] {
  const gutter = gutterFor(line, width, indent);
  if (line.marker === "…") return row(dim(`${gutter}…`), line.text ? dim(` ${line.text}`) : null);
  // A filled ground needs at least one cell, and a blank line still counts as a change.
  const text = line.text || " ";
  if (line.marker === "-") return row(dim(gutter), red(" - "), removedLine(text));
  if (line.marker === "+") return row(dim(gutter), green(" + "), addedLine(text));
  return row(dim(`${gutter}   `), dim(text));
}

export interface PatchPair {
  left: DiffRow | null;
  right: DiffRow | null;
}

/** Zip a removal with the addition that replaced it, so split reads across. */
export function splitPairs(rows: DiffRow[]): PatchPair[] {
  const out: PatchPair[] = [];
  let i = 0;
  while (i < rows.length) {
    const line = rows[i]!;
    if (line.marker === " " || line.marker === "…") {
      out.push({ left: line, right: line });
      i += 1;
      continue;
    }
    const removed: DiffRow[] = [];
    const added: DiffRow[] = [];
    while (i < rows.length && rows[i]!.marker === "-") {
      const line = rows[i]!;
      removed.push(line);
      i += 1;
    }
    while (i < rows.length && rows[i]!.marker === "+") {
      const line = rows[i]!;
      added.push(line);
      i += 1;
    }
    for (let at = 0; at < Math.max(removed.length, added.length); at += 1) {
      out.push({ left: removed[at] ?? null, right: added[at] ?? null });
    }
  }
  return out;
}

function cell(line: DiffRow | null, width: number, column: number): Segment[] {
  if (!line) return [dim(" ".repeat(width + column + 3))];
  const gutter = gutterFor(line, width, "");
  const room = Math.max(1, column - 1);
  const text = (line.text || " ").slice(0, room);
  if (line.marker === "-") return row(dim(gutter), red(" - "), removedLine(text));
  if (line.marker === "+") return row(dim(gutter), green(" + "), addedLine(text));
  return row(dim(gutter), dim(text.padEnd(room)));
}

/** How many screen rows this patch takes in this view — the pane sizes itself by it. */
export function patchRowCount(rows: DiffRow[], view: PatchView): number {
  return view === "unified" ? rows.length : splitPairs(rows).length;
}

export function patchRows(rows: DiffRow[], view: PatchView, screen = 0, indent = ""): Segment[][] {
  const width = numberWidth(rows);
  if (view === "unified" || screen <= 0) return rows.map((line) => patchRow(line, width, indent));
  const column = Math.max(8, Math.floor((screen - indent.length - width * 2 - 9) / 2));
  return splitPairs(rows).map((pair) =>
    row(cell(pair.left, width, column), dim(" │ "), cell(pair.right, width, column)),
  );
}
