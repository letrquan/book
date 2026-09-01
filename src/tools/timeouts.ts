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

/**
 * Hard ceiling on any resolved deadline: `setTimeout` takes a 32-bit signed
 * delay, and Node silently rewrites anything larger to **1ms** — so an operator
 * expressing "effectively no limit" as 3000000000 would get every command
 * killed instantly. Roughly 24.8 days.
 */
export const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

/** Head start the registry gives a tool that enforces its own deadline. */
export const SELF_TIMEOUT_GRACE_MS = 10_000;

function positiveMs(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(Math.floor(parsed), MAX_SAFE_TIMEOUT_MS);
}

export interface ToolTimeoutSources {
  /** Model-supplied `timeout` argument. Clamped to `toolTimeoutCeilingMs`. */
  requested?: unknown;
  /**
   * A deliberate per-tool setting, such as `agents.checkTimeoutMs`. More
   * specific than the blanket environment override, so it outranks it.
   */
  configured?: unknown;
  /** Environment carrying the operator's `BOOK_TOOL_TIMEOUT_MS` override. */
  env?: Record<string, string | undefined>;
  /** The tool's own built-in default. */
  fallback?: number;
}

/**
 * The largest deadline a model may ask for in a single call.
 *
 * An operator who sets `BOOK_TOOL_TIMEOUT_MS` has stated a bound, and lowering
 * it to 30s must actually cap a model that asks for ten minutes. It cannot
 * raise the per-call reach above `MAX_TOOL_TIMEOUT_MS` though: that is the
 * maximum the `Bash` schema publishes and validates against, and a ceiling the
 * model is told about but cannot pass is worse than no ceiling — it turns the
 * kill message's advice into a rejected retry. Raising the variable raises the
 * *default* deadline instead, which needs no argument to reach.
 */
export function toolTimeoutCeilingMs(env?: Record<string, string | undefined>): number {
  return Math.min(
    positiveMs(env?.BOOK_TOOL_TIMEOUT_MS) ?? MAX_TOOL_TIMEOUT_MS,
    MAX_TOOL_TIMEOUT_MS,
  );
}

/**
 * Resolve one deadline in milliseconds, most specific source first: the model's
 * argument (bounded by `toolTimeoutCeilingMs`), a deliberate per-tool setting,
 * the operator's `BOOK_TOOL_TIMEOUT_MS`, the tool's own default, then the
 * registry default. Every result is bounded by `MAX_SAFE_TIMEOUT_MS`.
 */
export function resolveToolTimeoutMs(sources: ToolTimeoutSources): number {
  const requested = positiveMs(sources.requested);
  if (requested !== undefined) return Math.min(requested, toolTimeoutCeilingMs(sources.env));
  const configured = positiveMs(sources.configured);
  if (configured !== undefined) return configured;
  const operator = positiveMs(sources.env?.BOOK_TOOL_TIMEOUT_MS);
  if (operator !== undefined) return operator;
  return positiveMs(sources.fallback) ?? DEFAULT_TOOL_TIMEOUT_MS;
}
