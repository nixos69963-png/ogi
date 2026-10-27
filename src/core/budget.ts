/**
 * The working budget.
 *
 * A budget the user set is both a ceiling and a floor: the run must stop when the
 * time is spent, and it must not stop early while time is unspent and the task is
 * unfinished. Turns are derived from the clock so a fast model cannot spin an
 * hour of useless loops, and the rebase rule keeps a resumed run counting against
 * the deadline it was given.
 */

export interface Budget {
  minutes: number | null;
  maxTurns: number;
  startedAt: number;
  deadlineAt: number | null;
  /** Internal only: how many times the floor has already spoken. */
  nudges: number;
}

export const TURNS_PER_MINUTE = 8;
export const MIN_TURNS = 80;
export const MAX_TURNS = 1600;
/** Two, not ten: a second empty exit means the work really is finished. */
export const MAX_BUDGET_NUDGES = 2;
const MIN_NUDGE_LEFT_MS = 45_000;

export function turnsFor(minutes: number | null): number {
  if (minutes == null) return MIN_TURNS;
  return Math.min(MAX_TURNS, Math.max(MIN_TURNS, Math.round(minutes * TURNS_PER_MINUTE)));
}

export function createBudget(minutes: number | null, now: number = Date.now()): Budget {
  return {
    minutes,
    maxTurns: turnsFor(minutes),
    startedAt: now,
    deadlineAt: minutes == null ? null : now + minutes * 60_000,
    nudges: 0,
  };
}

/** A resumed run keeps its original deadline; a re-armed budget gets a fresh one. */
export function rebaseBudget(previous: Budget | null, minutes: number | null, now: number = Date.now()): Budget {
  if (previous && minutes == null && previous.minutes == null) return previous;
  if (previous && previous.minutes != null && minutes === previous.minutes) {
    const left = previous.deadlineAt == null ? null : previous.deadlineAt - now;
    if (left != null && left > 0) return { ...previous, startedAt: now, nudges: previous.nudges };
  }
  return createBudget(minutes, now);
}

export function elapsedMs(b: Budget, now: number = Date.now()): number {
  return Math.max(0, now - b.startedAt);
}

export function timeLeftMs(b: Budget, now: number = Date.now()): number | null {
  if (b.deadlineAt == null) return null;
  return b.deadlineAt - now;
}

export function isExpired(b: Budget, now: number = Date.now()): boolean {
  return b.deadlineAt != null && now >= b.deadlineAt;
}

export function formatBudget(minutes: number | null): string {
  if (minutes == null) return "default";
  if (minutes === 0) return "until done";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatTimeLeft(ms: number | null): string {
  if (ms == null) return "∞";
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** What the run says when the clock beats it. It says the work is not lost. */
export function budgetSpentNote(b: Budget): string {
  const spent = formatBudget(b.minutes);
  return b.minutes == null
    ? "Stopped at the turn limit. Progress is saved — say continue to pick it up."
    : `Stopped after ${spent} of work. Progress is saved — say continue to pick it up.`;
}

/**
 * The floor. Returns text for the model's history only; nothing here is meant to
 * be printed as chatter, and it stops offering itself once the exit is near.
 */
export function takeBudgetNudge(b: Budget, now: number = Date.now()): string | null {
  if (b.minutes == null) return null;
  if (b.nudges >= MAX_BUDGET_NUDGES) return null;
  const left = timeLeftMs(b, now);
  if (left != null && left < MIN_NUDGE_LEFT_MS) return null;
  b.nudges += 1;
  const remaining = left == null ? "no deadline" : `${formatTimeLeft(left)} left`;
  return (
    `[harness] Working budget: ${remaining} of the ${formatBudget(b.minutes)} you were given. ` +
    `If any part of the task is still undone, do the next concrete step with your tools now. ` +
    `If the task is fully done and verified, say so in one short sentence and stop.`
  );
}
