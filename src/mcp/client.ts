/**
 * An MCP client: JSON-RPC 2.0 over the three transports servers actually use.
 *
 *   stdio   a newline-delimited JSON conversation with a child process
 *   http    the streamable protocol: one POST per message, answered inline as
 *           JSON or as a short event stream, with a session id carried in a header
 *   sse     the older protocol: a long GET for responses, a POST to an endpoint
 *           the server announces on that stream
 *
 * Nothing here knows what a "tool" does to the world; that judgement lives in
 * tools.ts. This file only carries bytes and turns protocol errors into text a
 * person can act on, because an MCP server that fails is usually one line of
 * stderr away from being fixable.
 */
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { McpServerConfig } from "./config.ts";

export const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "agent-cli", version: "0.1.0" };
const MAX_TOOLS = 256;
const MAX_PAGES = 20;

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

export interface McpToolResult {
  ok: boolean;
  text: string;
  data?: unknown;
}

export interface McpClient {
  config: McpServerConfig;
  serverInfo: { name: string; version: string };
  protocolVersion: string;
  instructions: string;
  tools: McpTool[];
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<McpToolResult>;
  close(): Promise<void>;
}

// ─── channels ─────────────────────────────────────────────────────────────────

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

abstract class Channel {
  protected nextId = 1;
  protected pending = new Map<number, Pending>();
  protected closed = false;
  protected closeReason = "the connection is closed";
  protected version: string | null = null;

  setProtocolVersion(version: string | null): void {
    this.version = version;
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw new Error(this.closeReason);
    if (signal?.aborted) throw new Error("aborted");
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return (await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const held = this.pending.get(id);
        if (!held) return;
        this.pending.delete(id);
        this.release(held);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const entry: Pending = { resolve, reject, timer, method, ...(signal ? { signal } : {}) };
      if (signal) {
        entry.onAbort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          reject(new Error(`${method} was stopped`));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      void this.transmit(payload, id, timeoutMs, signal).catch((cause: unknown) => {
        const held = this.pending.get(id);
        if (!held) return;
        this.pending.delete(id);
        this.release(held);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      });
    })) as T;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    void this.transmit(payload, null, 15_000).catch(() => {
      /* a lost notification is the server's to notice; the next request will show it */
    });
  }

  protected abstract transmit(payload: string, id: number | null, timeoutMs: number, signal?: AbortSignal): Promise<void>;

  protected abstract shutdown(): void | Promise<void>;

  protected receive(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Servers sometimes log to stdout. A non-protocol line is noise, not a reason
      // to drop a working connection; stderr is where their diagnostics belong.
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!message || typeof message !== "object") continue;
      const record = message as Record<string, unknown>;
      if (typeof record.method === "string") {
        if (typeof record.id === "number" || typeof record.id === "string") {
          this.answer({ id: record.id, method: record.method, params: record.params });
        }
        continue;
      }
      if (typeof record.id !== "number") continue;
      const held = this.pending.get(record.id);
      if (!held) continue;
      this.pending.delete(record.id);
      clearTimeout(held.timer);
      this.release(held);
      if (record.error && typeof record.error === "object") {
        const error = record.error as Record<string, unknown>;
        const detail = typeof error.message === "string" ? error.message : "the server reported an error";
        const code = typeof error.code === "number" ? ` (${error.code})` : "";
        held.reject(new Error(`${held.method} failed${code}: ${detail}`));
      } else {
        held.resolve(record.result);
      }
    }
  }

  /** Server → client requests. The protocol only mandates `ping`; say no clearly to the rest. */
  protected answer(request: ServerRequest): void {
    let body: Record<string, unknown>;
    if (request.method === "ping") body = { result: {} };
    else if (request.method === "roots/list") body = { result: { roots: [] } };
    else body = { error: { code: -32601, message: `this client does not implement ${request.method}` } };
    void this.transmit(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body }), null, 10_000).catch(() => {});
  }

  private release(entry: Pending): void {
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  }

  protected fail(reason: string): void {
    this.closed = true;
    this.closeReason = reason;
    for (const [id, held] of this.pending) {
      this.pending.delete(id);
      clearTimeout(held.timer);
      this.release(held);
      held.reject(new Error(reason));
    }
  }

  async close(): Promise<void> {
    const wasClosed = this.closed;
    if (!wasClosed) this.fail("the connection was closed");
    await this.shutdown();
  }
}

// ─── stdio ────────────────────────────────────────────────────────────────────

type Piped = ChildProcessByStdio<Writable, Readable, Readable>;

interface Launch {
  file: string;
  args: string[];
  verbatim?: boolean;
}

/** `npx` on Windows is `npx.cmd`, which only cmd.exe can start; everything else starts directly. */
function launchCommand(command: string, args: string[]): Launch {
  if (process.platform !== "win32") return { file: command, args };
  const resolved = resolveWindows(command);
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { file: resolved, args };
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  const line = [winQuote(resolved), ...args.map(winQuote)].join(" ");
  return { file: comspec, args: [`/d /s /c "${line}"`], verbatim: true };
}

function resolveWindows(command: string): string {
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase());
  const named = path.extname(command).toLowerCase();
  if (named && exts.includes(named)) return command;
  const dirs = /[\\/]/.test(command) ? [""] : (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const base = dir ? path.join(dir, command) : command;
    for (const ext of exts) {
      const candidate = `${base}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
    if (existsSync(base)) return base;
  }
  return command;
}

/** CRT-style quoting, with the whole line then handed to `cmd /s /c`. */
function winQuote(value: string): string {
  if (value === "") return '""';
  if (!/[\s"]/.test(value)) return value;
  let out = '"';
  let slashes = 0;
  for (const char of value) {
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    if (char === '"') {
      out += `${"\\".repeat(slashes * 2 + 1)}"`;
      slashes = 0;
      continue;
    }
    out += `${"\\".repeat(slashes)}${char}`;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

function stopProcess(child: ChildProcess, exited: () => boolean): void {
  if (exited() || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  if (process.platform !== "win32" || !child.pid) return;
  // An npx server is a wrapper around node; killing the wrapper orphans the child,
  // which keeps the pipe open. The tree has to go.
  const timer = setTimeout(() => {
    if (exited() || child.exitCode !== null) return;
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
    } catch {
      /* best effort: the process is already unreachable */
    }
  }, 1_200);
  timer.unref?.();
}

class StdioChannel extends Channel {
  private child: Piped;
  private buffer = "";
  private exited = false;
  private stderrTail = "";
  private readonly label: string;

  constructor(command: string, args: string[], env: Record<string, string>, label: string) {
    super();
    this.label = label;
    const launch = launchCommand(command, args);
    this.child = spawn(launch.file, launch.args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
    }) as Piped;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4_000);
    });
    this.child.on("error", (error) => this.fail(`${label}: could not start "${command}": ${error.message}`));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.fail(`${label}: server exited (${code ?? signal ?? "unknown"})${this.tail()}`);
    });
  }

  private tail(): string {
    const lines = this.stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-3);
    return lines.length ? ` — ${lines.join(" | ").slice(0, 400)}` : "";
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) this.receive(line);
      index = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > 8_000_000) {
      this.fail(`${this.label}: a line from the server grew past 8 MB without a newline`);
    }
  }

  protected async transmit(payload: string): Promise<void> {
    if (this.closed) throw new Error(this.closeReason);
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${payload}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  protected shutdown(): void {
    stopProcess(this.child, () => this.exited);
  }
}

// ─── streamable HTTP ──────────────────────────────────────────────────────────

class HttpChannel extends Channel {
  private sessionId: string | null = null;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly label: string,
  ) {
    super();
  }

  private headersFor(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.version ? { "mcp-protocol-version": this.version } : {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...this.headers,
    };
  }

  protected async transmit(payload: string, id: number | null, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error(this.closeReason);
    const controller = new AbortController();
    const forward = () => controller.abort();
    signal?.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
    try {
      const response = await fetch(this.url, { method: "POST", headers: this.headersFor(), body: payload, signal: controller.signal });
      const sid = response.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`${this.label}: HTTP ${response.status} ${response.statusText}${detail ? ` — ${clip(detail, 300)}` : ""}`);
      }
      if (id === null) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream") && response.body) {
        for await (const event of sseEvents(response.body)) {
          if (event.event !== "" && event.event !== "message") continue;
          this.receive(event.data);
          if (!this.pending.has(id)) return;
        }
        if (this.pending.has(id)) throw new Error(`${this.label}: the event stream ended before a response arrived`);
        return;
      }
      const text = await response.text();
      if (text.trim()) this.receive(text);
      if (this.pending.has(id)) {
        throw new Error(`${this.label}: HTTP ${response.status} had no response for the request`);
      }
    } catch (cause) {
      if (signal?.aborted) throw new Error("aborted");
      if (controller.signal.aborted) throw new Error(`${this.label}: no response within ${Math.round(timeoutMs / 1000)}s`);
      throw cause;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    }
  }

  protected async shutdown(): Promise<void> {
    const sid = this.sessionId;
    this.sessionId = null;
    if (!sid) return;
    try {
      await fetch(this.url, {
        method: "DELETE",
        headers: { ...this.headers, ...(this.version ? { "mcp-protocol-version": this.version } : {}), "mcp-session-id": sid },
        signal: AbortSignal.timeout(3_000),
      });
    } catch {
      /* session teardown is a courtesy; the server expires it anyway */
    }
  }
}

// ─── legacy SSE ───────────────────────────────────────────────────────────────

interface EndpointWaiter {
  resolve: (endpoint: string) => void;
  reject: (error: Error) => void;
}

class SseChannel extends Channel {
  private endpoint: string | null = null;
  private readonly waiters: EndpointWaiter[] = [];
  private readonly controller = new AbortController();

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly label: string,
  ) {
    super();
    void this.open();
  }

  private async open(): Promise<void> {
    try {
      const response = await fetch(this.url, {
        headers: { accept: "text/event-stream", "cache-control": "no-cache", ...this.headers },
        signal: this.controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error("the response had no event stream");
      for await (const event of sseEvents(response.body)) {
        if (event.event === "endpoint") {
          const target = event.data.trim();
          if (!target) continue;
          this.endpoint = new URL(target, this.url).toString();
          for (const waiter of this.waiters.splice(0)) waiter.resolve(this.endpoint);
          continue;
        }
        if (event.event === "" || event.event === "message") this.receive(event.data);
      }
      throw new Error("the event stream closed");
    } catch (cause) {
      const reason = this.controller.signal.aborted
        ? this.closeReason
        : `${this.label}: ${(cause as Error).message}`;
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(reason));
      this.fail(reason);
    }
  }

  private ready(timeoutMs: number): Promise<string> {
    if (this.endpoint) return Promise.resolve(this.endpoint);
    if (this.closed) return Promise.reject(new Error(this.closeReason));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`${this.label}: the server announced no endpoint within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const waiter: EndpointWaiter = {
        resolve: (endpoint) => {
          clearTimeout(timer);
          resolve(endpoint);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.waiters.push(waiter);
    });
  }

  protected async transmit(payload: string, id: number | null, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const endpoint = await this.ready(timeoutMs);
    const controller = new AbortController();
    const forward = () => controller.abort();
    signal?.addEventListener("abort", forward, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.headers },
        body: payload,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`${this.label}: HTTP ${response.status} ${response.statusText}${detail ? ` — ${clip(detail, 300)}` : ""}`);
      }
      const text = await response.text();
      // A compliant legacy server answers on the GET stream and returns 202 here.
      // A few answer inline; taking both costs nothing and fixes those.
      if (text.trim()) this.receive(text);
      if (id === null) return;
    } catch (cause) {
      if (signal?.aborted) throw new Error("aborted");
      if (controller.signal.aborted) throw new Error(`${this.label}: no response within ${Math.round(timeoutMs / 1000)}s`);
      throw cause;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    }
  }

  protected shutdown(): void {
    this.controller.abort();
  }
}

// ─── server-sent events ───────────────────────────────────────────────────────

interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

async function* sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary || boundary.index === undefined) break;
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseSse(raw);
        if (event) yield event;
      }
    }
    if (buffer.trim()) {
      const event = parseSse(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSse(raw: string): SseEvent | null {
  let event = "";
  const data: string[] = [];
  let id: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (!data.length && !event) return null;
  return { event, data: data.join("\n"), ...(id !== undefined ? { id } : {}) };
}

// ─── the client ───────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function label(config: McpServerConfig): string {
  return `mcp:${config.name}`;
}

function channelFor(config: McpServerConfig): Channel {
  if (config.type === "stdio") {
    if (!config.command) throw new Error(`mcp:${config.name}: a stdio server needs a command`);
    return new StdioChannel(config.command, config.args, config.env, label(config));
  }
  if (!config.url) throw new Error(`mcp:${config.name}: an ${config.type} server needs a URL`);
  return config.type === "sse"
    ? new SseChannel(config.url, config.headers, label(config))
    : new HttpChannel(config.url, config.headers, label(config));
}

function toTool(raw: Record<string, unknown>): McpTool | null {
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  const annotations = isObject(raw.annotations) ? raw.annotations : {};
  return {
    name: raw.name.trim(),
    ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
    description: typeof raw.description === "string" ? raw.description : "",
    inputSchema: isObject(raw.inputSchema) ? raw.inputSchema : { type: "object", properties: {} },
    readOnly: annotations.readOnlyHint === true,
    destructive: annotations.destructiveHint === true,
    idempotent: annotations.idempotentHint === true,
    openWorld: annotations.openWorldHint === true,
  };
}

/** Content blocks → one readable string. Images and binaries are named, not inlined. */
function renderResult(result: unknown): McpToolResult {
  const record = isObject(result) ? result : {};
  const blocks = Array.isArray(record.content) ? record.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isObject(block)) {
      parts.push(JSON.stringify(block));
      continue;
    }
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") parts.push(block.text);
        break;
      case "image":
        parts.push(`[image ${typeof block.mimeType === "string" ? block.mimeType : "unknown"} · ${byteSize(block.data)}]`);
        break;
      case "audio":
        parts.push(`[audio ${typeof block.mimeType === "string" ? block.mimeType : "unknown"} · ${byteSize(block.data)}]`);
        break;
      case "resource": {
        const resource = isObject(block.resource) ? block.resource : {};
        const uri = typeof resource.uri === "string" ? resource.uri : "(no uri)";
        if (typeof resource.text === "string") parts.push(`[resource ${uri}]\n${resource.text}`);
        else parts.push(`[resource ${uri} · ${typeof resource.mimeType === "string" ? resource.mimeType : "binary"}]`);
        break;
      }
      case "resource_link":
        parts.push(`[resource ${typeof block.uri === "string" ? block.uri : "(no uri)"}${typeof block.name === "string" ? ` · ${block.name}` : ""}]`);
        break;
      default:
        parts.push(JSON.stringify(block));
    }
  }
  const structured = record.structuredContent;
  const text = parts.join("\n").trim() || (structured !== undefined ? JSON.stringify(structured, null, 2) : "(the tool returned no content)");
  return { ok: record.isError !== true, text, ...(structured !== undefined ? { data: structured } : {}) };
}

function byteSize(data: unknown): string {
  if (typeof data !== "string") return "unknown size";
  return `${Math.round((data.length * 3) / 4 / 1024)} KB`;
}

export interface ConnectOptions {
  /**
   * How long the handshake may take. Startup is capped apart from the per-call
   * timeout: an npx download that never finishes must not hold the whole CLI.
   */
  timeoutMs?: number;
}

export async function connectServer(config: McpServerConfig, options: ConnectOptions = {}): Promise<McpClient> {
  const channel = channelFor(config);
  const handshake = Math.min(options.timeoutMs ?? config.timeoutMs, config.timeoutMs);
  try {
    const initialized = await channel.request<Record<string, unknown>>(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      handshake,
    );
    const protocolVersion = typeof initialized.protocolVersion === "string" ? initialized.protocolVersion : PROTOCOL_VERSION;
    channel.setProtocolVersion(protocolVersion);
    const info = isObject(initialized.serverInfo) ? initialized.serverInfo : {};
    const serverInfo = {
      name: typeof info.name === "string" ? info.name : config.name,
      version: typeof info.version === "string" ? info.version : "unknown",
    };
    const instructions = typeof initialized.instructions === "string" ? clip(initialized.instructions, 4_000) : "";
    channel.notify("notifications/initialized");

    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listed = await channel.request<Record<string, unknown>>("tools/list", cursor ? { cursor } : {}, handshake);
      const batch = Array.isArray(listed.tools) ? listed.tools : [];
      for (const raw of batch) {
        if (!isObject(raw)) continue;
        const tool = toTool(raw);
        if (tool) tools.push(tool);
        if (tools.length >= MAX_TOOLS) break;
      }
      const next = listed.nextCursor;
      if (typeof next !== "string" || !next || next === cursor || tools.length >= MAX_TOOLS) break;
      cursor = next;
    }

    return {
      config,
      serverInfo,
      protocolVersion,
      instructions,
      tools,
      async callTool(name, args, timeoutMs, signal) {
        const result = await channel.request<unknown>("tools/call", { name, arguments: args }, timeoutMs, signal);
        return renderResult(result);
      },
      close: () => channel.close(),
    };
  } catch (cause) {
    await channel.close().catch(() => {});
    throw cause instanceof Error ? cause : new Error(String(cause));
  }
}
