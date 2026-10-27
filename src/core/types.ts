/**
 * Shared types for the agent core.
 *
 * Kept deliberately small: the loop, the tools and the factory all speak these
 * shapes, so nothing needs to import from the runtime internals to add a tool.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Already parsed. A malformed argument blob is a tool error, never an exception. */
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  /** Assistant turns that ask for tools carry the calls; the loop appends results. */
  tool_calls?: ToolCall[];
  /** Set on role "tool" messages so the model can match result to call. */
  tool_call_id?: string;
  name?: string;
}

/** JSON Schema, loose on purpose: station contracts are authored as plain objects. */
export type JsonSchema = Record<string, unknown>;

export interface ToolResult {
  ok: boolean;
  /** What the model reads. Every result carries it, including failures — that text is the way out. */
  content: string;
  error?: string;
  /** Structured payload for the terminal and for tests. Never sent to the model. */
  data?: unknown;
}

/**
 * What a tool can do to the world, which is what decides whether it needs you.
 * read/compute never leave the machine; write touches your files; outward does
 * something another person can see — those are the ones the factory gates.
 */
export type ToolEffect = "read" | "compute" | "write" | "outward";

/** What a tool says about the call it is about to make, in one human line. */
export interface ApprovalRequest {
  tool: string;
  effect: ToolEffect;
  summary: string;
  /** Extra danger flag from the tool itself, e.g. a command that deletes. */
  risky?: string;
  /**
   * The change as a unified diff, computed before anything is written, so the
   * person answering sees what they are saying yes to instead of a sentence
   * about it. Only a tool that can name one supplies it.
   */
  patch?: string;
  /**
   * Why this call must be put in front of a person whatever the approval tier
   * says: it reaches the system, or it would destroy something that cannot be
   * re-created. A tool that can tell, tells; the gate is the same for all of them.
   */
  hard?: string;
  /**
   * The operator named this tool in configuration. That is a decision made before
   * the run, not a guess the model can make mid-run, so it runs at every tier.
   * Hard gates and outward effects still stop it.
   */
  autoAllow?: boolean;
}

export type ApprovalAnswer = "yes" | "no" | "always";

/**
 * How much the agent may do before it stops for you.
 *
 * `ask` is the everyday gate: every write and every outward action is shown to you.
 * `auto` runs the routine work — editing code, building, a command that only touches
 * the project — and still asks for anything that reaches outside it. `full` asks for
 * less again, but the same things stay behind a gate in every tier: the system
 * itself, an irreplaceable file, and anything another person would see.
 */
export type ApprovalLevel = "ask" | "auto" | "full";

export interface ToolContext {
  workspace: string;
  config: AppConfig;
  log: (event: LogEvent) => void;
  /** Ask the human. Only the loop is supposed to need this, but a tool may. */
  confirm: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
  signal: AbortSignal;
  attended: boolean;
  /** Turn number, for logs and for "stop repeating yourself" detection. */
  turn: number;
  /** Absolute path → workspace-relative label, so output never leaks the home dir. */
  display: (absolutePath: string) => string;
}

export interface ToolSpec<I = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  effect: ToolEffect;
  /** One line for the approval prompt. Without it the loop shows the argument keys. */
  describe?(input: I, ctx: ToolContext): { summary: string; risky?: string; patch?: string; hard?: string; autoAllow?: boolean };
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export interface LogEvent {
  at: number;
  turn: number;
  tool: string;
  effect: ToolEffect;
  args: Record<string, unknown>;
  ok: boolean;
  chars: number;
  /** Who said yes: the effect policy, a session grant, a person, or false for a refusal. */
  approved: "policy" | "session-grant" | "human" | "auto" | false;
  ms: number;
  error?: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  cron?: string;
  intervalMinutes?: number;
  lastRun?: number;
  nextRun?: number;
  template: string;
  args?: Record<string, unknown>;
}

export interface AppConfig {
  /** Ollama daemon; the model runs there, local or :cloud. */
  baseUrl: string;
  model: string;
  /** The project the agent is allowed to touch. */
  workspace: string;
  /** Absolute paths outside the workspace are refused unless this is true. */
  allowOutside: boolean;
  /** .env, private keys and browser credential stores are unreadable unless this is true. */
  allowSecrets: boolean;
  /** Wall-clock working budget in minutes; null means "until the work finishes". */
  budgetMinutes: number | null;
  maxTurns: number;
  /** A model answer longer than this is clipped before it re-enters history. */
  maxObserveChars: number;
  /** Context window we aim to stay under, in tokens. */
  contextTokens: number;
  compactAtPercent: number;
  /** Ask the human before write/outward tools; off means fully autonomous. */
  approvals: boolean;
  /** How much runs before it stops for you. `approvals` is the same switch, older name. */
  approvalLevel: ApprovalLevel;
  githubToken: string | null;
  githubRepo: string | null;
  /** Daily or periodic tasks to run automatically. */
  scheduledTasks?: ScheduledTask[];
}

export type AgentEvent =
  | { type: "plan"; steps: string[] }
  | { type: "thinking"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool-call"; turn: number; name: string; args: Record<string, unknown> }
  | { type: "tool-result"; turn: number; name: string; ok: boolean; chars: number; ms: number; data?: unknown; error?: string }
  /** A person is about to be asked. The live line steps aside for the prompt. */
  | { type: "approval"; name: string; effect: string; summary: string }
  | { type: "station"; station: string; stage: string; summary: string }
  | { type: "stopped"; reason: string; turns: number }
  | { type: "done"; text: string; turns: number; tokensIn: number; tokensOut: number };
