/**
 * Timeout resolution shared by the tool registry and the tools that enforce a
 * deadline of their own.
 *
 * The registry runs a deadline over every tool call. A tool that also runs one
 * must not be given the same budget: the registry arms its timer before
 * `tool.execute` is reached, so at equal values it always fires first and
 * replaces the tool's own report — including any output the tool had captured —
 * with a contentless `tool_timeout`. Such a tool declares `timeoutMs` on its
 * definition and the registry adds `SELF_TIMEOUT_GRACE_MS` on top, leaving the
 * tool's report the one the model sees.
 */

/** Registry deadline for a tool that does not declare one of its own. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** Ceiling on a model-supplied timeout, so one call cannot wedge the turn. */
export const MAX_TOOL_TIMEOUT_MS = 600_000;

/** Head start the registry gives a tool that enforces its own deadline. */
export const SELF_TIMEOUT_GRACE_MS = 10_000;

function positiveMs(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

export interface ToolTimeoutSources {
  /** Model-supplied `timeout` argument. Clamped to `MAX_TOOL_TIMEOUT_MS`. */
  requested?: unknown;
  /** Environment carrying the operator's `BOOK_TOOL_TIMEOUT_MS` override. */
  env?: Record<string, string | undefined>;
  /** The tool's own default, when it declares one. */
  fallback?: number;
}

/**
 * Resolve one deadline in milliseconds: model argument, then the operator's
 * `BOOK_TOOL_TIMEOUT_MS`, then the tool's default, then the registry default.
 *
 * Only the model argument is capped. The operator override is deliberately
 * uncapped — a build that legitimately needs half an hour is the operator's
 * call, while the ceiling exists so a model cannot stall its own turn.
 */
export function resolveToolTimeoutMs(sources: ToolTimeoutSources): number {
  const requested = positiveMs(sources.requested);
  if (requested !== undefined) return Math.min(requested, MAX_TOOL_TIMEOUT_MS);
  const operator = positiveMs(sources.env?.BOOK_TOOL_TIMEOUT_MS);
  if (operator !== undefined) return operator;
  return positiveMs(sources.fallback) ?? DEFAULT_TOOL_TIMEOUT_MS;
}
