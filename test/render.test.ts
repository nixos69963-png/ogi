/**
 * The terminal contract, proved through a sink.
 *
 * A pty would be the honest way to test colours and the fragile way to test
 * lines, so the renderer is handed a sink and the assertions read what an
 * operator reads, in order: the bullet, the verb, the file, the delta, the diff
 * rows, the live line while it waits — and that the live line is gone once it
 * is not.
 */
import { describe, expect, it } from "bun:test";
import { createRenderer } from "#ui/render.ts";
import type { AgentEvent } from "#core/types.ts";

/** Colour codes are not part of what a test asserts; the text is. */
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

function play(events: AgentEvent[], options: { quiet?: boolean; showThinking?: boolean } = {}): string[] {
  const out: string[] = [];
  const renderer = createRenderer({ sink: (text) => out.push(text.replace(ANSI, "")), ...options });
  for (const event of events) renderer(event);
  renderer.finish();
  return out;
}

/** Printed lines, without the newline the sink is handed. */
const lines = (events: AgentEvent[], options: { quiet?: boolean; showThinking?: boolean } = {}) =>
  play(events, options)
    .filter((entry) => !entry.startsWith("\r"))
    .map((entry) => entry.replace(/\n$/, ""));

const live = (events: AgentEvent[], options: { quiet?: boolean; showThinking?: boolean } = {}) =>
  play(events, options).filter((entry) => entry.startsWith("\r"));

const call = (name: string, args: Record<string, unknown> = {}): AgentEvent => ({ type: "tool-call", turn: 1, name, args });
const done = (name: string, over: Partial<Extract<AgentEvent, { type: "tool-result" }>> = {}): AgentEvent => ({
  type: "tool-result",
  turn: 1,
  name,
  ok: true,
  chars: 81,
  ms: 200,
  ...over,
});

describe("the bullets", () => {
  it("prints the agent's own text flush, with nothing bolted on in front", () => {
    const printed = lines([{ type: "assistant", text: "Two edits.\nThe second is the parser.\nDone" }]);
    expect(printed.length).toBe(3);
    expect(printed[0]).toBe("Two edits.");
    expect(printed[2]).toBe("Done");
  });

  it("shows a read the way you would say it out loud", () => {
    const printed = lines([call("read_file", { path: "src/core/config.ts" }), done("read_file", { chars: 214 })]);
    expect(printed[0]).toBe("● Read(file_path: \"src/core/config.ts\")");
    expect(printed[1]).toContain("⌄");
    expect(printed[1]).toContain("214 chars");
  });

  it("counts a list in the bullet and leaves the items to the block under it", () => {
    const printed = lines([call("plan_update", { steps: ["read it", "edit it", "check it"] }), done("plan_update")]);
    expect(printed[0]).toBe("● Plan(3 steps)");
  });

  it("names the verb and the file, and badges what changed", () => {
    const printed = lines([call("edit_file", { path: "src/core/config.ts", old_text: "a", new_text: "b" }), done("edit_file", { data: { added: 4, removed: 1 } })]);
    expect(printed[0]).toContain("Update");
    expect(printed[0]).toContain("src/core/config.ts");
    expect(printed[0], "the other two arguments are counted, not dumped").toContain("+2");
    expect(printed[1]).toContain("+4");
    expect(printed[1]).toContain("−1");
    expect(printed[1]).toContain("0.2s");
  });

  it("prints the diff under the edit, with the line numbers and which side changed", () => {
    const rows = [
      { marker: "-" as const, oldNo: 80, newNo: null, text: 'const DEFAULT_MODEL = "gemma4:31b-cloud";' },
      { marker: "+" as const, oldNo: null, newNo: 80, text: 'const DEFAULT_MODEL = "qwen3:0.6b";' },
      { marker: " " as const, oldNo: 81, newNo: 81, text: "export default DEFAULT_MODEL;" },
    ];
    const printed = lines([call("edit_file", { path: "src/core/config.ts" }), done("edit_file", { data: { added: 1, removed: 1, diff: rows } })]);
    expect(printed[2]).toContain("80");
    expect(printed[2]).toContain("- const DEFAULT_MODEL");
    expect(printed[3]).toContain("+ const DEFAULT_MODEL");
    expect(printed[3], "the new file's line number is the one worth reading").toContain("80");
    expect(printed[4]).toContain("81");
    expect(printed[4]).toContain("export default");
  });

  it("keeps the reason on the line when a call fails", () => {
    const printed = lines([call("read_file", { path: "nope.ts" }), done("read_file", { ok: false, chars: 0, error: "no such file: nope.ts" })]);
    expect(printed[1]).toContain("✗");
    expect(printed[1]).toContain("no such file: nope.ts");
  });

  it("reads a tool it does not know instead of printing nothing", () => {
    const printed = lines([call("teleport_file", { target: "moon" })]);
    expect(printed[0]).toContain("teleportFile");
    expect(printed[0]).toContain("moon");
  });

  it("bullets a station of the line, not just a tool", () => {
    const printed = lines([{ type: "station", station: "s2", stage: "accepted", summary: "the parser takes one value now" }]);
    expect(printed[0]?.startsWith("● s2")).toBe(true);
    expect(printed[1]).toContain("the parser takes one value now");
  });

  it("keeps the report for the caller, so it appears once", () => {
    const printed = lines([call("finish", { summary: "Two files changed." }), done("finish", { data: { summary: "Two files changed." } })]);
    expect(printed).toEqual([]);
    const asked = lines([call("request_input", { question: "Which branch should I push?" }), done("request_input")]);
    expect(asked[0]).toContain("Ask");
    expect(asked[0]).toContain("Which branch should I push?");
  });
});

describe("the live line", () => {
  it("says what it is doing, for how long, and how to stop", () => {
    const shown = live([{ type: "thinking", text: "planning the edit" }]);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[0]).toContain("thinking");
    expect(shown[0]).toContain("Ctrl+C stops");
    expect(shown[0]).toContain("s ·");
  });

  it("is erased when the run ends, so nothing is left under the prompt", () => {
    const all = play([{ type: "thinking", text: "planning" }, call("grep", { pattern: "x" }), done("grep")]);
    expect(all.at(-1)).toBe("\r");
    expect(all.filter((entry) => entry.startsWith("\r") && entry.length > 1).length).toBeGreaterThan(0);
  });

  it("shows the reasoning text only when the operator asked for it", () => {
    expect(live([{ type: "thinking", text: "I should read the parser first" }])[0]).not.toContain("read the parser first");
    expect(live([{ type: "thinking", text: "I should read the parser first" }], { showThinking: true })[0]).toContain("read the parser first");
  });

  it("leaves no gap when the model sends no reasoning", () => {
    const shown = live([{ type: "thinking", text: "" }], { showThinking: true })[0];
    expect(shown).toContain("thinking ·");
    expect(shown).not.toContain("thinking  ·");
  });

  it("steps aside for an approval prompt instead of printing over it", () => {
    const all = play([call("edit_file", { path: "src/a.ts" }), { type: "approval", name: "edit_file", effect: "write", summary: "write src/a.ts" }, done("edit_file")]);
    expect(all).toContain("\r");
    const printed = all.filter((entry) => !entry.startsWith("\r"));
    expect(printed.length).toBe(2);
    expect(printed.join("\n")).not.toContain("allow");
  });

  it("prints nothing but the report when the run is quiet", () => {
    const all = play([call("read_file", { path: "x" }), done("read_file"), { type: "done", text: "ok", turns: 2, tokensIn: 10, tokensOut: 5 }], { quiet: true });
    expect(all.length).toBe(0);
  });
});
