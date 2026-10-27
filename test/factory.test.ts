/**
 * The factory line, proved without a token.
 *
 * A scripted transport plays back canned turns per role, so these tests exercise
 * the real loop, the real tools, the real guard and the real files — only the
 * model is fake. That is what makes the promises testable: the foreman cannot
 * reach a write tool, a scout cannot write, an artefact that breaks its contract
 * comes back for a second round, and a station that claims a file the log does
 * not know about never passes the gate.
 *
 * Every run gets its own workspace: artefacts, the plan and the action log all
 * live on disk, so a shared directory would let one test pass on another's work.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createBudget } from "#core/budget.ts";
import { runFactory, ensureVerifier } from "#factory/foreman.ts";
import { artifactPath, readArtifact, shipGate, writeArtifact } from "#factory/artifacts.ts";
import { contractErrors, contractHint, reviewerBrief, stationBrief } from "#factory/briefs.ts";
import { buildPlan, loadPlan, savePlan, stationBudget, toolsFor, updateStation } from "#factory/plan.ts";
import { checkArtifact, checkPlan } from "#factory/schemas.ts";
import type { AssistantTurn } from "#core/provider.ts";
import { fakeCall, fakeTurn, scripted, tempWorkspace, testConfig, type TempWorkspace } from "./helpers.ts";

const created: TempWorkspace[] = [];

/** Indexing is unchecked, so a hand-built plan is read through this: an empty one is a bug in the test. */
function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("expected an entry and got none");
  return value;
}

/** A workspace for one run, seeded with the files the scripted turns expect. */
function fresh(files: Record<string, string> = {}): TempWorkspace {
  const run = tempWorkspace("factory");
  created.push(run);
  for (const [file, contents] of Object.entries(files)) run.write(file, contents);
  return run;
}

afterAll(() => {
  for (const run of created) run.cleanup();
});

const APP = `export const name = "herness";\nexport const version = 2;\n`;

const always = async () => "always" as const;

function scoutTurns(): AssistantTurn[] {
  return [
    fakeTurn([fakeCall("plan_update", { steps: ["read src/app.ts", "write the artefact"] })]),
    fakeTurn([fakeCall("read_file", { path: "src/app.ts" })]),
    fakeTurn([
      fakeCall("write_artifact", {
        findings: ["src/app.ts exports name and version"],
        files: [{ path: "src/app.ts", why: "the module the task is about" }],
        risks: [],
        next: "write notes.md from these two exports",
      }),
    ]),
    fakeTurn([fakeCall("finish", { summary: "surveyed the module", verified: "read_file returned both lines" })], ""),
  ];
}

function reviewPass(): AssistantTurn[] {
  return [
    fakeTurn([fakeCall("write_artifact", { verdict: "pass", problems: [], instructions: "none" })]),
    fakeTurn([fakeCall("finish", { summary: "artefact satisfies the acceptance items", verified: "read_file of the cited file" })]),
  ];
}

function builderTurns(): AssistantTurn[] {
  return [
    fakeTurn([fakeCall("write_file", { path: "notes.md", content: "# Plan\nname is herness, version 2" })]),
    fakeTurn([fakeCall("read_file", { path: "notes.md" })]),
    fakeTurn([
      fakeCall("write_artifact", {
        changed: [{ path: "notes.md", what: "created with the two exports" }],
        how_verified: "read_file notes.md returned 2 lines",
        open: [],
      }),
    ]),
    fakeTurn([fakeCall("finish", { summary: "notes.md written", verified: "read_file" })]),
  ];
}

function verifierTurns(): AssistantTurn[] {
  return [
    fakeTurn([fakeCall("read_file", { path: "notes.md" })]),
    fakeTurn([
      fakeCall("write_artifact", {
        verdict: "pass",
        checks: [{ name: "notes.md exists and names both exports", evidence: "line 2: name is herness, version 2", ok: true }],
        notes: "",
      }),
    ]),
    fakeTurn([fakeCall("finish", { summary: "acceptance met", verified: "read_file of notes.md" })]),
  ];
}

/** The verifier the harness appends to a scout-only line: it checks the survey, not a build. */
function surveyVerifierTurns(): AssistantTurn[] {
  return [
    fakeTurn([fakeCall("read_file", { path: "src/app.ts" })]),
    fakeTurn([
      fakeCall("write_artifact", {
        verdict: "pass",
        checks: [{ name: "src/app.ts is surveyed", evidence: "line 1 exports name, which the artefact names", ok: true }],
        notes: "",
      }),
    ]),
    fakeTurn([fakeCall("finish", { summary: "acceptance met", verified: "read_file of src/app.ts" })]),
  ];
}

const PLAN_ARGS = {
  acceptance: ["notes.md exists in the workspace", "notes.md mentions both exports of src/app.ts"],
  stations: [
    { kind: "scout", title: "Read the module", goal: "Report what src/app.ts exports.", accepts: ["names the real exports"] },
    { kind: "builder", title: "Write notes.md", goal: "Create notes.md from the scout's findings.", accepts: ["notes.md exists", "content mentions both exports"] },
  ],
};

/** One foreman turn and nothing else: the plan on disk is what the tests read. */
function planTurns(args = PLAN_ARGS): AssistantTurn[] {
  return [fakeTurn([fakeCall("submit_plan", args)]), fakeTurn([fakeCall("finish", { summary: "two stations", verified: "submit_plan accepted" })])];
}

function runLine(run: TempWorkspace, task: string, roles: Record<string, AssistantTurn[]>) {
  const script = scripted(roles);
  return runFactory({
    config: testConfig(run.dir),
    task,
    budget: createBudget(null),
    attended: true,
    confirm: always,
    transport: script.transport,
    onEvent: () => {},
  }).then((outcome) => ({ outcome, script }));
}

describe("the line end to end", () => {
  it("plans, runs every station, reviews each one and passes the gate", async () => {
    const run = fresh({ "src/app.ts": APP });
    const { outcome } = await runLine(run, "Summarise src/app.ts into notes.md", {
      foreman: planTurns(),
      "s1:scout": scoutTurns(),
      "review:s1": reviewPass(),
      "s2:builder": builderTurns(),
      "review:s2": reviewPass(),
      // The harness appends the verifier it did not plan, so the line always ends with a check.
      "s3:verifier": verifierTurns(),
      "review:s3": reviewPass(),
    });

    expect(outcome.plan).not.toBeNull();
    const plan = outcome.plan!;
    expect(plan.stations.map((s) => `${s.id}:${s.kind}`)).toEqual(["s1:scout", "s2:builder", "s3:verifier"]);
    expect(plan.stations.every((s) => s.state === "done")).toBe(true);
    expect(outcome.gate.ok).toBe(true);
    expect(outcome.gate.reasons).toEqual([]);
    expect(outcome.report).toContain("Ship gate: PASS");
    expect(readFileSync(path.join(run.dir, "notes.md"), "utf8")).toContain("herness");

    for (const id of ["s1", "s2", "s3"]) {
      expect(existsSync(artifactPath(run.dir, id))).toBe(true);
      expect(existsSync(artifactPath(run.dir, id).replace(/\.json$/, ".md"))).toBe(true);
      expect(loadPlan(run.dir)!.stations.find((s) => s.id === id)!.artifact).toBe(`${id}.json`);
    }
    // The review verdicts land on their own artefacts, so a claim can be audited later.
    expect(readArtifact(run.dir, "s1-r")).toEqual(expect.objectContaining({ verdict: "pass" }));
  }, 20_000);

  it("gives the foreman no tool that touches the machine", async () => {
    const run = fresh({ "src/app.ts": APP });
    const { script } = await runLine(run, "again", {
      foreman: planTurns(),
      "s1:scout": scoutTurns(),
      "review:s1": reviewPass(),
      "s2:builder": builderTurns(),
      "review:s2": reviewPass(),
      "s3:verifier": verifierTurns(),
      "review:s3": reviewPass(),
    });

    expect(script.toolsByRole.foreman).toEqual(["submit_plan", "finish", "request_input"]);
    expect(script.toolsByRole["s1:scout"]).not.toContain("write_file");
    expect(script.toolsByRole["s1:scout"]).not.toContain("run_command");
    expect(script.toolsByRole["s1:scout"]).toContain("write_artifact");
    expect(script.toolsByRole["s2:builder"]).toContain("write_file");
    expect(script.toolsByRole["s3:verifier"]).toContain("run_command");
    expect(script.toolsByRole["review:s2"]).not.toContain("run_command");
    expect(script.toolsByRole["review:s2"]).not.toContain("write_file");
  }, 20_000);

  it("keeps every station transcript separate from the others", async () => {
    const run = fresh({ "src/app.ts": APP });
    const { script } = await runLine(run, "separate", {
      foreman: planTurns(),
      "s1:scout": scoutTurns(),
      "review:s1": reviewPass(),
      "s2:builder": builderTurns(),
      "review:s2": reviewPass(),
      "s3:verifier": verifierTurns(),
      "review:s3": reviewPass(),
    });

    const scoutBrief = script.briefs["s1:scout"];
    const builderBrief = script.briefs["s2:builder"];
    expect(scoutBrief).toContain("Goal: Report what src/app.ts exports.");
    expect(builderBrief).toContain("What the stations before you handed over");
    expect(builderBrief).toContain("s1 (scout) artefact");
    // The scout's transcript never sees the builder's work, which is the whole saving.
    expect(scoutBrief).not.toContain("Write notes.md");
  }, 20_000);
});

describe("review rounds", () => {
  it("sends an artefact that breaks its contract back for one repair round", async () => {
    const run = fresh({ "src/app.ts": "export const name = 1;\n" });
    const fixed = fakeTurn([fakeCall("write_artifact", { findings: ["one export"], files: [{ path: "src/app.ts", why: "the module" }], risks: [], next: "write the summary" })]);
    const { outcome } = await runLine(run, "survey", {
      foreman: planTurns({
        acceptance: ["src/app.ts is surveyed"],
        stations: [{ kind: "scout", title: "Survey", goal: "Report what src/app.ts exports.", accepts: ["names the export"] }],
      }),
      // read, hand over a payload with no `next`, finish; then the repair round fixes it.
      "s1:scout": [
        fakeTurn([fakeCall("read_file", { path: "src/app.ts" })]),
        fakeTurn([fakeCall("write_artifact", { findings: ["one export"], files: [{ path: "src/app.ts", why: "the module" }] })]),
        fakeTurn([fakeCall("finish", { summary: "done", verified: "read_file" })]),
        fixed,
        fakeTurn([fakeCall("finish", { summary: "fixed", verified: "read_file again" })]),
      ],
      "review:s1": reviewPass(),
      "s2:verifier": surveyVerifierTurns(),
      "review:s2": reviewPass(),
    });

    const scout = outcome.plan!.stations.find((s) => s.id === "s1")!;
    expect(scout.review.rounds).toBe(2);
    expect(scout.review.verdict).toBe("pass");
    expect(scout.state).toBe("done");
    expect(outcome.gate.ok).toBe(true);
  }, 20_000);

  /**
   * The repair round runs after a review turn has left the harness pointed at
   * `s1-r`/reviewer. If the station inherits that, its hand-over is validated
   * against the reviewer contract and stored over the review — and the station
   * then has no artefact at all. Seen live on gemma4, so it is pinned here.
   */
  it("points a repair round back at its own station, not at the review", async () => {
    const run = fresh({ "src/app.ts": "export const name = 1;\n" });
    const { outcome } = await runLine(run, "survey after a revise", {
      foreman: planTurns({
        acceptance: ["src/app.ts is surveyed"],
        stations: [{ kind: "scout", title: "Survey", goal: "Report what src/app.ts exports.", accepts: ["names the export"] }],
      }),
      "s1:scout": [
        // a contract-valid artefact, so the gauge actually reads it
        fakeTurn([fakeCall("write_artifact", { findings: ["one export"], files: [{ path: "src/app.ts", why: "the module" }], risks: [], next: "write the summary" })]),
        fakeTurn([fakeCall("finish", { summary: "surveyed", verified: "read_file of src/app.ts" })]),
        // the repair round, after the gauge said revise
        fakeTurn([fakeCall("write_artifact", { findings: ["src/app.ts exports name"], files: [{ path: "src/app.ts", why: "the module" }], risks: [], next: "verify the file" })]),
        fakeTurn([fakeCall("finish", { summary: "named the export", verified: "read_file of src/app.ts" })]),
      ],
      "review:s1": [
        fakeTurn([fakeCall("write_artifact", { verdict: "revise", problems: ["the finding says one export but never names it"], instructions: "name the export in findings" })]),
        fakeTurn([fakeCall("finish", { summary: "revise", verified: "read the artefact" })]),
        ...reviewPass(),
      ],
      "s2:verifier": surveyVerifierTurns(),
      "review:s2": reviewPass(),
    });

    const scout = outcome.plan!.stations.find((s) => s.id === "s1")!;
    expect(scout.review.rounds).toBe(2);
    expect(scout.state).toBe("done");
    const handed = readArtifact(run.dir, "s1") as Record<string, unknown> | null;
    expect(Array.isArray(handed?.findings)).toBe(true);
    expect(String(JSON.stringify(handed))).toContain("exports name");
    const verdict = readArtifact(run.dir, "s1-r") as Record<string, unknown> | null;
    expect(verdict?.verdict).toBe("pass");
    expect(outcome.gate.ok).toBe(true);
  }, 20_000);

  it("fails a station after two rounds instead of looping forever", async () => {
    const run = fresh({ "src/app.ts": "export const name = 1;\n" });
    const { outcome } = await runLine(run, "silent", {
      foreman: planTurns({
        acceptance: ["an artefact exists"],
        stations: [{ kind: "scout", title: "Say nothing", goal: "Report one finding.", accepts: ["an artefact"] }],
      }),
      // never calls write_artifact at all
      "s1:scout": [fakeTurn([fakeCall("finish", { summary: "I looked around", verified: "list_dir" })])],
    });

    const scout = outcome.plan!.stations.find((s) => s.id === "s1")!;
    expect(scout.state).toBe("failed");
    expect(scout.review.rounds).toBe(2);
    expect(outcome.gate.ok).toBe(false);
    expect(outcome.gate.reasons.join(" ")).toContain("is failed, not done");
  }, 20_000);
});

describe("the ship gate", () => {
  it("refuses to ship a change the action log does not know about", async () => {
    const run = fresh({ "src/app.ts": APP });
    const { outcome } = await runLine(run, "ghost", {
      foreman: planTurns(),
      "s1:scout": scoutTurns(),
      "review:s1": reviewPass(),
      "s2:builder": [
        fakeTurn([fakeCall("write_file", { path: "notes.md", content: "# Plan" })]),
        fakeTurn([fakeCall("write_artifact", { changed: [{ path: "ghost.ts", what: "created, but was not" }], how_verified: "trust me", open: [] })]),
        fakeTurn([fakeCall("finish", { summary: "wrote notes.md", verified: "write_file ok" })]),
      ],
      "review:s2": reviewPass(),
      "s3:verifier": verifierTurns(),
      "review:s3": reviewPass(),
    });

    expect(outcome.gate.ok).toBe(false);
    expect(outcome.gate.reasons.join(" ")).toContain("ghost.ts");
    expect(outcome.gate.reasons.join(" ")).toContain("neither the log nor the disk agrees");
    expect(outcome.report).toContain("To continue");
  }, 20_000);

  it("will not accept a verifier that reports a failed check with a pass verdict", () => {
    const run = fresh();
    const plan = buildPlan({
      runId: "g1",
      task: "gate maths",
      acceptance: ["something is true"],
      stations: [{ kind: "verifier", title: "Check", goal: "Check it.", accepts: ["the check passes"] }],
      budgetMinutes: null,
    });
    const check = first(plan.stations);
    check.state = "done";
    check.review = { verdict: "pass", rounds: 1, problems: [] };
    writeArtifact(run.dir, "s1", "verifier", {
      verdict: "pass",
      checks: [{ name: "tests", evidence: "3 failed", ok: false }],
    });
    const gate = shipGate(run.dir, plan, []);
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toContain("failed check");
  });

  it("says plainly when a station has no artefact at all", () => {
    const run = fresh();
    const plan = buildPlan({ runId: "g2", task: "t", acceptance: ["a"], stations: [{ kind: "builder", title: "Build", goal: "g", accepts: ["a"] }], budgetMinutes: null });
    const build = first(plan.stations);
    build.state = "done";
    build.review = { verdict: "pass", rounds: 1, problems: [] };
    const gate = shipGate(run.dir, plan, []);
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(" ")).toContain("no artefact on disk");
  });
});

describe("plan rules", () => {
  it("rejects a plan that tries to schedule the reviewer", () => {
    const checked = checkPlan({ acceptance: ["a"], stations: [{ kind: "reviewer", title: "Judge", goal: "g", accepts: ["a"] }] });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors.join(" ")).toContain("must be one of");
  });

  it("rejects a plan with no acceptance criteria", () => {
    expect(checkPlan({ stations: [{ kind: "scout", title: "t", goal: "g", accepts: ["a"] }] }).ok).toBe(false);
  });

  it("keeps a reviewer out of the schedulable kinds but gives it read-only tools", () => {
    expect(toolsFor("reviewer")).not.toContain("write_file");
    expect(toolsFor("reviewer")).toContain("write_artifact");
    expect(toolsFor("scout")).not.toContain("edit_file");
    expect(toolsFor("builder")).toContain("edit_file");
    expect(toolsFor("verifier")).toContain("run_command");
    expect(toolsFor("verifier")).not.toContain("write_file");
  });

  it("carries the state of a crashed run: a station caught mid-flight is started again", () => {
    const run = fresh();
    const plan = buildPlan({ runId: "c1", task: "resume me", acceptance: ["a"], stations: [{ kind: "builder", title: "Build", goal: "g", accepts: ["a"] }], budgetMinutes: null });
    updateStation(run.dir, plan, "s1", { state: "running" });
    const loaded = loadPlan(run.dir)!;
    expect(first(loaded.stations).state).toBe("pending");
    expect(loadPlan(run.dir)!.task).toBe("resume me");
  });

  it("gives each station only its share of the time that is left", () => {
    const run = fresh();
    const global = createBudget(12, Date.now());
    const plan = buildPlan({
      runId: "b1",
      task: "budget",
      acceptance: ["a"],
      stations: [
        { kind: "scout", title: "1", goal: "g", accepts: ["a"] },
        { kind: "builder", title: "2", goal: "g", accepts: ["a"] },
        { kind: "verifier", title: "3", goal: "g", accepts: ["a"] },
      ],
      budgetMinutes: 12,
    });
    const slice = stationBudget(global, plan);
    expect(slice.minutes).toBeCloseTo(4, 0);
    expect(slice.deadlineAt! - slice.startedAt).toBeLessThanOrEqual(global.deadlineAt! - slice.startedAt);
    updateStation(run.dir, plan, "s1", { state: "done" });
    updateStation(run.dir, plan, "s2", { state: "done" });
    const last = stationBudget(global, plan);
    expect(last.deadlineAt).toBe(global.deadlineAt);
  });

  it("appends a verifier to a line that forgot one, once", () => {
    const run = fresh();
    const plan = buildPlan({
      runId: "v1",
      task: "no check planned",
      acceptance: ["a", "b"],
      stations: [
        { kind: "scout", title: "1", goal: "g", accepts: ["a"] },
        { kind: "builder", title: "2", goal: "g", accepts: ["b"] },
      ],
      budgetMinutes: null,
    });
    expect(plan.stations.some((s) => s.kind === "verifier")).toBe(false);
    ensureVerifier(plan, run.dir);
    ensureVerifier(plan, run.dir);
    const verifier = plan.stations.filter((s) => s.kind === "verifier");
    expect(verifier.length).toBe(1);
    expect(first(verifier).accepts).toEqual(["a", "b"]);
    // The appended station is on disk too, so a resumed line sees the same plan.
    expect(loadPlan(run.dir)!.stations.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("validates an artefact against its own contract, not a general one", () => {
    expect(checkArtifact("scout", { findings: ["f"], files: [{ path: "a", why: "b" }], next: "c" }).ok).toBe(true);
    const bad = checkArtifact("builder", { changed: [{ path: "a" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toContain("what");
  });

  it("tells the model that a list holds objects, not bare strings", () => {
    // The live run lost two rounds to `files: ["src/app.ts"]`, so the shape must be spelled out.
    expect(contractHint("scout")).toContain("files: list of { path: string, why: string }");
    expect(contractHint("builder")).toContain("changed: list of { path: string, what: string }");
    expect(contractHint("reviewer")).toContain("problems: list of string");
    const refusal = contractErrors("scout", ["/files/[0]: expected object, got string"]);
    expect(refusal).toContain("expected object, got string");
    expect(refusal).toContain("list of { path: string, why: string }");
  });

  /** A live unattended line burned its builder station retrying refused writes. */
  it("tells a writer what happens to a write when nobody is watching", () => {
    const plan = buildPlan({
      runId: "brief",
      task: "t",
      acceptance: ["notes.md exists"],
      stations: [{ kind: "builder", title: "Write", goal: "Write notes.md.", accepts: ["notes.md exists"] }],
      budgetMinutes: null,
    });
    const station = first(plan.stations);
    const alone = stationBrief({ plan, station, tools: toolsFor("builder"), upstream: [], attended: false });
    expect(alone).toContain("Nobody is watching this run");
    expect(alone).toContain("--yes");
    const watched = stationBrief({ plan, station, tools: toolsFor("builder"), upstream: [], attended: true });
    expect(watched).not.toContain("Nobody is watching this run");
    expect(watched).toContain("shown to the operator");
    // A scout never writes, so it gets neither line.
    const survey = stationBrief({
      plan,
      station: { ...station, kind: "scout" },
      tools: toolsFor("scout"),
      upstream: [],
      attended: false,
    });
    expect(survey).toContain("You are read-only");
  });

  /** Twice in one live run the gauge wrote `verdict` alone and had the call thrown back. */
  it("gives the gauge the shape it is asked to fill in", () => {
    const plan = buildPlan({
      runId: "gauge",
      task: "t",
      acceptance: ["src/app.ts is surveyed"],
      stations: [{ kind: "scout", title: "Survey", goal: "Report what src/app.ts exports.", accepts: ["names the export"] }],
      budgetMinutes: null,
    });
    const brief = reviewerBrief(first(plan.stations), "{}");
    expect(brief).toContain("verdict: string (pass | revise)");
    expect(brief).toContain("problems: list of string");
    expect(brief).toContain("instructions: string");
  });

  it("saves and reloads a plan a resumed run can continue from", () => {
    const run = fresh();
    const plan = buildPlan({ runId: "s", task: "keep me", acceptance: ["a"], stations: [{ kind: "scout", title: "T", goal: "g", accepts: ["a"] }], budgetMinutes: null });
    savePlan(run.dir, plan);
    expect(existsSync(path.join(run.dir, ".factory", "plan.json"))).toBe(true);
    expect(first(loadPlan(run.dir)!.stations).title).toBe("T");
  });
});
