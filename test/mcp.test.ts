/**
 * MCP without a network: a real child process speaking the real protocol.
 *
 * The fixture is a server, not a mock — it is spawned, handshaken, listed and
 * called over the same pipes a third-party server would use. What is asserted is
 * the part this CLI owns: the tool shape it builds, the gate it applies, and the
 * trust decision a project file has to pass.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectServer, type McpClient } from "#mcp/client.ts";
import { loadMcpConfig, type LoadedMcp, type McpServerConfig } from "#mcp/config.ts";
import { McpHub } from "#mcp/hub.ts";
import { parseAdd } from "#mcp/setup.ts";
import { mcpToolName, mcpToolSpecs } from "#mcp/tools.ts";
import { approveServer, isTrusted, revokeServer, serverFingerprint } from "#mcp/trust.ts";
import { loadCommands, matchCommand } from "#core/commands.ts";
import { tempWorkspace, testContext, type TempWorkspace } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.AGENT_HOME = process.env.AGENT_HOME;
  saved.AGENT_MCP = process.env.AGENT_MCP;
  saved.AGENT_MCP_TRUST_PROJECT = process.env.AGENT_MCP_TRUST_PROJECT;
});

afterEach(() => {
  for (const key of ["AGENT_HOME", "AGENT_MCP", "AGENT_MCP_TRUST_PROJECT"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function home(ws: TempWorkspace): string {
  const dir = path.join(ws.dir, "home");
  mkdirSync(dir, { recursive: true });
  process.env.AGENT_HOME = dir;
  return dir;
}

function stdioConfig(name = "fixture", overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name,
    scope: "user",
    origin: "user",
    source: "test",
    type: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    headers: {},
    allow: [],
    timeoutMs: 5_000,
    disabled: false,
    ...overrides,
  };
}

describe("stdio MCP client", () => {
  it("initializes, lists annotated tools, calls them, and closes", async () => {
    const ws = tempWorkspace("mcp");
    try {
      const client = await connectServer(stdioConfig());
      expect(client.serverInfo.name).toBe("fixture");
      expect(client.serverInfo.version).toBe("1.2.3");
      expect(client.instructions).toContain("prove the client");
      expect(client.tools.map((tool) => tool.name)).toEqual(["echo", "remove", "slow", "explode"]);
      const echo = client.tools.find((tool) => tool.name === "echo");
      expect(echo?.readOnly).toBe(true);
      expect(client.tools.find((tool) => tool.name === "remove")?.destructive).toBe(true);

      const result = await client.callTool("echo", { text: "hi" }, 3_000);
      expect(result.ok).toBe(true);
      expect(result.text).toBe("echo:hi");
      expect(result.data).toEqual({ echoed: "hi" });

      const failed = await client.callTool("explode", {}, 3_000);
      expect(failed.ok).toBe(false);
      expect(failed.text).toContain("broke on purpose");

      await client.close();
    } finally {
      ws.cleanup();
    }
  });

  it("a call that never answers times out with a readable error", async () => {
    const ws = tempWorkspace("mcp");
    try {
      const client = await connectServer(stdioConfig());
      await expect(client.callTool("slow", {}, 250)).rejects.toThrow(/timed out/);
      await client.close();
    } finally {
      ws.cleanup();
    }
  });

  it("tool specs are write-effect, honour annotations and the allow-list", async () => {
    const ws = tempWorkspace("mcp");
    try {
      const client = await connectServer(stdioConfig("kit", { allow: ["echo"] }));
      const specs = mcpToolSpecs(client);
      const echo = specs.find((spec) => spec.name === "mcp__kit__echo");
      const remove = specs.find((spec) => spec.name === "mcp__kit__remove");
      expect(echo).toBeDefined();
      expect(remove).toBeDefined();
      expect(echo?.effect).toBe("write");
      expect(remove?.effect).toBe("write");
      expect(echo?.description).toContain('server "kit"');
      expect(echo?.description).toContain("data from an external service");

      const ctx = testContext(ws.dir);
      const echoApproval = echo!.describe!({ text: "hi" }, ctx);
      expect(echoApproval.autoAllow).toBe(true);
      expect(echoApproval.risky).toBeUndefined();
      const removeApproval = remove!.describe!({ path: "C:\\x" }, ctx);
      expect(removeApproval.autoAllow).toBeUndefined();
      expect(removeApproval.risky).toContain("destructive");

      const ok = await echo!.execute({ text: "spec" }, ctx);
      expect(ok.ok).toBe(true);
      expect(ok.content).toBe("echo:spec");
      const bad = await specs.find((spec) => spec.name === "mcp__kit__explode")!.execute({}, ctx);
      expect(bad.ok).toBe(false);
      expect(bad.content.startsWith("ERROR:")).toBe(true);

      await client.close();
    } finally {
      ws.cleanup();
    }
  });

  it("names are provider-safe and collisions get a suffix", () => {
    const long = mcpToolName("a-very-long-server-name-that-goes-on-and-on-and-on", "another-very-long-tool-name-that-also-goes-on");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^mcp__/);
    const server = stdioConfig("s");
    const fake = {
      config: server,
      serverInfo: { name: "s", version: "1" },
      protocolVersion: "1",
      instructions: "",
      tools: [
        { name: "a b", title: "A", description: "", inputSchema: {}, readOnly: false, destructive: false, idempotent: false, openWorld: false },
        { name: "a-b", title: "B", description: "", inputSchema: {}, readOnly: false, destructive: false, idempotent: false, openWorld: false },
      ],
      callTool: async () => ({ ok: true, text: "" }),
      close: async () => {},
    } satisfies McpClient;
    const names = mcpToolSpecs(fake).map((spec) => spec.name);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).not.toBe(names[1]);
  });
});

describe("MCP configuration and trust", () => {
  it("project servers load as untrusted until approved, and a change re-opens the question", async () => {
    const ws = tempWorkspace("mcp");
    try {
      home(ws);
      const file = ws.write(".mcp.json", JSON.stringify({
        mcpServers: {
          proj: { command: "bun", args: ["server.ts"], env: { TOKEN: "${MCP_TEST_TOKEN:-fallback}" } },
        },
      }));
      process.env.MCP_TEST_TOKEN = "secret";
      const loaded = loadMcpConfig(ws.dir);
      expect(loaded.errors).toEqual([]);
      expect(loaded.files).toContain(file);
      const server = loaded.servers[0]!;
      expect(server.name).toBe("proj");
      expect(server.origin).toBe("project");
      expect(server.scope).toBe("project");
      expect(server.type).toBe("stdio");
      expect(server.env.TOKEN).toBe("secret");
      expect(isTrusted(server)).toBe(false);

      approveServer(server);
      expect(isTrusted(server)).toBe(true);
      const fingerprint = serverFingerprint(server);
      approveServer(server);
      expect(serverFingerprint(server)).toBe(fingerprint);

      const changed = { ...server, args: ["server.ts", "--extra"] };
      expect(serverFingerprint(changed)).not.toBe(fingerprint);
      expect(isTrusted(changed)).toBe(false);

      revokeServer("proj");
      expect(isTrusted(server)).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("missing variables are reported, not silently emptied, and ws is refused", () => {
    const ws = tempWorkspace("mcp");
    try {
      home(ws);
      ws.write(".mcp.json", JSON.stringify({
        mcpServers: {
          ws: { type: "ws", url: "ws://127.0.0.1:9000" },
          bare: { command: "bun", args: ["${MCP_ABSENT_XYZ}"] },
        },
      }));
      delete process.env.MCP_ABSENT_XYZ;
      const loaded = loadMcpConfig(ws.dir);
      expect(loaded.errors.join("\n")).toContain("WebSocket");
      expect(loaded.servers.map((server) => server.name)).toEqual(["bare"]);
      expect(loaded.servers[0]!.args[0]).toBe("${MCP_ABSENT_XYZ}");
      expect(loaded.warnings.join("\n")).toContain("MCP_ABSENT_XYZ");
    } finally {
      ws.cleanup();
    }
  });

  it("AGENT_MCP=0 turns the whole client off", () => {
    const ws = tempWorkspace("mcp");
    try {
      home(ws);
      ws.write(".mcp.json", JSON.stringify({ mcpServers: { x: { command: "bun" } } }));
      process.env.AGENT_MCP = "0";
      const loaded = loadMcpConfig(ws.dir);
      expect(loaded.servers).toEqual([]);
      expect(loaded.warnings.join(" ")).toContain("AGENT_MCP=0");
    } finally {
      ws.cleanup();
    }
  });

  it("a user plugin contributes commands and a trusted, namespaced server", () => {
    const ws = tempWorkspace("mcp");
    try {
      const dir = home(ws);
      const root = path.join(dir, "plugins", "kit");
      mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
      mkdirSync(path.join(root, "commands"), { recursive: true });
      writeFileSync(
        path.join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "kit", description: "test plugin", mcpServers: { local: { command: "bun", args: ["srv.ts"] } } }),
        "utf8",
      );
      writeFileSync(path.join(root, "commands", "review.md"), "# Review the current diff\n\nRead it and report.\n", "utf8");

      const loaded = loadMcpConfig(ws.dir);
      expect(loaded.errors).toEqual([]);
      expect(loaded.servers.map((server) => server.name)).toEqual(["plugin:kit:local"]);
      const server = loaded.servers[0]!;
      expect(server.scope).toBe("plugin");
      expect(server.origin).toBe("user");
      expect(isTrusted(server)).toBe(true);

      const commands = loadCommands(ws.dir);
      const review = matchCommand("/kit:review the diff", commands);
      expect(review?.command.description).toBe("Review the current diff");
      expect(review?.args).toBe("the diff");
    } finally {
      ws.cleanup();
    }
  });
});

describe("the in-session add command", () => {
  it("reads a quoted stdio command line the way a shell would", () => {
    const parsed = parseAdd('fs -- npx -y @modelcontextprotocol/server-filesystem "C:/My Docs"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.name).toBe("fs");
    expect(parsed.command.scope).toBe("user");
    expect(parsed.command.entry).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "C:/My Docs"],
    });
  });

  it("reads the URL form, its headers, environment, allow-list and scope", () => {
    const parsed = parseAdd(
      'api --url https://example.com/mcp --header "Authorization: Bearer t" -e TOKEN=x --allow get-sum,echo --timeout 30 --project',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.scope).toBe("project");
    expect(parsed.command.entry).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer t" },
      env: { TOKEN: "x" },
      allow: ["get-sum", "echo"],
      timeout_ms: 30_000,
    });
  });

  it("takes a pasted JSON entry and refuses a broken one", () => {
    const parsed = parseAdd('fs {"command":"bun","args":["server.ts"]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command.entry).toEqual({ command: "bun", args: ["server.ts"] });
    expect(parseAdd("fs {oops}").ok).toBe(false);
    expect(parseAdd("").ok).toBe(false);
  });
});

describe("MCP hub", () => {
  function fakeClient(config: McpServerConfig): McpClient {
    return {
      config,
      serverInfo: { name: "fake", version: "9" },
      protocolVersion: "2025-06-18",
      instructions: "be careful",
      tools: [
        {
          name: "echo",
          title: "Echo",
          description: "echo",
          inputSchema: { type: "object", properties: {} },
          readOnly: true,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      ],
      callTool: async () => ({ ok: true, text: "ok" }),
      close: async () => {},
    };
  }

  it("connects trusted servers, holds project servers pending, and approves on request", async () => {
    const ws = tempWorkspace("mcp");
    try {
      home(ws);
      const user = stdioConfig("user");
      const project = stdioConfig("project", { origin: "project", scope: "project" });
      const loaded: LoadedMcp = { servers: [user, project], errors: [], warnings: [], files: [] };
      let connects = 0;
      const hub = new McpHub(ws.dir, {
        loaded,
        connect: async (config) => {
          connects += 1;
          return fakeClient(config);
        },
      });
      await hub.start();
      expect(connects).toBe(1);
      expect(hub.status("user")?.state).toBe("connected");
      expect(hub.status("project")?.state).toBe("pending");
      expect(hub.specs().map((spec) => spec.name)).toEqual(["mcp__user__echo"]);
      expect(hub.summary()).toContain("1 connected");
      expect(hub.summary()).toContain("1 pending");
      expect(hub.promptBrief()).toContain("be careful");

      const approved = await hub.approve("project");
      expect(approved.ok).toBe(true);
      expect(connects).toBe(2);
      expect(hub.specs().map((spec) => spec.name)).toEqual(["mcp__user__echo", "mcp__project__echo"]);
      expect(isTrusted(project)).toBe(true);

      await hub.stop();
      expect(hub.specs()).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });

  it("a failed server is reported, not hidden", async () => {
    const ws = tempWorkspace("mcp");
    try {
      home(ws);
      const loaded: LoadedMcp = { servers: [stdioConfig("broken")], errors: [], warnings: [], files: [] };
      const hub = new McpHub(ws.dir, {
        loaded,
        connect: async () => {
          throw new Error("spawn failed: npx not found");
        },
      });
      await hub.start();
      expect(hub.status("broken")?.state).toBe("failed");
      expect(hub.status("broken")?.error).toContain("npx not found");
      expect(hub.errors().join(" ")).toContain("broken");
      await hub.stop();
    } finally {
      ws.cleanup();
    }
  });

  it("adds a server to the file, connects it in this session, and removes it again", async () => {
    const ws = tempWorkspace("mcp");
    try {
      const dir = home(ws);
      const loaded: LoadedMcp = { servers: [], errors: [], warnings: [], files: [] };
      const hub = new McpHub(ws.dir, { loaded, connect: async (config) => fakeClient(config) });
      await hub.start();

      const added = await hub.add("live", { type: "stdio", command: "bun", args: ["server.ts"] }, "user");
      expect(added.ok).toBe(true);
      expect(hub.status("live")?.state).toBe("connected");
      expect(hub.specs().map((spec) => spec.name)).toEqual(["mcp__live__echo"]);
      const file = path.join(dir, "mcp.json");
      expect(readFileSync(file, "utf8")).toContain('"live"');

      const duplicate = await hub.add("live", { type: "stdio", command: "bun" }, "user");
      expect(duplicate.ok).toBe(false);

      const pending = await hub.add("proj", { type: "stdio", command: "bun", args: ["s.ts"] }, "project");
      expect(pending.ok).toBe(true);
      expect(pending.status?.state).toBe("pending");

      const removed = await hub.remove("live");
      expect(removed.ok).toBe(true);
      expect(hub.status("live")).toBeUndefined();
      expect(readFileSync(file, "utf8")).not.toContain('"live"');
      expect((await hub.remove("live")).ok).toBe(false);
      await hub.stop();
    } finally {
      ws.cleanup();
    }
  });
});

