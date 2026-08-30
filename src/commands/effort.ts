import { effortLevelSchema } from '../settings.js';
import type { AgentConfig } from '../types/runtime.js';

export type EffortLevel = NonNullable<AgentConfig['effort']>;
export type EffortResult = { ok: boolean; error?: string };

/**
 * Derived from the settings schema rather than restated, so the CLI flag, the
 * env var, `settings.effort`, and `/effort` cannot come to disagree about which
 * levels exist.
 */
export const EFFORT_LEVELS: readonly EffortLevel[] = effortLevelSchema.options;

export const EFFORT_USAGE = 'Usage: /effort [low|medium|high|xhigh|max]';

/**
 * Normalize and validate one effort level, or throw naming the valid ones.
 *
 * Every other source of an effort level is checked -- `BOOK_EFFORT` against this
 * list, `settings.effort` against the schema it comes from. Without this the CLI
 * flag was the one input that reached the provider unchecked, turning a typo
 * into an opaque HTTP 400 instead of a CLI error.
 */
export function parseEffortLevel(raw: string, source: string): EffortLevel {
  const normalized = raw.trim().toLowerCase();
  if (!isEffortLevel(normalized)) {
    throw new Error(`${source} must be one of: ${EFFORT_LEVELS.join(', ')} (got "${raw}")`);
  }
  return normalized;
}

type EffortConfig = Pick<AgentConfig, 'model' | 'modelSelection' | 'modelInfo'>;

export function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_LEVELS.includes(value as EffortLevel);
}

/** Null means effort is disabled; an empty array means metadata exposes no choices. */
export function getAvailableEffortLevels(config: EffortConfig): EffortLevel[] | null {
  const metadata = config.modelInfo?.effort;
  if (metadata === false) return null;
  if (typeof metadata === 'object' && metadata.levels) {
    return EFFORT_LEVELS.filter((level) => metadata.levels?.includes(level));
  }
  return [...EFFORT_LEVELS];
}

export function getEffortUnavailableError(config: EffortConfig): string | undefined {
  const model = config.modelSelection ?? config.model;
  const levels = getAvailableEffortLevels(config);
  if (levels === null) return `Model "${model}" does not support configurable effort.`;
  if (levels.length === 0) return `Model "${model}" does not expose any effort levels.`;
  return undefined;
}

/** Validate, persist, then apply so a failed write never changes live state. */
export function updateEffortLevel(
  config: EffortConfig,
  level: EffortLevel,
  persist: (level: EffortLevel) => EffortResult,
  apply: (level: EffortLevel) => void,
): EffortResult {
  const unavailable = getEffortUnavailableError(config);
  if (unavailable) return { ok: false, error: unavailable };

  const levels = getAvailableEffortLevels(config) ?? [];
  if (!levels.includes(level)) {
    const model = config.modelSelection ?? config.model;
    return {
      ok: false,
      error: `Effort level "${level}" is not supported by model "${model}". Available levels: ${levels.join(', ')}.`,
    };
  }

  const result = persist(level);
  if (!result.ok) {
    return {
      ok: false,
      error: `Failed to save effort level${result.error ? `: ${result.error}` : '.'}`,
    };
  }

  apply(level);
  return { ok: true };
}
