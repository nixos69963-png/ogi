import { describe, expect, it } from "bun:test";
import {
  budgetSpentNote,
  createBudget,
  formatBudget,
  isExpired,
  MAX_BUDGET_NUDGES,
  rebaseBudget,
  takeBudgetNudge,
  timeLeftMs,
  turnsFor,
} from "#core/budget.ts";
import { clip, compact, estimateHistory, estimateTokens, maybeCompact, usedPercent } from "#core/history.ts";
import { stuckNote, systemPrompt, wrapUpNote } from "#core/prompt.ts";
import type { Message } from "#core/types.ts";
import { testConfig } from "./helpers.ts";

describe("token estimate", () => {
  it("counts ASCII at roughly 3.5 characters per token", () => {
    const tokens = estimateTokens("a".repeat(700));
    expect(tokens).toBeCloseTo(200, -1);
  });

  it("is more pessimistic for Arabic and CJK, which is correct", () => {
    expect(estimateTokens("ع".repeat(140))).toBeGreaterThan(estimateTokens("a".repeat(140)));
  });

  it("charges for tool calls, not just text", () => {
    const withCall: Message = { role: "assistant", content: "", tool_calls: [{ id: "1", name: "read_file", arguments: { path: "a/b/c.ts" } }] };
    expect(estimateHistory([withCall])).toBeGreaterThan(estimateHistory([{ role: "assistant", content: "" }]));
  });
});

describe("clip", () => {
  it("returns short text untouched", () => {
    expect(clip("hello", 100)).toBe("hello");
  });

  it("keeps both ends and says what was lost", () => {
    const text = `${"HEAD".repeat(100)}${"TAIL".repeat(100)}`;
    const clipped = clip(text, 200);
    expect(clipped.length).toBeLessThan(text.length);
    expect(clipped).toContain("HEAD");
    expect(clipped).toContain("TAIL");
    expect(clipped).toContain("chars omitted");
  });
});

describe("compaction", () => {
  const build = (turns: number): Message[] => {
    const messages: Message[] = [{ role: "system", content: "you are the agent" }];
    messages.push({ role: "user", content: "the original task" });
    for (let i = 0; i < turns; i += 1) {
      messages.push({ role: "assistant", content: `step ${i}`, tool_calls: [{ id: `c${i}`, name: "read_file", arguments: { path: `f${i}.ts` } }] });
      messages.push({ role: "tool", content: `x`.repeat(4000), tool_call_id: `c${i}`, name: "read_file" });
    }
    return messages;
  };

  it("does nothing to a short transcript", () => {
    const messages = build(2);
    const result = compact(messages, 16);
    expect(result.condensed).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("keeps the system prompt, drops the bulk, and preserves the tail", () => {
    const messages = build(30);
    const result = compact(messages, 8);
    expect(result.condensed).toBeGreaterThan(0);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.savedTokens).toBeGreaterThan(1000);
    const summary = result.messages[1];
    expect(summary?.role).toBe("user");
    expect(summary?.content).toContain("condensed history");
    expect(summary?.content).toContain("read_file");
    expect(summary?.content).toContain("the original task");
    expect(result.messages[result.messages.length - 1]?.content.length).toBeGreaterThan(3000);
  });

  it("only fires past its threshold", () => {
    const messages = build(20);
    const budget = { contextTokens: 60_000, compactAtPercent: 0.75 };
    expect(maybeCompact(messages, budget).condensed).toBe(0);
    expect(usedPercent(messages, budget)).toBeLessThan(0.75);
    const tight = { contextTokens: 2_000, compactAtPercent: 0.5 };
    expect(maybeCompact(messages, tight).condensed).toBeGreaterThan(0);
  });
});

describe("budget", () => {
  it("derives turns from the clock, bounded at both ends", () => {
    expect(turnsFor(null)).toBe(80);
    expect(turnsFor(1)).toBe(80); // floor
    expect(turnsFor(15)).toBe(120);
    expect(turnsFor(60)).toBe(480);
    expect(turnsFor(240)).toBe(1600); // ceiling
    expect(turnsFor(10_000)).toBe(1600);
  });

  it("has no deadline when the budget is until-done", () => {
    const budget = createBudget(null);
    expect(budget.deadlineAt).toBeNull();
    expect(isExpired(budget)).toBe(false);
    expect(takeBudgetNudge(budget)).toBeNull();
  });

  it("measures the budget as wall clock", () => {
    const now = 1_000_000;
    const budget = createBudget(30, now);
    expect(timeLeftMs(budget, now + 10 * 60_000)).toBe(20 * 60_000);
    expect(isExpired(budget, now + 31 * 60_000)).toBe(true);
  });

  it("keeps the original deadline when a run is resumed", () => {
    const now = 1_000_000;
    const first = createBudget(60, now);
    const resumed = rebaseBudget(first, 60, now + 20 * 60_000);
    expect(resumed.deadlineAt).toBe(first.deadlineAt);
    expect(resumed.startedAt).toBe(now + 20 * 60_000);
  });

  it("gives a fresh deadline when the budget was re-armed to a new length", () => {
    const now = 1_000_000;
    const first = createBudget(60, now);
    const rearmed = rebaseBudget(first, 15, now + 61 * 60_000);
    expect(rearmed.deadlineAt).not.toBe(first.deadlineAt);
    expect(rearmed.minutes).toBe(15);
  });

  it("nudges at most twice, and never near the end", () => {
    const now = 1_000_000;
    const budget = createBudget(60, now);
    expect(takeBudgetNudge(budget, now)).toContain("[harness]");
    expect(takeBudgetNudge(budget, now)).toContain("[harness]");
    expect(takeBudgetNudge(budget, now)).toBeNull();
    expect(budget.nudges).toBe(MAX_BUDGET_NUDGES);

    const late = createBudget(60, now);
    expect(takeBudgetNudge(late, now + 59.5 * 60_000)).toBeNull();
  });

  it("says the work is not lost when the clock wins", () => {
    expect(budgetSpentNote(createBudget(60))).toContain("1 h");
    expect(budgetSpentNote(createBudget(60))).toContain("Progress is saved");
    expect(budgetSpentNote(createBudget(null))).toContain("turn limit");
  });

  it("formats budgets the way the operator writes them", () => {
    expect(formatBudget(null)).toBe("default");
    expect(formatBudget(0)).toBe("until done");
    expect(formatBudget(15)).toBe("15 min");
    expect(formatBudget(90)).toBe("1 h 30 min");
  });
});

describe("brief", () => {
  it("states the rules the harness actually enforces", () => {
    const prompt = systemPrompt({ config: testConfig("/tmp/nowhere"), tools: ["read_file", "run_command"], budgetLabel: "- budget: 30 min" });
    for (const required of ["plan_update", "finish", "Workspace:", ".env", "logged", "- budget: 30 min", "read_file"]) {
      expect(prompt).toContain(required);
    }
  });

  it("keeps harness notes marked as harness notes", () => {
    expect(stuckNote({ name: "grep", count: 3 })).toContain("[harness]");
    expect(stuckNote({ name: "grep", count: 3 })).toContain("Do not call it again");
    expect(wrapUpNote()).toContain("[harness]");
  });

  it("teaches the web/browser/GitHub split the approver enforces", () => {
    const prompt = systemPrompt({ config: testConfig("/tmp/nowhere"), tools: ["read_file", "run_command"], budgetLabel: "- budget: 30 min" });
    // A model that rediscovered these the hard way burned a run on each one.
    for (const required of ["browser_open", "web_fetch", "Captchas", "github_push", "Never put a token in a command line"]) {
      expect(prompt).toContain(required);
    }
  });
});
