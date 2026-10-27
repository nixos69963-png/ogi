import { describe, expect, it } from "bun:test";
import { toolSchema, validate } from "#core/schemas.ts";

describe("validate", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 },
      mode: { type: "string", enum: ["a", "b"] },
      steps: { type: "array", items: { type: "string" }, minItems: 1 },
      nested: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    },
    required: ["path"],
    additionalProperties: false,
  };

  it("accepts a correct object", () => {
    const result = validate(schema, { path: "x.ts", limit: 10, mode: "a", steps: ["one"], nested: { ok: true } });
    expect(result.ok).toBe(true);
  });

  it("reports a missing required field with its path", () => {
    const result = validate(schema, { limit: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.join("\n")).toContain('/: missing required "path"');
  });

  it("rejects an unknown property when additionalProperties is false", () => {
    const result = validate(schema, { path: "a", surprise: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors[0]).toContain('unexpected property "surprise"');
  });

  it("catches a bad enum value and names the choices", () => {
    const result = validate(schema, { path: "a", mode: "c" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.join(" ")).toContain("must be one of");
  });

  it("checks number bounds, array item types and nesting", () => {
    const result = validate(schema, { path: "a", limit: 999, steps: [1], nested: {} });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const text = result.errors.join("\n");
    expect(text).toContain("above the maximum 100");
    expect(text).toContain("/steps/[0]: expected string, got integer");
    expect(text).toContain('/nested: missing required "ok"');
  });

  it("treats an integer as a number but not the other way round", () => {
    expect(validate({ type: "number" }, 3).ok).toBe(true);
    expect(validate({ type: "integer" }, 3.5).ok).toBe(false);
  });

  it("does not throw on the shapes a model really sends", () => {
    for (const value of [null, undefined, "string", [], {}, 0, NaN]) {
      expect(() => validate(schema, value)).not.toThrow();
    }
  });
});

describe("toolSchema", () => {
  it("produces the function shape Ollama expects", () => {
    const wire = toolSchema("read_file", "Read a file.", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }) as {
      type: string;
      function: { name: string; parameters: Record<string, unknown> };
    };
    expect(wire.type).toBe("function");
    expect(wire.function.name).toBe("read_file");
    expect(wire.function.parameters.type).toBe("object");
  });
});
