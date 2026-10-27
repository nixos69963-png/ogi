/**
 * The full-screen UI, built on OpenTUI.
 *
 * Why this file exists: a line UI writes escape codes into a stream and hopes the
 * terminal agrees. Wrapping, the caret, a scrollback that jumps under you, a diff
 * two hundred lines long — that is the hard part, and it was hand-rolled. Here the
 * layout, the text input and the scrolling are someone else's problem; this file
 * decides what goes in which box, how a patch is laid out, and which key means what.
 *
 * Three panes can own the keyboard, and only one at a time:
 *   prompt   the operator is typing
 *   review   a tool is waiting for an answer, with its diff on screen
 *   ask      the model is waiting to be told something
 * A popup — commands or files — can sit on top of the prompt and takes arrows first.
 *
 * Nothing here runs work or grants permission. `session.ts` holds the commands, the
 * loop runs the tools, and a question nobody answers is a refusal.
 */
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { activeMention, createFileIndex } from "#guard/mentions.ts";
import { loadCommands } from "#core/commands.ts";
import { buildTools } from "#tools/index.ts";
import { diffCounts, parsePatch, patchFile, type DiffRow } from "#ui/diff.ts";
import { verbFor } from "#ui/render.ts";
import type { AskOptions, AssistantTurn } from "#core/provider.ts";
import { PALETTE } from "#ui/repl.ts";
import { paletteFilter } from "#ui/input.ts";
import type { AppConfig, ApprovalAnswer, ApprovalRequest, ToolSpec } from "#core/types.ts";
import { createSession, type Session } from "./session.ts";
import type { McpHub } from "#mcp/hub.ts";
import { band, blue, bold, brand, chip, dim, green, paint, plain, red, row, simple, textOf, yellow, type Segment } from "./rows.ts";
import { welcomeBanner } from "./banner.ts";
import { patchRowCount, patchRows, type PatchView } from "./patch.ts";

/** Older rows scroll out for good; this is a working screen, not a log file. */
const MAX_ROWS = 500;
const POPUP_ROWS = 10;
const SPINNER = ["⣋", "⣹", "⣻", "⢼", "⣸", "⣴", "⣦", "⣧", "⣏", "⡏"];
const TICK_MS = 100;

const CHOSEN_GLYPH = "❯";
/** The only separator this screen uses: a hairline, not a frame. */
const HAIRLINE = "─";

const CHOICES: { label: string; value: ApprovalAnswer }[] = [
  { label: "Yes — do it", value: "yes" },
  { label: "Yes, and do not ask again for this tool this run", value: "always" },
  { label: "No — leave it undone", value: "no" },
];

const REVIEW_FOOTER = "esc says no · enter runs the choice · y / a / n · v unified|split · PgUp PgDn scroll";
const ASK_FOOTER = "↑↓ choose · Enter send · type to answer · Esc stops the run";

/** The panel's own rows, apart from anything about a patch: hairline, title, the
 *  one summary line, the question, the choices, two gaps and the keys. */
const REVIEW_FIXED = 7 + CHOICES.length;
/** What a patch puts above the lines themselves: ` │`, the count line, and the blank
 *  that hands the floor to the diff. */
const REVIEW_PATCH_HEADER = 3;
/** A long patch scrolls; it never eats the whole screen. */
const REVIEW_DIFF_MAX = 20;

interface Review {
  request: ApprovalRequest;
  resolve: (answer: ApprovalAnswer) => void;
  chosen: number;
  view: PatchView;
  /** The patch as rows, read once: every repaint draws the same rows it was given. */
  rows: DiffRow[];
  /** The file the patch says it changes, taken from the patch itself. */
  file: string | null;
}

interface Ask {
  question: string;
  options: string[];
  resolve: (answer: string | null) => void;
  chosen: number;
}

interface PopupItem {
  label: string;
  detail: string;
  /** What the prompt becomes if this row is taken. */
  insert: string;
  /** A command that needs no argument can be run by Enter; the rest only complete. */
  runnable: boolean;
}

interface Popup {
  kind: "commands" | "files";
  /** Where the `@` token starts, so completion splices in instead of appending. */
  start: number;
  cursor: number;
  items: PopupItem[];
}

export interface AppOptions {
  config: AppConfig;
  tools?: ToolSpec[];
  /** MCP servers already connected by the entry point. */
  mcp?: McpHub;
  showThinking?: boolean;
  /** A scripted provider, so the screen can be proven without spending a token. */
  transport?: (cfg: AppConfig, options: AskOptions) => Promise<AssistantTurn>;
  /** `/exit`, Ctrl+D or the second Ctrl+C. The owner does the teardown. */
  onQuit: () => void;
}

export interface App {
  session: Session;
  /** Repaint after a resize or a mode change. */
  repaint(): void;
  /** Stop the timer and give up the keyboard; does not touch the renderer. */
  destroy(): void;
}

export function buildApp(renderer: CliRenderer, options: AppOptions): App {
  const tools = options.tools ?? buildTools();
  const files = createFileIndex(options.config.workspace);
  let phase = "";
  let since = 0;
  let frame = 0;
  let busy = false;
  let review: Review | null = null;
  let ask: Ask | null = null;
  let popup: Popup | null = null;

  // ---------- the boxes ----------

  const root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    // No terminal scrollback here: a tall panel must be clipped, never allowed to
    // push the prompt off the screen.
    overflow: "hidden",
  });
  renderer.root.add(root);

  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    // The one child allowed to shrink: the panels below hold their own row counts.
    flexShrink: 1,
    minHeight: 2,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    // A thumb in the rule grey, and no track painted behind it.
    verticalScrollbarOptions: { trackOptions: { foregroundColor: "#4d4d4d" } },
  });
  const status = new TextRenderable(renderer, { id: "status", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  // The list of commands or files opens above the box, the way the reference screen does it.
  const popupBox = new BoxRenderable(renderer, { id: "popup", flexDirection: "column", visible: false, flexShrink: 0 });
  const reviewBox = new BoxRenderable(renderer, { id: "review", flexDirection: "column", visible: false, flexShrink: 0, height: REVIEW_FIXED + REVIEW_PATCH_HEADER });
  const askBox = new BoxRenderable(renderer, { id: "ask", flexDirection: "column", visible: false, flexShrink: 0 });
  // Typing happens between two hairlines: nothing else on the screen is framed.
  const overbar = new TextRenderable(renderer, { id: "overbar", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  const promptRow = new BoxRenderable(renderer, { id: "prompt-row", flexDirection: "row", height: 1, flexShrink: 0 });
  const promptCaret = new TextRenderable(renderer, { id: "caret", content: "", height: 1 });
  const prompt = new InputRenderable(renderer, {
    id: "prompt-input",
    flexGrow: 1,
    placeholder: "a task, or / for commands, or @ to hand over a file",
  });
  const underbar = new TextRenderable(renderer, { id: "underbar", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  const foot = new TextRenderable(renderer, { id: "foot", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });

  // A pane takes the box's place at the bottom of the screen, so it brings its own
  // top hairline and the box's two rules step aside — one screen, one set of lines.
  root.add(transcript);
  root.add(status);
  root.add(popupBox);
  root.add(overbar);
  root.add(promptRow);
  root.add(underbar);
  root.add(reviewBox);
  root.add(askBox);
  root.add(foot);
  promptRow.add(promptCaret);
  promptRow.add(prompt);

  const reviewDivider = new TextRenderable(renderer, { id: "review-line", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  const askDivider = new TextRenderable(renderer, { id: "ask-line", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });

  /** Everything that draws a line across the whole screen; the width is the terminal's, not ours. */
  function drawHairlines(): void {
    const line = paint(simple(HAIRLINE.repeat(Math.max(1, renderer.width)), "rule"));
    overbar.content = line;
    underbar.content = line;
    reviewDivider.content = line;
    askDivider.content = line;
  }

  const reviewTitle = new TextRenderable(renderer, { id: "review-title", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  const reviewConnector = new TextRenderable(renderer, { id: "review-connector", content: paint(row(dim(" │"))), height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  const reviewCounts = new TextRenderable(renderer, { id: "review-counts", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  const reviewSummary = new TextRenderable(renderer, { id: "review-summary", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  const reviewQuestion = new TextRenderable(renderer, { id: "review-question", content: paint(row(plain("Do you want to proceed?"))), height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  const reviewRisk = new TextRenderable(renderer, { id: "review-risk", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  // The blank that hands the floor from the header block to the patch itself.
  const reviewLead = new TextRenderable(renderer, { id: "review-lead", content: "", height: 1, flexShrink: 0 });
  const reviewScroll = new ScrollBoxRenderable(renderer, {
    id: "review-scroll",
    flexShrink: 0,
    scrollY: true,
    verticalScrollbarOptions: { trackOptions: { foregroundColor: "#4d4d4d" } },
  });
  const reviewChoices = new BoxRenderable(renderer, { id: "review-choices", flexDirection: "column", flexShrink: 0, height: CHOICES.length });
  const reviewFooter = new TextRenderable(renderer, {
    id: "review-footer",
    content: paint(row(dim(REVIEW_FOOTER))),
    height: 1,
    truncate: true,
    wrapMode: "none",
    flexShrink: 0,
  });
  // The reference panel breathes: a row of nothing between the patch and the question,
  // and another before the keys.
  const reviewGap = new TextRenderable(renderer, { id: "review-gap", content: "", height: 1, flexShrink: 0 });
  const reviewGap2 = new TextRenderable(renderer, { id: "review-gap-2", content: "", height: 1, flexShrink: 0 });
  reviewBox.add(reviewDivider);
  reviewBox.add(reviewTitle);
  reviewBox.add(reviewConnector);
  reviewBox.add(reviewCounts);
  reviewBox.add(reviewSummary);
  reviewBox.add(reviewRisk);
  reviewBox.add(reviewLead);
  reviewBox.add(reviewScroll);
  reviewBox.add(reviewGap);
  reviewBox.add(reviewQuestion);
  reviewBox.add(reviewChoices);
  reviewBox.add(reviewGap2);
  reviewBox.add(reviewFooter);

  const askTitle = new TextRenderable(renderer, { id: "ask-title", content: paint(row(chip(" ? question "), dim(" the agent needs to know something"))), height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  const askQuestion = new TextRenderable(renderer, { id: "ask-question", content: "", height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  const askChoices = new BoxRenderable(renderer, { id: "ask-choices", flexDirection: "column", flexShrink: 0 });
  const askRow = new BoxRenderable(renderer, { id: "ask-row", flexDirection: "row", height: 1, flexShrink: 0 });
  const askLabel = new TextRenderable(renderer, { id: "ask-label", content: paint(row(dim("answer · "), blue(`${CHOSEN_GLYPH} `))), height: 1 });
  const answer = new InputRenderable(renderer, { id: "answer-input", flexGrow: 1, placeholder: "type an answer, then Enter" });
  const askFooter = new TextRenderable(renderer, { id: "ask-footer", content: paint(row(dim(ASK_FOOTER))), height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
  askRow.add(askLabel);
  askRow.add(answer);
  askBox.add(askDivider);
  askBox.add(askTitle);
  askBox.add(askQuestion);
  askBox.add(askChoices);
  askBox.add(askRow);
  askBox.add(askFooter);

  let askChoiceLines: TextRenderable[] = [];
  let reviewChoiceLines: TextRenderable[] = [];
  let popupLines: TextRenderable[] = [];

  // ---------- the transcript ----------

  const lines: TextRenderable[] = [];
  let lineId = 0;
  /** The text of the last row on screen — a blank is only ever asked for once. */
  let lastText = "";

  function addRow(parts: Segment[]): void {
    const text = textOf(parts);
    // Two blank rows in a row is one blank row too many, whoever asked for them.
    if (!text && !lastText) return;
    lastText = text;
    const line = new TextRenderable(renderer, {
      id: `line-${(lineId += 1)}`,
      content: paint(parts),
      wrapMode: "word",
      height: "auto",
      minHeight: 1,
    });
    transcript.add(line);
    lines.push(line);
    while (lines.length > MAX_ROWS) {
      const old = lines.shift();
      if (old) transcript.remove(old);
    }
  }

  /** One blank row between blocks. Only a block start asks for it, so a `⎿` line
   *  added straight after its `●` stays flush with it. */
  function gap(): void {
    if (!lastText) return;
    addRow([]);
  }

  function clearTranscript(): void {
    for (const line of lines.splice(0, lines.length)) transcript.remove(line);
    lastText = "";
  }

  /** A line the operator typed, on its own band, so their words are never mistaken for the agent's. */
  function echo(text: string): void {
    gap();
    addRow(row(band(`${CHOSEN_GLYPH} `, "grey"), band(text, "bold")));
  }

  /** The live line: what it is doing, for how long, and how to stop it — with where
   *  the session stands pushed to the right end of the same row. */
  let statusDrawn = "";

  function drawStatus(): void {
    const state = session.state();
    const right = row(
      dim(`${state.budget}  ·  ${state.messages} messages  ·  ~${state.contextTokens} tokens`),
      ...(state.queued ? [dim(`  ·  ${state.queued} queued`)] : []),
      ...(state.turns ? [dim(`  ·  last run ${state.turns} turns ${state.tokens} tokens`)] : []),
    );
    if (review || ask) {
      statusDrawn = "";
      status.content = "";
      return;
    }
    const left = phase
      ? row(brand(SPINNER[frame % SPINNER.length]!), plain(` ${phase}`), dim(` · ${((Date.now() - since) / 1000).toFixed(1)}s · Ctrl+C stops`))
      : row(dim(" "));
    const text = `${textOf(left)}|${textOf(right)}`;
    if (text !== statusDrawn) {
      statusDrawn = text;
      status.content = paint(spread(left, right));
    }
    if (phase) frame += 1;
  }

  function setStatus(text: string): void {
    if (text === phase) return;
    phase = text;
    since = Date.now();
    if (!text) frame = 0;
    drawStatus();
  }

  /** Two clusters pushed to opposite ends of the row, the way the reference screen does it. */
  function spread(left: Segment[], right: Segment[]): Segment[] {
    const pad = Math.max(1, renderer.width - textOf(left).length - textOf(right).length);
    return row(left, dim(" ".repeat(pad)), right);
  }

  /** Under the box: the tier the keyboard is in, and the command that changes it. */
  function drawFoot(): void {
    const state = session.state();
    const tier = state.config.approvalLevel;
    const mark =
      tier === "ask" ? yellow("▸▸ writes ask") : tier === "auto" ? green("▸▸ auto — routine writes run") : red("▸▸ full access — writes run unasked");
    foot.content = paint(row(mark, dim(" (/approve ask|auto|full · outward and the system always ask)")));
  }

  function refresh(): void {
    drawFoot();
    drawStatus();
    drawHairlines();
  }

  const timer = setInterval(drawStatus, TICK_MS);

  // A smaller terminal takes rows away; the panels re-claim theirs by arithmetic.
  function onResize(): void {
    // The pane redraws rather than only relayouts: a split patch is measured in columns.
    if (review) drawReview();
    if (ask) drawAskChoices();
    if (popup) drawPopup();
    repaint();
  }
  renderer.on("resize", onResize);

  // ---------- the popup: / commands and @ files ----------

  /** The built-in palette plus the operator's own files, cached per workspace. */
  let paletteCache: { workspace: string; entries: { command: string; description: string }[] } | null = null;
  function paletteFor(workspace: string): { command: string; description: string }[] {
    if (paletteCache?.workspace === workspace) return paletteCache.entries;
    const entries = PALETTE.concat(
      loadCommands(workspace).map((command) => ({ command: `/${command.name}`, description: `${command.description} · ${command.scope}` })),
    );
    paletteCache = { workspace, entries };
    return entries;
  }

  function closePopup(): void {
    popup = null;
    popupBox.visible = false;
    for (const line of popupLines) popupBox.remove(line);
    popupLines = [];
  }

  function syncPopup(): void {
    const value = prompt.value;
    const mention = activeMention(value, prompt.cursorOffset);
    let next: Popup | null = null;
    if (mention) {
      const items: PopupItem[] = files.complete(mention.query, POPUP_ROWS).map((found) => ({
        label: found,
        detail: "",
        insert: found,
        runnable: false,
      }));
      next = items.length ? { kind: "files", start: mention.start, cursor: 0, items } : null;
    } else if (value.startsWith("/") && !value.includes(" ")) {
      const items: PopupItem[] = paletteFilter(paletteFor(session.state().config.workspace), value).map((entry) => ({
        label: entry.command,
        detail: entry.description,
        insert: entry.command,
        runnable: !entry.command.includes("<"),
      }));
      next = items.length ? { kind: "commands", start: 0, cursor: 0, items } : null;
    }
    if (!next) {
      closePopup();
      return;
    }
    const same = popup && popup.kind === next.kind && popup.items.length === next.items.length && popup.items.every((item, i) => item.label === next.items[i]?.label);
    popup = same ? { ...next, cursor: Math.min(popup?.cursor ?? 0, Math.max(0, next.items.length - 1)) } : next;
    drawPopup();
  }

  function drawPopup(): void {
    if (!popup) return;
    drawHairlines();
    for (const line of popupLines) popupBox.remove(line);
    popupLines = [];
    const room = Math.max(20, renderer.width - 24);
    const shown = popup.items;
    const nameWidth = Math.min(24, Math.max(...shown.map((item) => item.label.length)) + 2);
    shown.forEach((item, index) => {
      const on = index === popup?.cursor;
      const label = item.label.padEnd(nameWidth);
      // Two columns, no block behind either: the pointer picks the row, colour picks nothing.
      const parts = row(on ? blue(`${CHOSEN_GLYPH} `) : plain("  "), on ? blue(label) : plain(label), item.detail ? dim(` ${item.detail.slice(0, room)}`) : null);
      const line = new TextRenderable(renderer, { id: `popup-${index}`, content: paint(parts), height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
      popupBox.add(line);
      popupLines.push(line);
    });
    const hint = popup.kind === "files" ? "↑↓ choose · Tab or Enter insert · Esc hide" : "↑↓ choose · Tab insert · Enter run · Esc hide";
    const footer = new TextRenderable(renderer, { id: "popup-foot", content: paint(row(dim(`  ${hint} · ${shown.length} shown`))), height: 1, truncate: true, wrapMode: "none", flexShrink: 0 });
    popupBox.add(footer);
    popupLines.push(footer);
    popupBox.height = shown.length + 1;
    popupBox.visible = true;
  }

  /** Take the highlighted row: a file splices into the `@` token, a command fills the line. */
  function takePopup(run: boolean): void {
    if (!popup) return;
    const item = popup.items[popup.cursor];
    if (!item) return;
    const kind = popup.kind;
    const start = popup.start;
    if (kind === "files") {
      const value = prompt.value;
      const cursor = prompt.cursorOffset;
      const before = value.slice(0, start);
      const after = value.slice(cursor);
      closePopup();
      prompt.setText(`${before}@${item.insert} ${after}`);
      prompt.cursorOffset = before.length + item.insert.length + 2;
      syncPopup();
      return;
    }
    closePopup();
    prompt.setText(`${item.insert}${item.runnable ? "" : " "}`);
    if (run && item.runnable) {
      const text = prompt.value;
      prompt.setText("");
      remember(text);
      echo(text);
      session.submit(text);
      return;
    }
    syncPopup();
  }

  // ---------- review: the approval with its diff ----------

  let patchLines: TextRenderable[] = [];

  /** The patch in the format the reference agent uses: a gutter of line numbers, a
   *  marker, and the changed line on a ground that says which way it goes. */
  function drawPatch(): void {
    for (const line of patchLines) reviewScroll.remove(line);
    patchLines = [];
    if (!review) return;
    patchRows(review.rows, review.view, renderer.width).forEach((parts, index) => {
      const line = new TextRenderable(renderer, {
        id: `patch-${index}`,
        content: paint(parts),
        height: 1,
        truncate: true,
        wrapMode: "none",
        flexShrink: 0,
      });
      reviewScroll.add(line);
      patchLines.push(line);
    });
  }

  /** Row counts are arithmetic here, not negotiation: only the transcript gives way. */
  function layoutReview(): void {
    const patch = Boolean(review?.rows.length);
    const risk = Boolean(review?.request.risky || review?.request.hard);
    reviewRisk.visible = risk;
    reviewConnector.visible = patch;
    reviewCounts.visible = patch;
    reviewLead.visible = patch;
    reviewSummary.visible = !patch;
    reviewScroll.visible = patch;
    const chrome = REVIEW_FIXED + (patch ? REVIEW_PATCH_HEADER : 1) + (risk ? 1 : 0);
    // Five rows stay outside the pane: status, the prompt box's own lines and the foot.
    const room = Math.max(2, renderer.height - chrome - 6);
    const shown = review ? patchRowCount(review.rows, review.view) : 0;
    const diff = Math.min(room, Math.max(2, Math.min(REVIEW_DIFF_MAX, shown)));
    reviewScroll.height = patch ? diff : 0;
    reviewBox.height = chrome + (patch ? diff : 0);
  }

  function openReview(request: ApprovalRequest, resolve: (answer: ApprovalAnswer) => void): void {
    const rows = parsePatch(request.patch ?? "");
    review = {
      request,
      resolve,
      chosen: 2,
      view: "unified",
      rows,
      file: request.patch ? patchFile(request.patch) : null,
    };
    closePopup();
    promptRow.visible = false;
    overbar.visible = false;
    underbar.visible = false;
    askBox.visible = false;
    reviewBox.visible = true;
    drawReview();
    prompt.blur();
  }

  /** `2 additions`, `1 removal` — the reference counts out loud, and so does this. */
  function counted(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  }

  function drawReview(): void {
    if (!review) return;
    const request = review.request;
    const verb = verbFor(request.tool).label;
    layoutReview();
    drawHairlines();
    reviewTitle.content = paint(
      row(
        green("● "),
        bold(review.file ? `${verb} [${review.file}]` : verb),
        dim(`  ${request.tool} · ${request.effect}`),
        review.file ? dim(`  ${review.view}`) : null,
      ),
    );
    reviewSummary.content = paint(row(dim("  "), plain(request.summary)));
    // A gate says why it is a gate; a caution only says it is worth a second look.
    const caution = request.hard ?? request.risky;
    if (caution) {
      reviewRisk.content = paint(
        row(dim(request.hard ? "  this is asked at every level: " : "  caution: "), yellow(caution)),
      );
    }
    if (review.rows.length) {
      const { added, removed } = diffCounts(review.rows);
      // Nothing is written yet, so the line says what the yes would do, not what it did.
      reviewCounts.content = paint(
        row(
          dim(" └── will change "),
          plain(review.file ?? "the file"),
          dim(" with "),
          green(counted(added, "addition")),
          dim(" and "),
          red(counted(removed, "removal")),
        ),
      );
    }
    drawPatch();

    for (const line of reviewChoiceLines) reviewChoices.remove(line);
    reviewChoiceLines = [];
    CHOICES.forEach((choice, index) => {
      const on = index === review?.chosen;
      // The cursor is a glyph in the corner and the chosen word takes the pointer colour.
      const parts = row(on ? blue(CHOSEN_GLYPH) : plain(" "), plain(" "), dim(`${index + 1}. `), on ? blue(choice.label) : plain(choice.label));
      const line = new TextRenderable(renderer, {
        id: `choice-${index}`,
        content: paint(parts),
        height: 1,
        truncate: true,
        wrapMode: "none",
        flexShrink: 0,
      });
      reviewChoices.add(line);
      reviewChoiceLines.push(line);
    });
  }

  function answerReview(value: ApprovalAnswer): void {
    if (!review) return;
    const resolve = review.resolve;
    review = null;
    reviewBox.visible = false;
    promptRow.visible = true;
    overbar.visible = true;
    underbar.visible = true;
    addRow(
      row(
        dim("  ⎿  "),
        value === "no" ? yellow("no") : green(value),
        dim(value === "no" ? " — left undone" : value === "always" ? " — this tool, this run" : ""),
      ),
    );
    prompt.focus();
    setStatus(phase);
    resolve(value);
  }

  // ---------- ask: the model's question, on screen ----------

  function drawAskChoices(): void {
    if (!ask) return;
    for (const line of askChoiceLines) askChoices.remove(line);
    askChoiceLines = [];
    askChoices.height = ask.options.length;
    askBox.height = 6 + ask.options.length;
    drawHairlines();
    ask.options.forEach((option, index) => {
      const on = index === ask?.chosen;
      const line = new TextRenderable(renderer, {
        id: `ask-${index}`,
        content: paint(row(on ? blue(CHOSEN_GLYPH) : plain(" "), plain(" "), dim(`${index + 1}. `), on ? blue(option) : plain(option))),
        height: 1,
        truncate: true,
        wrapMode: "none",
        flexShrink: 0,
      });
      askChoices.add(line);
      askChoiceLines.push(line);
    });
  }

  function openAsk(question: string, list: string[], resolve: (value: string | null) => void): void {
    ask = { question, options: list, resolve, chosen: 0 };
    closePopup();
    promptRow.visible = false;
    overbar.visible = false;
    underbar.visible = false;
    reviewBox.visible = false;
    askQuestion.content = paint(row(bold(question)));
    drawAskChoices();
    askBox.visible = true;
    prompt.blur();
    answer.focus();
    setStatus(phase);
  }

  function answerAsk(value: string | null): void {
    if (!ask) return;
    const resolve = ask.resolve;
    ask = null;
    askBox.visible = false;
    answer.setText("");
    promptRow.visible = true;
    overbar.visible = true;
    underbar.visible = true;
    addRow(value ? row(dim("  ⎿  "), plain(value)) : row(dim("  ⎿  no answer — the run stops rather than guesses")));
    prompt.focus();
    resolve(value);
  }

  // ---------- keys ----------

  const history: string[] = [];
  let historyAt = -1;

  function remember(text: string): void {
    if (!text) return;
    if (history[history.length - 1] !== text) history.push(text);
    historyAt = -1;
  }

  function recall(direction: -1 | 1): void {
    if (!history.length) return;
    historyAt = historyAt === -1 ? (direction === -1 ? history.length - 1 : -1) : Math.max(-1, Math.min(history.length - 1, historyAt + direction));
    prompt.setText(historyAt === -1 ? "" : history[historyAt]!);
  }

  function onKey(key: KeyEvent): void {
    if (key.eventType === "release") return;

    // The stop button works in every mode, including while a pane is asking.
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      session.interrupt();
      return;
    }

    // Whoever owns the screen owns the keys; nothing leaks into the prompt behind it.
    if (review) {
      key.preventDefault();
      key.stopPropagation();
      reviewKeys(key);
      return;
    }
    if (ask) {
      if (askKeys(key)) {
        key.preventDefault();
        key.stopPropagation();
      }
      return;
    }

    if (key.ctrl && key.name === "d") {
      key.preventDefault();
      options.onQuit();
      return;
    }
    if (key.ctrl && key.name === "l") {
      key.preventDefault();
      clearTranscript();
      return;
    }

    if (popup && popupKeys(key)) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (!popup && (key.name === "up" || key.name === "down")) {
      key.preventDefault();
      key.stopPropagation();
      recall(key.name === "up" ? -1 : 1);
    }
  }

  function popupKeys(key: KeyEvent): boolean {
    if (!popup) return false;
    const size = popup.items.length;
    if (!size) return false;
    if (key.name === "up" || key.name === "pageup") {
      popup.cursor = key.name === "pageup" ? Math.max(0, popup.cursor - 5) : (popup.cursor + size - 1) % size;
      drawPopup();
      return true;
    }
    if (key.name === "down" || key.name === "pagedown") {
      popup.cursor = key.name === "pagedown" ? Math.min(size - 1, popup.cursor + 5) : (popup.cursor + 1) % size;
      drawPopup();
      return true;
    }
    if (key.name === "tab") {
      takePopup(false);
      return true;
    }
    if (key.name === "return") {
      takePopup(true);
      return true;
    }
    if (key.name === "escape") {
      closePopup();
      return true;
    }
    return false;
  }

  function reviewKeys(key: KeyEvent): void {
    if (!review) return;
    const size = CHOICES.length;
    if (key.name === "up" || key.name === "down") {
      review.chosen = (review.chosen + size + (key.name === "up" ? -1 : 1)) % size;
      drawReview();
      return;
    }
    const rows = Math.max(1, reviewScroll.viewport.height - 2);
    if (key.name === "pageup") {
      reviewScroll.scrollTo(Math.max(0, reviewScroll.scrollTop - rows));
      return;
    }
    if (key.name === "pagedown") {
      reviewScroll.scrollTo(reviewScroll.scrollTop + rows);
      return;
    }
    if (key.name === "return") return answerReview(CHOICES[review.chosen]!.value);
    // Closing the pane without saying yes is a no. Silence has never meant permission.
    if (key.name === "escape") return answerReview("no");
    if (key.name === "v") {
      review.view = review.view === "unified" ? "split" : "unified";
      drawReview();
      return;
    }
    if (key.name === "y") return answerReview("yes");
    if (key.name === "a") return answerReview("always");
    if (key.name === "n") return answerReview("no");
    if (key.name === "1") return answerReview("yes");
    if (key.name === "2") return answerReview("always");
    if (key.name === "3") return answerReview("no");
  }

  function askKeys(key: KeyEvent): boolean {
    if (!ask) return false;
    const size = ask.options.length;
    if (size && (key.name === "up" || key.name === "down")) {
      ask.chosen = (ask.chosen + size + (key.name === "up" ? -1 : 1)) % size;
      drawAskChoices();
      return true;
    }
    if (key.name === "return") {
      const typed = answer.value.trim();
      if (typed) answerAsk(typed);
      else if (size) answerAsk(ask.options[ask.chosen] ?? null);
      return true;
    }
    if (key.name === "escape") {
      answerAsk(null);
      return true;
    }
    if (size && /^[1-9]$/.test(key.name)) {
      const index = Number(key.name) - 1;
      if (index < size) answerAsk(ask.options[index]!);
      return true;
    }
    // Anything else is the operator typing an answer; let it reach the input.
    return false;
  }

  renderer.keyInput.on("keypress", onKey);

  prompt.on(InputRenderableEvents.INPUT, () => {
    syncPopup();
  });
  prompt.on(InputRenderableEvents.ENTER, () => {
    const text = prompt.value.trim();
    prompt.setText("");
    closePopup();
    if (!text) return;
    remember(text);
    echo(text);
    session.submit(text);
  });

  // ---------- the brain ----------

  function placeholder(): void {
    prompt.placeholder = busy ? "typing here queues steering for the next turn" : "a task, or / for commands, or @ to hand over a file";
    promptCaret.content = paint(row(busy ? yellow(`${CHOSEN_GLYPH} `) : blue(`${CHOSEN_GLYPH} `)));
  }

  const session = createSession({
    config: options.config,
    tools,
    mcp: options.mcp,
    showThinking: options.showThinking,
    transport: options.transport,
    hooks: {
      row: addRow,
      gap,
      status: setStatus,
      approve: (request) =>
        new Promise<ApprovalAnswer>((resolve) => {
          openReview(request, resolve);
        }),
      ask: (question, list) =>
        new Promise<string | null>((resolve) => {
          openAsk(question, list, resolve);
        }),
      busy: (next) => {
        busy = next;
        placeholder();
        refresh();
      },
      // Stopping must also put down whatever was waiting for an answer.
      interrupted: () => {
        if (review) answerReview("no");
        if (ask) answerAsk(null);
      },
      changed: refresh,
      quit: () => options.onQuit(),
    },
  });

  function repaint(): void {
    refresh();
    renderer.requestRender();
  }

  function destroy(): void {
    clearInterval(timer);
    renderer.off("resize", onResize);
    renderer.keyInput.off("keypress", onKey);
    session.dispose();
  }

  for (const line of welcomeBanner(renderer.width, options.config.model, options.config.workspace)) addRow(line);
  placeholder();
  refresh();
  prompt.focus();

  return { session, repaint, destroy };
}

/** The terminal the full-screen UI needs: a real tty on both ends, and no request not to use it. */
export function tuiPossible(): boolean {
  if (process.env.AGENT_CLASSIC === "1" || process.env.NO_TUI === "1") return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export interface StartOptions {
  config: AppConfig;
  tools?: ToolSpec[];
  mcp?: McpHub;
  task?: string;
  showThinking?: boolean;
  /** A scripted provider, so the screen can be driven from a test. */
  transport?: (cfg: AppConfig, options: AskOptions) => Promise<AssistantTurn>;
  /** Called once the screen is gone and the process may exit. */
  onExit?: () => void;
}

export async function startTui(options: StartOptions): Promise<void> {
  const renderer = await createCliRenderer({
    // Ctrl+C is the operator's stop button, not an exit signal.
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    clearOnShutdown: true,
    useMouse: true,
    autoFocus: true,
    targetFps: 30,
  });
  let app: App | null = null;
  // Resolving only after the screen is gone lets the caller print, clean up, exit.
  await new Promise<void>((resolve) => {
    let closed = false;
    const quit = (): void => {
      if (closed) return;
      closed = true;
      app?.destroy();
      renderer.destroy();
      options.onExit?.();
      resolve();
    };
    app = buildApp(renderer, {
      config: options.config,
      tools: options.tools,
      mcp: options.mcp,
      showThinking: options.showThinking,
      transport: options.transport,
      onQuit: quit,
    });
    if (options.task) app.session.submit(options.task);
  });
}
