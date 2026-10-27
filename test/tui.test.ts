/**
 * The full screen, proven frame by frame. Nothing here talks to a model: every
 * run is scripted, so what an operator sees — the diff before the write, the
 * palette, the answer pane — is checked as pixels, and a refusal is checked on
 * the disk as well as on the screen.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestRenderer } from "@opentui/core/testing";
import { buildApp, type App } from "#tui/app.ts";
import { decodePng, logoRows, sampleLogo } from "#tui/logo.ts";
import { buildTools } from "#tools/index.ts";
import type { AssistantTurn } from "#core/provider.ts";
import type { AppConfig } from "#core/types.ts";
import { fakeCall, fakeTurn, scripted, tempWorkspace, testConfig, type TempWorkspace } from "./helpers.ts";

interface Keys {
  pressKey(key: string): void;
  pressTab(): void;
  pressEnter(): void;
  pressEscape(): void;
  pressArrow(direction: "up" | "down" | "left" | "right"): void;
  pressCtrlC(): void;
  typeText(text: string): Promise<void>;
}

interface Screen {
  app: App;
  keys: Keys;
  dir: string;
  /** The whole frame, trailing blanks cut. */
  frame(): string;
  rows(): string[];
  /** Every run of ink in the painted frame, with the colour it was drawn in. */
  spans(): Span[];
  settle(ms?: number): Promise<void>;
  close(): Promise<void>;
}

interface Rgba {
  buffer: { 0: number; 1: number; 2: number; 3: number };
}

interface Span {
  text: string;
  fg?: Rgba;
  bg?: Rgba;
}

async function open(
  roles: Record<string, AssistantTurn[]> = {},
  overrides: Partial<AppConfig> = {},
  seed: Record<string, string> = {},
  /** Kitty encoding is the only way the mock can put a modifier on the wire. */
  kitty = false,
): Promise<Screen> {
  const ws: TempWorkspace = tempWorkspace("tui");
  for (const [file, contents] of Object.entries(seed)) {
    const target = path.join(ws.dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  const config = testConfig(ws.dir, { model: "test:1b", budgetMinutes: 20, ...overrides });
  const script = scripted(roles);
  const setup = (await createTestRenderer({
    width: 100,
    height: 30,
    // The same promise the real screen makes: Ctrl+C belongs to the operator, not to the process.
    exitOnCtrlC: false,
    ...(kitty ? { kittyKeyboard: true } : {}),
  })) as unknown as {
    renderer: Parameters<typeof buildApp>[0];
    flush(): Promise<void>;
    captureCharFrame(): string;
    captureSpans(): { lines: { spans: Span[] }[] };
    dispose(): Promise<void>;
    mockInput: Keys;
  };
  const app = buildApp(setup.renderer, { config, tools: buildTools(), transport: script.transport, onQuit: () => {} });
  await setup.flush();

  const frame = (): string => setup.captureCharFrame().split("\n").map((row) => row.replace(/ +$/g, "")).join("\n");

  return {
    app,
    keys: setup.mockInput,
    dir: ws.dir,
    frame,
    rows: () => frame().split("\n"),
    spans: () => setup.captureSpans().lines.flatMap((line) => line.spans),
    async settle(ms = 200) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await setup.flush();
    },
    async close() {
      app.destroy();
      await setup.dispose();
      ws.cleanup();
    },
  };
}

const writeProbe = fakeCall("write_file", { path: "notes/new.md", content: "created by the test\nsecond line\n" });
const finish = (summary: string) => fakeCall("finish", { summary, verified: "re-read the file" });
const reviewScript = (): Record<string, AssistantTurn[]> => ({
  plain: [fakeTurn([writeProbe]), fakeTurn([finish("notes/new.md written")])],
});
const task = "make notes/new.md say what it should say";

function titleRow(rows: string[]): string {
  const row = rows.find((line) => line.includes("write_file"));
  expect(row).toBeDefined();
  return row ?? "";
}

describe("the screen", () => {
  it("names the model, the workspace and the way in", async () => {
    const sc = await open();
    const frame = sc.frame();
    expect(frame).toContain("test:1b");
    expect(frame).toContain(path.basename(sc.app.session.state().config.workspace));
    expect(frame).toContain("20 min");
    expect(frame).toContain("writes ask");
    expect(frame).toContain("❯ a task, or / for commands, or @ to hand over a file");
    await sc.close();
  });

  it("opens on the robot, in the logo's own cobalt", async () => {
    const sc = await open();
    const mark = sc.spans().filter((span) => /[█▀▄]/.test(span.text));
    expect(mark.length, "one run per line of the block robot").toBeGreaterThan(3);
    const cobalt = mark.filter((span) => span.fg?.buffer[0] === 46 && span.fg?.buffer[1] === 91 && span.fg?.buffer[2] === 255);
    const pixels = cobalt.reduce((sum, span) => sum + [...span.text].length, 0);
    expect(cobalt.length, "every part of the robot is #2e5bff, the web logo's blue").toBeGreaterThan(3);
    expect(pixels).toBeGreaterThan(20);
    const lines = sc.rows().filter((line) => /[█▀▄]{4}/.test(line));
    // Three rows are solid enough to match: the head, the eyes row, and the head again.
    // The legs row has gaps, so it never counts as a bar.
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.length, "a banner is not a wall").toBeLessThan(14);
    await sc.close();
  });

  it("paints the command list when /help runs", async () => {
    const sc = await open();
    sc.app.session.submit("/help");
    await sc.settle();
    const frame = sc.frame();
    expect(frame).toContain("/factory <task>");
    expect(frame).toContain("show this list");
    await sc.close();
  });

  it("keeps what the operator typed visibly theirs", async () => {
    const sc = await open({ plain: [fakeTurn([finish("noted")])] });
    await sc.keys.typeText("read the notes");
    sc.keys.pressEnter();
    await sc.settle(500);
    expect(sc.frame()).toContain("❯ read the notes");
    const typed = sc.spans().find((span) => span.text.includes("read the notes"));
    expect(typed?.bg?.buffer[3]).toBeGreaterThan(0);
    expect(sc.frame()).toContain("noted");
    await sc.close();
  });
});

describe("the pickers", () => {
  it("narrows / to matching commands and completes on Tab", async () => {
    const sc = await open();
    await sc.keys.typeText("/mod");
    await sc.settle();
    const frame = sc.frame();
    expect(frame).toContain("/model <name>");
    expect(frame).toContain("/models");
    expect(frame).toContain("Tab insert");
    expect(frame).not.toContain("/exit");
    sc.keys.pressTab();
    await sc.settle();
    expect(sc.frame()).toContain("❯ /model <name>");
    await sc.close();
  });

  it("lists files for @ and splices the chosen one at the token", async () => {
    const sc = await open({}, {}, { "notes/a.md": "# a\n", "notes/b.md": "# b\n" });
    await sc.keys.typeText("read @notes/");
    await sc.settle();
    const frame = sc.frame();
    expect(frame).toContain("notes/a.md");
    expect(frame).toContain("notes/b.md");
    expect(frame).toContain("Tab or Enter insert");
    sc.keys.pressTab();
    await sc.settle();
    expect(sc.frame()).toMatch(/❯ read @notes\/a\.md/);
    await sc.close();
  });

  it("leaves the typed line alone when Esc hides the palette", async () => {
    const sc = await open();
    await sc.keys.typeText("/mod");
    await sc.settle();
    sc.keys.pressEscape();
    await sc.settle(400);
    const frame = sc.frame();
    expect(frame).not.toContain("Tab insert");
    expect(frame).toContain("❯ /mod");
    await sc.close();
  });
});

describe("the review pane", () => {
  it("shows the diff before anything is written", async () => {
    const sc = await open(reviewScript());
    sc.app.session.submit(task);
    await sc.settle(400);
    const frame = sc.frame();
    // The reference pane: a bullet names the change, the connector drops to the count.
    expect(frame).toContain("● Write [notes/new.md]  write_file · write");
    expect(frame).toContain("└── will change notes/new.md with 2 additions and 0 removals");
    expect(frame).toContain("1  + created by the test");
    expect(frame).toContain("1. Yes — do it");
    expect(frame).toContain("esc says no");
    expect(existsSync(path.join(sc.dir, "notes/new.md"))).toBe(false);
    await sc.close();
  });

  it("is a flat screen: hairlines, no frames, and the cursor left on no", async () => {
    const sc = await open(reviewScript());
    sc.app.session.submit(task);
    await sc.settle(400);
    const rows = sc.rows();
    const frame = sc.frame();
    expect(frame).toContain("Do you want to proceed?");
    expect(frame).toContain("❯ 3. No — leave it undone");
    // Nothing closes a box around the text: the corner glyphs never appear.
    expect(frame).not.toContain("┌");
    expect(frame).not.toContain("┐");
    expect(frame).not.toContain("┘");
    // A `│` here is only ever a connector, the split's middle rule, or the welcome
    // card's own edge — which comes as a pair. Never a frame around the transcript.
    expect(rows.every((line) => !line.startsWith("│") || line.endsWith("│"))).toBe(true);
    // The pane takes the box's place: one hairline above it, and no second set of rules.
    expect(rows.some((line) => /^─+$/.test(line))).toBe(true);
    expect(rows.filter((line) => /^─+$/.test(line)).length).toBe(1);
    await sc.close();
  });

  it("types between two hairlines, with the mode under the box and the list above it", async () => {
    const sc = await open();
    await sc.keys.typeText("/mod");
    await sc.settle();
    const rows = sc.rows();
    const rules = rows.map((line, index) => (line.trim() !== "" && /^─+$/.test(line) ? index : -1)).filter((index) => index >= 0);
    const caret = rows.findIndex((line) => line.trim() === "❯ /mod");
    const list = rows.findIndex((line) => line.includes("❯ /model <name>"));
    expect(rules.length).toBe(2);
    expect(list).toBeGreaterThan(-1);
    expect(list).toBeLessThan(rules[0]!);
    expect(caret).toBeGreaterThan(rules[0]!);
    expect(caret).toBeLessThan(rules[1]!);
    expect(rows[caret + 2]).toContain("▸▸ writes ask");
    await sc.close();
  });

  it("paints ink, not blocks: nothing is picked out in blue and the cursor row is bare", async () => {
    const sc = await open(reviewScript());
    sc.app.session.submit(task);
    await sc.settle(400);
    const spans = sc.spans();
    // A filled block behind text would show up as a background with the blue channel on top.
    const blue = spans.filter((span) => {
      const bg = span.bg?.buffer;
      return Boolean(bg && bg[3] > 0 && bg[2] > bg[0] && bg[2] > bg[1]);
    });
    expect(blue.map((span) => span.text)).toEqual([]);
    const cursor = spans.find((span) => span.text.includes("No — leave it undone"));
    expect(cursor?.bg?.buffer[3]).toBe(0);
    const hairline = spans.find((span) => span.text.startsWith("──"));
    expect(hairline?.fg?.buffer[0]).toBe(77);
    await sc.close();
  });

  it("turns the same patch sideways with v", async () => {
    const sc = await open(reviewScript());
    sc.app.session.submit(task);
    await sc.settle(400);
    expect(titleRow(sc.rows())).toContain("unified");
    expect(sc.frame()).toContain("2  + second line");
    sc.keys.pressKey("v");
    await sc.settle();
    expect(titleRow(sc.rows())).toContain("split");
    // The additions sit in the right-hand column, with the middle rule between.
    expect(sc.frame()).toContain("│    1  + created by the test");
    expect(sc.frame()).toContain("2  + second line");
    await sc.close();
  });

  it("writes when the answer is y and the run goes on", async () => {
    const sc = await open(reviewScript());
    sc.app.session.submit(task);
    await sc.settle(400);
    sc.keys.pressKey("y");
    await sc.settle(600);
    expect(readFileSync(path.join(sc.dir, "notes/new.md"), "utf8")).toContain("created by the test");
    const frame = sc.frame();
    expect(frame).toContain("⎿  yes");
    expect(frame).toContain("notes/new.md written");
    expect(frame).toContain("turns");
    await sc.close();
  });

  it("leaves the file alone when the answer is n", async () => {
    const sc = await open(reviewScript());
    sc.app.session.submit(task);
    await sc.settle(400);
    sc.keys.pressKey("n");
    await sc.settle(400);
    expect(existsSync(path.join(sc.dir, "notes/new.md"))).toBe(false);
    const frame = sc.frame();
    expect(frame).toContain("⎿  no");
    expect(frame).toContain("a task, or / for commands");
    await sc.close();
  });

  it("counts a bare Esc as no", async () => {
    const sc = await open(reviewScript());
    sc.app.session.submit(task);
    await sc.settle(400);
    sc.keys.pressEscape();
    await sc.settle(500);
    expect(existsSync(path.join(sc.dir, "notes/new.md"))).toBe(false);
    expect(sc.frame()).toContain("⎿  no");
    await sc.close();
  });

  it("puts the pane down when the operator stops the run", async () => {
    const sc = await open(reviewScript(), {}, {}, true);
    sc.app.session.submit(task);
    await sc.settle(400);
    sc.keys.pressCtrlC();
    await sc.settle(500);
    const frame = sc.frame();
    expect(frame).toContain("stopping the run");
    expect(frame).not.toContain("esc says no");
    expect(existsSync(path.join(sc.dir, "notes/new.md"))).toBe(false);
    sc.app.session.submit("/stop");
    await sc.settle(300);
    expect(sc.app.session.state().busy).toBe(false);
    await sc.close();
  });
});

describe("the answer pane", () => {
  it("asks, takes a choice and keeps going", async () => {
    const ask = fakeCall("request_input", { question: "which name should it use?", options: ["alpha", "beta"] });
    const sc = await open({ plain: [fakeTurn([ask]), fakeTurn([finish("named as told")])] });
    sc.app.session.submit("name it");
    await sc.settle(400);
    const frame = sc.frame();
    expect(frame).toContain("the agent needs to know something");
    expect(frame).toContain("which name should it use?");
    expect(frame).toContain("1. alpha");
    expect(frame).toContain("type to answer");
    sc.keys.pressArrow("down");
    await sc.settle();
    expect(sc.frame()).toContain("❯ 2. beta");
    sc.keys.pressEnter();
    await sc.settle(600);
    const done = sc.frame();
    expect(done).toContain("⎿  beta");
    expect(done).toContain("named as told");
    await sc.close();
  });

  it("stops the run instead of guessing when Esc is pressed", async () => {
    const ask = fakeCall("request_input", { question: "which name should it use?" });
    const sc = await open({ plain: [fakeTurn([ask]), fakeTurn([finish("named as told")])] });
    sc.app.session.submit("name it");
    await sc.settle(400);
    sc.keys.pressEscape();
    await sc.settle(500);
    const frame = sc.frame();
    expect(frame).toContain("no answer — the run stops rather than guesses");
    expect(frame).not.toContain("named as told");
    await sc.close();
  });
});

describe("a @mention in a task", () => {
  it("hands the file over and says so on the screen", async () => {
    const sc = await open({ plain: [fakeTurn([finish("read it")])] }, {}, { "notes/a.md": "# notes\nsecond line\n" });
    sc.app.session.submit("read @notes/a.md and tell me what it says");
    await sc.settle(400);
    const frame = sc.frame();
    expect(frame).toContain("injected notes/a.md");
    expect(frame).toContain("read it");
    await sc.close();
  });
});

describe("the space between blocks", () => {
  it("opens a blank row before every new call, and none inside one", async () => {
    const read = fakeCall("read_file", { path: "notes/a.md" });
    const list = fakeCall("list_dir", { path: "notes" });
    const sc = await open({ plain: [fakeTurn([read]), fakeTurn([list]), fakeTurn([finish("looked")])] }, {}, { "notes/a.md": "# notes\n" });
    sc.app.session.submit("look at the notes");
    await sc.settle(800);
    const rows = sc.rows();
    const bullets = rows.map((line, index) => (line.trimStart().startsWith("●") ? index : -1)).filter((index) => index >= 0);
    expect(bullets.length).toBe(2);
    for (const index of bullets) {
      // Every block starts under a blank row...
      expect(rows[index - 1]!.trim()).toBe("");
      // ...and the row above that is the previous block's own last line, not a second gap.
      expect(rows[index - 2]!.trim()).not.toBe("");
    }
    // The result line belongs to its call: no blank creeps between the ● and its ⎿.
    const first = bullets[0]!;
    expect(rows[first + 1]!.trimStart().startsWith("⎿")).toBe(true);
    await sc.close();
  });
});

describe("the tiers on the screen", () => {
  it("runs the write unasked at full access and still stops at the floor", async () => {
    const gate = fakeCall("run_command", { command: "rm -rf notes" });
    const sc = await open({ plain: [fakeTurn([writeProbe]), fakeTurn([gate]), fakeTurn([finish("done")])] }, { approvalLevel: "full" });
    sc.app.session.submit("/approve full");
    await sc.settle(300);
    expect(sc.frame()).toContain("▸▸ full access");

    sc.app.session.submit(task);
    await sc.settle(900);
    // The write needed no answer; the deletion does, and says why at every level.
    expect(existsSync(path.join(sc.dir, "notes/new.md"))).toBe(true);
    const frame = sc.frame();
    expect(frame).toContain("Do you want to proceed?");
    expect(frame).toContain("this is asked at every level");
    sc.keys.pressKey("n");
    await sc.settle(500);
    expect(sc.frame()).toContain("⎿  no");
    expect(existsSync(path.join(sc.dir, "notes/new.md"))).toBe(true);
    await sc.close();
  });
});

describe("markdown, as the model meant it", () => {
  const report = [
    "## What changed",
    "",
    "The **builder** now runs:",
    "",
    "1. compiles",
    "2. proves",
    "",
    "- [x] shipped",
    "- [ ] docs",
    "",
    "```",
    "bun run check",
    "```",
  ].join("\n");

  it("prints titles, points and code instead of the marks that mean them", async () => {
    const sc = await open({ plain: [fakeTurn([], report)] });
    sc.app.session.submit("write it up");
    await sc.settle(700);
    const frame = sc.frame();
    expect(frame).not.toContain("## What changed");
    expect(frame).toContain("What changed");
    expect(frame).not.toContain("**builder**");
    expect(frame).toContain("builder now runs");
    expect(frame).toContain("1. compiles");
    expect(frame).toContain("☑ shipped");
    expect(frame).toContain("☐ docs");
    // A fence is a place to put text, not text to show.
    expect(frame).not.toContain("```");
    expect(frame).toContain("bun run check");
    await sc.close();
  });
});

describe("the mark itself", () => {
  it("reads the logo that ships with the CLI", () => {
    const asset = fileURLToPath(new URL("../assets/logo.png", import.meta.url));
    const image = decodePng(Buffer.from(readFileSync(asset)));
    expect(image).not.toBeNull();
    expect(image!.width).toBeGreaterThan(64);
    expect(image!.height).toBeGreaterThan(64);

    const { rows, cells } = sampleLogo(image!, 20);
    // Two cells per text line, and the mark has to fill its box top to bottom.
    expect(rows).toBeLessThanOrEqual(20);
    expect(cells.length).toBeGreaterThan(100);
    expect(new Set(cells.map((cell) => cell.y)).size).toBeGreaterThan(10);
    // Same grid, same seed: the worn cells are the same ones every run.
    expect(sampleLogo(image!, 20).cells.map((cell) => `${cell.x},${cell.y}`)).toEqual(cells.map((cell) => `${cell.x},${cell.y}`));
  });

  it("is no banner at all when the operator does not want one", () => {
    const before = { ...process.env };
    try {
      process.env.AGENT_BANNER = "0";
      expect(logoRows({ width: 100 })).toEqual([]);
      process.env.AGENT_BANNER = "";
      delete process.env.AGENT_BANNER;
      expect(logoRows({ width: 100 }).length).toBeGreaterThan(4);
      expect(logoRows({ width: 100, cols: 8 }).length).toBeLessThan(logoRows({ width: 100 }).length + 1);
      process.env.AGENT_LOGO = "D:/not/here/logo.png";
      expect(logoRows({ width: 100 })).toEqual([]);
    } finally {
      for (const key of ["AGENT_BANNER", "AGENT_LOGO"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  it("refuses a file that is not a PNG instead of guessing at it", () => {
    expect(decodePng(Buffer.from("not a png at all, not even close"))).toBeNull();
    expect(decodePng(Buffer.alloc(0))).toBeNull();
  });
});
