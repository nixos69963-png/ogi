/**
 * The browser group, proved without opening a window.
 *
 * What matters here is the shape of the door, not the page: which effects each
 * action carries (that is what the approver reads), what is refused before Chrome
 * is ever touched, and what the factory line may hold. The driving itself was run
 * against a real Chromium — navigate, index, click, type, screenshot, tabs — and
 * needs a browser to repeat, so it is not in a test that must pass on a machine
 * without one.
 */
import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserSettings, findChrome, findLive, launchAttempts, launchDied, recordedPort, type BrowserSettings } from "#browser/cdp.ts";
import { createApprover } from "#guard/approval.ts";
import { buildTools, toolMap } from "#tools/index.ts";
import { BROWSER_OBSERVE, BROWSER_TOOLS } from "#tools/browser.ts";
import { toolsFor } from "#factory/plan.ts";
import { tempWorkspace, testContext } from "./helpers.ts";

const byName = toolMap(BROWSER_TOOLS);

/** A workspace the tests never create: every call here is refused before a file is touched. */
const NOWHERE = path.join(os.tmpdir(), "agent-cli-browser-test");

async function call(name: string, args: Record<string, unknown> = {}, workspace = NOWHERE) {
  const spec = byName.get(name);
  if (!spec) throw new Error(`no tool named ${name}`);
  return spec.execute(args as never, testContext(workspace));
}

describe("what each browser action is allowed to be", () => {
  it("carries the effects the approver gates on", () => {
    const outward = ["browser_click", "browser_type", "browser_press", "browser_select"];
    const readable = ["browser_open", "browser_state", "browser_extract", "browser_scroll", "browser_history", "browser_tab"];
    for (const name of outward) expect(byName.get(name)!.effect).toBe("outward");
    for (const name of readable) expect(byName.get(name)!.effect).toBe("read");
    expect(byName.get("browser_screenshot")!.effect).toBe("compute");
    expect(byName.get("browser_close")!.effect).toBe("compute");
  });

  it("is advertised by the registry with a description the model can steer by", () => {
    const all = buildTools();
    for (const spec of BROWSER_TOOLS) {
      expect(all.some((tool) => tool.name === spec.name)).toBe(true);
      expect(spec.description.length).toBeGreaterThan(80);
    }
    expect(new Set(BROWSER_TOOLS.map((spec) => spec.name)).size).toBe(BROWSER_TOOLS.length);
  });

  it("refuses an outward browser action when nobody is watching, and asks when somebody is", async () => {
    const silent = createApprover({ approvals: true, attended: false, confirm: async () => "yes" });
    const alone = await silent.decide({ tool: "browser_click", effect: "outward", summary: "click element 3" });
    expect(alone.allowed).toBe(false);

    const watched = createApprover({ approvals: true, attended: true, confirm: async () => "no" });
    const asked = await watched.decide({ tool: "browser_type", effect: "outward", summary: "type into 4" });
    expect(asked.allowed).toBe(false);
    expect(watched.answered()).toBe(1);

    // approvals=off buys writes, not a voice: outward still needs the person.
    const autonomous = createApprover({ approvals: false, attended: false, confirm: async () => "yes" });
    expect((await autonomous.decide({ tool: "browser_press", effect: "outward", summary: "press Enter" })).allowed).toBe(false);
  });

  it("lets an unattended run read a page, because loading one changes nothing", async () => {
    const silent = createApprover({ approvals: true, attended: false, confirm: async () => "no" });
    const opened = await silent.decide({ tool: "browser_open", effect: "read", summary: "open https://example.com in the browser" });
    expect(opened.allowed).toBe(true);
    if (opened.allowed) expect(opened.approvedBy).toBe("policy");
    expect(silent.answered()).toBe(0);
  });
});

describe("refusals that happen before a window exists", () => {
  it("will not read the local disk through the browser", async () => {
    const result = await call("browser_open", { url: "file:///C:/Windows/win.ini" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not allowed");
    expect(result.content).toContain("read_file");
  });

  it("will not reach a machine-local service", async () => {
    for (const url of ["http://localhost:11434/api/tags", "http://127.0.0.1:8080/admin", "http://192.168.1.1/"]) {
      const result = await call("browser_open", { url });
      expect(result.ok, url).toBe(false);
      expect(result.content).toContain("Refused");
    }
  });

  it("says what is wrong with a URL that is not one", async () => {
    const result = await call("browser_open", { url: "example.com if you can" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("not a URL");
  });

  it("asks for a fresh reading instead of clicking a number that is gone", async () => {
    const result = await call("browser_click", { index: 0 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("browser_state");
  });

  it("needs the text before it types anything", async () => {
    expect((await call("browser_type", { index: 3, text: "" })).ok).toBe(false);
    expect((await call("browser_type", { index: NaN, text: "x" })).ok).toBe(false);
    expect((await call("browser_press", { key: "  " })).ok).toBe(false);
    expect((await call("browser_select", { option: "a" })).ok).toBe(false);
  });

  it("reports no session rather than starting one to close it", async () => {
    const result = await call("browser_close");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("No browser session");
  });
});

describe("the settings a machine actually has", () => {
  it("keeps the profile where Chrome can open it: local app data on Windows, the workspace elsewhere", () => {
    const workspace = tempWorkspace("browser");
    const local = tempWorkspace("browser-local");
    const before = { profile: process.env.AGENT_BROWSER_PROFILE, local: process.env.LOCALAPPDATA };
    try {
      delete process.env.AGENT_BROWSER_PROFILE;
      const expected =
        process.platform === "win32"
          ? path.join((process.env.LOCALAPPDATA = local.dir), "agent", "browser-profile")
          : path.join(workspace.dir, ".agent", "browser-profile");
      expect(browserSettings(workspace.dir).profileDir).toBe(expected);
    } finally {
      if (before.profile === undefined) delete process.env.AGENT_BROWSER_PROFILE;
      else process.env.AGENT_BROWSER_PROFILE = before.profile;
      if (before.local === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = before.local;
    }
    expect(browserSettings(workspace.dir).port).toBe(9333);
    workspace.cleanup();
    local.cleanup();
  });

  it("takes an explicit browser, port and profile, and falls back when a port is nonsense", () => {
    const before = { ...process.env };
    try {
      process.env.AGENT_BROWSER_PORT = "9999";
      process.env.AGENT_BROWSER_PROFILE = "D:/somewhere/else/profile";
      const settings = browserSettings(NOWHERE);
      expect(settings.port).toBe(9999);
      expect(settings.profileDir).toBe("D:/somewhere/else/profile");

      process.env.AGENT_BROWSER_PORT = "80";
      expect(browserSettings(NOWHERE).port).toBe(9333);

      process.env.AGENT_BROWSER_EXECUTABLE = "D:/not/here/chrome.exe";
      expect(findChrome()).toBeNull();
    } finally {
      for (const key of ["AGENT_BROWSER_PORT", "AGENT_BROWSER_PROFILE", "AGENT_BROWSER_EXECUTABLE"]) delete process.env[key];
      Object.assign(process.env, before);
    }
  });

  it("names the browser it found, or says there is none", () => {
    const found = findChrome();
    if (found) expect(found.length).toBeGreaterThan(4);
    expect(typeof browserSettings(NOWHERE).headless).toBe("boolean");
  });

  it("reads the Windows launcher's exit as a hand-off, not a death", () => {
    // `chrome.exe` spawns the browser under its own PID and exits 0 inside ~100ms.
    // Reading that exit as a crash abandoned a DevTools port that was about to open
    // and retried into a second Chrome — which is how "the profile is held by
    // another window" got manufactured out of a clean machine.
    expect(launchDied(null)).toBe(false);
    expect(launchDied({ code: 0, spawnFailed: false })).toBe(false);
    expect(launchDied({ code: null, spawnFailed: false })).toBe(false);
    // Only a failed spawn or a real non-zero exit means no browser is coming.
    expect(launchDied({ code: 21, spawnFailed: false })).toBe(true);
    expect(launchDied({ code: 0, spawnFailed: true })).toBe(true);
  });
});

describe("the line's share of the browser", () => {
  it("lets a scout look but never act on a page", () => {
    const scout = toolsFor("scout");
    expect(scout).toContain("browser_state");
    expect(scout).toContain("browser_extract");
    expect(scout).not.toContain("browser_type");
    expect(scout).not.toContain("browser_click");
    expect(scout).not.toContain("browser_screenshot");
  });

  it("gives the verifier the same eyes and the builder none", () => {
    expect(toolsFor("verifier")).toContain("browser_scroll");
    expect(toolsFor("builder")).not.toContain("browser_open");
    expect(toolsFor("reviewer")).not.toContain("browser_state");
    for (const name of BROWSER_OBSERVE) expect(toolsFor("scout").concat(toolsFor("verifier"))).toContain(name);
  });
});

describe("when Chrome will not open the port", () => {
  const profileDir = path.join(NOWHERE, "browser-profile");
  const settings = (over: Partial<BrowserSettings> = {}): BrowserSettings => ({
    port: 9333,
    executable: null,
    headless: true,
    profileDir,
    ...over,
  });

  it("starts where the operator pointed and moves port and profile together", () => {
    const attempts = launchAttempts(settings());
    expect(attempts.length).toBe(3);
    expect(attempts[0]).toEqual({ port: 9333, profileDir });
    expect(attempts[1]).toEqual({ port: 9334, profileDir: `${profileDir}-alt1` });
    expect(attempts[2]).toEqual({ port: 9335, profileDir: `${profileDir}-alt2` });
  });

  it("reads the port Chrome recorded, and refuses anything that is not one", () => {
    const ws = tempWorkspace("recorded-port");
    try {
      const dir = path.join(ws.dir, "profile");
      mkdirSync(dir, { recursive: true });
      expect(recordedPort(dir)).toBeNull();
      writeFileSync(path.join(dir, "DevToolsActivePort"), "0\n/devtools/browser/x\n");
      expect(recordedPort(dir)).toBeNull();
      writeFileSync(path.join(dir, "DevToolsActivePort"), "9344\n/devtools/browser/x\n");
      expect(recordedPort(dir)).toBe(9344);
    } finally {
      ws.cleanup();
    }
  });

  it("attaches to a Chrome that is already serving the profile instead of fighting it", async () => {
    const live = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/stand-in", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/x" }));
    });
    await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", () => resolve()));
    const livePort = (live.address() as AddressInfo).port;
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", () => resolve()));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const ws = tempWorkspace("live-chrome");
    try {
      const dir = path.join(ws.dir, "profile");
      mkdirSync(dir, { recursive: true });
      // Nothing answers on the configured port; the profile knows where the browser is.
      writeFileSync(path.join(dir, "DevToolsActivePort"), `${livePort}\n/devtools/browser/x\n`);
      const found = await findLive(settings({ port: deadPort, profileDir: dir }));
      expect(found?.port).toBe(livePort);
      expect(found?.info.Browser).toBe("Chrome/stand-in");

      // No recorded port and no answer: null, which is what sends the caller to launch.
      expect(await findLive(settings({ port: deadPort, profileDir: ws.dir }))).toBeNull();
    } finally {
      live.close();
      ws.cleanup();
    }
  });
});
