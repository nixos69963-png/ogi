/**
 * The two socket transports, against local HTTP servers.
 *
 * The streamable server answers `tools/list` as an event stream and everything
 * else as plain JSON, which is the awkward half of the protocol; the legacy
 * server only answers on its long GET, which is the other one. Both are real
 * sockets, so the header handling — session id, protocol version, auth — is
 * observed rather than assumed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { connectServer } from "#mcp/client.ts";
import type { McpServerConfig } from "#mcp/config.ts";
import { tempWorkspace, type TempWorkspace } from "./helpers.ts";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.AGENT_HOME = process.env.AGENT_HOME;
});

afterEach(() => {
  if (saved.AGENT_HOME === undefined) delete process.env.AGENT_HOME;
  else process.env.AGENT_HOME = saved.AGENT_HOME;
});

function home(ws: TempWorkspace): void {
  const dir = path.join(ws.dir, "home");
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_HOME = dir;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("the test server did not get a port"));
    });
  });
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function clientConfig(url: string, type: "http" | "sse", headers: Record<string, string> = {}): McpServerConfig {
  return {
    name: `net-${type}`,
    scope: "user",
    origin: "user",
    source: "test",
    type,
    args: [],
    env: {},
    url,
    headers,
    allow: [],
    timeoutMs: 5_000,
    disabled: false,
  };
}

const TOOLS = [
  {
    name: "echo",
    description: "echo over a socket",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
];

describe("streamable HTTP", () => {
  it("initializes, keeps the session, parses an SSE answer and closes with DELETE", async () => {
    const ws = tempWorkspace("mcp-http");
    home(ws);
    const seen: { method: string; protocol: string | undefined; session: string | undefined; auth: string | undefined }[] = [];
    let deleted = false;
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method === "DELETE") {
          deleted = true;
          response.writeHead(200).end();
          return;
        }
        const text = await readBody(request);
        let message: Record<string, unknown> = {};
        try {
          message = JSON.parse(text) as Record<string, unknown>;
        } catch {
          response.writeHead(400).end("not json");
          return;
        }
        seen.push({
          method: typeof message.method === "string" ? message.method : `response:${String(message.id)}`,
          protocol: typeof request.headers["mcp-protocol-version"] === "string" ? request.headers["mcp-protocol-version"] : undefined,
          session: typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : undefined,
          auth: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
        });
        if (message.method === "initialize") {
          response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-42" });
          response.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "streamable", version: "2.0.0" },
            },
          }));
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "tools/list") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } })}\n\n`);
          response.end();
          return;
        }
        if (message.method === "tools/call") {
          const params = (message.params ?? {}) as Record<string, unknown>;
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: `http:${String(args.text ?? "")}` }] },
          }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } }));
      })();
    });

    try {
      const port = await listen(server);
      const client = await connectServer(clientConfig(`http://127.0.0.1:${port}/mcp`, "http", { authorization: "Bearer test-token" }));
      expect(client.serverInfo.name).toBe("streamable");
      expect(client.tools.map((tool) => tool.name)).toEqual(["echo"]);
      const result = await client.callTool("echo", { text: "hi" }, 3_000);
      expect(result.text).toBe("http:hi");

      const init = seen.find((entry) => entry.method === "initialize");
      expect(init?.protocol).toBeUndefined();
      expect(init?.auth).toBe("Bearer test-token");
      const after = seen.filter((entry) => entry.method !== "initialize");
      expect(after.every((entry) => entry.session === "session-42")).toBe(true);
      expect(after.every((entry) => entry.protocol === "2025-06-18")).toBe(true);

      await client.close();
      expect(deleted).toBe(true);
    } finally {
      await stop(server);
      ws.cleanup();
    }
  });

  it("an HTTP error becomes the caller's error, with the status in it", async () => {
    const ws = tempWorkspace("mcp-http");
    home(ws);
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "text/plain" }).end("missing token");
    });
    try {
      const port = await listen(server);
      await expect(connectServer(clientConfig(`http://127.0.0.1:${port}/mcp`, "http"))).rejects.toThrow(/HTTP 401/);
    } finally {
      await stop(server);
      ws.cleanup();
    }
  });
});

describe("legacy SSE", () => {
  it("waits for the endpoint event and takes answers from the GET stream", async () => {
    const ws = tempWorkspace("mcp-sse");
    home(ws);
    let stream: ServerResponse | null = null;
    const seen: { protocol: string | undefined; auth: string | undefined }[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/sse") {
          seen.push({
            protocol: typeof request.headers["mcp-protocol-version"] === "string" ? request.headers["mcp-protocol-version"] : undefined,
            auth: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
          });
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          response.write("event: endpoint\ndata: /messages?sessionId=legacy-1\n\n");
          stream = response;
          return;
        }
        if (request.method === "POST" && url.pathname === "/messages") {
          const text = await readBody(request);
          response.writeHead(202).end("Accepted");
          let message: Record<string, unknown> = {};
          try {
            message = JSON.parse(text) as Record<string, unknown>;
          } catch {
            return;
          }
          if (message.method === "notifications/initialized") return;
          let result: unknown;
          if (message.method === "initialize") {
            result = {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "legacy", version: "0.9.0" },
            };
          } else if (message.method === "tools/list") {
            result = { tools: TOOLS };
          } else if (message.method === "tools/call") {
            const params = (message.params ?? {}) as Record<string, unknown>;
            const args = (params.arguments ?? {}) as Record<string, unknown>;
            result = { content: [{ type: "text", text: `sse:${String(args.text ?? "")}` }] };
          } else {
            stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } })}\n\n`);
            return;
          }
          // A real legacy server may answer before the POST returns; the client
          // holds the pending call either way.
          stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
          return;
        }
        response.writeHead(404).end();
      })();
    });

    try {
      const port = await listen(server);
      const client = await connectServer(clientConfig(`http://127.0.0.1:${port}/sse`, "sse", { authorization: "Bearer legacy" }));
      expect(client.serverInfo.name).toBe("legacy");
      const result = await client.callTool("echo", { text: "hi" }, 3_000);
      expect(result.text).toBe("sse:hi");
      expect(seen[0]?.auth).toBe("Bearer legacy");
      await client.close();
    } finally {
      stream = null;
      await stop(server);
      ws.cleanup();
    }
  });
});
