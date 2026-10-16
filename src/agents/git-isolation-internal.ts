/**
 * The seams `git-isolation.test.ts` reaches through, and the reason this module exists at all.
 *
 * Every export is there for tests. `gitForTest` is the runner whose `input` branch no exported
 * path reaches without a real snapshot (#351), `isolatedGitForTest` is the same runner behind the
 * pins every call in the module carries, and `cherryPickFailureResult` is the one decision in a
 * failed apply that cannot be provoked from outside — a real conflict is unreachable through
 * `applyVerifiedCandidate` by construction, because the drift check refuses to run a pick that
 * could conflict (#357).
 *
 * The other two are how the test of a signing read that overruns its buffer gets a buffer it can
 * overrun cheaply (#453). `applyVerifiedCandidateForTest` is `applyVerifiedCandidate` with the size
 * of that read's buffer passed in: a number, for that one read, so a test can shrink the buffer but
 * cannot swap the runner the read goes through, which is a way to make it pin nothing.
 * `DEFAULT_MAX_BUFFER_BYTES` is the size production gives it, so a test that pads past it can read
 * the size instead of repeating the number.
 *
 * Keeping them here rather than in `git-isolation.ts` says they are not part of the module's
 * surface: nothing under `src/` imports this file, so a caller reaching for any of them is reaching
 * past the API rather than using it.
 */
export {
  applyVerifiedCandidateForTest,
  cherryPickFailureResult,
  DEFAULT_MAX_BUFFER_BYTES,
  gitForTest,
  isolatedGitForTest,
} from './git-isolation.js';
