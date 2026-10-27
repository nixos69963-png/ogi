/**
 * The `@` promise: what the operator pointed at is what the model receives, and
 * what was refused is said out loud instead of quietly dropped.
 */
import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { activeMention, createFileIndex, injectMentions, mentionNotice, type MentionLimits } from "#guard/mentions.ts";
import type { PathPolicy } from "#guard/path_guard.ts";
import { tempWorkspace } from "./helpers.ts";

const policy = (dir: string, overrides: Partial<PathPolicy> = {}): PathPolicy => ({
  workspace: dir,
  allowOutside: false,
  allowSecrets: false,
  ...overrides,
});

describe("injecting what the operator mentioned", () => {
  it("appends the file it names, and says that it did", () => {
    const ws = tempWorkspace("mentions");
    ws.write("src/app.py", "def main():\n    return 1\n");
    const report = injectMentions("fix the bug in @src/app.py", policy(ws.dir));
    expect(report.text).toContain("fix the bug in @src/app.py");
    expect(report.text).toContain('<injected_file path="src/app.py" lines="2">');
    expect(report.text).toContain("    return 1");
    expect(report.injected).toEqual([{ path: "src/app.py", kind: "file", count: 2, truncated: false }]);
    expect(report.blocked).toEqual([]);
    ws.cleanup();
  });

  it("lists a directory instead of reading it", () => {
    const ws = tempWorkspace("mentions");
    ws.write("notes/a.md", "# a\n");
    ws.write("notes/b.md", "# b\n");
    const report = injectMentions("look at @notes", policy(ws.dir));
    expect(report.injected[0]?.kind).toBe("dir");
    expect(report.injected[0]?.path).toBe("notes");
    expect(report.text).toContain("<injected_dir path=\"notes\">");
    expect(report.text).toContain("a.md");
    expect(report.text, "a directory listing is not file contents").not.toContain("# a");
    ws.cleanup();
  });

  it("truncates a long file and marks that it did", () => {
    const ws = tempWorkspace("mentions");
    ws.write("big.txt", `${"line\n".repeat(500)}`);
    const report = injectMentions("@big.txt", policy(ws.dir), { maxFileLines: 40 });
    expect(report.text).toContain('lines="500" truncated="true"');
    expect(report.text.split("\n").length, "the injected block is bounded").toBeLessThan(60);
    expect(report.injected[0]?.truncated).toBe(true);
    ws.cleanup();
  });

  it("refuses a path outside the workspace and keeps the reason", () => {
    const ws = tempWorkspace("mentions");
    const outside = path.join(path.dirname(ws.dir), "elsewhere.txt");
    writeFileSync(outside, "not yours\n", "utf8");
    const report = injectMentions(`read @${outside}`, policy(ws.dir));
    expect(report.injected).toEqual([]);
    expect(report.blocked[0]?.reason).toContain("outside the workspace");
    ws.cleanup();
  });

  it("refuses a secret file the same way read_file does", () => {
    const ws = tempWorkspace("mentions");
    ws.write(".env", "GITHUB_TOKEN=secret-thing\n");
    const report = injectMentions("@.env", policy(ws.dir));
    expect(report.text).not.toContain("secret-thing");
    expect(report.blocked[0]?.reason).toContain("deny list");
    ws.cleanup();
  });

  it("refuses a binary rather than injecting its bytes", () => {
    const ws = tempWorkspace("mentions");
    writeFileSync(path.join(ws.dir, "blob.bin"), "abc\u0000def", "utf8");
    const report = injectMentions("@blob.bin", policy(ws.dir));
    expect(report.blocked[0]?.reason).toContain("binary");
    ws.cleanup();
  });

  it("spends one budget across every mention", () => {
    const ws = tempWorkspace("mentions");
    ws.write("a.txt", "x".repeat(4000));
    ws.write("b.txt", "y".repeat(4000));
    const limits: MentionLimits = { maxTotalChars: 6000 };
    const report = injectMentions("@a.txt and @b.txt", policy(ws.dir), limits);
    expect(report.injected.length).toBe(1);
    expect(report.blocked[0]?.reason).toContain("budget");
    ws.cleanup();
  });

  it("names a path that is not there, and stays quiet about a handle", () => {
    const ws = tempWorkspace("mentions");
    const report = injectMentions("ping @alice about @src/gone.ts", policy(ws.dir));
    expect(report.missing).toEqual(["src/gone.ts"]);
    expect(report.blocked, "@alice is a name at someone, not a broken path").toEqual([]);
    ws.cleanup();
  });

  it("leaves the message alone when nothing is mentioned", () => {
    const ws = tempWorkspace("mentions");
    const report = injectMentions("add a --json flag", policy(ws.dir));
    expect(report.text).toBe("add a --json flag");
    expect(report.injected).toEqual([]);
    ws.cleanup();
  });

  it("tells the operator in one line what became context", () => {
    const ws = tempWorkspace("mentions");
    ws.write("src/app.py", "def main():\n    return 1\n");
    const said = mentionNotice(injectMentions("no mentions here", policy(ws.dir)));
    expect(said, "nothing mentioned, nothing to say").toBeNull();
    const line = mentionNotice(injectMentions("@src/app.py and @gone.ts", policy(ws.dir)));
    expect(line).toContain("src/app.py (2 lines)");
    expect(line).toContain("not found: gone.ts");
    ws.cleanup();
  });
});

describe("the picker behind @", () => {
  it("knows when the operator is naming a file", () => {
    expect(activeMention("fix @src/core", 13)).toEqual({ start: 4, query: "src/core" });
    expect(activeMention("mail me@example.com", 9)).toBeNull();
    expect(activeMention("two words here", 5)).toBeNull();
    expect(activeMention("fix @src/app.py now", 15)).toEqual({ start: 4, query: "src/app.py" });
    expect(activeMention("fix @src/app.py now", 17)).toBeNull();
  });

  it("offers the shortest real paths first, and never the ones no one means", () => {
    const ws = tempWorkspace("mentions");
    ws.write("src/mentions.ts", "export const x = 1;\n");
    ws.write("docs/mentions.md", "# mentions\n");
    ws.write("node_modules/left-pad/index.js", "module.exports = 1;\n");
    ws.write(".agent/log/keep.jsonl", "{}\n");
    const index = createFileIndex(ws.dir);
    expect(index.complete("ment")).toEqual(["src/mentions.ts", "docs/mentions.md"]);
    expect(index.complete("in", 5), "node_modules is not a suggestion").toEqual([]);
    expect(index.paths().some((p) => p.startsWith(".agent/"))).toBe(false);
    ws.cleanup();
  });
});
