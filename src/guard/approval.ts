/**
 * Approvals: what the agent may do without asking you.
 *
 * The rule follows the effect a tool has, not which tool it is. Reading and
 * computing are free. Writing to your files asks first. Anything another person
 * can see — a comment, a push, a message, a payment — needs a person, and an
 * unattended run cannot supply one, so it stops and leaves a draft instead.
 *
 * The tier says how much of the routine work runs before that stop. It never
 * lowers the floor: a step that reaches the machine itself, destroys a file that
 * cannot be re-created, or speaks for you outside this project is put in front of
 * you at every level — and refused when there is nobody there to answer.
 *
 * "always" is scoped to one tool for one run. It is never written to disk, so the
 * next task starts with the same gate as this one.
 */
import type { ApprovalAnswer, ApprovalLevel, ApprovalRequest } from "#core/types.ts";

export type { ApprovalAnswer, ApprovalRequest } from "#core/types.ts";

export type ApprovalDecision =
  | { allowed: true; approvedBy: "policy" | "human" | "session-grant" }
  | { allowed: false; reason: string };

export interface Approver {
  decide(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Tools the human waved through for this run — surfaced by `/grants`. */
  grants(): string[];
  answered(): number;
}

/** Commands that destroy work. These are gated even in autonomous (approvals=off) mode. */
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i,
  /\bdel\s+\/[sq]/i,
  /\brd\s+\/s/i,
  /\bgit\s+clean\s+-(?:[fx]{2}|fd)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bdrop\s+(table|database)\b/i,
  /\bformat\b\s+[a-z]:/i,
  /(?:^|\s)(?:>\s*\/dev\/sd|mkfs\b)/i,
];

export function isDestructive(command: string): string | null {
  for (const re of DESTRUCTIVE) if (re.test(command)) return "it deletes or overwrites files you have not backed up";
  return null;
}

/**
 * Commands that reach the machine rather than the project: the registry, services,
 * the network stack, another user's rights, a global package, a disk. Each one is
 * worth a question even to someone who said "do not ask me", because none of them
 * are undone by the harness and several outlive the task.
 */
const SYSTEM: [RegExp, string][] = [
  [/\b(?:reg|regedit)\b(?:\s|\.[a-z]|$)/i, "it edits the Windows registry"],
  [/\bschtasks\b|\bcrontab\b/i, "it schedules work on this machine, outside the task"],
  [/\bnetsh\b|\broute\s+(?:add|delete)\b/i, "it changes the network"],
  [/\bsc\s+(?:create|delete|start|stop|config|qc)\b|\bsystemctl\b/i, "it changes a system service"],
  [/\bwmic\b/i, "it reaches Windows management"],
  [/\btaskkill\s+\/f\b|\bpkill\s+-9\b|\bkillall\b/i, "it stops a process that is not the agent's own"],
  [/\b(?:shutdown|restart-computer|stop-computer)\b/i, "it stops the machine"],
  [/\b(?:sudo|runas)\b/i, "it asks for another user's rights"],
  [/\bsetx\b|\bsetenv\b|SetItemProperty.*Environment/i, "it changes your environment"],
  [/\bgit\s+config\s+(?:--global|--system)\b/i, "it changes git settings outside this project"],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|rm|uninstall)\s+(?:-g|--global)\b/i, "it installs for every project on the machine"],
  [/\b(?:icacls|takeown|secedit)\b|\bchmod\s+0?777\b/i, "it changes who may read what"],
  [/\b(?:mkfs|diskpart|fdisk)\b|\bdd\s+if=/i, "it rewrites a disk"],
  [/(?:curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(?:sh|bash|pwsh|powershell|iex)\b|\bfrom\s+(?:ls|cat)\s+.*\|\s*iex/i, "it runs a script fetched from somewhere else"],
  [/\.ssh\b|[\\/](?:id_rsa|id_ed25519)\b|[\\/]\.aws[\\/]/i, "it reaches a key store"],
  [/\b(?:[a-z]:[\\/](?:windows|winnt|system32|program\s+files(?:\s+\(x86\))?)|(?:^|[\s"'`(])[\\/](?:etc|usr|bin|sbin|var|proc|sys)[\\/])/i, "it names a path inside the machine, not inside the project"],
];

/** Why this command is not part of the project's own work, or null when it is. */
export function touchesSystem(command: string): string | null {
  for (const [re, why] of SYSTEM) if (re.test(command)) return why;
  return null;
}

/**
 * Files whose contents exist nowhere else. Losing one is not a reverted edit: the
 * lockfile is the record of what was installed, the manifest is the record of what
 * the project is, and a `.env` holds what no backup will reconstruct.
 */
const IRREPLACEABLE = new Set([
  "package.json", "package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml",
  "tsconfig.json", "jsconfig.json", "bunfig.toml", "deno.json", "vite.config.ts",
  "go.mod", "go.sum", "cargo.toml", "cargo.lock", "pom.xml", "build.gradle", "build.gradle.kts",
  "requirements.txt", "pyproject.toml", "poetry.lock", "pipfile", "pipfile.lock", "setup.py",
  "gemfile", "gemfile.lock", "composer.json", "composer.lock", "mix.exs", "podfile",
  "makefile", "dockerfile", "docker-compose.yml", "compose.yml",
  "agents.md", "qoder.md", "readme.md", "license", ".gitignore", ".gitattributes", ".env",
]);

/** Directories that hold the record rather than the work. */
const RECORD_DIRS = /[\\/](?:\.git|\.agent|\.qoder|\.factory|\.ssh)(?:[\\/]|$)/i;

/** Why deleting or replacing this path cannot be undone, or null when it can. */
export function irreplaceable(target: string): string | null {
  const name = target.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (RECORD_DIRS.test(target)) return `${name || target} is part of the record — version control, backups or the plan itself`;
  if (name.startsWith(".env")) return "an .env file holds what no backup can reconstruct";
  if (IRREPLACEABLE.has(name)) return `${name} is a manifest or lockfile: the project is defined by it, not by anything on disk`;
  return null;
}

/** The path a delete command removes: the first word after `rm`, `del`, `rd`. */
const REMOVAL = /(?:^|[\s;&|(])(?:rm|del|erase|rd|rmdir)\s+(?:-+\w+\s+)*([^\s;&|]+)/gi;

/**
 * What a command has to be asked about. `hard` is what no tier waves through;
 * `risky` is what `auto` still asks and `full` runs. Deleting through a command
 * is treated the way `remove_path` is treated — the harness has no backup of a
 * file a shell removed, so an ordinary one asks and a manifest does not pass.
 */
export function commandGate(command: string): { risky?: string; hard?: string } {
  const gate = touchesSystem(command) ?? isDestructive(command);
  if (gate) return { risky: gate, hard: gate };
  let removed: string | null = null;
  for (const match of command.matchAll(REMOVAL)) {
    const target = match[1];
    if (!target) continue;
    const permanent = irreplaceable(target);
    if (permanent) return { risky: permanent, hard: permanent };
    removed ??= target;
  }
  return removed ? { risky: "it deletes a file, and a command's delete leaves no backup" } : {};
}

export interface ApproverOptions {
  /** The tier. When it is not given, `approvals` decides: on is `ask`, off is `auto`. */
  level?: ApprovalLevel;
  /** The older name of the same switch, kept so every existing caller still means what it meant. */
  approvals?: boolean;
  attended: boolean;
  confirm: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
}

export function createApprover(options: ApproverOptions): Approver {
  const level: ApprovalLevel = options.level ?? (options.approvals === false ? "auto" : "ask");
  const granted = new Set<string>();
  let answered = 0;

  return {
    grants: () => [...granted],
    answered: () => answered,

    async decide(request) {
      // Outward effects need a person, full stop. No tier buys the right to speak as you.
      if (request.effect === "outward" && !options.attended) {
        return {
          allowed: false,
          reason:
            `"${request.tool}" acts outside this machine (${request.summary}) and nobody is watching this run. ` +
            `It stays a draft: run it attended, or do that step yourself.`,
        };
      }

      // The floor. A hard gate is asked at every level, and with nobody to ask it is
      // refused rather than waved through by the absence of a person.
      if (request.hard) {
        if (!options.attended) {
          return {
            allowed: false,
            reason: `"${request.tool}" was refused (${request.summary} — ${request.hard}) and nobody is watching this run to approve it.`,
          };
        }
        answered += 1;
        const answer = await options.confirm(request);
        // "always" cannot apply to a gate: a hard step is put in front of you every
        // time it appears, because the second one is rarely like the first.
        if (answer === "yes" || answer === "always") return { allowed: true, approvedBy: "human" };
        return { allowed: false, reason: `you declined: ${request.summary} — ${request.hard}` };
      }

      // An explicit allow-list entry is the operator's decision, made in
      // configuration. It sits below the hard floor and below outward: naming a
      // tool in a file does not buy it the right to speak for you.
      if (request.autoAllow) return { allowed: true, approvedBy: "policy" };

      const needsAsking = request.effect === "write" || request.effect === "outward" || Boolean(request.risky);
      if (!needsAsking) return { allowed: true, approvedBy: "policy" };

      // What the tier waves through: `auto` runs routine writes and plain commands,
      // `full` runs the ones a tool flagged as worth a second look too. Outward is
      // never routine, at any level.
      const routine = request.effect === "write" && !request.risky;
      if (level === "auto" && routine) return { allowed: true, approvedBy: "policy" };
      // `full` adds the writes a tool thought were worth a second look. The gates
      // above it already returned; nothing that reaches outside the project lands here.
      if (level === "full" && request.effect === "write") return { allowed: true, approvedBy: "policy" };

      if (granted.has(request.tool) && !request.risky) return { allowed: true, approvedBy: "session-grant" };

      // What reaches here is what the tier did not wave through. With no person to
      // ask it stays shut — and the log says refused, not a yes nobody gave.
      if (!options.attended) {
        return {
          allowed: false,
          reason:
            `"${request.tool}" was refused (${request.risky ? `${request.summary} — ${request.risky}` : request.summary}) ` +
            `and nobody is watching this run to approve it.`,
        };
      }

      answered += 1;
      const answer = await options.confirm(request);
      if (answer === "always") granted.add(request.tool);
      if (answer === "no") {
        return {
          allowed: false,
          reason: request.risky
            ? `you declined: ${request.summary} — ${request.risky}`
            : `you declined ${request.tool}: ${request.summary}`,
        };
      }
      return { allowed: true, approvedBy: "human" };
    },
  };
}

/** The line the terminal prints when asking. Short, and never two questions at once. */
export function formatApprovalPrompt(request: ApprovalRequest): string {
  const head = `allow ${request.tool}? ${request.summary}`;
  const why = request.hard ?? request.risky;
  return why ? `${head}\n  caution: ${why}` : head;
}
