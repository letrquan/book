/**
 * Variables that survive `clearInheritedBookEnv` in the unit and contract tiers.
 *
 * - `BOOK_HOME`: its being unset is an observable production state, and the sweep harness pins it
 *   to a temporary directory so a test cannot reach the developer's real `~/.book`. The reasoning
 *   is in `vitest-setup.ts`; this setup leaves it exactly as the launcher gave it.
 * - `BOOK_TOOL_TELEMETRY_DIR`: `vitest-setup.ts` pins it per worker, and it runs first.
 *
 * Nothing else is kept: every other BOOK_* variable a test reads is one that test sets itself
 * (`vi.stubEnv` or an assignment), after this runs.
 */
export const KEPT_BOOK_ENV: readonly string[] = ['BOOK_HOME', 'BOOK_TOOL_TELEMETRY_DIR'];

/**
 * Deletes every `BOOK_*` key from `env` except those in `keep`, and returns the names it removed.
 *
 * A suite is often run from inside a Book session, whose own overrides (BOOK_EFFORT, BOOK_MODEL,
 * BOOK_MAX_TOKENS, ...) would otherwise outrank the defaults a test expects, so the suite's result
 * depended on who launched it (#467).
 */
export function clearInheritedBookEnv(
  env: NodeJS.ProcessEnv,
  keep: readonly string[] = KEPT_BOOK_ENV,
): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith('BOOK_') || keep.includes(key)) continue;
    delete env[key];
    removed.push(key);
  }
  return removed;
}
