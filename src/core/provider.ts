/**
 * Ollama provider.
 *
 * One daemon, local models and :cloud models behind the same /api/chat, and the
 * only transport the agent has. Streaming is the default because a factory run
 * that takes four minutes to show anything feels broken.
 *
 * The awkward part of streaming tool calls is that the arguments arrive in
 * pieces, and Ollama hands them back either as partial JSON strings or as
 * already-split objects depending on the model. Both are accumulated here so the
 * loop only ever sees a parsed object.
 */
import type { AppConfig, Message, ToolCall } from "#core/types.ts";
import { isCloudModel } from "#core/config.ts";

export interface ProviderTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AssistantTurn {
  content: string;
  /** Reasoning channels (thinking models) come back here, never mixed into content. */
  thinking: string;
  toolCalls: ToolCall[];
  usage: Usage;
  ms: number;
}

export class ProviderError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface AskOptions {
  model: string;
  messages: Message[];
  tools?: ProviderTool[];
  signal?: AbortSignal;
  temperature?: number;
  numPredict?: number;
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function joinSignal(external: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timed out")), ms);
  const onAbort = () => ac.abort(external?.reason);
  external?.addEventListener("abort", onAbort);
  return {
    signal: ac.signal,
    cancel: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/** Accumulator that survives both partial-string and object argument payloads. */
class CallAccumulator {
  private byKey = new Map<string, { id: string; name: string; argText: string; argObject: Record<string, unknown>; order: number }>();

  add(raw: unknown, fallbackIndex: number): void {
    if (!raw || typeof raw !== "object") return;
    const call = raw as Record<string, any>;
    const fn = (call.function ?? {}) as Record<string, any>;
    const index = typeof call.index === "number" ? call.index : fallbackIndex;
    const key = call.id ? String(call.id) : `idx:${index}`;
    const entry = this.byKey.get(key) ?? { id: String(call.id ?? `call_${index}`), name: "", argText: "", argObject: {}, order: this.byKey.size };
    if (call.id) entry.id = String(call.id);
    if (typeof fn.name === "string") entry.name += fn.name;
    const args = fn.arguments;
    if (typeof args === "string") entry.argText += args;
    else if (args && typeof args === "object") Object.assign(entry.argObject, args);
    this.byKey.set(key, entry);
  }

  finish(): ToolCall[] {
    const out: ToolCall[] = [];
    for (const entry of [...this.byKey.values()].sort((a, b) => a.order - b.order)) {
      if (!entry.name) continue;
      let parsed: Record<string, unknown> = entry.argObject;
      if (entry.argText.trim()) {
        try {
          parsed = { ...(JSON.parse(entry.argText) as Record<string, unknown>), ...entry.argObject };
        } catch {
          parsed = { raw: entry.argText, ...entry.argObject };
        }
      }
      out.push({ id: entry.id, name: entry.name, arguments: parsed });
    }
    return out;
  }
}

export async function ask(cfg: AppConfig, opts: AskOptions): Promise<AssistantTurn> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { signal, cancel } = joinSignal(opts.signal, timeoutMs);

  const body: Record<string, unknown> = {
    model: opts.model,
    stream: true,
    messages: opts.messages.map(toWire),
    options: { num_predict: opts.numPredict ?? 4096, temperature: opts.temperature ?? 0.2 },
  };
  if (opts.tools?.length) body.tools = opts.tools;

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    cancel();
    if (signal.aborted && (signal.reason as Error | undefined)?.message !== "timed out") throw cause;
    const why = (signal.reason as Error | undefined)?.message === "timed out" ? `no answer in ${Math.round(timeoutMs / 1000)}s` : String(cause);
    throw new ProviderError(
      `Ollama at ${cfg.baseUrl} did not answer (${why}).`,
      `Is the daemon running? Try:  ollama list   |   ollama pull ${opts.model}`,
    );
  }

  if (!res.ok || !res.body) {
    cancel();
    const text = await res.text().catch(() => "");
    const detail = readError(text) ?? `HTTP ${res.status}`;
    throw new ProviderError(
      `Ollama refused "${opts.model}": ${detail}`,
      /not found|does not exist|unknown model/i.test(detail) ? `ollama pull ${opts.model}` : undefined,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let thinking = "";
  const calls = new CallAccumulator();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let sequence = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineEnd;
      while ((lineEnd = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line) continue;
        let chunk: Record<string, any>;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }
        if (chunk.error) throw new ProviderError(String(chunk.error));
        const msg = (chunk.message ?? {}) as Record<string, any>;
        if (typeof msg.content === "string" && msg.content) {
          content += msg.content;
          opts.onDelta?.(msg.content);
        }
        if (typeof msg.thinking === "string" && msg.thinking) {
          thinking += msg.thinking;
          opts.onThinking?.(msg.thinking);
        }
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) calls.add(tc, sequence++);
        }
        if (chunk.done) {
          usage = {
            inputTokens: Number(chunk.prompt_eval_count ?? 0),
            outputTokens: Number(chunk.eval_count ?? 0),
          };
        }
      }
    }
  } finally {
    cancel();
  }

  return { content, thinking, toolCalls: calls.finish(), usage, ms: Date.now() - started };
}

/** The wire shape Ollama expects: tool results ride as role "tool" with the call id. */
function toWire(m: Message): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls?.length) {
    wire.tool_calls = m.tool_calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
  }
  if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
  if (m.name) wire.name = m.name;
  return wire;
}

function readError(text: string): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    /* not JSON, fall through */
  }
  return text.slice(0, 300);
}

/** Used by `agent models` and by the station runner to pick a cheaper brain. */
export async function listModels(cfg: AppConfig): Promise<{ name: string; sizeGb: number; cloud: boolean }[]> {
  const res = await fetch(`${cfg.baseUrl}/api/tags`).catch((cause) => {
    throw new ProviderError(`Ollama at ${cfg.baseUrl} is not answering (${String(cause)}).`, "start it with: ollama serve");
  });
  if (!res.ok) throw new ProviderError(`Ollama /api/tags returned HTTP ${res.status}`);
  const json = (await res.json()) as { models?: { name: string; size: number }[] };
  return (json.models ?? []).map((m) => ({
    name: m.name,
    sizeGb: Math.round(((m.size ?? 0) / 1_000_000_000) * 10) / 10,
    cloud: isCloudModel(m.name),
  }));
}
