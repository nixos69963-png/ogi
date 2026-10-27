/**
 * Browser tools: the agent's hands on a real page.
 *
 * These exist because `web_fetch` deliberately cannot: it has no session, runs no
 * script and fills no form. When a page needs to be *used* rather than read, this
 * is the tool group that does it — driving the Chrome on this machine, in the
 * agent's own profile.
 *
 * Where the safety sits:
 *   - Loading a page is a read, exactly like web_fetch: a GET that changes nothing
 *     on the site. It is still Chrome, in the agent's own logged-out profile.
 *   - Clicking, typing, pressing a key, choosing an option: `outward`. Those act
 *     as you and change what the site holds, so an unattended run is refused and an
 *     attended one asks. Answer "always" once and the rest of the run is yours.
 *   - Passwords: refused outright, by the tool, not by a prompt. The agent never
 *     types into a password field; a person logs into the agent's profile once and
 *     the session is there afterwards.
 *   - Captchas and bot walls: refused. The agent does not solve them and does not
 *     pretend not to be an agent.
 *   - `file:` URLs and machine-local hosts: refused, same guard as web_fetch.
 */
import { clip } from "#core/history.ts";
import { redact } from "#guard/redact.ts";
import type { ToolResult, ToolSpec } from "#core/types.ts";
import { UnsafeUrl, assertSafeUrl } from "./web.ts";
import { bool, err, num, obj, ok, relativeTo, str, tool } from "./define.ts";
import * as cdp from "#browser/cdp.ts";

/** A field that must never receive text from the agent. */
const CREDENTIAL_FIELD = /pass|pwd|secret|otp|pin|cvv|card|account\s*number|ssn/i;
/** The agent does not solve these, and says so. */
const CHALLENGE_MARK = /captcha|are you a (human|robot)|verify (that )?you|human verification|challenge\/turnstile/i;
/** Words that mean the click spends money or speaks in public. */
const OUTWARD_HEAVY = /pay|buy|purchase|checkout|order|send|publish|post|delete|remove|cancel|withdraw|transfer|subscribe|accept terms/i;

const MAX_INDEX_LINES = 140;

async function attach(ctx: Parameters<ToolSpec["execute"]>[1]): Promise<void> {
  await cdp.ensureBrowser(ctx.workspace);
}

function browserFailure(cause: unknown): ToolResult {
  const error = cause as Error;
  if (error instanceof UnsafeUrl) return err(`Refused: ${error.message}`);
  if (error instanceof cdp.BrowserError) return err(`Browser: ${error.message}`);
  return err(`Browser call failed: ${error.message}`);
}

function stateText(state: cdp.Snapshot): string {
  const shown = state.lines.slice(0, MAX_INDEX_LINES);
  const header = [
    `${state.url}`,
    `title: ${state.title || "(no title)"} · ready: ${state.ready} · ${state.count} clickable`,
    `scroll y=${state.scroll.y} of ${state.scroll.height} · viewport ${state.viewport.width}x${state.viewport.height}`,
  ].join("\n");
  const tail =
    state.lines.length > shown.length
      ? `\n… ${state.lines.length - shown.length} more elements. browser_extract reads the text; browser_scroll brings the rest into view.`
      : "";
  return `${header}\n${shown.join("\n")}${tail}\n\nNumbers die when the page changes: re-read browser_state before clicking again.`;
}

/** What a click or a type is about to do, in the approval line. */
function targetNote(element: cdp.IndexedElement): string {
  return `${element.tag}${element.type ? `:${element.type}` : ""} "${element.label || element.name || element.href || "no label"}"`;
}

/** The one thing no answer to the approval prompt unlocks. */
function refusal(element: cdp.IndexedElement): string | null {
  const haystack = `${element.name} ${element.type} ${element.label} ${element.role}`;
  if (CHALLENGE_MARK.test(haystack) || CHALLENGE_MARK.test(element.href)) {
    return "That looks like a human-verification control. The agent does not solve captchas or get around a site's protections — do that step in the window yourself, then tell it to continue.";
  }
  return null;
}

const open = tool({
  name: "browser_open",
  description:
    "Start Chrome (the installed one, in the agent's own profile) if it is not running and load a URL in the agent's tab. " +
    "Returns the indexed page. Loading is a read — a GET that changes nothing on the site — but it is Chrome doing it, " +
    "in a profile that holds no log-ins. Acting on what comes back is browser_click/browser_type, and those do ask. " +
    "http/https only — machine-local and private addresses are refused, and a local file has read_file.",
  effect: "read",
  inputSchema: obj({ url: str("Full https:// URL to open.") }, ["url"]),
  describe: (input) => ({ summary: `open ${String(input.url ?? "?")} in the browser` }),
  async execute(input, ctx): Promise<ToolResult> {
    const raw = String(input.url ?? "").trim();
    if (!raw) return err("browser_open needs a url.");
    try {
      const url = await assertSafeUrl(raw);
      await attach(ctx);
      const state = await cdp.navigate(url.toString());
      const challenge = CHALLENGE_MARK.test(`${state.title} ${state.url}`)
        ? "\nnote: this page presents itself as a human-verification challenge. The agent will not attempt to pass one."
        : "";
      return ok(`${stateText(state)}${challenge}`, { url: state.url, clickable: state.count });
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const state = tool({
  name: "browser_state",
  description:
    "Read the current page as a numbered list of what can be acted on: links, buttons, fields, their labels and whether they are offscreen. " +
    "Call it after anything that changes the page — the numbers only exist until the next render.",
  effect: "read",
  inputSchema: obj({}),
  describe: () => ({ summary: "read the indexed page" }),
  async execute(_input, ctx): Promise<ToolResult> {
    try {
      await attach(ctx);
      const page = await cdp.snapshot();
      return ok(stateText(page), { url: page.url, clickable: page.count });
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const click = tool({
  name: "browser_click",
  description:
    "Click the element with this index, as a real mouse click at its centre. Use the index from browser_state, never a guessed selector. " +
    "Refused for human-verification controls. A click on something that pays, sends, publishes or deletes is called out before it happens.",
  effect: "outward",
  inputSchema: obj({ index: num("The [n] from browser_state.") }, ["index"]),
  describe: (input) => ({ summary: `click element ${String(input.index ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    const index = Math.trunc(Number(input.index ?? NaN));
    if (!Number.isFinite(index) || index < 1) return err("browser_click needs an index from browser_state, e.g. 12.");
    try {
      await attach(ctx);
      const element = await cdp.describeIndex(index);
      if (!element) {
        const page = await cdp.snapshot();
        return err(`Nothing carries index ${index}. The page changed or the number is out of range — ${page.count} clickable now. Call browser_state.`);
      }
      const blocked = refusal(element);
      if (blocked) return err(blocked);
      if (element.disabled) return err(`"${element.label}" is disabled on the page, so clicking it does nothing.`);
      const heavy = OUTWARD_HEAVY.test(`${element.label} ${element.name} ${element.href} ${element.type}`);
      const result = await cdp.click(index);
      const after = await cdp.snapshot();
      const page = CHALLENGE_MARK.test(`${after.title} ${after.url}`) ? "\nnote: this is a human-verification page. The agent stops here; a person passes it." : "";
      return ok(
        `${result.moved ? "navigated" : `clicked ${targetNote(element)}${heavy ? " (this looks like an outward effect — check the result)" : ""}`}\n${stateText(after)}${page}`,
        { url: after.url, clickable: after.count, navigated: result.moved, heavy },
      );
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const type = tool({
  name: "browser_type",
  description:
    "Put text into the field with this index: focus it, clear it, insert the text the way typing does (so frameworks see it). " +
    "Passwords, one-time codes and card numbers are refused — the agent never handles a credential; a person fills that field.",
  effect: "outward",
  inputSchema: obj(
    {
      index: num("The [n] from browser_state."),
      text: str("The exact text to put in. Nothing is added to it."),
      submit: bool("Press Enter afterwards (for a search box). Default false."),
    },
    ["index", "text"],
  ),
  describe: (input) => ({ summary: `type into element ${String(input.index ?? "?")}: ${clip(String(input.text ?? ""), 60)}` }),
  async execute(input, ctx): Promise<ToolResult> {
    const index = Math.trunc(Number(input.index ?? NaN));
    const text = String(input.text ?? "");
    if (!Number.isFinite(index) || index < 1) return err("browser_type needs an index from browser_state.");
    if (!text) return err("browser_type needs the text to put in.");
    try {
      await attach(ctx);
      const element = await cdp.describeIndex(index);
      if (!element) return err(`Nothing carries index ${index} right now. Call browser_state and use a number from that reading.`);
      const blocked = refusal(element);
      if (blocked) return err(blocked);
      const credential = element.type === "password" || CREDENTIAL_FIELD.test(`${element.name} ${element.label} ${element.type}`);
      if (credential) {
        return err(
          `That field looks like a credential ("${targetNote(element)}"). The agent does not type passwords, codes or card numbers — they would end up in its transcript and log. ` +
            "A person types this one in the window that is open, then the agent continues.",
        );
      }
      const focused = await cdp.typeText(index, text, Boolean(input.submit));
      const after = await cdp.snapshot();
      return ok(`typed ${text.length} chars into ${targetNote(element)}${input.submit ? " and pressed Enter" : ""} (focus: ${focused})\n${stateText(after)}`, {
        url: after.url,
        focused,
      });
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const press = tool({
  name: "browser_press",
  description: "Send one key to whatever has focus: Enter, Tab, Escape, Backspace, an arrow, or a single character.",
  effect: "outward",
  inputSchema: obj({ key: str("Named key (Enter, Tab, Escape, PageDown…) or one character.") }, ["key"]),
  describe: (input) => ({ summary: `press ${String(input.key ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    const key = String(input.key ?? "").trim();
    if (!key) return err("browser_press needs a key.");
    try {
      await attach(ctx);
      await cdp.pressKey(key);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = await cdp.snapshot();
      return ok(`pressed ${key}\n${stateText(after)}`, { url: after.url });
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const choose = tool({
  name: "browser_select",
  description: "Choose an option in a dropdown (or tick a checkbox) by its index. The option is matched by value or by its visible text.",
  effect: "outward",
  inputSchema: obj({ index: num("The [n] from browser_state."), option: str("Option value or the text to look for.") }, ["index", "option"]),
  describe: (input) => ({ summary: `choose "${String(input.option ?? "?")}" on element ${String(input.index ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    const index = Math.trunc(Number(input.index ?? NaN));
    if (!Number.isFinite(index) || index < 1) return err("browser_select needs an index from browser_state.");
    try {
      await attach(ctx);
      const element = await cdp.describeIndex(index);
      if (!element) return err(`Nothing carries index ${index}. Call browser_state first.`);
      const blocked = refusal(element);
      if (blocked) return err(blocked);
      const result = await cdp.selectOption(index, String(input.option ?? ""));
      const after = await cdp.snapshot();
      return ok(`${result} on ${targetNote(element)}\n${stateText(after)}`, { url: after.url });
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const scroll = tool({
  name: "browser_scroll",
  description: "Scroll the page. Everything below the fold is [offscreen] in browser_state until you bring it in.",
  effect: "read",
  inputSchema: obj({
    direction: str("down or up.", { enum: ["down", "up"] }),
    amount: num("Pixels; default is one viewport height."),
  }),
  describe: (input) => ({ summary: `scroll ${String(input.direction ?? "down")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    try {
      await attach(ctx);
      const bounds = await cdp.pageBounds();
      const amount = Number(input.amount ?? bounds.height * 0.9) || 600;
      const where = await cdp.scroll(input.direction === "up" ? "up" : "down", amount);
      const after = await cdp.snapshot();
      return ok(`scroll y=${where.y} of ${where.height}\n${stateText(after)}`, { y: where.y, url: after.url });
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const extract = tool({
  name: "browser_extract",
  description:
    "The page as readable text — what a person sees, not the HTML. Use it to answer something from the page; use browser_state to act on it. " +
    "Credential-looking strings are masked before this leaves the browser.",
  effect: "read",
  inputSchema: obj({ max_chars: num("Default and maximum follow the observe cap; ask for less for a long page.") }),
  describe: () => ({ summary: "read the page text" }),
  async execute(input, ctx): Promise<ToolResult> {
    try {
      await attach(ctx);
      const wanted = Number(input.max_chars ?? ctx.config.maxObserveChars) || ctx.config.maxObserveChars;
      const page = await cdp.pageText(Math.min(200_000, Math.max(2_000, wanted)));
      const cleaned = redact(page.text);
      return ok(`${page.url}\n${page.title ? `title: ${page.title}\n` : ""}${cleaned.hits.length ? "note: credential-looking strings were masked\n" : ""}${clip(cleaned.text, wanted)}`, {
        url: page.url,
        chars: cleaned.text.length,
      });
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const shot = tool({
  name: "browser_screenshot",
  description:
    "Take a picture of the page into .agent/shots/ and hand back the path. With labels=true each clickable gets its number drawn on it, so a picture and browser_state agree. " +
    "Only take one when the text is not enough — layout, a chart, a page you cannot read.",
  effect: "compute",
  inputSchema: obj({ labels: bool("Draw the index numbers first. Default false.") }),
  describe: () => ({ summary: "screenshot the page" }),
  async execute(input, ctx): Promise<ToolResult> {
    try {
      await attach(ctx);
      const file = await cdp.screenshot(ctx.workspace, Boolean(input.labels));
      return ok(`screenshot: ${relativeTo(ctx, file.file)} (${(file.bytes / 1024).toFixed(0)} KB)`, file);
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const tabs = tool({
  name: "browser_tab",
  description:
    "Manage tabs: list them, open a new one (pass a url), switch to one (pass a target starting with the id), or close one. " +
    "The agent keeps one tab per task; open a second only when you need two pages side by side.",
  effect: "read",
  inputSchema: obj({
    action: str("What to do.", { enum: ["list", "new", "switch", "close"] }),
    url: str("For action=new."),
    target: str("For switch/close: the first characters of the target id from list."),
  }, ["action"]),
  describe: (input) => {
    const action = String(input.action ?? "list");
    return { summary: `tab ${action}${input.url ? ` ${String(input.url)}` : ""}${input.target ? ` ${String(input.target)}` : ""}` };
  },
  async execute(input, ctx): Promise<ToolResult> {
    const action = String(input.action ?? "list");
    try {
      await attach(ctx);
      if (action === "new") {
        const raw = String(input.url ?? "about:blank");
        const url = raw === "about:blank" ? raw : (await assertSafeUrl(raw)).toString();
        const page = await cdp.newTab(url);
        return ok(`new tab opened\n${stateText(page)}`, { url: page.url });
      }
      const list = await cdp.listTabs();
      if (action === "list") {
        return ok(list.map((t) => `${t.active ? "▸" : " "} ${t.targetId} ${t.title || "(no title)"} — ${t.url}`).join("\n") || "No page tabs.", { tabs: list });
      }
      const needle = String(input.target ?? "").trim();
      const match = list.find((t) => t.targetId === needle || t.targetId.startsWith(needle) || t.url === needle);
      if (!match) {
        return err(`No tab matches "${needle}". Open ones: ${list.map((t) => `${t.targetId} (${t.url})`).join(", ") || "none"}.`);
      }
      if (action === "close") {
        await cdp.closeTab(match.targetId);
        const after = await cdp.snapshot();
        return ok(`closed ${match.targetId}\n${stateText(after)}`, { url: after.url });
      }
      const page = await cdp.switchTab(match.targetId);
      return ok(`switched to ${match.targetId}\n${stateText(page)}`, { url: page.url });
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const history = tool({
  name: "browser_history",
  description: "Go back, go forward, or reload the current page. Returns the indexed page afterwards.",
  effect: "read",
  inputSchema: obj({ step: str("Which way.", { enum: ["back", "forward", "reload"] }) }, ["step"]),
  describe: (input) => ({ summary: `browser ${String(input.step ?? "back")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    const step = String(input.step ?? "back");
    try {
      await attach(ctx);
      const page = step === "reload" ? await cdp.reload() : await cdp.historyStep(step === "forward" ? "forward" : "back");
      return ok(stateText(page), { url: page.url });
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

const stop = tool({
  name: "browser_close",
  description:
    "Close the browser session the agent started. If Chrome was already running before this task, it is left alone — the agent only puts away what it opened.",
  effect: "compute",
  inputSchema: obj({}),
  describe: () => ({ summary: "close the browser the agent launched" }),
  async execute(_input, ctx): Promise<ToolResult> {
    try {
      if (!cdp.isAttached()) return ok("No browser session is open.");
      await attach(ctx);
      const list = await cdp.listTabs();
      cdp.closeBrowser();
      return ok(`Session ended. ${list.length} tab(s) were open. The agent's profile stays on disk, so a login you did there stays.`);
    } catch (cause) {
      return browserFailure(cause);
    }
  },
});

export const BROWSER_TOOLS: ToolSpec[] = [open, state, click, type, press, choose, scroll, extract, shot, tabs, history, stop];

/**
 * The browsing a factory station may do: open a page, look, read, scroll, go back.
 * All of it is `read` — a station may see a site but must not change it, so
 * clicking, typing and choosing stay out of the line.
 */
export const BROWSER_OBSERVE = ["browser_open", "browser_state", "browser_extract", "browser_scroll", "browser_history"];
