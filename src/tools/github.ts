/**
 * GitHub, over its REST API and nothing else.
 *
 * No `gh` CLI, no SDK: the token then has exactly one handler in this codebase —
 * the `authorization` header below. A secret that can travel through a command
 * line travels into the action log, into `ps`, and into every backup of it.
 *
 * The split with git is deliberate. A branch is made and pushed by the machine's
 * own git, in the workspace, the way the operator would; the API only ever
 * *talks about* it — opens the pull request, reads what CI made of it. So no file
 * content is ever re-uploaded through a second route that bypasses your review.
 *
 * Where the safety sits:
 *   - Reading an issue, listing issues, reading CI: `read`. They work without a
 *     token on a public repo, and a token raises the rate limit.
 *   - Commenting, opening a pull request, pushing: `outward`. They ask a person
 *     and are refused when nobody is watching, because GitHub keeps what it is
 *     given and the whole team reads it.
 *   - `GITHUB_REPO` (or a `repo` argument) is the only repository reachable, and
 *     every path is built onto https://api.github.com, so nothing else gets the
 *     token even by accident.
 *   - The CI fix round is capped: after two reads of the same failing head, the
 *     tool says stop instead of feeding another attempt.
 */
import { clip } from "#core/history.ts";
import type { ToolContext, ToolResult, ToolSpec } from "#core/types.ts";
import { bool, err, enumerate, num, obj, ok, str, tool } from "./define.ts";
import { getShell, toBashPath } from "./shell.ts";

const API_HOST = "api.github.com";
const API_BASE = `https://${API_HOST}`;
const API_VERSION = "2022-11-28";
/** A page of issues, at most. Beyond this the model is reading a changelog, not working. */
const MAX_PAGE = 50;
/**
 * Parse ceiling, not a transcript ceiling. Cutting a JSON body to a pretty size
 * *before* parsing is how a long issue list turns into "no issues" — the tool
 * output is clipped per field instead, after the parse that has to stay whole.
 */
const MAX_PARSE = 400_000;
/** What of an unparsable reply (an HTML error page from a proxy) is worth keeping. */
const MAX_ERROR_TEXT = 4_000;

/** Two looks at the same failing head, then the line has to say what is wrong. */
export const CI_FIX_CAP = 2;

export class GithubError extends Error {}

export interface Repo {
  owner: string;
  name: string;
  slug: string;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * Branch and sha characters only; `/` stays readable for `feature/x`. Bounded,
 * because a 300-character "branch" that reaches a shell is a bug looking for a
 * quoting mistake to prove itself with.
 */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function parseRepo(value: string): Repo {
  const trimmed = value.trim();
  if (!SLUG.test(trimmed)) throw new GithubError(`"${trimmed.slice(0, 60)}" is not an "owner/name" repository. Set GITHUB_REPO or pass repo.`);
  const [owner = "", name = ""] = trimmed.split("/");
  return { owner, name, slug: `${owner}/${name}` };
}

/** The repo for one call: the argument if there is one, otherwise the configured project. */
export function repoFor(ctx: ToolContext, override: unknown): Repo {
  const raw = typeof override === "string" && override.trim() ? override : ctx.config.githubRepo ?? "";
  if (!raw) throw new GithubError("No repository is configured. Set GITHUB_REPO=owner/name, or pass repo on this call.");
  return parseRepo(raw);
}

function ref(value: unknown, what: string): string {
  const raw = String(value ?? "").trim();
  // One message for every bad ref, empty included: two wordings would be two
  // things for the model to get wrong in the same way.
  if (!REF.test(raw) || raw.includes("..")) {
    throw new GithubError(`${what} "${raw.slice(0, 60)}" is not a branch, tag or commit. Use a name like main or feature/x, or a sha.`);
  }
  return raw;
}

function integer(value: unknown, what: string, max = 2_147_483_647): number {
  const n = Math.trunc(Number(value ?? NaN));
  if (!Number.isFinite(n) || n < 1 || n > max) throw new GithubError(`${what} must be a positive whole number, got "${String(value ?? "")}".`);
  return n;
}

/**
 * One segment of a path, encoded. `/` is put back so `feature/x` stays one ref
 * instead of two path segments that GitHub would not match.
 */
function seg(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, "/");
}

export interface Reply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/** The only place the token is ever read, and the only place it is ever written. */
function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function gh(
  ctx: ToolContext,
  method: "GET" | "POST" | "PATCH",
  apiPath: string,
  options: { query?: Record<string, string | number>; body?: unknown } = {},
): Promise<Reply> {
  const url = new URL(API_BASE + (apiPath.startsWith("/") ? apiPath : `/${apiPath}`));
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
  // The base pins the host, but say it out loud: this is the check that keeps the
  // token on this one request.
  if (url.host !== API_HOST) throw new GithubError(`Refusing to send a request to ${url.host}. GitHub calls go to ${API_HOST} only.`);

  const token = ctx.config.githubToken;
  const res = await fetch(url.toString(), {
    method,
    signal: ctx.signal,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "agent-cli/1.0 (+local working agent)",
      "x-github-api-version": API_VERSION,
      ...(token ? authHeader(token) : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const raw = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(raw.slice(0, MAX_PARSE));
  } catch {
    body = clip(raw, MAX_ERROR_TEXT);
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: res.status, body, headers };
}

function messageOf(reply: Reply): string {
  const body = reply.body as { message?: string; errors?: Array<{ message?: string }> } | null;
  if (!body || typeof body !== "object") return "";
  const nested = Array.isArray(body.errors) ? body.errors.map((e) => e?.message ?? "").filter(Boolean).join("; ") : "";
  return [body.message ?? "", nested].filter(Boolean).join(" — ");
}

/** A status number is not actionable; this sentence is. */
export function explain(reply: Reply, repo: string): string {
  const detail = messageOf(reply);
  if (reply.status === 401) return "GitHub rejected the token (401). It is expired or revoked — re-create it and set GITHUB_TOKEN again.";
  if (reply.status === 403) {
    if (reply.headers["x-ratelimit-remaining"] === "0") return "GitHub rate limit is spent (403). It resets within the hour; check `agent config` for the token in use.";
    return `GitHub refused with 403 for ${repo}. The token is missing a scope (needs contents:write for a push, pull_requests:write for a PR)${detail ? `: ${detail}` : ""}.`;
  }
  if (reply.status === 404) {
    return ctxless404(repo, detail);
  }
  if (reply.status === 422) return `GitHub could not accept that (422)${detail ? `: ${detail}` : ""}.`;
  return `HTTP ${reply.status} from GitHub for ${repo}${detail ? `: ${detail}` : ""}`;
}

/** A private repo with no token is indistinguishable from one that does not exist. */
function ctxless404(repo: string, detail: string): string {
  return `GitHub has nothing at ${repo} for this caller (404). Either the name is wrong or the repository is private and this token cannot see it${detail ? `: ${detail}` : ""}.`;
}

function failure(reply: Reply, repo: string): ToolResult {
  return err(explain(reply, repo), { status: reply.status });
}

function labelList(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((l) => String((l as { name?: string }).name ?? "")).filter(Boolean).join(",");
}

/** `${repo}#${ref}` → how many times CI has been read for it this session. */
const ciReads = new Map<string, number>();

/** The cap, as a number of reads already spent on this head. Exported for the test. */
export function ciReadCount(repo: string, refName: string): number {
  return ciReads.get(`${repo}#${refName}`) ?? 0;
}

export function resetCiReads(): void {
  ciReads.clear();
}

const readIssue = tool({
  name: "github_issue",
  description:
    "Read one issue or PR on the configured repository: number, state, author, labels and the body. " +
    "No token needed for a public repo. This does not post anything.",
  effect: "read",
  inputSchema: obj({ number: num("The issue or PR number, e.g. 41."), repo: str("Optional owner/name. Defaults to GITHUB_REPO.") }, ["number"]),
  describe: (input) => ({ summary: `read issue #${String(input.number ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const repo = repoFor(ctx, input.repo);
      const n = integer(input.number, "number");
      const reply = await gh(ctx, "GET", `/repos/${repo.slug}/issues/${n}`);
      if (reply.status !== 200) return failure(reply, repo.slug);
      const issue = reply.body as Record<string, unknown>;
      const comments = Number(issue.comments ?? 0);
      return ok(
        [
          `#${n} ${String(issue.title ?? "(no title)")} — ${String(issue.state ?? "?")}${issue.merged ? ", merged" : ""}`,
          `by ${String((issue.user as { login?: string })?.login ?? "?")} · ${comments} comment(s) · labels: ${labelList(issue.labels) || "none"}`,
          `url: ${String(issue.html_url ?? "")}`,
          "",
          clip(String(issue.body ?? "(no body)"), 4_000),
          comments ? `The thread is not included; read ${String(issue.comments_url ?? "the comments url")} with web_fetch if the discussion matters.` : "",
        ].join("\n"),
        { number: n, state: issue.state, comments },
      );
    } catch (cause) {
      return githubFailure(cause);
    }
  },
});

const listIssues = tool({
  name: "github_issues",
  description:
    "List issues on the configured repository as one line each: number, state, title, labels, updated. " +
    "Pull requests are left out. Use it to find what to work on; use github_issue to read one.",
  effect: "read",
  inputSchema: obj({
    state: enumerate("open, closed or all.", ["open", "closed", "all"]),
    labels: str("Comma-separated label names, e.g. bug,good-first-issue."),
    limit: num("How many lines, default 20, maximum 50."),
    repo: str("Optional owner/name."),
  }),
  describe: (input) => ({ summary: `list ${String(input.state ?? "open")} issues` }),
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const repo = repoFor(ctx, input.repo);
      // Read the default once: `String(input.state)` on its own turns an omitted
      // state into the literal "undefined", which GitHub reads as a bad filter.
      const wanted = String(input.state ?? "open");
      const state = ["open", "closed", "all"].includes(wanted) ? wanted : "open";
      const limit = Math.min(MAX_PAGE, Math.max(1, integer(input.limit ?? 20, "limit", MAX_PAGE)));
      const query: Record<string, string | number> = { state, per_page: limit };
      if (input.labels) query.labels = String(input.labels);
      const reply = await gh(ctx, "GET", `/repos/${repo.slug}/issues`, { query });
      if (reply.status !== 200) return failure(reply, repo.slug);
      const items = (Array.isArray(reply.body) ? reply.body : []).filter((item) => !(item as Record<string, unknown>).pull_request) as Array<Record<string, unknown>>;
      if (!items.length) return ok(`No ${state} issues${input.labels ? ` with labels ${String(input.labels)}` : ""} on ${repo.slug}.`, { count: 0 });
      const lines = items.map((item) => {
        const updated = String(item.updated_at ?? "").slice(0, 10);
        return `#${String(item.number)} [${String(item.state)}] ${String(item.title ?? "")}${labelList(item.labels) ? ` {${labelList(item.labels)}}` : ""} · ${updated}`;
      });
      return ok(`${repo.slug} · ${lines.length} ${state} issue(s)\n${lines.join("\n")}`, { count: lines.length });
    } catch (cause) {
      return githubFailure(cause);
    }
  },
});

const commentIssue = tool({
  name: "github_comment",
  description:
    "Post a comment on an issue or PR. This is outward: it is public, it notifies people, and GitHub keeps it. " +
    "It asks the operator every time and is refused when nobody is watching. Needs GITHUB_TOKEN with repo access.",
  effect: "outward",
  inputSchema: obj({
    number: num("Issue or PR number."),
    body: str("The comment, exactly as it will appear. Say what changed and how it was checked."),
    repo: str("Optional owner/name."),
  }, ["number", "body"]),
  describe: (input) => ({ summary: `comment on #${String(input.number ?? "?")}: "${clip(String(input.body ?? ""), 70)}"`, risky: "a public comment that notifies the people on this issue" }),
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const repo = repoFor(ctx, input.repo);
      if (!ctx.config.githubToken) return err("No GITHUB_TOKEN is set, so nothing can be posted. Reads work without it; writes do not.");
      const n = integer(input.number, "number");
      const body = String(input.body ?? "").trim();
      if (!body) return err("github_comment needs a body. An empty comment is noise on somebody's issue.");
      if (body.length > 20_000) return err(`That comment is ${body.length} characters; GitHub allows 65,536 but a person has to read it. Cut it under 20,000.`);
      const reply = await gh(ctx, "POST", `/repos/${repo.slug}/issues/${n}/comments`, { body: { body } });
      if (reply.status !== 201) return failure(reply, repo.slug);
      const posted = reply.body as Record<string, unknown>;
      return ok(`Commented on #${n}: ${String(posted.html_url ?? "(no url returned)")}`, { url: posted.html_url });
    } catch (cause) {
      return githubFailure(cause);
    }
  },
});

const openPr = tool({
  name: "github_pr",
  description:
    "Open a pull request from a branch that already exists on the remote. The branch itself is made and pushed with git " +
    "(run_command, or github_push) — this only asks GitHub to review what is already there. Outward: it notifies the team.",
  effect: "outward",
  inputSchema: obj({
    title: str("Under 72 characters, what the change does."),
    head: str("The branch to merge from, e.g. feature/json-flag."),
    base: str("The branch to merge into. Defaults to the repository's default branch."),
    body: str("What changed, why, and how it was verified."),
    draft: bool("True opens it as a draft. Default false."),
    repo: str("Optional owner/name."),
  }, ["title", "head"]),
  describe: (input) => ({ summary: `open a PR: ${String(input.head ?? "?")} → ${String(input.base ?? "default")}, "${clip(String(input.title ?? ""), 60)}"`, risky: "a pull request is visible to everyone on this repository" }),
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const repo = repoFor(ctx, input.repo);
      if (!ctx.config.githubToken) return err("No GITHUB_TOKEN is set, so a pull request cannot be opened.");
      const title = String(input.title ?? "").trim();
      if (!title) return err("github_pr needs a title.");
      if (title.length > 255) return err(`That title is ${title.length} characters; GitHub stops at 255. Shorten it.`);
      const head = ref(input.head, "head");
      const base = input.base ? ref(input.base, "base") : await defaultBranch(ctx, repo.slug);
      if (head === base) return err(`head and base are both "${head}". A branch does not merge into itself — make the branch off ${base}.`);
      const reply = await gh(ctx, "POST", `/repos/${repo.slug}/pulls`, {
        body: { title, head, base, body: String(input.body ?? "").trim(), draft: Boolean(input.draft) },
      });
      if (reply.status !== 201) {
        const detail = messageOf(reply);
        if (reply.status === 422 && /already exists/i.test(detail)) {
          return err(`There is already an open pull request for ${head} → ${base} on ${repo.slug}. Find it with github_issues, or push more commits to that branch — do not open a second one.`);
        }
        if (reply.status === 422 && /no commits|Head sha|validate/i.test(detail)) {
          return err(`GitHub has no branch "${head}" on ${repo.slug} yet. Push it first: run_command \`git push -u origin ${head}\` (or github_push), then open the PR.`);
        }
        return failure(reply, repo.slug);
      }
      const pr = reply.body as Record<string, unknown>;
      return ok(`Pull request #${String(pr.number)} opened: ${String(pr.html_url ?? "")}\n${head} → ${base}${pr.draft ? " (draft)" : ""}`, { number: pr.number, url: pr.html_url });
    } catch (cause) {
      return githubFailure(cause);
    }
  },
});

async function defaultBranch(ctx: ToolContext, slug: string): Promise<string> {
  const reply = await gh(ctx, "GET", `/repos/${slug}`);
  if (reply.status !== 200) throw new GithubError(explain(reply, slug));
  return String((reply.body as { default_branch?: string }).default_branch ?? "main");
}

const readCi = tool({
  name: "github_ci",
  description:
    "What CI made of a branch or commit: each check run with its status, conclusion and, for a failure, its summary. " +
    "Read it after a push, before claiming a change is green. The fix round is capped at two looks at the same failing head.",
  effect: "read",
  inputSchema: obj({ ref: str("A branch name, tag or commit sha."), repo: str("Optional owner/name.") }, ["ref"]),
  describe: (input) => ({ summary: `read CI for ${String(input.ref ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const repo = repoFor(ctx, input.repo);
      const refName = ref(input.ref, "ref");
      const key = `${repo.slug}#${refName}`;
      const seen = (ciReads.get(key) ?? 0) + 1;
      ciReads.set(key, seen);
      const reply = await gh(ctx, "GET", `/repos/${repo.slug}/commits/${seg(refName)}/check-runs`, { query: { per_page: 30 } });
      if (reply.status !== 200) return failure(reply, repo.slug);
      const runs = ((reply.body as { check_runs?: unknown[] }).check_runs ?? []) as Array<Record<string, unknown>>;
      if (!runs.length) return ok(`No check runs for ${refName} on ${repo.slug}. Either nothing ran yet, or that ref is not what the workflow was triggered on.`, { count: 0 });
      const lines = runs.map((run) => {
        const output = (run.output ?? {}) as { title?: string; summary?: string };
        const conclusion = String(run.conclusion ?? "");
        const detail = conclusion && conclusion !== "success" ? clip([output.title, output.summary].filter(Boolean).join(" — "), 700) : "";
        return `- ${String(run.name ?? "(unnamed)")}: ${String(run.status)}${conclusion ? ` / ${conclusion}` : ""}${detail ? `\n    ${detail}` : ""}`;
      });
      const failing = runs.filter((run) => String(run.conclusion ?? "") !== "success" && String(run.conclusion ?? "") !== "skipped");
      if (failing.length && seen > CI_FIX_CAP) {
        return ok(
          `${failing.length} check(s) still failing on ${refName} (look ${seen} of the ${CI_FIX_CAP} allowed fix rounds):\n${lines.join("\n")}\n\n` +
            `The cap is reached. Two pushes have not changed this, so a third will not either: say which check fails and what it says, and let the operator decide. ` +
            `Do not push again for this head.`,
          { count: runs.length, failing: failing.length, capped: true },
        );
      }
      return ok(`${repo.slug} @ ${refName} · ${runs.length} check(s), ${failing.length} not passing (fix round ${seen}/${CI_FIX_CAP})\n${lines.join("\n")}`, {
        count: runs.length,
        failing: failing.length,
      });
    } catch (cause) {
      return githubFailure(cause);
    }
  },
});

/**
 * The git command, as one string in the right order.
 *
 * `git` first, then the `-c` overrides, then `push`: git reads its options before
 * the subcommand, and a `-c` that lands in front of `git` is a shell error.
 * The helper is a bash function passed as one single-quoted argument, and the
 * token is expanded inside it from the child's own environment — the secret is
 * never in this string, so it never reaches argv, the log or a screenshot.
 */
export function pushCommand(input: { token: boolean; branch: string; remote: string; upstream: boolean }): string {
  const helper = input.token ? `-c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'` : "";
  const track = input.upstream ? "--set-upstream " : "";
  return `GIT_TERMINAL_PROMPT=0 git ${helper} push ${track}${input.remote} ${input.branch} 2>&1`;
}

const pushBranch = tool({
  name: "github_push",
  description:
    "Push one branch to the repository's remote with the machine's own git. Outward: what is pushed is on GitHub for the team. " +
    "The token is handed to git through a credential helper that reads it from the environment, so it never appears in the command, " +
    "the process list or the action log. Without GITHUB_TOKEN this uses whatever git credentials the machine already has.",
  effect: "outward",
  inputSchema: obj({
    branch: str("The local branch to push, e.g. feature/json-flag."),
    remote: str("Remote name. Default origin."),
    set_upstream: bool("Track the remote branch. Default true."),
  }, ["branch"]),
  describe: (input) => ({ summary: `push ${String(input.branch ?? "?")} to ${String(input.remote ?? "origin")}`, risky: "commits on this branch become visible on GitHub" }),
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const branch = ref(input.branch, "branch");
      const remote = ref(input.remote || "origin", "remote");
      const hasToken = Boolean(ctx.config.githubToken);
      const command = pushCommand({
        token: hasToken,
        branch,
        remote,
        upstream: input.set_upstream !== false,
      });
      const result = await getShell(ctx.workspace).run(`cd ${toBashPath(ctx.workspace)} && ${command}`, 120_000, ctx.workspace);
      if (result.timedOut) return err(`git push for ${branch} ran past 120s and was stopped. A large branch, or a prompt git was not allowed to ask.`);
      if (result.code !== 0) {
        const out = clip(result.output, 1_500);
        if (/rejected|non-fast-forward/i.test(out)) return err(`git push ${branch} was rejected: the remote branch has commits you do not have.\n${out}\nDo not force it. Rebase or ask the operator.`);
        if (/could not read|authentication|terminal prompts disabled|invalid access token/i.test(out)) {
          return err(`git could not authorise the push for ${branch}. ${hasToken ? "The token set in GITHUB_TOKEN was refused — it may lack contents:write." : "No GITHUB_TOKEN is set, so git used the machine's own credentials."}\n${out}`);
        }
        return err(`git push ${branch} exited ${result.code}.\n${out}`);
      }
      return ok(`Pushed ${branch} to ${remote}.\n${clip(result.output, 800)}\nOpen the pull request with github_pr when it is ready.`, { branch, remote });
    } catch (cause) {
      return githubFailure(cause);
    }
  },
});

function githubFailure(cause: unknown): ToolResult {
  const error = cause as Error;
  if (error instanceof GithubError) return err(error.message);
  if (error.name === "AbortError") return err("The GitHub call was stopped before it answered.");
  return err(`GitHub request failed: ${error.message}`, { hint: "api.github.com must be reachable; a proxy or offline run returns this." });
}

export const GITHUB_READS = ["github_issue", "github_issues", "github_ci"];
export const GITHUB_WRITES = ["github_comment", "github_pr", "github_push"];
export const GITHUB_TOOLS: ToolSpec[] = [readIssue, listIssues, commentIssue, openPr, readCi, pushBranch];
