/**
 * Who drives this process: a person, or another agent harness running Book as its tool.
 *
 * It decides one thing today: what the model may write to memory. A session another agent drives
 * is that agent's delegated task, and its prompt is the delegator's per-task contract — "Ground
 * rules" a spec run must follow, a temporary semaphore — which the memory store kept turning into
 * permanent repository rules. What the run learns by doing the work is still worth keeping, so a
 * delegated session saves learnings only (`memoryWriteScope` in `memory-store.ts`).
 */
import type { SessionDriver } from './types/runtime.js';

export type { SessionDriver } from './types/runtime.js';

export const SESSION_DRIVERS: readonly SessionDriver[] = ['human', 'agent'];

export interface ResolvedSessionDriver {
  driver: SessionDriver;
  /** What decided it: `flag`, `BOOK_SESSION_DRIVER`, or the agent markers seen in the environment. */
  signals: string[];
}

/** Exactly `human` or `agent`: a driver read back from a session file or another process. */
export function isSessionDriver(value: unknown): value is SessionDriver {
  return SESSION_DRIVERS.includes(value as SessionDriver);
}

/** `human` or `agent`, ignoring case and surrounding space; anything else is not a driver. */
export function parseSessionDriver(value: string | undefined): SessionDriver | undefined {
  const normalized = value?.trim().toLowerCase();
  return isSessionDriver(normalized) ? normalized : undefined;
}

/**
 * An explicit choice wins (the `--session-driver` flag or the SDK option, then
 * `BOOK_SESSION_DRIVER`); otherwise the environment an agent harness gives its children decides.
 * Claude Code sets `CLAUDECODE=1` and `AI_AGENT=claude-code_<version>_agent` in every process it
 * spawns, including the PTY its run-book driver opens the real TUI in, so the interactive entry
 * point alone does not mean a person is typing.
 */
export function resolveSessionDriver(input: {
  explicit?: string;
  env: Record<string, string | undefined>;
}): ResolvedSessionDriver {
  const explicit = parseSessionDriver(input.explicit);
  if (explicit) return { driver: explicit, signals: ['flag'] };
  const fromEnv = parseSessionDriver(input.env.BOOK_SESSION_DRIVER);
  if (fromEnv) return { driver: fromEnv, signals: ['BOOK_SESSION_DRIVER'] };
  const signals: string[] = [];
  const claudeCode = input.env.CLAUDECODE?.trim();
  if (claudeCode && claudeCode !== '0') signals.push('CLAUDECODE');
  if (input.env.AI_AGENT?.trim()) signals.push('AI_AGENT');
  return { driver: signals.length > 0 ? 'agent' : 'human', signals };
}
