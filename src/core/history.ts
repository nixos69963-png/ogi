/**
 * History: how much context a run is carrying, and what happens when it is full.
 *
 * Two rules drive the whole file. First, a tool result is *observation*, not
 * literature: it gets clipped to maxObserveChars before it enters history, because
 * a 400 KB file dump costs tokens for four hours afterwards. Second, when the
 * transcript approaches the context window, the oldest work is condensed into one
 * deterministic summary rather than sent to a model to be rewritten — summarising
 * a summary is how agents lose the plot and pay for the privilege.
 *
 * The estimate is a heuristic, not a tokenizer. It is deliberately pessimistic
 * (1 token per ~3.5 chars for ASCII, worse for CJK) so compaction fires early.
 */
import type { Message } from "#core/types.ts";

const ASCII_CHARS_PER_TOKEN = 3.5;
const WIDE_CHARS_PER_TOKEN = 1.4;

/** Scripts where a single character is often a whole token: Arabic, Hebrew, Indic, CJK, emoji. */
function isWide(code: number): boolean {
  if (code >= 0x0590 && code <= 0x09ff) return true; // Hebrew, Arabic, Syriac, Devanagari
  if (code >= 0x3000) return true; // CJK, Hangul, fullwidth, emoji and everything above
  return false;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let wide = 0;
  let ascii = 0;
  for (const ch of text) {
    if (isWide(ch.codePointAt(0) ?? 0)) wide += 1;
    else ascii += 1;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + wide / WIDE_CHARS_PER_TOKEN);
}

export function estimateMessage(m: Message): number {
  const own = estimateTokens(m.content) + (m.name ? estimateTokens(m.name) : 0);
  const calls = (m.tool_calls ?? []).reduce(
    (sum, c) => sum + estimateTokens(c.name) + estimateTokens(safeJson(c.arguments)),
    0,
  );
  return own + calls + 4; // role/framing overhead
}

export function estimateHistory(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessage(m), 0);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** Keep the beginning and the end of a long observation; the middle is noise. */
export function clip(text: string, maxChars: number): string {
  const clean = text ?? "";
  if (clean.length <= maxChars) return clean;
  const head = Math.ceil(maxChars * 0.62);
  const tail = maxChars - head;
  const omitted = clean.length - maxChars;
  return `${clean.slice(0, head)}\n…[${omitted} chars omitted: ${clean.length} total]…\n${clean.slice(-tail)}`;
}

export interface HistoryBudget {
  contextTokens: number;
  compactAtPercent: number;
}

export function usedPercent(messages: Message[], budget: HistoryBudget): number {
  if (budget.contextTokens <= 0) return 0;
  return estimateHistory(messages) / budget.contextTokens;
}

/**
 * Condense everything older than the last `keepTail` messages.
 *
 * What survives is what the run needs to continue: the system prompt, the task,
 * the calls made and the shape of their results. A stale tool result is replaced
 * by one line, which is honest about being a summary and tells the agent how to
 * look the detail up again.
 */
export function compact(messages: Message[], keepTail = 16): { messages: Message[]; condensed: number; savedTokens: number } {
  const head = messages.slice(0, 1);
  const system = head[0]?.role === "system" ? head : [];
  const rest = messages.slice(system.length);
  if (rest.length <= keepTail + 2) return { messages, condensed: 0, savedTokens: 0 };

  const body = rest.slice(0, rest.length - keepTail);
  const tail = rest.slice(rest.length - keepTail);
  const before = estimateHistory(messages);

  const lines: string[] = [];
  for (const m of body) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const c of m.tool_calls) lines.push(`- called ${c.name}(${shortArgs(c.arguments)})`);
    } else if (m.role === "tool") {
      lines.push(`  → ${m.name ?? "result"}: ${oneLine(m.content, 120)}`);
    } else if (m.role === "assistant" && m.content.trim()) {
      lines.push(`- said: ${oneLine(m.content, 160)}`);
    }
  }

  const task = rest.find((m) => m.role === "user");
  const summary: Message = {
    role: "user",
    content:
      `[condensed history — ${lines.length} lines of earlier work, trimmed to save context]\n` +
      `Task: ${oneLine(task?.content ?? "(see above)", 300)}\n` +
      (lines.length ? lines.join("\n") : "- (no tool calls earlier)") +
      `\n[end of condensed history]. Re-read a file or re-run a command if you need a detail that was dropped.`,
  };

  const next = [...system, summary, ...tail];
  return { messages: next, condensed: body.length, savedTokens: Math.max(0, before - estimateHistory(next)) };
}

/** Compact only when we are actually approaching the window. */
export function maybeCompact(messages: Message[], budget: HistoryBudget, keepTail = 16): { messages: Message[]; condensed: number; savedTokens: number } {
  if (usedPercent(messages, budget) < budget.compactAtPercent) return { messages, condensed: 0, savedTokens: 0 };
  return compact(messages, keepTail);
}

function shortArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") parts.push(`${key}=${oneLine(value, 60)}`);
    else if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${value}`);
    else parts.push(key);
  }
  return parts.join(", ").slice(0, 160);
}

function oneLine(text: string, max: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
