/**
 * The loop's promise to the operator: while a person is being asked, nothing
 * else prints. A ticking status line drawn over "allow? [y]es / [n]o" is how an
 * approval prompt becomes unreadable, so the run emits an `approval` event the
 * renderer can step aside for, and the answer — either way — is what comes back
 * as the tool result.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { run } from "#core/loop.ts";
import type { AgentEvent, ApprovalAnswer, ApprovalRequest } from "#core/types.ts";
import { fakeCall, fakeTurn, scripted, tempWorkspace, testConfig } from "./helpers.ts";

const write = fakeCall("write_file", { path: "notes/a.md", content: "# first\n" });

function playThrough(answer: ApprovalAnswer) {
  const ws = tempWorkspace("loop");
  const events: AgentEvent[] = [];
  const asked: string[] = [];
  const script = scripted({ plain: [fakeTurn([write]), fakeTurn([], "done")] });
  return run({
    config: testConfig(ws.dir),
    task: "write the note",
    budget: null,
    attended: true,
    transport: script.transport,
    confirm: async (request) => {
      asked.push(`${request.tool}:${request.effect}`);
      return answer;
    },
    onEvent: (event) => events.push(event),
  }).then((outcome) => ({ ws, events, asked, outcome }));
}

describe("an approval asked in the middle of a run", () => {
  it("steps aside for the question, then does the write", async () => {
    const { ws, events, asked, outcome } = await playThrough("yes");
    expect(asked).toEqual(["write_file:write"]);
    const approval = events.findIndex((e) => e.type === "approval");
    const result = events.findIndex((e) => e.type === "tool-result");
    expect(approval).toBeGreaterThan(-1);
    expect(result).toBeGreaterThan(approval);
    expect(existsSync(path.join(ws.dir, "notes/a.md"))).toBe(true);
    expect(outcome.text).toBe("done");
    ws.cleanup();
  });

  it("refuses with nothing written when the answer is no", async () => {
    const { ws, events, outcome } = await playThrough("no");
    const result = events.find((e) => e.type === "tool-result");
    expect(result && result.type === "tool-result" && result.ok).toBe(false);
    expect(existsSync(path.join(ws.dir, "notes/a.md"))).toBe(false);
    expect(outcome.denied).toBe(1);
    ws.cleanup();
  });

  /** A `denied` printed under the bullet that came before it names nothing. The call
   *  the operator refused has to appear on the screen as its own line. */
  it("prints the refused call as its own line, so the denial has a name", async () => {
    const { ws, events } = await playThrough("no");
    const call = events.find((e) => e.type === "tool-call");
    expect(call && call.type === "tool-call" && call.name).toBe("write_file");
    ws.cleanup();
  });
});

describe("a question the agent asks while it works", () => {
  const askCall = fakeCall("request_input", { question: "Which branch should I push?", options: ["main", "dev"] });

  async function askThrough(answer: string | null) {
    const ws = tempWorkspace("ask");
    const events: AgentEvent[] = [];
    const heard: [string, string[]][] = [];
    const script = scripted({ plain: [fakeTurn([askCall]), fakeTurn([], "pushed dev")] });
    const outcome = await run({
      config: testConfig(ws.dir),
      task: "push it",
      budget: null,
      attended: true,
      transport: script.transport,
      ask: async (question, options) => {
        heard.push([question, options]);
        return answer;
      },
      onEvent: (event) => events.push(event),
    });
    return { ws, events, heard, outcome, script };
  }

  it("puts the question and its options in front of the operator, then continues", async () => {
    const { ws, events, heard, outcome } = await askThrough("dev");
    expect(heard).toEqual([["Which branch should I push?", ["main", "dev"]]]);
    expect(outcome.stopped).toBeNull();
    expect(outcome.text).toBe("pushed dev");
    const asked = events.find((e) => e.type === "approval");
    expect(asked && asked.type === "approval" && asked.name).toBe("request_input");
    const continued = outcome.messages.find((m) => m.role === "user" && m.content.startsWith("The operator answered:"));
    expect(continued?.content).toBe("The operator answered: dev. Continue with that in mind.");
    ws.cleanup();
  });

  it("stops and says what it was held up on when nobody answers", async () => {
    const { ws, outcome, events } = await askThrough(null);
    expect(outcome.stopped).toBe("asking the operator: Which branch should I push?");
    expect(outcome.text).toBe(outcome.stopped);
    expect(events.some((e) => e.type === "stopped")).toBe(true);
    ws.cleanup();
  });

  it("stops the same way when the run has nobody to ask at all", async () => {
    const ws = tempWorkspace("ask");
    const script = scripted({ plain: [fakeTurn([askCall]), fakeTurn([], "should have stopped")] });
    const outcome = await run({
      config: testConfig(ws.dir),
      task: "push it",
      budget: null,
      attended: true,
      transport: script.transport,
      onEvent: () => {},
    });
    expect(outcome.text).toBe("asking the operator: Which branch should I push?");
    expect(script.turns).toBe(1);
    ws.cleanup();
  });
});

describe("an approval that can be read", () => {
  it("arrives with the diff the change would make", async () => {
    const ws = tempWorkspace("loop");
    const seen: ApprovalRequest[] = [];
    const script = scripted({ plain: [fakeTurn([write]), fakeTurn([], "done")] });
    await run({
      config: testConfig(ws.dir),
      task: "write the note",
      budget: null,
      attended: true,
      transport: script.transport,
      confirm: async (request) => {
        seen.push(request);
        return "yes";
      },
      onEvent: () => {},
    });
    expect(seen[0]?.patch).toContain("+++ b/notes/a.md");
    expect(seen[0]?.patch).toContain("+# first");
    ws.cleanup();
  });
});

describe("the report a run ends on", () => {
  it("is the finish summary, once", async () => {
    const ws = tempWorkspace("loop");
    const events: AgentEvent[] = [];
    const script = scripted({
      plain: [fakeTurn([fakeCall("finish", { summary: "Two lines changed.", verified: "re-read both files" })], "I edited the two files.")],
    });
    const outcome = await run({
      config: testConfig(ws.dir, { approvals: false }),
      task: "edit two files",
      budget: null,
      attended: true,
      transport: script.transport,
      onEvent: (event) => events.push(event),
    });
    expect(outcome.text).toBe("Two lines changed.");
    const reported = events.filter((e) => e.type === "tool-result" && e.name === "finish");
    expect(reported.length).toBe(1);
    ws.cleanup();
  });
});
