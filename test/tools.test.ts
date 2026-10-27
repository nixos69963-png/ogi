import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBackups, restore } from "#guard/backup.ts";
import { finish, planUpdate, requestInput } from "#tools/control.ts";
import { editFile, listDir, movePath, readFile, removePath, writeFile } from "#tools/files.ts";
import { globFiles, grepFiles } from "#tools/search.ts";
import { assertSafeUrl, botChallenge, htmlToText, userAgent, webFetch } from "#tools/web.ts";
import { bashCandidates, bashMissingHint, closeAllShells, findBash, runCommand } from "#tools/shell.ts";
import { tempWorkspace, testContext } from "./helpers.ts";

const ws = tempWorkspace("tools");
const ctx = testContext(ws.dir);

beforeAll(() => {
  ws.write("src/app.ts", `export const name = "herness";\nexport const version = 2;\n`);
  ws.write("src/util/format.ts", `export function pad(n: number) { return String(n).padStart(2, "0"); }\n`);
  ws.write("src/constants.ts", `export const NEEDLE = 1;\nexport const other = 2;\n`);
  ws.write("README.md", `# Title\n\nSome prose mentioning herness once.\n`);
  ws.write("node_modules/dep/index.js", `const NEEDLE = "in a dependency, must never be searched";\n`);
});

afterAll(() => {
  ws.cleanup();
});

describe("read_file", () => {
  it("returns line-numbered content and the real line count", async () => {
    const result = await readFile.execute({ path: "src/app.ts" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("1\texport const name");
    expect(result.content).toContain("src/app.ts");
  });

  it("honours offset and limit", async () => {
    const result = await readFile.execute({ path: "src/app.ts", offset: 2, limit: 1 }, ctx);
    expect(result.content).toContain("2\texport const version = 2;");
    expect(result.content).not.toContain("1\texport const name");
  });

  it("suggests a nearby file when the name is wrong", async () => {
    const result = await readFile.execute({ path: "src/ap.ts" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not exist");
    expect(JSON.stringify(result.data)).toContain("src/app.ts");
  });

  it("refuses a directory, and points at list_dir", async () => {
    const result = await readFile.execute({ path: "src" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("list_dir");
  });

  it("names the right tool when the path is a web address", async () => {
    const result = await readFile.execute({ path: "https://www.typescriptlang.org" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("web_fetch");
    expect(result.error).toContain("browser_open");
  });

  it("will not read the .env it was told to read", async () => {
    const result = await readFile.execute({ path: ".env" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("deny list");
  });
});

describe("write_file / edit_file", () => {
  it("creates a file and backs up the old one on the next write", async () => {
    const created = await writeFile.execute({ path: "notes/a.md", content: "# first" }, ctx);
    expect(created.ok).toBe(true);
    expect(existsSync(path.join(ws.dir, "notes/a.md"))).toBe(true);
    expect(created.content).toContain("Created");

    const updated = await writeFile.execute({ path: "notes/a.md", content: "# second" }, ctx);
    expect(updated.content).toContain("Updated");
    expect(readFileSync(path.join(ws.dir, "notes/a.md"), "utf8")).toBe("# second\n");
    expect(listBackups(ws.dir, 5).length).toBeGreaterThan(0);
  });

  it("replaces a unique match and reports lines changed", async () => {
    const result = await editFile.execute({ path: "src/app.ts", old_text: 'name = "herness"', new_text: 'name = "agent"' }, ctx);
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(ws.dir, "src/app.ts"), "utf8")).toContain('name = "agent"');
  });

  it("answers an approval with the diff it would make, without touching the file", () => {
    ws.write("src/preview.ts", `export const a = 1;\nexport const b = 2;\n`);
    const preview = editFile.describe?.({ path: "src/preview.ts", old_text: "export const b = 2;", new_text: "export const b = 3;" }, ctx);
    expect(preview?.summary).toBe("edit src/preview.ts");
    expect(preview?.patch).toContain("-export const b = 2;");
    expect(preview?.patch).toContain("+export const b = 3;");
    expect(preview?.patch).toContain("@@ -1,2 +1,2 @@");
    expect(readFileSync(path.join(ws.dir, "src/preview.ts"), "utf8"), "a preview writes nothing").toContain("export const b = 2;");
  });

  it("has no preview to offer when the text would not match", () => {
    ws.write("src/unmatched.ts", `export const here = 1;\n`);
    const preview = editFile.describe?.({ path: "src/unmatched.ts", old_text: "export const nope = 9;", new_text: "x" }, ctx);
    expect(preview?.patch).toBeUndefined();
  });

  it("hands the screen the lines that changed, with the numbers to jump to", async () => {
    ws.write("src/parser.ts", `export const mode = "loose";\nexport const depth = 3;\n`);
    const result = await editFile.execute({ path: "src/parser.ts", old_text: 'mode = "loose"', new_text: 'mode = "strict"' }, ctx);
    type Evidence = { added: number; removed: number; diff: { marker: string; text: string; newNo: number | null; oldNo: number | null }[] };
    const evidence = result.data as Evidence;
    expect(evidence.added).toBe(1);
    expect(evidence.removed).toBe(1);
    const plus = evidence.diff.filter((row) => row.marker === "+");
    expect(plus.map((row) => row.text)).toEqual(['export const mode = "strict";']);
    expect(plus[0]?.newNo).toBe(1);
    expect(evidence.diff.some((row) => row.marker === " " && row.text.includes("depth")), "the untouched neighbour is printed as context").toBe(true);
  });

  it("counts every line of a new file as added, and caps what it shows", async () => {
    const created = await writeFile.execute({ path: "notes/new.md", content: "# one\n# two" }, ctx);
    type Evidence = { added: number; removed: number; diff: { marker: string; text: string }[] };
    expect((created.data as Evidence).added).toBe(2);
    expect((created.data as Evidence).removed).toBe(0);
    expect((created.data as Evidence).diff.map((row) => row.marker)).toEqual(["+", "+"]);

    const long = await writeFile.execute({ path: "notes/long.md", content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") }, ctx);
    const shown = (long.data as Evidence).diff;
    expect(shown.length, "an operator does not scroll through forty rows to learn a file was created").toBeLessThanOrEqual(27);
    expect(shown.at(-1)?.marker).toBe("…");
    expect(shown.at(-1)?.text).toContain("more line(s) not shown");
  });

  it("refuses an ambiguous match instead of guessing, and says how many there were", async () => {
    ws.write("dup.txt", "same\nsame\nsame\n");
    const result = await editFile.execute({ path: "dup.txt", old_text: "same", new_text: "other" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("appears 3 times");
    expect(result.error).toContain("replace_all");
    expect(readFileSync(path.join(ws.dir, "dup.txt"), "utf8")).toBe("same\nsame\nsame\n");
  });

  it("replaces every occurrence when told to", async () => {
    const result = await editFile.execute({ path: "dup.txt", old_text: "same", new_text: "other", replace_all: true }, ctx);
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(ws.dir, "dup.txt"), "utf8")).toBe("other\nother\nother\n");
  });

  it("shows the nearest lines when the text does not match at all", async () => {
    const result = await editFile.execute({ path: "src/util/format.ts", old_text: "padStart(9", new_text: "x" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No exact match");
    expect(JSON.stringify(result.data)).toContain("padStart");
  });

  it("refuses a no-op edit", async () => {
    const result = await editFile.execute({ path: "src/app.ts", old_text: "version", new_text: "version" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("identical");
  });
});

describe("undo", () => {
  it("puts the previous bytes back", () => {
    const before = readFileSync(path.join(ws.dir, "src/app.ts"), "utf8");
    const backup = listBackups(ws.dir, 20).find((entry) => entry.target.endsWith("app.ts"));
    expect(backup).toBeDefined();
    const result = restore(ws.dir, "src/app.ts");
    expect(result.ok).toBe(true);
    const after = readFileSync(path.join(ws.dir, "src/app.ts"), "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("herness");
  });

  it("says so when there is nothing to restore", () => {
    const result = restore(ws.dir, "never/created.txt");
    if (result.ok) throw new Error("expected a failed restore");
    expect(result.error).toContain("No backup");
  });
});

describe("list_dir / move_path / remove_path", () => {
  it("lists directories before files and shows entries", async () => {
    const result = await listDir.execute({ path: "." }, ctx);
    expect(result.content).toContain("src/");
    expect(result.content).toContain("README.md");
    expect(result.content).not.toContain("node_modules/dep");
  });

  it("moves a file and refuses to overwrite", async () => {
    ws.write("keep.txt", "keep");
    const moved = await movePath.execute({ from: "keep.txt", to: "moved/keep.txt" }, ctx);
    expect(moved.ok).toBe(true);
    expect(existsSync(path.join(ws.dir, "moved/keep.txt"))).toBe(true);
    const clash = await movePath.execute({ from: "moved/keep.txt", to: "README.md" }, ctx);
    expect(clash.ok).toBe(false);
    expect(clash.error).toContain("already exists");
  });

  it("deletes a file and keeps a copy", async () => {
    ws.write("gone.txt", "content");
    const removed = await removePath.execute({ path: "gone.txt" }, ctx);
    expect(removed.ok).toBe(true);
    expect(removed.content).toContain("copy kept");
    expect(existsSync(path.join(ws.dir, "gone.txt"))).toBe(false);
  });

  it("refuses a recursive delete", async () => {
    const result = await removePath.execute({ path: "src" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not empty");
  });
});

describe("glob and grep", () => {
  it("matches by pattern and skips node_modules", async () => {
    const result = await globFiles.execute({ pattern: "src/**/*.ts" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("app.ts");
    expect(result.content).toContain("format.ts");
    expect(result.content).not.toContain("node_modules");
  });

  it("says nothing matched but shows what exists with that extension", async () => {
    const result = await globFiles.execute({ pattern: "deep/nope/*.rs" }, ctx);
    expect(JSON.stringify(result.data)).toContain("count\":0");
  });

  it("finds a string across files with file:line output", async () => {
    const result = await grepFiles.execute({ pattern: "NEEDLE" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/constants.ts:1:");
    expect(result.content).not.toContain("must never be searched");

    const prose = await grepFiles.execute({ pattern: "prose", fixed_string: true }, ctx);
    expect(prose.content).toContain("README.md");
  });

  it("narrows with path_glob and reports the files searched", async () => {
    const result = await grepFiles.execute({ pattern: "padStart", path_glob: "src/**/*.ts" }, ctx);
    expect(result.content).toContain("format.ts");
  });

  it("rejects a broken regular expression with advice", async () => {
    const result = await grepFiles.execute({ pattern: "(unclosed" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid pattern");
    expect(result.error).toContain("fixed_string");
  });

  it("adds context lines when asked", async () => {
    const result = await grepFiles.execute({ pattern: "version", path: "src/app.ts", context: 1 }, ctx);
    expect(result.content).toContain("1 |");
  });
});

describe("control tools", () => {
  it("sets a plan and refuses an empty one", async () => {
    const good = await planUpdate.execute({ steps: ["one", "two"] }, ctx);
    expect(good.content).toContain("1. one");
    const empty = await planUpdate.execute({ steps: [] }, ctx);
    expect(empty.ok).toBe(false);
  });

  it("will not close a run without evidence", async () => {
    const noProof = await finish.execute({ summary: "did it" }, ctx);
    expect(noProof.ok).toBe(false);
    expect(noProof.error).toContain("evidence");
    const done = await finish.execute({ summary: "did it", verified: "ran the tests" }, ctx);
    expect(done.ok).toBe(true);
  });

  it("turns request_input into a question, not an action", async () => {
    const result = await requestInput.execute({ question: "which name?" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ question: "which name?", options: [] });
  });
});

describe("web_fetch helpers (offline)", () => {
  it("converts html to readable text and keeps the title", () => {
    const { title, text } = htmlToText(
      `<html><head><title>Docs &amp; More</title></head><body><script>var x = "<b>not text</b>";</script><style>p{color:red}</style><h1>Heading</h1><p>First paragraph.</p><ul><li>one</li><li>two</li></ul></body></html>`,
    );
    expect(title).toBe("Docs & More");
    expect(text).toContain("Heading");
    expect(text).toContain("- one");
    expect(text).not.toContain("not text");
    expect(text).not.toContain("color:red");
  });

  it("refuses schemes and hosts that are not the public web", async () => {
    for (const url of ["file:///etc/passwd", "http://localhost:11434/api/tags", "http://127.0.0.1/x", "http://192.168.1.1/admin", "http://169.254.169.254/latest/meta-data", "http://[::1]:80"]) {
      const outcome = await assertSafeUrl(url).then(
        () => null,
        (cause: Error) => cause.message,
      );
      expect(outcome, url).not.toBeNull();
    }
  });

  it("lets a normal public URL through", async () => {
    await expect(assertSafeUrl("https://example.com/api")).resolves.toBeInstanceOf(URL);
  });

  it("asks as a browser this machine actually has, and says who it is", () => {
    const identity = userAgent();
    expect(identity.startsWith("Mozilla/5.0 (")).toBe(true);
    expect(identity).toContain("Chrome/");
    expect(identity).toContain("agent-cli");
  });

  it("names a bot check instead of working around one", () => {
    const wall = botChallenge(429, "<html>Vercel Security Checkpoint</html>", "Vercel");
    expect(wall).toContain("browser_open");
    expect(wall, "no workaround advice").not.toMatch(/rotate|spoof|retry with/i);
    expect(botChallenge(500, "Internal Server Error", "nginx")).toBeNull();
    expect(botChallenge(429, "Too Many Requests", "")).toBeNull();
  });

  it("sends that identity and stops at the wall on the first answer", async () => {
    const sent: Record<string, unknown>[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: { headers?: Record<string, string> }) => {
      sent.push({ ...(init?.headers ?? {}) });
      return new Response("<html><title>Attention Required</title><p>Vercel Security Checkpoint</p></html>", {
        status: 429,
        headers: { "content-type": "text/html", server: "Vercel" },
      });
    }) as unknown as typeof fetch;
    try {
      const result = await webFetch.execute({ url: "http://8.8.8.8/docs" }, testContext("/tmp/nowhere"));
      expect(sent.length).toBe(1);
      expect(String(sent[0]?.["user-agent"])).toContain("Mozilla/5.0");
      expect(result.ok).toBe(false);
      expect(result.content).toContain("bot check");
      expect(result.content).toContain("browser_open");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("calls a plain rate limit a rate limit, and tells the model not to loop on it", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("Too Many Requests", { status: 429, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    try {
      const result = await webFetch.execute({ url: "http://8.8.8.8/api" }, testContext("/tmp/nowhere"));
      expect(result.ok).toBe(false);
      expect(result.content).toContain("rate limited");
      expect(result.content).toContain("Do not retry this call in a loop");
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("shell", () => {
  const bash = findBash();
  it("finds bash or says what to install", () => {
    expect(bash, "AGENT_BASH / Git for Windows").not.toBeNull();
  });

  it("finds a portable git nobody installed, on a machine with no PATH to lean on", () => {
    if (process.platform !== "win32") return;
    const home = path.join(os.tmpdir(), `agent-cli-fake-home-${process.pid}`);
    const shell = path.join(home, ".qoder", "bin", "git", "bin", "bash.exe");
    const nowhere = path.join(home, "no-such-install");
    mkdirSync(path.dirname(shell), { recursive: true });
    writeFileSync(shell, "");
    const before = { ...process.env };
    try {
      // The real machine this failed on: git was never installed into Program
      // Files and the shell sat in an editor's own folder, so the agent told the
      // operator to install Git Bash. Guessing off PATH alone is what missed it.
      process.env.USERPROFILE = home;
      process.env.HOME = home;
      process.env.PATH = nowhere;
      process.env.AGENT_BASH = "";
      for (const key of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "ChocolateyInstall"]) process.env[key] = nowhere;
      expect(findBash()).toBe(shell);
      expect(bashCandidates()).toContain(shell);
    } finally {
      Object.assign(process.env, before);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("names where it looked instead of only saying it failed", () => {
    const hint = bashMissingHint();
    expect(hint).toContain("Looked in:");
    expect(hint).toContain("AGENT_BASH");
    expect(bashCandidates().length).toBeGreaterThan(3);
  });

  it.skipIf(!bash)("keeps state between commands", async () => {
    const first = await runCommand.execute({ command: "export PROBE=hello42" }, ctx);
    expect(first.ok).toBe(true);
    const second = await runCommand.execute({ command: "echo value=$PROBE" }, ctx);
    expect(second.content).toContain("value=hello42");
  });

  it.skipIf(!bash)("remembers the working directory", async () => {
    await runCommand.execute({ command: "cd src/util" }, ctx);
    const where = await runCommand.execute({ command: "pwd" }, ctx);
    expect(where.content.replace(/\\/g, "/")).toContain("src/util");
    await runCommand.execute({ command: "cd", cwd: ws.dir }, ctx);
  });

  it.skipIf(!bash)("reports a non-zero exit and says what to do", async () => {
    const result = await runCommand.execute({ command: "false" }, ctx);
    expect(result.content).toContain("[exit 1]");
    expect(result.content).toContain("command failed");
  });

  it.skipIf(!bash)("returns merged stdout and stderr in order", async () => {
    const result = await runCommand.execute({ command: "echo out; echo err 1>&2" }, ctx);
    expect(result.content.indexOf("out")).toBeLessThan(result.content.indexOf("err"));
  });

  it.skipIf(!bash)("kills a hung command on its own timeout and survives it", async () => {
    const hung = await runCommand.execute({ command: "sleep 30", timeout_seconds: 1 }, ctx);
    expect(JSON.stringify(hung.data)).toContain("timedOut");
    const after = await runCommand.execute({ command: "echo alive" }, ctx);
    expect(after.content).toContain("alive");
    closeAllShells();
  });

  afterAll(() => closeAllShells());
});
