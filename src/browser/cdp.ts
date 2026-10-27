/**
 * The browser: your own Chrome, driven over its DevTools port.
 *
 * Why not a headless library: every one of them ships a private browser build,
 * and a private build is a new thing to patch and a new identity for the site to
 * look at. This attaches to the Chrome that is already installed, in a profile
 * that belongs to the agent, so the agent sees what you see and nothing is
 * downloaded to do it.
 *
 * Two things are load-bearing here.
 *
 * The profile. Chrome 136 refuses `--remote-debugging-port` on your default
 * profile, and that is the right call — so the agent gets its own, outside the
 * project. On Windows it lives under %LOCALAPPDATA%: a profile inside a project on
 * the D: drive never opens the DevTools port here — Chrome writes its scaffolding
 * and exits silently, so the workspace is not where a browser belongs. It is not a
 * copy of yours: the agent starts logged out, and whatever you choose to log into
 * inside it stays on this machine.
 *
 * The index. A page is thousands of nodes; a model has no eyes. So every visible
 * interactive element is numbered once, the number is stamped on the element as
 * `data-agent-idx`, and the agent says "click 12" instead of guessing a selector.
 * The tools resolve that number back to the element in the page, not to a
 * remembered coordinate, which is what makes a click survive a re-render.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_DIR } from "#guard/log.ts";

const DEFAULT_PORT = 9333;
const LAUNCH_WAIT_MS = 20_000;
const RPC_TIMEOUT_MS = 25_000;
/** Indexed elements are what the agent can point at; everything else is text. */
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable=true]",
  "[tabindex]",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=searchbox]",
  "[role=combobox]",
  "[onclick]",
  "summary",
].join(",");

export interface BrowserSettings {
  port: number;
  executable: string | null;
  headless: boolean;
  profileDir: string;
}

export interface Snapshot {
  url: string;
  title: string;
  ready: string;
  count: number;
  scroll: { x: number; y: number; height: number };
  viewport: { width: number; height: number };
  lines: string[];
}

export interface IndexedElement {
  index: number;
  tag: string;
  type: string;
  name: string;
  role: string;
  href: string;
  label: string;
  value: string;
  disabled: boolean;
}

export interface TabInfo {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
}

export class BrowserError extends Error {}

/** Where the agent's browser profile lives when the operator does not say. */
export function defaultProfileDir(workspace: string): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA?.trim() || process.env.USERPROFILE?.trim();
    if (local) return path.join(local, "agent", "browser-profile");
  }
  return path.join(workspace, AGENT_DIR, "browser-profile");
}

/** Where Chrome is, and which profile and port to use. Env-driven, so a machine without Chrome just leaves these tools unused. */
export function browserSettings(workspace: string): BrowserSettings {
  const port = Number(process.env.AGENT_BROWSER_PORT ?? DEFAULT_PORT);
  return {
    port: Number.isFinite(port) && port > 1024 ? port : DEFAULT_PORT,
    executable: findChrome(),
    headless: /^(1|true)$/i.test(process.env.AGENT_BROWSER_HEADLESS ?? ""),
    profileDir: process.env.AGENT_BROWSER_PROFILE?.trim() || defaultProfileDir(workspace),
  };
}

export function findChrome(): string | null {
  const override = process.env.AGENT_BROWSER_EXECUTABLE?.trim();
  if (override) return existsSync(override) ? override : null;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge",
           "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

let socket: WebSocket | null = null;
let rpcId = 0;
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (cause: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
/** targetId → DevTools session id, so one socket drives many tabs. */
const sessions = new Map<string, string>();
let current: { targetId: string; sessionId: string } | null = null;
let child: ChildProcess | null = null;
let launchedByUs = false;
/** What the last launch did, so a failure can name a cause instead of guessing. */
let lastExit: { code: number | null; spawnFailed: boolean; ms: number } | null = null;
let chromeNoise = "";
/** The port and profile actually in use, which is not always the configured pair. */
let inUse: { port: number; profileDir: string } | null = null;

async function httpJson(port: number, pathname: string, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new BrowserError(`DevTools endpoint ${pathname} answered ${res.status}.`);
  return (await res.json()) as Record<string, unknown>;
}

function openSocket(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const fail = (cause: unknown) => reject(cause instanceof Error ? cause : new BrowserError(`The browser's DevTools socket refused us: ${String(cause)}`));
    ws.onerror = () => fail(new BrowserError("Could not open the DevTools WebSocket. Is another agent holding the port?"));
    ws.onopen = () => {
      socket = ws;
      resolve();
    };
    ws.onmessage = (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const id = typeof message.id === "number" ? message.id : 0;
      if (!id) return; // an event; nothing in this driver waits for one
      const pending = waiting.get(id);
      if (!pending) return;
      waiting.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new BrowserError(`DevTools said: ${String((message.error as Record<string, unknown>).message ?? "unknown error")}`));
      else pending.resolve(message.result ?? {});
    };
    ws.onclose = () => {
      for (const pending of waiting.values()) {
        clearTimeout(pending.timer);
        pending.reject(new BrowserError("The browser closed the DevTools socket."));
      }
      waiting.clear();
      sessions.clear();
      current = null;
      socket = null;
    };
  });
}

function send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new BrowserError("Not connected to the browser. Call a browser tool once and it will start Chrome for you."));
  rpcId += 1;
  const id = rpcId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new BrowserError(`${method} took over ${RPC_TIMEOUT_MS / 1000}s and was dropped. The page may be busy — try browser_state.`));
    }, RPC_TIMEOUT_MS);
    waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

/** Chrome writes this into the profile when it opens DevTools; line 1 is the port it really bound. */
export function recordedPort(profileDir: string): number | null {
  try {
    const first = (readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0] ?? "").trim();
    const port = Number(first);
    return Number.isFinite(port) && port > 1024 ? port : null;
  } catch {
    return null;
  }
}

async function probe(port: number): Promise<Record<string, unknown> | null> {
  try {
    return await httpJson(port, "/json/version");
  } catch {
    return null;
  }
}

/**
 * A Chrome the agent can already use. The configured port first, then whatever
 * port the profile recorded — a leftover from an earlier run that never got a
 * teardown is still a live browser, and fighting it would be the wrong cure.
 */
export async function findLive(settings: BrowserSettings): Promise<{ info: Record<string, unknown>; port: number; profileDir: string } | null> {
  const recorded = recordedPort(settings.profileDir);
  for (const port of [settings.port, recorded]) {
    if (!port) continue;
    const info = await probe(port);
    if (info) return { info, port, profileDir: settings.profileDir };
  }
  return null;
}

/**
 * The (port, profile) pairs to try, cheapest first. A port someone else holds and a
 * profile a leftover Chrome holds are different failures, and one retry cannot fix
 * both — so each attempt moves both, and the first attempt stays exactly what the
 * operator configured.
 */
export function launchAttempts(settings: BrowserSettings): { port: number; profileDir: string }[] {
  return [0, 1, 2].map((attempt) => ({
    port: settings.port + attempt,
    profileDir: attempt === 0 ? settings.profileDir : `${settings.profileDir}-alt${attempt}`,
  }));
}

function killChild(): void {
  if (child) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  child = null;
  launchedByUs = false;
}

function launch(settings: BrowserSettings, port: number, profileDir: string): void {
  mkdirSync(profileDir, { recursive: true });
  // A headless-shell build is headless already; handing it --headless=new makes it refuse to start.
  const headlessShell = /headless[-_]shell/i.test(settings.executable ?? "");
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--hide-crash-restore-bubble",
    // No account sync: what the agent browses must not be pushed into your profile.
    "--disable-sync",
    ...(settings.headless && !headlessShell ? ["--headless=new"] : []),
    "about:blank",
  ];
  lastExit = null;
  chromeNoise = "";
  // stderr is kept, not ignored: Chrome names the reason it refused, and that is the
  // only way a failure two weeks from now can be read off the screen.
  child = spawn(settings.executable ?? "", args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  const started = Date.now();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (chromeNoise.length < 4_000) chromeNoise += chunk;
  });
  child.on("error", () => {
    lastExit = { code: null, spawnFailed: true, ms: Date.now() - started };
    child = null;
  });
  child.on("exit", (code) => {
    lastExit = { code, spawnFailed: false, ms: Date.now() - started };
  });
  launchedByUs = true;
  child.unref();
}

/**
 * Did the launch actually fail?
 *
 * On Windows `chrome.exe` is a launcher: it starts the browser as its own process
 * and exits with code 0 inside ~100ms. Reading that as a death abandons a DevTools
 * port that is about to open, and the retries leave a second Chrome behind — which
 * is exactly how "the profile is held by another window" gets created out of
 * nothing. Only a failed spawn or a non-zero exit means the browser is not coming.
 */
export function launchDied(exit: { code: number | null; spawnFailed: boolean } | null): boolean {
  return exit !== null && (exit.spawnFailed || (exit.code ?? 0) !== 0);
}

/** Wait for the port to answer, and stop early the moment the process is demonstrably gone. */
async function waitPort(port: number, ms: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const info = await probe(port);
    if (info) return info;
    if (launchDied(lastExit) || Date.now() > deadline) return null;
    await sleep(400);
  }
}

function flat(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `…${one.slice(-max)}` : one;
}

function gaveUp(settings: BrowserSettings): string {
  const pairs = launchAttempts(settings);
  const last = pairs[pairs.length - 1]!;
  const cause = lastExit?.spawnFailed
    ? `the Chrome at ${settings.executable} could not be started at all`
    : launchDied(lastExit)
      ? // The classic one with a real exit code: a Chrome already owns this profile, so
        // the new process hands the URL to it and quits with an error.
        `Chrome exited with code ${lastExit?.code ?? "?"} after ${lastExit?.ms ?? 0}ms, which is what it does when another Chrome already holds the profile`
      : `Chrome was started ${pairs.length} times and stayed alive, but no DevTools port answered — from ${settings.port} to ${last.port}. Something is refusing local debugging: an enterprise policy, or antivirus.`;
  const noise = flat(chromeNoise, 240);
  return (
    `Could not reach a Chrome DevTools port: ${cause}. ` +
    `Close the other Chrome windows using profile ${settings.profileDir}, or give the agent a free pair: ` +
    `AGENT_BROWSER_PORT=9444 and AGENT_BROWSER_PROFILE=<a folder nobody else uses>.` +
    (noise ? `\nChrome said: ${noise}` : "")
  );
}

/** Get to a connected, attached, usable page. Every tool starts here. */
export async function ensureBrowser(workspace: string): Promise<{ version: string; launched: boolean }> {
  const settings = browserSettings(workspace);
  if (!settings.executable) {
    throw new BrowserError("No Chrome or Edge found. Install Chrome, or point the agent at it: AGENT_BROWSER_EXECUTABLE=/path/to/chrome.exe");
  }
  let found = await findLive(settings);
  if (!found) {
    for (const [attempt, pair] of launchAttempts(settings).entries()) {
      killChild();
      launch(settings, pair.port, pair.profileDir);
      const info = await waitPort(pair.port, attempt === 0 ? LAUNCH_WAIT_MS : 8_000);
      if (info) {
        found = { info, port: pair.port, profileDir: pair.profileDir };
        break;
      }
    }
  }
  if (!found) {
    killChild();
    throw new BrowserError(gaveUp(settings));
  }
  inUse = { port: found.port, profileDir: found.profileDir };
  const version = String(found.info.Browser ?? "browser");
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    const wsUrl = String(found.info.webSocketDebuggerUrl ?? "");
    if (!wsUrl) throw new BrowserError("DevTools reported no browser WebSocket URL.");
    await openSocket(wsUrl);
  }
  await ensureTab();
  return { version, launched: launchedByUs };
}

/** Attach to a page tab: the first one there is, or a fresh blank one. */
async function ensureTab(): Promise<{ targetId: string; sessionId: string }> {
  if (current && sessions.has(current.targetId)) return current;
  const targets = (await send<{ targetInfos?: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos ?? [];
  const page = targets.find((t) => t.type === "page" && !/^devtools:/i.test(t.url));
  const targetId = page?.targetId ?? (await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
  return attach(targetId);
}

async function attach(targetId: string): Promise<{ targetId: string; sessionId: string }> {
  const existing = sessions.get(targetId);
  if (existing) {
    current = { targetId, sessionId: existing };
    return current;
  }
  const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  sessions.set(targetId, sessionId);
  await send("Page.enable", {}, sessionId).catch(() => undefined);
  await send("Runtime.enable", {}, sessionId).catch(() => undefined);
  current = { targetId, sessionId };
  return current;
}

function tab(): { targetId: string; sessionId: string } {
  if (!current) throw new BrowserError("No tab is attached yet.");
  return current;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the document to settle, so a snapshot is not taken mid-navigation. */
async function waitForReady(timeoutMs = 12_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let ready = "loading";
  for (;;) {
    ready = String(await evaluate("document.readyState", false));
    if (ready === "complete" || Date.now() > deadline) return ready;
    await sleep(250);
  }
}

async function evaluate(expression: string, awaitPromise = false): Promise<unknown> {
  const { sessionId } = tab();
  const result = await send<{ result: Record<string, unknown>; exceptionDetails?: Record<string, unknown> }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise },
    sessionId,
  );
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const text = String((details.exception as Record<string, unknown> | undefined)?.description ?? details.text ?? "the page refused the call");
    throw new BrowserError(`The page answered with an error: ${text.slice(0, 300)}`);
  }
  return result.result?.value;
}

/** The injected indexer. Returns JSON, never a DOM object — objects do not cross returnByValue. */
const SNAPSHOT_SCRIPT = `(function (SELECTOR) {
  var MARK = "data-agent-idx";
  Array.prototype.forEach.call(document.querySelectorAll("[" + MARK + "]"), function (el) { el.removeAttribute(MARK); });
  function box(el) { return el.getBoundingClientRect(); }
  function shown(el) {
    var r = box(el);
    if (r.width < 2 || r.height < 2) return false;
    var s = window.getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    return true;
  }
  function clean(text, max) {
    return String(text == null ? "" : text).replace(/\\s+/g, " ").replace(/[<>]/g, " ").trim().slice(0, max || 120);
  }
  function label(el, tag, type) {
    if (tag === "input" && type === "password") return "(hidden password)";
    var fromAria = el.getAttribute("aria-label");
    var own = clean(fromAria || el.placeholder || el.title, 80);
    if (own) return own;
    if (tag === "input") return clean(el.value, 60);
    var text = clean(el.innerText || el.textContent, 90);
    if (text) return text;
    var associated = el.labels && el.labels[0];
    if (associated) return clean(associated.innerText || associated.textContent, 60);
    return "";
  }
  var nodes = document.querySelectorAll(SELECTOR);
  var out = [];
  var n = 0;
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (!shown(el)) continue;
    n = n + 1;
    el.setAttribute(MARK, String(n));
    var tag = el.tagName.toLowerCase();
    var type = el.getAttribute("type") || "";
    var bits = [tag];
    if (type) bits.push("type=" + type);
    if (el.id) bits.push("id=" + el.id);
    var name = el.getAttribute("name");
    if (name) bits.push("name=" + name);
    var role = el.getAttribute("role");
    if (role) bits.push("role=" + role);
    var href = el.getAttribute("href");
    if (href) bits.push("href=" + clean(href, 110));
    var ph = el.getAttribute("placeholder");
    if (ph) bits.push("placeholder=" + clean(ph, 60));
    if (el.disabled) bits.push("disabled");
    if (el.getAttribute("aria-expanded")) bits.push("aria-expanded=" + el.getAttribute("aria-expanded"));
    var rect = box(el);
    var offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
    var text = label(el, tag, type);
    out.push("[" + n + "]<" + bits.join(" ") + ">" + (text ? " " + text : "") + (offscreen ? " [offscreen]" : ""));
  }
  var root = document.documentElement;
  return JSON.stringify({
    url: location.href,
    title: document.title,
    ready: document.readyState,
    count: n,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY), height: root ? root.scrollHeight : 0 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    lines: out,
  });
})(${JSON.stringify(INTERACTIVE_SELECTOR)})`;

export async function snapshot(): Promise<Snapshot> {
  const raw = await evaluate(SNAPSHOT_SCRIPT);
  const value = JSON.parse(String(raw)) as Snapshot;
  return { ...value, lines: Array.isArray(value.lines) ? value.lines : [] };
}

/** Where one indexed element is and what it says — the click target, in words. */
export async function describeIndex(index: number): Promise<IndexedElement | null> {
  const script = `(function (i) {
    var el = document.querySelector('[data-agent-idx="' + i + '"]');
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    return JSON.stringify({
      index: i,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      role: el.getAttribute("role") || "",
      href: el.getAttribute("href") || "",
      label: String(el.getAttribute("aria-label") || el.placeholder || el.title || (el.innerText || el.textContent || "")).replace(/\\s+/g, " ").trim().slice(0, 120),
      value: el.tagName.toLowerCase() === "input" && el.getAttribute("type") === "password" ? "(hidden password)" : String(el.value || "").slice(0, 60),
      disabled: !!el.disabled,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    });
  })(${Math.trunc(index)})`;
  const raw = await evaluate(script);
  if (raw === null || raw === undefined) return null;
  return JSON.parse(String(raw)) as IndexedElement;
}

/** One focusable element, resolved by its index, or a refusal the model can act on. */
async function locate(index: number): Promise<{ found: true; x: number; y: number; tag: string } | { found: false; error: string }> {
  const script = `(function (i) {
    var el = document.querySelector('[data-agent-idx="' + i + '"]');
    if (!el) return JSON.stringify({ found: false, error: "Nothing carries index " + i + " on this page. Call browser_state again — numbers die when the page changes." });
    el.scrollIntoView({ block: "center", inline: "center" });
    var rect = el.getBoundingClientRect();
    return JSON.stringify({ found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: el.tagName.toLowerCase() });
  })(${Math.trunc(index)})`;
  const raw = await evaluate(script);
  return JSON.parse(String(raw)) as { found: true; x: number; y: number; tag: string } | { found: false; error: string };
}

async function mouse(type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
  const { sessionId } = tab();
  await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseWheel" ? 0 : 1, ...extra }, sessionId);
}

export async function navigate(url: string): Promise<Snapshot> {
  const { sessionId } = tab();
  await send("Page.navigate", { url }, sessionId);
  await waitForReady();
  // A page that never finishes loading is still worth showing rather than hiding.
  await sleep(300);
  return snapshot();
}

export async function click(index: number): Promise<{ moved: boolean; url: string }> {
  const target = await locate(index);
  if (!target.found) throw new BrowserError(target.error);
  const before = String(await evaluate("location.href"));
  await mouse("mousePressed", target.x, target.y);
  await mouse("mouseReleased", target.x, target.y);
  await sleep(250);
  await waitForReady(6_000);
  return { moved: String(await evaluate("location.href")) !== before, url: before };
}

export async function clickLinkAt(x: number, y: number): Promise<void> {
  await mouse("mousePressed", x, y);
  await mouse("mouseReleased", x, y);
}

/**
 * Put text into a field the way a person does: focus, clear, insert.
 *
 * Setting `.value` alone is not enough — React keeps its own copy of the value and
 * an app will drop what it did not see typed. So the field is emptied with the
 * prototype setter (the one trick that does reset that copy) and the text goes in
 * through Input.insertText, which produces the same events a keyboard does.
 */
export async function typeText(index: number, text: string, submit = false): Promise<string> {
  const target = await locate(index);
  if (!target.found) throw new BrowserError(target.error);
  await mouse("mousePressed", target.x, target.y);
  await mouse("mouseReleased", target.x, target.y);

  const clear = `(function (i) {
    var el = document.querySelector('[data-agent-idx="' + i + '"]');
    if (!el) return "gone";
    el.focus();
    var tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      var proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(el, "");
      else el.value = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    }
    return "ok";
  })(${Math.trunc(index)})`;
  const cleared = String(await evaluate(clear));
  if (cleared === "gone") throw new BrowserError(`Index ${index} disappeared while focusing it. Call browser_state.`);

  const { sessionId } = tab();
  await send("Input.insertText", { text }, sessionId);
  if (submit) await pressKey("Enter");
  await sleep(150);
  return String(await evaluate("document.activeElement ? document.activeElement.tagName.toLowerCase() : 'none'"));
}

const KEY_CODES: Record<string, { keyCode: number; code: string }> = {
  Enter: { keyCode: 13, code: "Enter" },
  Tab: { keyCode: 9, code: "Tab" },
  Escape: { keyCode: 27, code: "Escape" },
  Backspace: { keyCode: 8, code: "Backspace" },
  Delete: { keyCode: 46, code: "Delete" },
  Space: { keyCode: 32, code: "Space" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
  ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, code: "ArrowRight" },
  Home: { keyCode: 36, code: "Home" },
  End: { keyCode: 35, code: "End" },
  PageUp: { keyCode: 33, code: "PageUp" },
  PageDown: { keyCode: 34, code: "PageDown" },
};

export async function pressKey(key: string): Promise<void> {
  const named = KEY_CODES[key];
  const { sessionId } = tab();
  if (named) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: named.code, windowsVirtualKeyCode: named.keyCode, nativeVirtualKeyCode: named.keyCode }, sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: named.code, windowsVirtualKeyCode: named.keyCode, nativeVirtualKeyCode: named.keyCode }, sessionId);
    return;
  }
  if (key.length === 1) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: key }, sessionId);
    await send("Input.insertText", { text: key }, sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key }, sessionId);
    return;
  }
  throw new BrowserError(`I do not know the key "${key}". Named keys: ${Object.keys(KEY_CODES).join(", ")} — or one character.`);
}

export async function selectOption(index: number, option: string): Promise<string> {
  const target = await locate(index);
  if (!target.found) throw new BrowserError(target.error);
  const script = `(function (i, wanted) {
    var el = document.querySelector('[data-agent-idx="' + i + '"]');
    if (!el) return "gone";
    var tag = el.tagName.toLowerCase();
    if (tag === "select") {
      var options = el.options;
      for (var j = 0; j < options.length; j++) {
        var o = options[j];
        if (o.value === wanted || String(o.textContent).trim().toLowerCase().indexOf(wanted.toLowerCase()) >= 0) {
          el.value = o.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return "chosen:" + o.value;
        }
      }
      return "no match; options are " + Array.prototype.map.call(options, function (o) { return String(o.textContent).trim(); }).slice(0, 12).join(" | ");
    }
    if (el.getAttribute) {
      el.checked = true;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return "checked";
    }
    return "not a field";
  })(${Math.trunc(index)}, ${JSON.stringify(option)})`;
  const result = String(await evaluate(script));
  if (result === "gone") throw new BrowserError(`Index ${index} is not on the page any more. Call browser_state.`);
  if (result.startsWith("no match")) throw new BrowserError(`${result}`);
  return result;
}

export async function scroll(direction: "down" | "up", amount: number): Promise<{ y: number; height: number }> {
  const factor = direction === "up" ? -1 : 1;
  const script = `(function (delta) {
    window.scrollBy({ top: delta, left: 0, behavior: "instant" });
    var root = document.documentElement;
    return JSON.stringify({ y: Math.round(window.scrollY), height: root ? root.scrollHeight : 0 });
  })(${Math.trunc(factor * amount)})`;
  const raw = await evaluate(script);
  await sleep(250);
  return JSON.parse(String(raw)) as { y: number; height: number };
}

/** The page as text — the same reading a person gets when they look at it. */
export async function pageText(maxChars: number): Promise<{ url: string; title: string; text: string }> {
  const script = `(function () {
    function clean(node) {
      if (!node) return "";
      var clone = node.cloneNode(true);
      var bad = clone.querySelectorAll("script,style,noscript,svg,template");
      for (var i = 0; i < bad.length; i++) bad[i].remove();
      return String(clone.innerText || clone.textContent || "");
    }
    var body = document.body || document.documentElement;
    return JSON.stringify({ url: location.href, title: document.title, text: clean(body).replace(/\\n{3,}/g, "\\n\\n") });
  })()`;
  const value = JSON.parse(String(await evaluate(script))) as { url: string; title: string; text: string };
  return { ...value, text: value.text.slice(0, Math.max(2_000, maxChars)) };
}

/** The visible box, in CSS pixels. Chrome dropped `metrics` from this reply years ago. */
export async function pageBounds(): Promise<{ width: number; height: number }> {
  const { sessionId } = tab();
  const reply = await send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }; layoutViewport?: { clientWidth?: number; clientHeight?: number } }>(
    "Page.getLayoutMetrics",
    {},
    sessionId,
  );
  const box = reply.cssLayoutViewport ?? reply.layoutViewport;
  return { width: Number(box?.clientWidth) || 800, height: Number(box?.clientHeight) || 600 };
}

/**
 * Draw the index numbers on the page before the shot, so the picture and the
 * transcript use one language. The overlay is removed whatever happens: a page
 * left wearing the agent's labels is a page the operator then has to fix.
 */
async function withOverlay<T>(draw: boolean, work: () => Promise<T>): Promise<T> {
  if (draw) {
    await evaluate(`(function () {
      var MARK = "data-agent-idx";
      var old = document.getElementById("agent-overlay");
      if (old) old.remove();
      var layer = document.createElement("div");
      layer.id = "agent-overlay";
      layer.style.cssText = "position:absolute;left:0;top:0;z-index:2147483647;pointer-events:none";
      var nodes = document.querySelectorAll("[" + MARK + "]");
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var r = el.getBoundingClientRect();
        var badge = document.createElement("div");
        badge.textContent = el.getAttribute(MARK);
        badge.style.cssText = "position:absolute;left:" + Math.round(r.left + window.scrollX) + "px;top:" + Math.round(r.top + window.scrollY) +
          "px;background:#0b57d0;color:#fff;font:11px/1.4 monospace;padding:0 3px;border:1px solid #fff;border-radius:3px;max-width:180px;overflow:hidden";
        layer.appendChild(badge);
      }
      document.body.appendChild(layer);
      return String(nodes.length);
    })()`);
  }
  try {
    return await work();
  } finally {
    if (draw) await evaluate(`(function () { var l = document.getElementById("agent-overlay"); if (l) l.remove(); return "clean"; })()`).catch(() => undefined);
  }
}

export async function screenshot(workspace: string, labelled: boolean): Promise<{ file: string; bytes: number }> {
  const { sessionId } = tab();
  const capture = await withOverlay(labelled, async () => send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 62 }, sessionId));
  const buffer = Buffer.from(capture.data, "base64");
  const dir = path.join(workspace, AGENT_DIR, "shots");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`);
  writeFileSync(file, buffer);
  return { file, bytes: buffer.length };
}

export async function listTabs(): Promise<TabInfo[]> {
  const targets = (await send<{ targetInfos?: { targetId: string; type: string; title?: string; url: string }[] }>("Target.getTargets")).targetInfos ?? [];
  return targets
    .filter((t) => t.type === "page" && !/^devtools:/i.test(t.url))
    .map((t) => ({ targetId: t.targetId, title: t.title ?? "", url: t.url, active: current?.targetId === t.targetId }));
}

/**
 * Open a tab and put a page in it.
 *
 * The url is not passed to createTarget: that returns before the page exists, and
 * the first reading of the new tab was always `about:blank` with nothing indexed.
 * Creating an empty tab and then navigating it is the same work, one step later.
 */
export async function newTab(url: string): Promise<Snapshot> {
  const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  await attach(targetId);
  if (url !== "about:blank") return navigate(url);
  await waitForReady();
  return snapshot();
}

export async function switchTab(targetId: string): Promise<Snapshot> {
  await attach(targetId);
  await send("Target.activateTarget", { targetId });
  await sleep(200);
  return snapshot();
}

export async function closeTab(targetId: string): Promise<void> {
  await send("Target.closeTarget", { targetId }).catch(() => undefined);
  sessions.delete(targetId);
  if (current?.targetId === targetId) current = null;
  await ensureTab();
}

export async function historyStep(step: "back" | "forward"): Promise<Snapshot> {
  const { sessionId } = tab();
  const history = await send<{ currentIndex: number; entries: { id: number; url: string }[] }>("Page.getNavigationHistory", {}, sessionId);
  const index = Math.max(0, Math.min(history.entries.length - 1, history.currentIndex + (step === "back" ? -1 : 1)));
  const entry = history.entries[index];
  if (!entry || index === history.currentIndex) throw new BrowserError(`There is nowhere to go ${step}. The page has ${history.entries.length} entry(ies).`);
  await send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId);
  await waitForReady();
  return snapshot();
}

export async function reload(): Promise<Snapshot> {
  const { sessionId } = tab();
  await send("Page.reload", {}, sessionId);
  await waitForReady();
  return snapshot();
}

export function isAttached(): boolean {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

/**
 * Only close what we opened. A browser the operator was already running stays
 * running — the agent does not get to end a person's session.
 */
export function closeBrowser(): void {
  const ws = socket;
  if (launchedByUs && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id: ++rpcId, method: "Browser.close" }));
  }
  if (launchedByUs && child) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  launchedByUs = false;
  child = null;
  inUse = null;
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  socket = null;
  current = null;
  sessions.clear();
}

/** What the operator is told when a browser tool is refused before it starts. */
export function browserHint(workspace: string): string {
  const settings = browserSettings(workspace);
  const used = inUse ?? { port: settings.port, profileDir: settings.profileDir };
  const moved = used.port !== settings.port || used.profileDir !== settings.profileDir ? " (last run moved off the configured pair)" : "";
  return `chrome: ${settings.executable ?? "NOT FOUND"} · port ${used.port} · profile ${used.profileDir} · mode ${settings.headless ? "headless" : "visible"}${moved}`;
}
