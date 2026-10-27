/**
 * The diff block, proved on text.
 *
 * What an operator trusts after an edit is a handful of lines with numbers on
 * them, so the assertions are about the numbers: which line in the new file, how
 * much context survived, and where the unchanged middle was collapsed rather than
 * printed.
 */
import { describe, expect, it } from "bun:test";
import { diffCounts, diffRows, unifiedDiff } from "#ui/diff.ts";

/** `+ 81 text` — the shape the renderer prints, compact enough to assert on. */
function shape(rows: ReturnType<typeof diffRows>): string[] {
  return rows.map((row) => `${row.marker}${row.newNo ?? row.oldNo ?? ""} ${row.text}`);
}

describe("diffRows", () => {
  it("shows the changed line against its neighbour, with the new file's numbers", () => {
    const before = 'const model = "gemma4:31b-cloud";\nexport default model;\n';
    const after = 'const model = "qwen3:0.6b";\nexport default model;\n';
    expect(shape(diffRows(before, after))).toEqual(['-1 const model = "gemma4:31b-cloud";', '+1 const model = "qwen3:0.6b";', " 2 export default model;"]);
  });

  it("counts the lines the way the rows read", () => {
    const rows = diffRows("a\nb\nc\n", "a\nb2\nb3\nc\n");
    expect(diffCounts(rows)).toEqual({ added: 2, removed: 1 });
    expect(rows.filter((row) => row.marker === " ").length, "the untouched lines are context, not changes").toBeGreaterThan(0);
  });

  it("says nothing when nothing changed", () => {
    expect(diffRows("same\n", "same\n")).toEqual([]);
  });

  it("collapses the unchanged middle between two edits", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[1] = "edited top";
    changed[58] = "edited bottom";
    const rows = diffRows(lines.join("\n"), changed.join("\n"), { context: 2 });
    const skipped = rows.filter((row) => row.marker === "…");
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.text).toContain("unchanged line(s)");
    expect(diffCounts(rows)).toEqual({ added: 2, removed: 2 });
  });

  it("keeps the numbers honest across a collapse", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[35] = "edited";
    const rows = diffRows(lines.join("\n"), changed.join("\n"), { context: 1 });
    const edited = rows.find((row) => row.marker === "+");
    expect(edited?.newNo, "the new file's own line number, not the row's position").toBe(36);
    expect(rows[0]?.marker, "the untouched thousand-line opening is one dim row, not thirty printed lines").toBe("…");
    expect(shape(rows)).toContain("+36 edited");
  });

  it("caps what it draws and says how much was left out", () => {
    const before = Array.from({ length: 30 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 30 }, (_, i) => `new ${i}`).join("\n");
    const rows = diffRows(before, after, { context: 0, maxRows: 12 });
    expect(rows.length).toBe(13);
    expect(rows.at(-1)?.marker).toBe("…");
    expect(rows.at(-1)?.text).toContain("more line(s) not shown");
  });

  it("reports a huge rewrite as a block replacement instead of building a table the machine cannot pay for", () => {
    const before = Array.from({ length: 2200 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 2200 }, (_, i) => `b${i}`).join("\n");
    const rows = diffRows(before, after, { context: 0, maxRows: 6 });
    expect(rows[0]?.marker).toBe("-");
    expect(diffCounts(diffRows(before, after, { context: 0, maxRows: Number.MAX_SAFE_INTEGER }))).toEqual({ added: 2200, removed: 2200 });
  });

  it("treats a file with no trailing newline as the lines it is", () => {
    expect(shape(diffRows("one", "one\ntwo"))).toEqual([" 1 one", "+2 two"]);
  });
});

describe("unifiedDiff", () => {
  it("is a patch a diff viewer can place, not a description of one", () => {
    const before = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
    const after = "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\n";
    expect(unifiedDiff(before, after, { file: "notes.md" }).split("\n")).toEqual([
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,6 +1,6 @@",
      " one",
      " two",
      "-three",
      "+THREE",
      " four",
      " five",
      " six",
    ]);
  });

  it("cuts a separate hunk for each change far enough apart", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const after = before.replace("line 1", "CHANGED 1").replace("line 25", "CHANGED 25");
    const hunks = unifiedDiff(before, after, { file: "a.txt" }).split("\n").filter((row) => row.startsWith("@@"));
    expect(hunks.length).toBe(2);
    expect(hunks[0]).toBe("@@ -1,5 +1,5 @@");
    expect(hunks[1]).toBe("@@ -23,7 +23,7 @@");
  });

  it("says nothing when nothing changed, and stops when the change is enormous", () => {
    expect(unifiedDiff("same\n", "same\n")).toBe("");
    const before = Array.from({ length: 60 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 60 }, (_, i) => `b${i}`).join("\n");
    const rows = unifiedDiff(before, after, { maxLines: 10 }).split("\n").slice(2);
    expect(rows.filter((row) => row.startsWith("+") || row.startsWith("-")).length).toBeLessThanOrEqual(10);
  });
});
