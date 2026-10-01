/**
 * The seams `git-isolation.test.ts` reaches through, and the reason this module exists at all.
 *
 * Both exports are there for tests: `gitForTest` is the runner whose `input` branch no exported
 * path reaches without a real snapshot (#351), and `cherryPickFailureResult` is the one decision in
 * a failed apply that cannot be provoked from outside — a real conflict is unreachable through
 * `applyVerifiedCandidate` by construction, because the drift check refuses to run a pick that
 * could conflict (#357). Keeping them here rather than in `git-isolation.ts` says they are not part
 * of the module's surface: nothing under `src/` imports this file, so a caller reaching for either
 * one is reaching past the API rather than using it.
 */
export { cherryPickFailureResult, gitForTest } from './git-isolation.js';
