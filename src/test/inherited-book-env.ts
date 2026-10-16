/**
 * The non-BOOK variable a tier's vitest config sets in `test.env` to tell `vitest-setup.ts` which
 * tier it is running in. It cannot be a BOOK_* name: the setup is what clears those.
 */
export const BOOK_TIER_ENV = 'VITEST_BOOK_TIER';

/** The value `vitest.integration.config.ts` gives {@link BOOK_TIER_ENV}. */
export const INTEGRATION_TIER = 'integration';

/** The escape hatch: a comma-separated list of extra names to keep, e.g. `BOOK_DEBUG,BOOK_DEBUG_STDERR`. */
export const KEEP_ENV_VAR = 'BOOK_TEST_KEEP_ENV';

/**
 * The provider settings a TUI session must inherit for a streaming test to mean anything (#358).
 * `tui-integration.test.ts` hands exactly these to its PTY child (`buildTuiChildEnv`), so the
 * integration tier's setup must not delete them before that file reads them.
 */
export const TUI_PROVIDER_ENV_VARS: readonly string[] = [
  'BOOK_API_KEY',
  'BOOK_BASE_URL',
  'BOOK_PROVIDER',
  'BOOK_MODEL',
  'BOOK_EFFORT',
];

/**
 * Variables that survive `clearInheritedBookEnv` in every tier.
 *
 * - `BOOK_HOME`: its being unset is an observable production state, and the sweep harness pins it
 *   to a temporary directory so a test cannot reach the developer's real `~/.book`. The reasoning
 *   is in `vitest-setup.ts`; this setup leaves it exactly as the launcher gave it.
 * - `BOOK_TOOL_TELEMETRY_DIR`: `vitest-setup.ts` pins it per worker, and it runs first.
 *
 * Nothing else is kept by default: every other BOOK_* variable a test reads is one that test sets
 * itself (`vi.stubEnv` or an assignment), after this runs. See {@link resolveKeptBookEnv} for the
 * integration tier's additions and the `BOOK_TEST_KEEP_ENV` escape hatch.
 */
export const KEPT_BOOK_ENV: readonly string[] = ['BOOK_HOME', 'BOOK_TOOL_TELEMETRY_DIR'];

/** Reads `name` from `env` the way Windows does, whatever case the key was stored in. */
function readEnvIgnoringCase(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

/**
 * The names `clearInheritedBookEnv` must keep for the process described by `env`: the defaults,
 * plus the provider variables in the integration tier, plus whatever `BOOK_TEST_KEEP_ENV` lists.
 */
export function resolveKeptBookEnv(env: NodeJS.ProcessEnv): string[] {
  const keep = [...KEPT_BOOK_ENV];
  if (readEnvIgnoringCase(env, BOOK_TIER_ENV) === INTEGRATION_TIER) {
    keep.push(...TUI_PROVIDER_ENV_VARS);
  }
  const requested = readEnvIgnoringCase(env, KEEP_ENV_VAR) ?? '';
  for (const name of requested.split(',')) {
    const trimmed = name.trim();
    if (trimmed) keep.push(trimmed);
  }
  return keep;
}

/**
 * Deletes every `BOOK_*` key from `env` except those in `keep`, and returns the names it removed.
 * The prefix and the keep list are both compared upper-cased, because Windows environment names are
 * case-insensitive: a key stored as `Book_Effort` is still what `process.env.BOOK_EFFORT` reads.
 *
 * A suite is often run from inside a Book session, whose own overrides (BOOK_EFFORT, BOOK_MODEL,
 * BOOK_MAX_TOKENS, ...) would otherwise outrank the defaults a test expects, so the suite's result
 * depended on who launched it (#467).
 */
export function clearInheritedBookEnv(
  env: NodeJS.ProcessEnv,
  keep: readonly string[] = KEPT_BOOK_ENV,
): string[] {
  const kept = new Set(keep.map((name) => name.toUpperCase()));
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (!upper.startsWith('BOOK_') || kept.has(upper)) continue;
    delete env[key];
    removed.push(key);
  }
  return removed;
}
