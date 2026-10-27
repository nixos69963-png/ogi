#!/usr/bin/env bun
/**
 * Put `ogi` (and `agent`) on PATH, once.
 *
 *   bun setup.ts                 install the shims into ~/bin
 *   bun setup.ts --dir <path>    install somewhere already on PATH
 *
 * The shims start this checkout by absolute path, so there is nothing to copy and
 * an edit here is live in the next run. They also pass the directory you launched
 * from as `--workspace`, which is the one thing a shortcut or a shell profile can
 * get wrong on its own. A later `-w <dir>` on the command line still wins.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(root, "bin", "agent.ts");
const names = ["ogi", "agent"];

function fail(message: string): never {
  process.stderr.write(`! ${message}\n`);
  process.exit(1);
}

if (!("bun" in process.versions)) fail("run this with Bun: bun setup.ts");
if (!existsSync(entry)) fail(`cannot find ${entry} — run setup.ts from the project root`);

const argv = process.argv.slice(2);
const at = argv.indexOf("--dir");
const wanted = at >= 0 ? argv[at + 1] : undefined;
if (at >= 0 && !wanted) fail("--dir needs a path");
if (wanted && argv[at + 1]?.startsWith("-")) fail("--dir needs a path");

const home = os.homedir();
const installDir = wanted
  ? path.resolve(wanted)
  : process.platform === "win32"
    ? path.join(home, "bin")
    : path.join(home, ".local", "bin");

const normalize = (value: string): string => {
  const resolved = path.resolve(value.replace(/^"(.*)"$/, "$1"));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const onPath = (dir: string): boolean =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => normalize(entry) === normalize(dir));

// The TUI needs its renderer; a fresh clone has no node_modules yet.
if (!existsSync(path.join(root, "node_modules", "@opentui", "core", "package.json"))) {
  process.stdout.write("installing dependencies with bun install…\n");
  const install = spawnSync(process.execPath, ["install"], { cwd: root, stdio: "inherit" });
  if (install.status !== 0) fail("bun install failed");
}

mkdirSync(installDir, { recursive: true });

const bun = process.execPath;
const written: string[] = [];
for (const name of names) {
  // Both shapes, even on Windows: cmd and PowerShell take the .cmd, Git Bash
  // and WSL take the extensionless script.
  const cmd = path.join(installDir, `${name}.cmd`);
  writeFileSync(cmd, `@echo off\r\n"${bun}" "${entry}" -w "%CD%" %*\r\n`, "utf8");
  written.push(cmd);

  const sh = path.join(installDir, name);
  writeFileSync(sh, `#!/usr/bin/env bash\nexec "${bun}" "${entry}" -w "$PWD" "$@"\n`, "utf8");
  if (process.platform !== "win32") chmodSync(sh, 0o755);
  written.push(sh);
}

const probe = spawnSync(process.execPath, [entry, "--help"], { cwd: root, encoding: "utf8" });
if (probe.status !== 0 || !(probe.stdout ?? "").includes("local working agent")) {
  fail(`the entry point did not answer --help${probe.stderr ? `: ${probe.stderr.trim()}` : ""}`);
}

const lines = [
  "",
  "OGI setup",
  "",
  `  bun       ${bun}`,
  `  entry     ${entry}`,
  `  install   ${installDir}`,
  `  wrote     ${names.flatMap((name) => [name, `${name}.cmd`]).join(", ")}`,
  `  on PATH   ${onPath(installDir) ? "yes" : "no"}`,
  "",
];
if (!onPath(installDir)) {
  lines.push(
    `  ${installDir} is not on PATH. Add it, then open a new terminal:`,
    process.platform === "win32"
      ? `    setx PATH "%PATH%;${installDir}"`
      : `    echo 'export PATH="${installDir}:$PATH"' >> ~/.bashrc`,
    "",
  );
}
lines.push(
  "Next:",
  "  ogi doctor       what this machine can and cannot do",
  "  ogi              the full screen, in this directory",
  "  ogi -w <dir>     work on another folder",
  "",
);
process.stdout.write(lines.join("\n"));
