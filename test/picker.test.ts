/**
 * The two blocks a person points at with the keyboard: the approval list and the
 * `/` palette. Their text is the contract — numbered options, a cursor on one of
 * them, a "Type something." row that is numbered too — so it is asserted as rows,
 * without needing a terminal.
 */
import { describe, expect, it } from "bun:test";
import { paletteFilter, paletteRows, type PaletteEntry } from "#ui/input.ts";
import { HELP, PALETTE as REPL_PALETTE } from "#ui/repl.ts";
import { pickRows, type PickRequest } from "#ui/select.ts";

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const clean = (rows: string[]): string[] => rows.map((row) => row.replace(ANSI, ""));

const approval: PickRequest<unknown> = {
  title: 'write_file (write)',
  body: ['create notes/list.md — "three lines"'],
  question: "Do you want to proceed?",
  choices: [
    { label: "Yes", value: "yes" },
    { label: "Yes, and do not ask again for this tool this run", value: "always" },
    { label: "No — leave it undone", value: "no" },
  ],
  footer: "↑↓ move · Enter select · Esc says no",
};

describe("the approval picker", () => {
  it("lists the answers numbered, with the cursor on the first", () => {
    const rows = clean(pickRows(approval, { index: 0, typing: false, typed: "" }));
    expect(rows[0]).toContain("write_file (write)");
    expect(rows[1]).toContain("create notes/list.md");
    expect(rows).toContain("  > 1. Yes");
    expect(rows).toContain("    2. Yes, and do not ask again for this tool this run");
    expect(rows).toContain("    3. No — leave it undone");
    expect(rows.at(-1)).toContain("↑↓ move · Enter select · Esc says no");
  });

  it("moves the cursor, which is the whole point of arrows", () => {
    const rows = clean(pickRows(approval, { index: 2, typing: false, typed: "" }));
    expect(rows).toContain("  > 3. No — leave it undone");
    expect(rows).toContain("    1. Yes");
  });

  it("defaults the footer to the keys that actually work", () => {
    const rows = clean(pickRows({ title: "Which one?", choices: [{ label: "a", value: "a" }] }, { index: 0, typing: false, typed: "" }));
    expect(rows.at(-1)).toContain("↑↓ move · Enter select · Esc cancel");
  });
});

describe("a question the agent asks", () => {
  const asking: PickRequest<unknown> = {
    title: "The agent needs to know something",
    body: ["Which branch should I push?"],
    question: "Which one?",
    choices: [{ label: "main", value: "main" }],
    allowType: true,
  };

  it("offers the list and a row to type in, numbered after it", () => {
    const rows = clean(pickRows(asking, { index: 0, typing: false, typed: "" }));
    expect(rows).toContain("  > 1. main");
    expect(rows).toContain("    2. Type something.");
    expect(rows.join("\n")).toContain("Which branch should I push?");
  });

  it("shows what has been typed so far, on its own row", () => {
    const rows = clean(pickRows(asking, { index: 1, typing: true, typed: "rel" }));
    expect(rows).toContain("  > 2. Type something. rel");
    expect(rows).toContain("    1. main");
  });
});

const PALETTE: PaletteEntry[] = [
  { command: "/model", description: "switch model for this session" },
  { command: "/models", description: "what this ollama daemon can run" },
  { command: "/log", description: "recent actions" },
  { command: "/stop", description: "stop the run in flight" },
];

describe("the slash palette", () => {
  it("shows every command before you type a letter", () => {
    expect(paletteFilter(PALETTE, "/").map((entry) => entry.command)).toEqual(["/model", "/models", "/log", "/stop"]);
  });

  it("narrows as you type, and matches on the prefix you wrote", () => {
    expect(paletteFilter(PALETTE, "/mo").map((entry) => entry.command)).toEqual(["/model", "/models"]);
    expect(paletteFilter(PALETTE, "/model").map((entry) => entry.command)).toEqual(["/model", "/models"]);
    expect(paletteFilter(PALETTE, "/models").map((entry) => entry.command)).toEqual(["/models"]);
  });

  it("says nothing when the text is not a command", () => {
    expect(paletteFilter(PALETTE, "read me")).toEqual([]);
    expect(paletteFilter(PALETTE, "/zzz")).toEqual([]);
  });

  it("draws two columns, a cursor, and the key map", () => {
    const rows = clean(paletteRows(PALETTE, 0, 80));
    expect(rows[0]).toContain("> /model");
    expect(rows[1]).toContain("  /models");
    expect(rows[0], "the description sits beside the command, not under it").toContain("switch model for this session");
    expect(rows.at(-1)).toBe("  ↑↓ choose · Tab complete · Enter run · Esc hide");
  });

  it("caps the list and counts what is hiding", () => {
    const many: PaletteEntry[] = Array.from({ length: 20 }, (_, i) => ({ command: `/c${i}`, description: `command ${i}` }));
    const rows = clean(paletteRows(many, 0, 80));
    expect(rows.length).toBe(13);
    expect(rows.at(-1)).toContain("8 more");
  });

  it("offers the REPL every command /help admits to", () => {
    const documented = HELP.filter(([name]) => name.startsWith("/")).map(([name]) => name);
    expect(REPL_PALETTE.map((entry) => entry.command)).toEqual(documented);
    expect(REPL_PALETTE.every((entry) => entry.description.length > 0), "a command with no description is a command you cannot use").toBe(true);
    for (const entry of REPL_PALETTE) {
      expect(paletteFilter(REPL_PALETTE, entry.command).map((found) => found.command)).toContain(entry.command);
    }
  });
});
