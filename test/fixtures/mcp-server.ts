/**
 * A tiny MCP server over stdio, used by the tests.
 *
 * It speaks newline-delimited JSON-RPC, the same framing a real server uses, so
 * the client is exercised through its real parser rather than a stub. It offers
 * one read-only tool, one destructive one, one that sleeps, and one that fails —
 * enough to prove listing, annotations, calls, timeouts and error mapping.
 */
import { createInterface } from "node:readline";

const VERSION = "2025-06-18";

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

const tools = [
  {
    name: "echo",
    title: "Echo",
    description: "Returns the text it was given.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "remove",
    title: "Remove a thing",
    description: "Pretends to delete something.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "slow",
    description: "Never answers.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "explode",
    description: "Returns a tool error.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === "echo") {
    const text = typeof args.text === "string" ? args.text : "";
    return { content: [{ type: "text", text: `echo:${text}` }], structuredContent: { echoed: text } };
  }
  if (name === "remove") {
    return { content: [{ type: "text", text: `removed ${String(args.path ?? "")}` }] };
  }
  if (name === "slow") {
    return new Promise(() => {
      /* deliberately never settles */
    });
  }
  if (name === "explode") {
    return { isError: true, content: [{ type: "text", text: "it broke on purpose" }] };
  }
  return { isError: true, content: [{ type: "text", text: `no such tool: ${name}` }] };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const method = message.method;
  const id = message.id;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.2.3" },
        instructions: "This server exists to prove the client works.",
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({ id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    void callTool(name, args).then((result) => send({ id, result }));
    return;
  }
  if (method === "ping") {
    send({ id, result: {} });
    return;
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `no method ${String(method)}` } });
});
