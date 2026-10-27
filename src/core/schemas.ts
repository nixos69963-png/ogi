/**
 * A small JSON Schema reader.
 *
 * Station contracts and tool parameters are authored as plain JSON Schema, the
 * way the factory template does it, so the CLI ships with no validation
 * dependency. This checks the parts we actually use — type, required, enum,
 * properties, items, bounds — and returns a readable path list instead of
 * throwing, because a malformed model answer is data, not a crash.
 */
import type { JsonSchema } from "#core/types.ts";

export type Validation = { ok: true; value: unknown } | { ok: false; errors: string[] };

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

function typeofValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function matches(type: string, v: unknown): boolean {
  const actual = typeofValue(v);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return type === actual;
}

function walk(schema: JsonSchema, value: unknown, path: string, errors: string[]): unknown {
  const type = schema.type;
  if (typeof type === "string" && TYPES.has(type)) {
    if (!matches(type, value)) {
      errors.push(`${path || "/"}: expected ${type}, got ${typeofValue(value)}`);
      return value;
    }
  } else if (Array.isArray(type)) {
    if (!type.some((t) => typeof t === "string" && matches(t, value))) {
      errors.push(`${path || "/"}: expected one of ${type.join("|")}, got ${typeofValue(value)}`);
      return value;
    }
  }

  const allowed = schema.enum;
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    errors.push(`${path || "/"}: must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push(`${path || "/"}: shorter than ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push(`${path || "/"}: longer than ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      errors.push(`${path || "/"}: does not match /${schema.pattern}/`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      errors.push(`${path || "/"}: ${value} is below the minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      errors.push(`${path || "/"}: ${value} is above the maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      errors.push(`${path || "/"}: needs at least ${schema.minItems} item(s), has ${value.length}`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      errors.push(`${path || "/"}: allows at most ${schema.maxItems} item(s), has ${value.length}`);
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      value.forEach((item, i) => walk(items as JsonSchema, item, `${path}/[${i}]`, errors));
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key !== "string") continue;
        if (!(key in record) || record[key] === undefined || record[key] === null && (schema.properties as Record<string, JsonSchema> | undefined)?.[key]?.type !== "null") {
          errors.push(`${path || "/"}: missing required "${key}"`);
        }
      }
    }
    const props = schema.properties;
    if (props && typeof props === "object") {
      for (const [key, sub] of Object.entries(props as Record<string, JsonSchema>)) {
        if (key in record && record[key] !== undefined) walk(sub, record[key], `${path}/${key}`, errors);
      }
    }
    if (schema.additionalProperties === false && props && typeof props === "object") {
      const known = new Set(Object.keys(props as Record<string, unknown>));
      for (const key of Object.keys(record)) {
        if (!known.has(key)) errors.push(`${path || "/"}: unexpected property "${key}"`);
      }
    }
  }
  return value;
}

export function validate(schema: JsonSchema, value: unknown): Validation {
  const errors: string[] = [];
  walk(schema, value, "", errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** Turn any object into the {name, description, parameters} shape Ollama wants. */
export function toolSchema(name: string, description: string, parameters: JsonSchema): unknown {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", ...parameters },
    },
  };
}
