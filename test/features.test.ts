/**
 * The features that were lifted from Claude Code, tested where they are pure:
 * memory files, command files, the subagent's tool list, and the verify report.
 * Nothing here needs a model, a network or a token.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expandCommand, loadCommands, matchCommand } from "#core/commands.ts";
import { initMemory, loadMemory, memoryBrief, memorySummary } from "#core/memory.ts";
import { research } from "#core/subagent.ts";
import { researchTools } from "#tools/delegate.ts";
import { checkGate, discoverChecks, parseDiagnostics } from "#tools/verify.ts";
import { fakeTurn, scripted, tempWorkspace, testConfig } from "./helpers.ts";

function withHome<T>(dir: string, body: () => T): T {
  const previous = process.env.AGENT_HOME;
  process.env.AGENT_HOME = dir;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.AGENT_HOME;
    else process.env.AGENT_HOME = previous;
  }
}

describe("standing instructions", () => {
  it("reads both project spellings and the user file, nearest first", () => {
    const ws = tempWorkspace("memory");
    const home = tempWorkspace("home");
    ws.write("AGENTS.md", "Shared rule.\n");
    ws.write("AGENT.md", "# Rules\nUse bun.\n");
    home.write("AGENT.md", "Global rule.\n");
    const sources = withHome(home.dir, () => loadMemory(ws.dir));
    expect(sources.map((source) => source.path)).toEqual([
      path.join(ws.dir, "AGENTS.md"),
      path.join(ws.dir, "AGENT.md"),
      path.join(home.dir, "AGENT.md"),
    ]);
    const brief = withHome(home.dir, () => memoryBrief(sources));
    expect(brief).toContain("Standing instructions");
    expect(brief).toContain("Use bun.");
    expect(brief).toContain("Global rule.");
    ws.cleanup();
    home.cleanup();
  });

  it("cuts a file that would eat the context, and says so", () => {
    const ws = tempWorkspace("memory-big");
    ws.write("AGENT.md", "x".repeat(20_000));
    const [source] = withHome(ws.dir, () => loadMemory(ws.dir));
    expect(source?.truncated).toBe(true);
    expect((source?.chars ?? 0)).toBeLessThanOrEqual(12_000);
    ws.cleanup();
  });

  it("writes a starter once and never overwrites the operator's file", () => {
    const ws = tempWorkspace("memory-init");
    ws.write("package.json", JSON.stringify({ name: "demo", scripts: { check: "bun run check" } }));
    const created = initMemory(ws.dir);
    expect(created.created).toBe(true);
    expect(memorySummary(loadMemory(ws.dir)).join("\n")).toContain("AGENT.md");
    const again = initMemory(ws.dir);
    expect(again.created).toBe(false);
    expect(again.ok).toBe(true);
    ws.cleanup();
  });

  it("has nothing to say when no file exists", () => {
    const ws = tempWorkspace("memory-empty");
    const home = tempWorkspace("memory-home-empty");
    expect(withHome(home.dir, () => loadMemory(ws.dir))).toEqual([]);
    expect(withHome(home.dir, () => memoryBrief([]))).toBe("");
    expect(memorySummary([])[0]).toContain("/init");
    ws.cleanup();
    home.cleanup();
  });
});

describe("custom commands", () => {
  it("loads both scopes, lets the project win, and substitutes the arguments", () => {
    const ws = tempWorkspace("commands");
    const home = tempWorkspace("commands-home");
    mkdirSync(path.join(ws.dir, ".agent", "commands"), { recursive: true });
    mkdirSync(path.join(home.dir, "commands"), { recursive: true });
    ws.write(".agent/commands/review.md", "# Review the change\nReview $1 carefully.\nAll: $ARGUMENTS\n");
    home.write("commands/review.md", "# User review\nUser body.\n");
    home.write("commands/fix.md", "# Fix a bug\nFix it.\n");
    const commands = withHome(home.dir, () => loadCommands(ws.dir));
    expect(commands.map((command) => command.name)).toEqual(["fix", "review"]);
    const review = commands.find((command) => command.name === "review");
    expect(review?.scope).toBe("project");
    expect(review?.description).toBe("Review the change");
    const matched = matchCommand("/review src/app.ts now", commands);
    expect(matched?.command.name).toBe("review");
    expect(expandCommand(matched!.command, matched!.args)).toBe("Review src/app.ts carefully.\nAll: src/app.ts now");
    ws.cleanup();
    home.cleanup();
  });

  it("appends arguments when the file has no placeholder", () => {
    const ws = tempWorkspace("commands-append");
    const home = tempWorkspace("commands-append-home");
    mkdirSync(path.join(ws.dir, ".agent", "commands"), { recursive: true });
    ws.write(".agent/commands/plan.md", "# Make a plan\nWrite the plan.\n");
    const commands = withHome(home.dir, () => loadCommands(ws.dir));
    expect(expandCommand(commands[0]!, "the parser")).toBe("Write the plan.\n\nArguments: the parser");
    expect(matchCommand("/nope x", commands)).toBeNull();
    ws.cleanup();
    home.cleanup();
  });
});

describe("the subagent", () => {
  it("is given reading tools and nothing that can change the machine", () => {
    const names = researchTools().map((spec) => spec.name);
    expect(names).toContain("read_file");
    expect(names).toContain("grep");
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("browser_click");
    expect(names).not.toContain("delegate");
  });

  it("runs in its own context and comes back with the report", async () => {
    const ws = tempWorkspace("research");
    const systems: string[] = [];
    const script = scripted({ plain: [fakeTurn([], "The loop lives in src/core/loop.ts:96.")] });
    const result = await research({
      config: testConfig(ws.dir),
      task: "where is the loop?",
      tools: researchTools(),
      transport: (cfg, options) => {
        const first = options.messages[0];
        systems.push(first?.content ?? "");
        return script.transport(cfg, options);
      },
    });
    expect(result.text).toBe("The loop lives in src/core/loop.ts:96.");
    expect(result.turns).toBe(1);
    expect(systems[0]).toContain("research subagent");
    ws.cleanup();
  });
});

describe("verify", () => {
  it("runs the check script when the manifest has one", () => {
    const ws = tempWorkspace("verify");
    ws.write("package.json", JSON.stringify({ scripts: { check: "bun run typecheck && bun test", test: "bun test" } }));
    const steps = discoverChecks(ws.dir);
    expect(steps.map((step) => step.label)).toEqual(["check"]);
    expect(steps[0]?.display).toContain("run check");
    ws.cleanup();
  });

  it("falls back to the separate scripts, in the order that fails fastest", () => {
    const ws = tempWorkspace("verify-scripts");
    ws.write("package.json", JSON.stringify({ scripts: { test: "bun test", lint: "eslint .", typecheck: "tsc --noEmit" } }));
    expect(discoverChecks(ws.dir).map((step) => step.label)).toEqual(["typecheck", "lint", "test"]);
    ws.cleanup();
  });

  it("reads tsc and test-runner output into a short list", () => {
    const parsed = parseDiagnostics(
      "\u001b[31msrc/a.ts(12,4): error TS2322: Type 'x' is not assignable.\u001b[0m\nsome noise\n\n276 pass\n0 fail\n(fail) the loop > stops\n",
    );
    expect(parsed.errors[0]).toBe("src/a.ts:12:4 TS2322: Type 'x' is not assignable.");
    expect(parsed.errors).toContain("fail: the loop > stops");
    expect(parsed.summary.join(" ")).toContain("276 pass");
  });

  it("will not wave through a check that deletes work, whatever the tier", () => {
    const ws = tempWorkspace("verify-gate");
    ws.write("package.json", JSON.stringify({ scripts: { check: "rm -rf build" } }));
    const gate = checkGate(discoverChecks(ws.dir));
    expect(gate.hard).toBeTruthy();
    ws.cleanup();
  });
});
