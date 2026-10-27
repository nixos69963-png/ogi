/**
 * web_fetch: read a public page, safely.
 *
 * Deliberately narrower than a browser: one GET, no cookies, no session, no
 * following of anything that looks like a form. The model gets the text of a page
 * it can cite, not a second identity on the internet.
 *
 * Two guards matter. The SSRF check resolves the hostname before the request and
 * re-checks every redirect hop, because "http://localhost" behind a redirect is
 * how an agent that can reach a network ends up reading an internal service. The
 * byte cap stops a 40 MB download from becoming a 40 MB bill.
 *
 * The third thing here is the identity. A bare `python-requests`-style UA gets a
 * 429 from every CDN in front of a documentation site, which makes the tool look
 * broken when the page is public. So web_fetch asks as a browser of the version
 * actually installed on this machine, plus `agent-cli`, which is who we really
 * are. What web_fetch does NOT do is work around a check a site decided to put
 * up: a bot wall is answered by naming it and handing the page to the real browser.
 */
import { promises as dns } from "node:dns";
import type { LookupAddress } from "node:dns";
import { readdirSync } from "node:fs";
import path from "node:path";
import { clip } from "#core/history.ts";
import { findChrome } from "#browser/cdp.ts";
import { redact } from "#guard/redact.ts";
import type { ToolResult } from "#core/types.ts";
import { bool, err, num, obj, ok, str, tool } from "./define.ts";

const MAX_BYTES = 2_000_000;
const MAX_HOPS = 5;

export class UnsafeUrl extends Error {}

const PLATFORM = (() => {
  if (process.platform === "win32") return "Windows NT 10.0; Win64; x64";
  if (process.platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  return "X11; Linux x86_64";
})();

/** The version folder sitting next to chrome.exe is the version that is installed. */
function chromeVersion(executable: string): string | null {
  try {
    const versions = readdirSync(path.dirname(executable), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+(\.\d+){2,3}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
    return versions[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The `user-agent` web_fetch sends. Built from the browser on this machine, so it
 * is a claim that can be checked, and it keeps `agent-cli` at the end — a tool
 * that hides who it is has no business complaining when a site distrusts it.
 */
export function userAgent(): string {
  const executable = findChrome();
  const version = executable ? chromeVersion(executable) : null;
  return `Mozilla/5.0 (${PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version ?? "120.0.0.0"} Safari/537.36 agent-cli/1.0`;
}

/** What a bot wall looks like in a body, whatever the CDN calls it today. */
const CHALLENGE = /security checkpoint|cf-browser-verification|attention required|enable javascript and cookies|_cf_chl|vercel-protection|vcs_|just a moment/i;

/**
 * Names the wall, if the answer is one. Returns null for an ordinary error, which
 * the caller reports as what it is.
 */
export function botChallenge(status: number, body: string, server: string): string | null {
  const challenged = CHALLENGE.test(body) || (/vercel|cloudflare|akamai/i.test(server) && (status === 403 || status === 429));
  if (!challenged) return null;
  const who = server ? ` (${server.split(/[\s/]/)[0]})` : "";
  return (
    `HTTP ${status} from a bot check${who}. web_fetch does not work around one — a check like that is a wall ` +
    `the site put up on purpose, and getting past it is not this tool's job. Two honest ways in: ` +
    `browser_open reads the page in real Chrome (that is a read, and it asks nothing), or find the same ` +
    `content at the site's own docs or API address.`
  );
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast & reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("ff")) return true;
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]!);
  return false;
}

/** Parses, then proves the URL names a public host and nothing else. */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrl(`"${raw}" is not a URL I can fetch. Give the full https:// address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrl(`${url.protocol} is not allowed. web_fetch speaks http and https only — a local file has read_file.`);
  }
  if (!url.hostname) throw new UnsafeUrl("The URL has no host.");
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|metadata\.google|169\.254\.169\.254)$/i.test(bare)) {
    throw new UnsafeUrl(`${bare} is a machine-local name. The agent does not reach internal services.`);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    if (isPrivateV4(bare)) throw new UnsafeUrl(`${bare} is a private address.`);
  } else if (/^[0-9a-f:]+$/i.test(bare)) {
    if (isPrivateV6(bare)) throw new UnsafeUrl(`${bare} is a private IPv6 address.`);
  } else {
    let records: LookupAddress[];
    try {
      records = await dns.lookup(bare, { all: true, verbatim: true });
    } catch {
      return url; // unresolvable is not unsafe; the request will fail on its own
    }
    for (const record of records) {
      if (record.family === 4 ? isPrivateV4(record.address) : isPrivateV6(record.address)) {
        throw new UnsafeUrl(`${bare} resolves to the private address ${record.address}.`);
      }
    }
  }
  return url;
}

/** HTML → readable text. No dependency, no parser: enough to read a doc page. */
export function htmlToText(html: string): { title: string; text: string } {
  let source = html.replace(/<!--[\s\S]*?-->/g, " ");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1];
  source = source
    .replace(/<script[\s>][\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s>][\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<(br|hr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  source = decodeEntities(source)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: decodeEntities(title ?? "").trim(), text: source };
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•" };
  return text
    .replace(/&#(\d+);/g, (_m, code: string) => safeChar(Number(code)))
    .replace(/&#[xX](\h+);/g, (_m, code: string) => safeChar(Number.parseInt(code, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => named[name.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > cap) throw new UnsafeUrl(`The page is ${(declared / 1e6).toFixed(1)} MB, over the ${(cap / 1e6).toFixed(0)} MB cap.`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > cap) {
      void reader.cancel();
      return text.slice(0, cap);
    }
  }
  return text;
}

export const webFetch = tool({
  name: "web_fetch",
  description:
    "Fetch one public web page over https and return its readable text (no scripts, no cookies, no forms). " +
    "Use it for documentation, an API's own docs, a changelog. It is read-only: nothing on the page is executed and no log-in state exists. " +
    "It identifies as a browser of the version installed here, plus agent-cli. Machine-local addresses are refused. " +
    "If a site answers with a bot check, that is the end of this route: the page needs browser_open, which is a real browser and still a read.",
  effect: "read",
  inputSchema: obj({
    url: str("Full https:// or http:// URL."),
    focus: str("Optional: the sentence you are looking for, used to pick which part of a long page is returned."),
    max_chars: num("Default 8000, maximum 40000."),
    raw: bool("Return the body verbatim (JSON/XML) instead of converting HTML to text."),
  }, ["url"]),
  describe: (input) => ({ summary: `fetch ${String(input.url ?? "?")}` }),
  async execute(input, ctx): Promise<ToolResult> {
    const rawUrl = String(input.url ?? "").trim();
    if (!rawUrl) return err("web_fetch needs a url.");
    const maxChars = Math.min(40_000, Math.max(500, Number(input.max_chars ?? 8_000) || 8_000));

    let current = rawUrl;
    let res: Response | null = null;
    let hops = 0;
    for (;;) {
      let url: URL;
      try {
        url = await assertSafeUrl(current);
      } catch (cause) {
        const error = cause as Error;
        return err(`Refused: ${error.message}`);
      }
      try {
        res = await fetch(url.toString(), {
          method: "GET",
          redirect: "manual",
          signal: ctx.signal,
          headers: {
            "user-agent": userAgent(),
            accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
          },
        });
      } catch (cause) {
        return err(`Fetch failed for ${url.host}: ${String(cause)}`, { hint: "The host may need a browser session; use the browser tools instead of web_fetch." });
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (!location) return err(`${url.host} returned ${res.status} with no Location header.`);
        hops += 1;
        if (hops > MAX_HOPS) return err(`Too many redirects (${MAX_HOPS}) from ${rawUrl}.`);
        current = new URL(location, url).toString();
        continue;
      }
      break;
    }
    if (!res) return err("No response.");
    const contentType = res.headers.get("content-type") ?? "";
    const body = await readCapped(res, MAX_BYTES).catch((cause) => {
      throw new Error(String(cause));
    });
    if (!res.ok) {
      const { text } = htmlToText(body);
      const wall = botChallenge(res.status, body, res.headers.get("server") ?? "");
      if (wall) return err(`${res.url || current}: ${wall}`, { status: res.status, hint: "browser_open is the tool for a page behind a check." });
      if (res.status === 429) {
        return err(`HTTP 429 from ${res.url || current}: rate limited${text ? `: ${clip(text, 200)}` : ""}. Do not retry this call in a loop — read what you have, or come back to it later.`, { status: 429 });
      }
      return err(`HTTP ${res.status} from ${res.url || current}${text ? `: ${clip(text, 400)}` : ""}`, { status: res.status });
    }

    const isHtml = /html/i.test(contentType) || /^\s*</.test(body);
    const extracted = input.raw || !isHtml ? { title: "", text: body.trim() } : htmlToText(body);
    const cleaned = redact(extracted.text);
    if (cleaned.hits.length) ctx.log({ at: Date.now(), turn: ctx.turn, tool: "web_fetch", effect: "read", args: { url: current }, ok: true, chars: cleaned.text.length, approved: "auto", ms: 0 });

    let chosen = cleaned.text;
    if (input.focus) {
      const needle = String(input.focus).toLowerCase();
      const paragraphs = cleaned.text.split(/\n{2,}/);
      const near = paragraphs.filter((p) => p.toLowerCase().includes(needle.slice(0, 24)));
      if (near.length) chosen = near.join("\n\n");
    }
    const shown = clip(chosen, maxChars);
    const header = `${res.status} ${res.url || current}\n${extracted.title ? `title: ${extracted.title}\n` : ""}${contentType ? `type: ${contentType.split(";")[0]}\n` : ""}${cleaned.hits.length ? "note: credential-looking strings in the page were masked\n" : ""}`;
    return ok(`${header}${shown}`, { url: res.url || current, chars: chosen.length, status: res.status });
  },
});

export const WEB_TOOLS = [webFetch];
