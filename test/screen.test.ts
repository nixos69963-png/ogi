/**
 * The interactive screens, driven by keystrokes.
 *
 * A pty is not available in a test run, so the screen is assembled the way the
 * terminal assembles it: stdin claims to be a TTY, a fake stream feeds real escape
 * sequences through the real hub, and `process.stdout.write` is captured so the
 * rows an operator would see can be read back. That is enough to prove the parts
 * that matter — the cursor moves where the arrows say, Enter answers with the row
 * it was on, Esc is a refusal, and a line printed by the run lands above the
 * prompt instead of through it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createLineEditor, type PaletteEntry } from "#ui/input.ts";
import { closeKeyHub, keyHub, type KeyStream } from "#ui/keys.ts";
import { choose } from "#ui/select.ts";
import { line, setPromptAnchor } from "#ui/terminal.ts";

function fakeStream(): KeyStream & { sends: (text: string) => void } {
  const listeners: ((chunk: Buffer | string) => void)[] = [];
  return {
    isTTY: true,
    on(_event, listener) {
      listeners.push(listener);
    },
    off(_event, listener) {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    setRawMode() {},
    resume() {},
    sends(text) {
      for (const listener of [...listeners]) listener(text);
    },
  };
}

let stream: ReturnType<typeof fakeStream>;
let printed: string[];
const stdinIsTTY = process.stdin.isTTY;
const stdoutIsTTY = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);

/**
 * A small terminal: it applies the cursor moves and erases the way a console
 * would, so an assertion reads the frame the operator is looking at instead of the
 * bytes that produced it. Redrawing in place is the whole design of the prompt
 * line, and a byte-level assertion cannot tell a redraw from a mess.
 */
function display(chunks: string[], rows = 24, cols = 80): string[] {
  const grid: string[][] = Array.from({ length: rows }, () => " ".repeat(cols).split(""));
  const text = chunks.join("");
  let row = 0;
  let col = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\x1b") {
      const escape = /^\[([0-9;]*)([A-Za-z~])/.exec(text.slice(i + 1));
      if (escape) {
        const count = Number(escape[1] || 0) || 1;
        const command = escape[2];
        if (command === "A") row = Math.max(0, row - count);
        else if (command === "B") row = Math.min(rows - 1, row + count);
        else if (command === "C") col = Math.min(cols - 1, col + count);
        else if (command === "D") col = Math.max(0, col - count);
        else if (command === "J") {
          for (let c = col; c < cols; c += 1) grid[row]![c] = " ";
          for (let r = row + 1; r < rows; r += 1) grid[r] = " ".repeat(cols).split("");
        } else if (command === "K") {
          for (let c = col; c < cols; c += 1) grid[row]![c] = " ";
        }
        i += escape[0].length;
        continue;
      }
    }
    if (char === "\r") col = 0;
    else if (char === "\n") {
      row = Math.min(rows - 1, row + 1);
      col = 0;
    } else if (col < cols) {
      grid[row]![col] = char;
      col += 1;
    }
  }
  const out = grid.map((r) => r.join("").trimEnd());
  while (out.length && out.at(-1) === "") out.pop();
  return out;
}

/** What is on the screen now. */
function screen(): string[] {
  return display(printed);
}

beforeEach(() => {
  stream = fakeStream();
  printed = [];
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  process.stdout.columns = 80;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    printed.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  closeKeyHub();
  keyHub(stream);
});

afterEach(() => {
  closeKeyHub();
  process.stdout.write = realWrite;
  process.stdin.isTTY = stdinIsTTY;
  process.stdout.isTTY = stdoutIsTTY;
  setPromptAnchor(null);
});

const PALETTE: PaletteEntry[] = [
  { command: "/model", description: "switch model for this session" },
  { command: "/stop", description: "stop the run in flight" },
  { command: "/tools", description: "list the tools this build has" },
];

/** The row the operator is typing on is always the last one on the screen. */
function promptRow(): string | undefined {
  return screen().at(-1);
}

describe("the prompt line and its palette", () => {
  it("opens the whole command list on a bare slash", async () => {
    const editor = createLineEditor({ prompt: "> ", palette: PALETTE });
    const reading = editor.read();
    stream.sends("/");
    expect(screen().join("\n")).toContain("/model");
    expect(screen().join("\n")).toContain("/tools");
    expect(screen().join("\n")).toContain("↑↓ choose");
    stream.sends("s");
    expect(screen().join("\n")).toContain("/stop");
    expect(screen().join("\n"), "the list narrowed to what was typed").not.toContain("/model");
    stream.sends("\x1b");
    stream.sends("\r");
    expect(await reading).toBe("/s");
    editor.stop();
  });

  it("moves the cursor with the arrows and completes with Tab", async () => {
    const editor = createLineEditor({ prompt: "> ", palette: PALETTE });
    const reading = editor.read();
    stream.sends("/t");
    stream.sends("\x1b[B");
    stream.sends("\t");
    expect(promptRow()).toBe("> /tools");
    stream.sends("\r");
    expect(await reading).toBe("/tools");
    editor.stop();
  });

  it("walks back through what was typed, newest first", async () => {
    const editor = createLineEditor({ prompt: "> ", palette: PALETTE });
    for (const text of ["first task", "second task"]) {
      const reading = editor.read();
      stream.sends(`${text}\r`);
      expect(await reading).toBe(text);
    }
    const reading = editor.read();
    stream.sends("\x1b[A");
    expect(promptRow()).toBe("> second task");
    stream.sends("\x1b[A");
    expect(promptRow()).toBe("> first task");
    stream.sends("\x1b[B");
    expect(promptRow()).toBe("> second task");
    stream.sends("\x1b[B");
    expect(promptRow(), "down past the newest entry is the empty line again").toBe(">");
    stream.sends("third task\r");
    expect(await reading).toBe("third task");
    editor.stop();
  });

  it("runs the highlighted command when Enter is pressed on a bare list", async () => {
    const editor = createLineEditor({ prompt: "> ", palette: PALETTE });
    const reading = editor.read();
    stream.sends("/");
    stream.sends("\x1b[B");
    stream.sends("\r");
    expect(await reading).toBe("/stop");
    editor.stop();
  });

  it("prints what the run says above the prompt, and puts the prompt back", async () => {
    const editor = createLineEditor({ prompt: "> ", palette: PALETTE });
    const reading = editor.read();
    stream.sends("fix the par");
    line("● Update(src/core/parser.ts)");
    const rows = screen();
    expect(rows).toContain("● Update(src/core/parser.ts)");
    expect(rows.at(-1), "the live prompt stays the last row on the screen").toBe("> fix the par");
    stream.sends("ser\r");
    expect(await reading).toBe("fix the parser");
    expect(screen().join("\n"), "what was said is still on the screen").toContain("fix the parser");
    editor.stop();
  });

  it("hands Ctrl+C to the caller instead of typing it into the line", async () => {
    let interrupts = 0;
    const editor = createLineEditor({ prompt: "> ", palette: PALETTE, onCtrlC: () => (interrupts += 1) });
    editor.read();
    stream.sends("half a thought");
    stream.sends("\u0003");
    stream.sends("x\r");
    expect(interrupts).toBe(1);
    expect(promptRow(), "the line was cleared by the interrupt, not kept").toBe("> x");
    editor.stop();
  });
});

describe("the approval picker", () => {
  it("asks with the command in view and answers with the row the cursor is on", async () => {
    const asking = choose<"yes" | "no">({
      title: "run_command (outward)",
      body: ['mkdir -p "notes"'],
      question: "Do you want to proceed?",
      choices: [
        { label: "Yes", value: "yes" },
        { label: "No — leave it undone", value: "no" },
      ],
    });
    expect(screen().join("\n")).toContain('mkdir -p "notes"');
    expect(screen().join("\n")).toContain("> 1. Yes");
    stream.sends("\x1b[B");
    expect(screen().join("\n")).toContain("> 2. No");
    stream.sends("\r");
    const answer = await asking;
    expect(answer?.value).toBe("no");
    expect(answer?.label).toBe("No — leave it undone");
    expect(screen().join("\n"), "what was chosen stays on the screen after the block goes away").toContain("→ No — leave it undone");
  });

  it("takes a number as the answer", async () => {
    const asking = choose({ title: "Which one?", choices: [{ label: "main", value: "main" }, { label: "dev", value: "dev" }] });
    stream.sends("2");
    expect((await asking)?.value).toBe("dev");
  });

  it("is a refusal when it is cancelled, never a silent yes", async () => {
    const asking = choose({ title: "Delete notes/a.md?", choices: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] });
    stream.sends("\x1b");
    expect(await asking).toBeNull();
  });

  it("lets the operator type an answer the list did not offer", async () => {
    const asking = choose({
      title: "The agent needs to know something",
      body: ["Which branch should I push?"],
      choices: [{ label: "main", value: "main" }],
      allowType: true,
    });
    stream.sends("release-7\r");
    expect((await asking)?.typed).toBe("release-7");
  });

  it("gives the keys and the screen back to the prompt when it closes", async () => {
    const editor = createLineEditor({ prompt: "> ", palette: PALETTE });
    const reading = editor.read();
    stream.sends("push ");

    const asking = choose({ title: "Push to main?", choices: [{ label: "Yes", value: "yes" }] });
    stream.sends("\r");
    expect((await asking)?.value).toBe("yes");

    stream.sends("it\r");
    expect(await reading).toBe("push it");
    editor.stop();
  });
});
