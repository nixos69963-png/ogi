/**
 * Test helpers. No model, no network, no token: a run in these tests is either a
 * pure function or a tool called directly.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "#core/config.ts";
import type { AskOptions, AssistantTurn } from "#core/provider.ts";
import type { AppConfig, ApprovalAnswer, ApprovalLevel, ApprovalRequest, LogEvent, Message, ToolCall, ToolContext } from "#core/types.ts";

/**
 * Scratch space sits beside the project, not on the system drive: this machine's
 * C: is nearly full, and a full temp dir once failed a run for reasons that had
 * nothing to do with the code.
 */
const TMP_ROOT = process.env.AGENT_TEST_TMP ?? fileURLToPath(new URL("../.test-tmp", import.meta.url));

export interface TempWorkspace {
  dir: string;
  write(relative: string, contents: string): string;
  remove(relative: string): void;
  cleanup(): void;
}

export function tempWorkspace(prefix = "ws"): TempWorkspace {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
  return {
    dir,
    write(relative, contents) {
      const target = path.join(dir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf8");
      return target;
    },
    remove(relative) {
      rmSync(path.join(dir, relative), { force: true });
    },
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows keeps a handle on a running bash session; the next run reaps it */
      }
    },
  };
}

export function testConfig(workspace: string, overrides: Partial<AppConfig> = {}): AppConfig {
  // The tier and the older switch are one setting: whichever a test names, the
  // other follows it rather than disagreeing.
  const approvalLevel: ApprovalLevel = overrides.approvalLevel ?? (overrides.approvals === false ? "auto" : "ask");
  return {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    workspace,
    allowOutside: false,
    allowSecrets: false,
    budgetMinutes: null,
    maxTurns: 80,
    maxObserveChars: 12_000,
    contextTokens: 60_000,
    compactAtPercent: 0.75,
    githubToken: null,
    githubRepo: null,
    ...overrides,
    approvalLevel,
    approvals: approvalLevel === "ask",
  };
}

export interface TestContext extends ToolContext {
  events: LogEvent[];
  asked: ApprovalRequest[];
  answer: ApprovalAnswer;
}

export function testContext(workspace: string, overrides: Partial<AppConfig> = {}): TestContext {
  const config = testConfig(workspace, overrides);
  const events: LogEvent[] = [];
  const asked: ApprovalRequest[] = [];
  const ctx = {
    workspace,
    config,
    events,
    asked,
    answer: "yes" as ApprovalAnswer,
    log: (event: LogEvent) => {
      events.push(event);
    },
    confirm: async () => "yes" as ApprovalAnswer,
    signal: new AbortController().signal,
    attended: true,
    turn: 1,
    display: (absolute: string) => path.relative(workspace, absolute) || ".",
  } as TestContext;
  ctx.confirm = async (request) => {
    asked.push(request);
    return ctx.answer;
  };
  return ctx;
}

/* ---------- a scripted model, so the harness can be tested without a token ---------- */

export function fakeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c-${Math.random().toString(36).slice(2, 9)}`, name, arguments: args };
}

export function fakeTurn(toolCalls: ToolCall[], content = ""): AssistantTurn {
  return { content, thinking: "", toolCalls, usage: { inputTokens: 120, outputTokens: 40 }, ms: 1 };
}

/** Which role a transcript belongs to, read off the system brief. */
function roleOf(system: string): string {
  if (system.includes("You are the foreman")) return "foreman";
  const station = /^You are station (s\d+) on a work line: (\w+)\./m.exec(system);
  if (station) return `${station[1]}:${station[2]}`;
  const gauge = /review gauge for station (s\d+)/.exec(system);
  if (gauge) return `review:${gauge[1]}`;
  return "plain";
}

export interface Script {
  transport: (cfg: AppConfig, options: AskOptions) => Promise<AssistantTurn>;
  /** Scripted turns, consumed in order per role; an exhausted role says nothing. */
  turns: number;
  toolsByRole: Record<string, string[]>;
  briefs: Record<string, string>;
}

/**
 * Plays back canned turns by role. Nothing here decides what the test asserts;
 * it records the tool list and the brief each role was given, which is how the
 * factory's promises — a scout that cannot write, a foreman that cannot touch a
 * file — are proved rather than claimed.
 */
export function scripted(roles: Record<string, AssistantTurn[]>): Script {
  const cursor: Record<string, number> = {};
  const script: Script = {
    turns: 0,
    toolsByRole: {},
    briefs: {},
    async transport(_cfg: AppConfig, options: AskOptions): Promise<AssistantTurn> {
      const system = (options.messages.find((m: Message) => m.role === "system")?.content ?? "");
      const role = roleOf(system);
      const index = cursor[role] ?? 0;
      cursor[role] = index + 1;
      script.turns += 1;
      if (!script.toolsByRole[role]) script.toolsByRole[role] = (options.tools ?? []).map((tool) => tool.function.name);
      if (!script.briefs[role]) script.briefs[role] = system;
      return roles[role]?.[index] ?? fakeTurn([]);
    },
  };
  return script;
}
