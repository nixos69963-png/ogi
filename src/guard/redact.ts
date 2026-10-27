/**
 * Secret redaction.
 *
 * Tool output re-enters the model's history, and the model may be a billed cloud
 * endpoint. So anything that looks like a credential is masked on the way out —
 * both into the transcript and into the action log. This is a blunt filter on
 * purpose: false positives cost a re-typed token, false negatives cost a leak.
 */

interface Pattern {
  name: string;
  re: RegExp;
  /** How to rebuild the match from its captured tail, so the hint stays recognisable. */
  keep: (tail: string) => string;
}

const PATTERNS: Pattern[] = [
  { name: "openai-like key", re: /\bsk-(?:or-|proj-)?[A-Za-z0-9_-]{12,}/g, keep: (t) => `sk-${t.slice(-4)}` },
  { name: "github token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g, keep: (t) => `gh_…${t.slice(-4)}` },
  { name: "slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, keep: (t) => `xox…${t.slice(-4)}` },
  { name: "anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, keep: (t) => `sk-ant-…${t.slice(-4)}` },
  { name: "aws secret", re: /\bAKIA[0-9A-Z]{12,}\b/g, keep: (t) => `AKIA…${t.slice(-4)}` },
  { name: "google api key", re: /\bAIza[0-9A-Za-z_-]{20,}/g, keep: (t) => `AIza…${t.slice(-4)}` },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g, keep: () => "[private key removed]"},
  { name: "bearer token", re: /\b(?:Bearer|token[:=])[ \t]*[A-Za-z0-9._~+/-]{16,}=*/gi, keep: (t) => `Bearer …${t.slice(-4)}` },
  { name: "assignment", re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)["'\s]*[:=]["']?[^\s"'&]{6,}/gi, keep: (t) => `[redacted ${t.length} chars]` },
];

/** Long matches first, so the private-key block wins over the assignment inside it. */
const ORDERED = [...PATTERNS].sort((a, b) => b.re.source.length - a.re.source.length);

export interface Redaction {
  text: string;
  hits: string[];
}

export function redact(input: string): Redaction {
  if (!input) return { text: input, hits: [] };
  const hits: string[] = [];
  let text = input;
  for (const pattern of ORDERED) {
    pattern.re.lastIndex = 0;
    if (!pattern.re.test(text)) continue;
    hits.push(pattern.name);
    text = text.replace(pattern.re, (m) => {
      const tail = m.slice(-Math.min(4, m.length));
      return pattern.keep(tail);
    });
  }
  return { text, hits };
}

/** For the log: never persist an argument that carries a credential verbatim. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") out[key] = redact(value).text;
    else if (value && typeof value === "object") out[key] = "[object]";
    else out[key] = value;
  }
  return out;
}
