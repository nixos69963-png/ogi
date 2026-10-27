/**
 * Tool authoring helpers.
 *
 * A tool is a name, a schema, an effect and a function. Nothing else. Keeping the
 * four in one shape is what lets the loop gate by effect, the provider advertise
 * the schema, and a test call `execute()` directly without a model in the loop.
 */
import path from "node:path";
import type { JsonSchema, ToolContext, ToolResult, ToolSpec } from "#core/types.ts";
import { guardPath } from "#guard/path_guard.ts";

export function tool<I = Record<string, unknown>>(spec: ToolSpec<I>): ToolSpec<I> {
  return spec;
}

/** Success whose content is what the model reads. */
export function ok(content: string, data?: unknown): ToolResult {
  return { ok: true, content, ...(data === undefined ? {} : { data }) };
}

/**
 * Failure. The text goes to the model, so it must contain the way out —
 * "no such file" is useless, "no such file; siblings are x, y" is not.
 */
export function err(error: string, data?: unknown): ToolResult {
  return { ok: false, error, content: error, ...(data === undefined ? {} : { data }) };
}

export function obj(props: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties: props, required, additionalProperties: false };
}

export function str(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: "string", description, ...extra };
}

export function num(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: "number", description, ...extra };
}

export function bool(description: string): JsonSchema {
  return { type: "boolean", description };
}

export function arr(description: string, items: JsonSchema): JsonSchema {
  return { type: "array", description, items };
}

export function enumerate(description: string, values: readonly string[]): JsonSchema {
  return { type: "string", description, enum: [...values] };
}

/** Every file tool starts here: one guarded, canonical, absolute path. */
export function resolvePath(
  ctx: ToolContext,
  raw: unknown,
  intent: "read" | "write" | "run",
): { ok: true; path: string; inside: boolean } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Expected a path string." };
  return guardPath(
    {
      workspace: ctx.workspace,
      allowOutside: ctx.config.allowOutside,
      allowSecrets: ctx.config.allowSecrets,
      cwd: ctx.workspace,
    },
    raw,
    intent,
  );
}

/** What the model and the transcript see: forward slashes, workspace-relative. */
export function relativeTo(ctx: ToolContext, absolute: string): string {
  const rel = path.relative(ctx.workspace, absolute);
  const display = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : absolute;
  return display.replace(/\\/g, "/");
}

/** Argument access that never throws on the shape the model actually sends. */
export function field<T>(args: Record<string, unknown>, key: string): T | undefined {
  return args[key] as T | undefined;
}

export function requireField<T>(args: Record<string, unknown>, key: string): { ok: true; value: T } | { ok: false; error: string } {
  const value = args[key];
  if (value === undefined || value === null || value === "") return { ok: false, error: `Missing required argument "${key}".` };
  return { ok: true, value: value as T };
}
