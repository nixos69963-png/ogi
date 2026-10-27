/**
 * GitHub, proved with a fake transport.
 *
 * Nothing here touches the network: `fetch` is replaced with a recorder, so these
 * tests can say what actually matters about a token-holding integration — where
 * the request goes, which header the secret ends up in, whether it leaks into
 * anything a person later reads, and what happens when GitHub says no.
 *
 * The writes are the other half. A comment, a pull request and a push all carry
 * `outward`, so the approver's answer — ask a person, refuse when nobody is
 * watching — is a property of the tool list, not of a prompt.
 */
import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import { createApprover } from "#guard/approval.ts";
import { CI_FIX_CAP, GithubError, GITHUB_READS, GITHUB_TOOLS, GITHUB_WRITES, ciReadCount, gh, parseRepo, pushCommand, repoFor, resetCiReads } from "#tools/github.ts";
import { closeShell, credentialInUrl, getShell, runCommand, toBashPath } from "#tools/shell.ts";
import { buildTools, toolMap } from "#tools/index.ts";
import { toolsFor } from "#factory/plan.ts";
import { tempWorkspace, testContext } from "./helpers.ts";

const SECRET = "ghp_S3cr3tValueNotForLogging";
const byName = toolMap(GITHUB_TOOLS);

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let captured: Captured[] = [];
/** The tests share one process with the MCP socket tests, which need the real fetch. */
const realFetch = globalThis.fetch;

function stubFetch(status = 200, body: unknown = {}, headers: Record<string, string> = {}): void {
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const options = (init ?? {}) as Record<string, unknown>;
    const raw = (options.headers ?? {}) as Record<string, string>;
    captured.push({
      url: String(input),
      method: String(options.method ?? "GET"),
      headers: { ...raw },
      body: typeof options.body === "string" ? options.body : "",
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as never;
}

afterEach(() => {
  captured = [];
  resetCiReads();
  globalThis.fetch = realFetch;
});

function ctx(overrides: Partial<Parameters<typeof testContext>[1]> = {}) {
  return testContext("D:/workstation/cli-demo", { githubToken: SECRET, githubRepo: "acme/widget", ...overrides });
}

describe("the token's one route", () => {
  it("puts the secret in exactly one header, on api.github.com, and nowhere in the answer", async () => {
    stubFetch(200, [{ number: 7, title: "Fix the parser", state: "open", updated_at: "2026-10-01T09:00:00Z", labels: [{ name: "bug" }] }]);
    const result = await byName.get("github_issues")!.execute({ state: "open" }, ctx());

    expect(captured.length).toBe(1);
    const request = captured[0]!;
    expect(new URL(request.url).host).toBe("api.github.com");
    expect(request.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(request.headers.accept).toContain("application/vnd.github+json");
    // The secret is in exactly one place — the header — and in nothing a person reads after.
    expect(JSON.stringify(request).split(SECRET).length - 1).toBe(1);
    expect(result.content).not.toContain(SECRET);
    expect(JSON.stringify(result.data ?? {})).not.toContain(SECRET);
    expect(result.content).toContain("#7 [open] Fix the parser");
  });

  it("leaves the header out entirely when no token is configured", async () => {
    stubFetch(200, [{ number: 1, title: "public", state: "open", labels: [] }]);
    const result = await byName.get("github_issues")!.execute({}, ctx({ githubToken: null }));
    expect(result.ok).toBe(true);
    expect(captured[0]!.headers.authorization).toBeUndefined();
  });

  it("sends nothing that is not api.github.com, whatever the path argument looks like", async () => {
    stubFetch(200, {});
    for (const attempt of ["//evil.com/steal", "https://evil.com/", "..%2f..%2fetc", "/repos/acme/widget/../../y"]) {
      const reply = await gh(ctx(), "GET", attempt);
      expect(new URL(captured[captured.length - 1]!.url).host).toBe("api.github.com");
      expect(reply.status).toBe(200);
    }
  });

  it("refuses a repository that is not an owner/name pair", () => {
    expect(() => parseRepo("widget")).toThrow(GithubError);
    expect(() => parseRepo("acme/widget/extra")).toThrow(GithubError);
    expect(() => parseRepo("acme/widget; rm -rf")).toThrow(GithubError);
    expect(parseRepo(" acme/widget ").slug).toBe("acme/widget");
    expect(() => repoFor(ctx({ githubRepo: null }), undefined)).toThrow(/GITHUB_REPO/);
    expect(repoFor(ctx({ githubRepo: null }), "other/repo").slug).toBe("other/repo");
  });
});

describe("what a GitHub call is allowed to be", () => {
  it("carries the effects the approver gates on", () => {
    for (const name of GITHUB_READS) expect(byName.get(name)!.effect).toBe("read");
    for (const name of GITHUB_WRITES) expect(byName.get(name)!.effect).toBe("outward");
    expect(new Set(GITHUB_TOOLS.map((spec) => spec.name)).size).toBe(GITHUB_TOOLS.length);
    for (const spec of GITHUB_TOOLS) expect(spec.description.length).toBeGreaterThan(80);
    expect(buildTools().filter((spec) => spec.name.startsWith("github_")).length).toBe(GITHUB_TOOLS.length);
  });

  it("asks a person for every GitHub write and refuses all three when nobody is watching", async () => {
    const silent = createApprover({ approvals: true, attended: false, confirm: async () => "yes" });
    for (const name of GITHUB_WRITES) {
      expect((await silent.decide({ tool: name, effect: "outward", summary: name })).allowed).toBe(false);
    }
    const watched = createApprover({ approvals: false, attended: true, confirm: async () => "no" });
    const asked = await watched.decide({ tool: "github_push", effect: "outward", summary: "push feature/x" });
    expect(asked.allowed).toBe(false);
    expect(watched.answered()).toBe(1);
    // reads cost nobody anything
    const autonomous = createApprover({ approvals: false, attended: false, confirm: async () => "no" });
    expect((await autonomous.decide({ tool: "github_issue", effect: "read", summary: "read #7" })).allowed).toBe(true);
  });

  it("gives every station the reads and only the builder the writes", () => {
    for (const kind of ["scout", "builder", "verifier"] as const) {
      for (const name of GITHUB_READS) expect(toolsFor(kind)).toContain(name);
    }
    for (const name of GITHUB_WRITES) {
      expect(toolsFor("builder")).toContain(name);
      expect(toolsFor("scout")).not.toContain(name);
      expect(toolsFor("verifier")).not.toContain(name);
      expect(toolsFor("reviewer")).not.toContain(name);
    }
  });
});

describe("a write that is not allowed to happen", () => {
  it("will not post without a token, and will not post an empty comment", async () => {
    stubFetch(201, { html_url: "https://github.com/acme/widget/issues/7#issuecomment-1" });
    const noToken = await byName.get("github_comment")!.execute({ number: 7, body: "hello" }, ctx({ githubToken: null }));
    expect(noToken.ok).toBe(false);
    expect(noToken.error).toContain("GITHUB_TOKEN");
    expect(captured.length).toBe(0);

    const empty = await byName.get("github_comment")!.execute({ number: 7, body: "   " }, ctx());
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("empty comment");
    expect(captured.length).toBe(0);
  });

  it("posts the body it was given, to the issue it was given", async () => {
    stubFetch(201, { html_url: "https://github.com/acme/widget/issues/7#issuecomment-1" });
    const result = await byName.get("github_comment")!.execute({ number: 7, body: "Fixed in 2f1a9c; bun test passes." }, ctx());
    expect(result.ok).toBe(true);
    const request = captured[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toContain("/repos/acme/widget/issues/7/comments");
    expect(JSON.parse(request.body).body).toBe("Fixed in 2f1a9c; bun test passes.");
    expect(result.content).toContain("issuecomment-1");
  });

  it("does not open a pull request from a branch to itself", async () => {
    stubFetch(201, { number: 12, html_url: "https://github.com/acme/widget/pull/12" });
    const same = await byName.get("github_pr")!.execute({ title: "x", head: "main", base: "main" }, ctx());
    expect(same.ok).toBe(false);
    expect(same.error).toContain("does not merge into itself");
    expect(captured.length).toBe(0);
  });

  it("says how to fix the two 422s a first pull request runs into", async () => {
    stubFetch(422, { message: "Validation Failed", errors: [{ message: "pull request already exists for these refs" }] });
    const exists = await byName.get("github_pr")!.execute({ title: "x", head: "feature/a", base: "main" }, ctx());
    expect(exists.error).toContain("already an open pull request");

    stubFetch(422, { message: "Validation Failed", errors: [{ message: "Head sha does not exist" }] });
    const missing = await byName.get("github_pr")!.execute({ title: "x", head: "feature/b", base: "main" }, ctx());
    expect(missing.error).toContain("Push it first");
    expect(missing.error).toContain("git push -u origin feature/b");
  });

  it("refuses a branch name that is not a branch name before touching git", async () => {
    for (const bad of ["", "feature; rm -rf", "-u", "$(whoami)", "two words", "a".repeat(300)]) {
      const result = await byName.get("github_push")!.execute({ branch: bad }, ctx());
      expect(result.ok, bad).toBe(false);
      expect(result.error).toContain("not a branch");
    }
  });

  it("reads a remote branch name as one ref, slashes and all", async () => {
    stubFetch(200, { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
    const result = await byName.get("github_ci")!.execute({ ref: "feature/json-flag" }, ctx());
    expect(result.ok).toBe(true);
    expect(captured[0]!.url).toContain("/repos/acme/widget/commits/feature/json-flag/check-runs");
  });
});

describe("the answers GitHub gives", () => {
  it("turns each status into something a station can act on", async () => {
    const cases: [number, Record<string, unknown>, Record<string, string>, string][] = [
      [401, { message: "Bad credentials" }, {}, "rejected the token"],
      [403, { message: "Resource not accessible by personal access token" }, {}, "missing a scope"],
      [403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }, "rate limit is spent"],
      [404, { message: "Not Found" }, {}, "private and this token cannot see it"],
    ];
    for (const [status, body, headers, phrase] of cases) {
      stubFetch(status, body, headers);
      const result = await byName.get("github_issue")!.execute({ number: 7 }, ctx());
      expect(result.ok, `${status}`).toBe(false);
      expect(result.error).toContain(phrase);
      expect(result.error).not.toContain(SECRET);
    }
  });

  it("leaves an HTML error page as text instead of pretending it parsed", async () => {
    stubFetch(502, "<html>502 Bad Gateway</html>");
    const result = await byName.get("github_issue")!.execute({ number: 7 }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("502");
  });

  /** Found live: a body cut to a tidy size before parsing made a long issue list read as empty. */
  it("still lists every issue when the reply is long", async () => {
    const page = Array.from({ length: 6 }, (_unused, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
      state: "open",
      labels: [],
      updated_at: "2026-10-01T09:00:00Z",
      body: "x".repeat(12_000),
    }));
    stubFetch(200, page);
    const result = await byName.get("github_issues")!.execute({ limit: 6 }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain("6 open issue(s)");
    expect(result.content).toContain("Issue 6");
    // an omitted filter still says what it assumed, on the wire and in the line
    expect(captured[0]!.url).toContain("state=open");
    expect(captured[0]!.url).toContain("per_page=6");
  });
});

describe("the CI fix round has a floor under it", () => {
  function failing(): void {
    stubFetch(200, { check_runs: [{ name: "test", status: "completed", conclusion: "failure", output: { title: "bun test failed", summary: "1 of 42 tests failed: expected 2 to be 3" } }] });
  }

  it("allows two looks at the same head, then stops asking for a third push", async () => {
    const ci = byName.get("github_ci")!;
    failing();
    const first = await ci.execute({ ref: "feature/a" }, ctx());
    expect(first.ok).toBe(true);
    expect(first.content).toContain("bun test failed");
    expect(first.content).toContain("fix round 1/2");

    failing();
    const second = await ci.execute({ ref: "feature/a" }, ctx());
    expect(second.content).toContain("fix round 2/2");
    expect(second.content).not.toContain("The cap is reached");

    failing();
    const third = await ci.execute({ ref: "feature/a" }, ctx());
    expect(third.content).toContain("The cap is reached");
    expect(third.content).toContain("Do not push again");
    expect(JSON.stringify(third.data)).toContain('"capped":true');
    expect(CI_FIX_CAP).toBe(2);
  });

  it("counts each head separately", async () => {
    failing();
    await byName.get("github_ci")!.execute({ ref: "feature/a" }, ctx());
    failing();
    const other = await byName.get("github_ci")!.execute({ ref: "feature/b" }, ctx());
    expect(other.content).toContain("fix round 1/2");
    expect(ciReadCount("acme/widget", "feature/a")).toBe(1);
    resetCiReads();
    expect(ciReadCount("acme/widget", "feature/a")).toBe(0);
  });
});

describe("the git side of a push", () => {
  it("builds a command git can actually read, with the helper only when there is a token", () => {
    const withToken = pushCommand({ token: true, branch: "feature/x", remote: "origin", upstream: true });
    expect(withToken.startsWith("GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c 'credential.helper=")).toBe(true);
    expect(withToken).toContain("push --set-upstream origin feature/x");
    // the variable name is in the string; the value never is
    expect(withToken).toContain("$GITHUB_TOKEN");
    expect(withToken).not.toContain(SECRET);
    const withoutToken = pushCommand({ token: false, branch: "main", remote: "upstream", upstream: false });
    expect(withoutToken).not.toContain("credential.helper");
    expect(withoutToken).toBe("GIT_TERMINAL_PROMPT=0 git  push upstream main 2>&1");
  });

  /**
   * The quoting above is either valid bash or it is not, and only a real shell
   * says which. This pushes into a bare repository on disk — no network, no
   * GitHub — so what is proved is the command form, not somebody's API.
   */
  it("pushes a branch for real, through the same command string", async () => {
    const run = tempWorkspace("gpush");
    const shell = getShell(run.dir);
    const remoteDir = `${path.basename(run.dir)}-remote.git`;
    const seed = await shell.run(
      `cd ${toBashPath(run.dir)} && git init -q -b test-branch && git config user.email agent@test && git config user.name agent && ` +
        `git commit -q --allow-empty -m seed && git init -q --bare ${toBashPath(path.join(run.dir, "..", remoteDir))} && ` +
        `git remote add origin ${toBashPath(path.join(run.dir, "..", remoteDir))} && git --version`,
      60_000,
      run.dir,
    );
    expect(seed.code, seed.output).toBe(0);

    const pushed = await byName.get("github_push")!.execute({ branch: "test-branch" }, testContext(run.dir, { githubToken: SECRET }));
    expect(pushed.ok, pushed.error).toBe(true);

    const arrived = await shell.run(`git ls-remote ${toBashPath(path.join(run.dir, "..", remoteDir))} 2>&1`, 30_000, run.dir);
    expect(arrived.code).toBe(0);
    expect(arrived.output).toContain("refs/heads/test-branch");
    // and the token is not sitting in the repository's config where a push wrote it
    const config = await shell.run(`cd ${toBashPath(run.dir)} && git remote get-url origin && cat .git/config`, 30_000, run.dir);
    expect(config.output).not.toContain(SECRET);

    closeShell(run.dir);
    run.cleanup();
  }, 90_000);
});

describe("a secret in a command line", () => {
  it("is caught in the URL form and as a bare token, with the secret taken out of what it reports", () => {
    expect(credentialInUrl("curl https://user:pw@acme.internal/x")).toBe("https://***@acme.internal");
    const asUsername = credentialInUrl("git push https://ghp_abcdef0123456789abcdef@github.com/acme/widget");
    expect(asUsername).toContain("ghp_");
    expect(asUsername).not.toContain("abcdef0123456789");
    expect(credentialInUrl("curl -H 'Authorization: Bearer ghp_abcdef0123456789abcdef' https://api.github.com")).toContain("GitHub token");
  });

  it("does not mistake a normal command, a port or a public URL for a credential", () => {
    for (const safe of ["git push origin main", "curl https://api.github.com/repos/acme/widget", "bun test", "ollama serve", "ssh git@github.com"]) {
      expect(credentialInUrl(safe), safe).toBeNull();
    }
  });

  it("is refused before the command runs", async () => {
    const result = await runCommand.execute({ command: `git remote set-url origin https://x-access-token:${SECRET}@github.com/acme/widget` }, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Refused");
    expect(result.error).toContain("***@github.com");
    // the hint names the way out, and it travels in data, not in the secret-free line
    expect(JSON.stringify(result.data)).toContain("github_push");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
