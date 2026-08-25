/**
 * Host-agnostic `/review` driver.
 *
 * The pipeline itself was already injectable (`ReviewAgentRunner`), but the
 * *sequencing* around it — single vs deep, the `--fix` follow-up, and the
 * "review failed" wording — lived inside the TUI, which is what made `/review`
 * unreachable from any other host. It lives here so every host runs the same
 * steps and emits the same text, and so a machine host can project one run into
 * a stable JSON shape without re-deriving anything.
 *
 * The review target is still resolved by the pipeline (`resolveReviewTarget`,
 * called inside `runSingleReview` / `runDeepReview`) from the host's workspace,
 * never by a reviewer agent.
 */

import {
  applyReviewFixes,
  renderFixResult,
  type FixAgentRunner,
  type FixRunResult,
} from './fix.js';
import {
  runDeepReview,
  runSingleReview,
  type ReviewAgentRunner,
  type ReviewRunOptions,
} from './orchestration.js';
import type { ReviewTarget } from './target.js';
import type {
  ReviewCoverage,
  ReviewFinding,
  ReviewReport,
  ReviewScope,
  ReviewVerdict,
} from './types.js';

export interface HostReviewRequest {
  /** Already parsed by `parseReviewScope`; `--base`, paths and ranges included. */
  scope: ReviewScope;
  /** Review root. The host owns it; reviewers never choose their own. */
  workspace: string;
  runner: ReviewAgentRunner;
  /**
   * Supplied only by a host that may apply patches. A `--fix` scope without one
   * fails instead of silently degrading to a read-only review.
   */
  fixRunner?: FixAgentRunner;
  /**
   * Progressive output. Segments are also returned in order, so a host that
   * renders once (print mode) and a host that streams (the TUI) share this code.
   */
  onSegment?: (text: string) => void;
  /**
   * Cancels the run. A review is minutes of work in agents the user cannot see
   * into, so every host that can take input while one is running needs a way to
   * end it that is not "kill the process".
   */
  signal?: AbortSignal;
}

export interface HostReviewResult {
  /**
   * Human-readable output, in emission order.
   *
   * A streaming host (one that supplied `onSegment`) also gets progress
   * segments here — the announced target — which a host that renders once
   * deliberately does not, so its printed report stays exactly the report.
   */
  segments: string[];
  target?: ReviewTarget;
  report?: ReviewReport;
  fix?: FixRunResult;
  /**
   * Set when the review could not run at all (bad scope, unresolvable target,
   * runner failure). Distinct from an inconclusive verdict, which means the
   * review ran but its coverage was incomplete.
   */
  error?: string;
  /** Set when the host cancelled the run before it produced a report. */
  cancelled?: boolean;
}

/** Raised when a `--fix` scope reaches a host that cannot apply patches. */
export const FIX_REQUIRES_APPLY_HOST =
  '--fix requires a host that can apply verified patches; no fix runner was provided.';

export const REVIEW_CANCELLED_NOTICE = '■ Review cancelled. No findings were reported.';

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : 'unknown';
}

/**
 * The "what is happening right now" line, emitted before the first agent starts.
 *
 * Everything downstream of this point runs inside agents for minutes with no
 * output of its own, so this is the only thing standing between the user and a
 * prompt that looks hung. It names the resolved target specifically — file
 * count, base, and path scope — because the second question after "is it
 * running?" is always "is it reviewing what I meant?".
 */
export function reviewStartSegment(target: ReviewTarget, scope: ReviewScope): string {
  const count = target.changedFiles.length;
  const files = `${count} file${count === 1 ? '' : 's'}`;
  const where =
    target.kind === 'committed-range'
      ? `${shortSha(target.baseSha)}...${shortSha(target.headSha)}`
      : `the working tree against ${shortSha(target.baseSha)}`;
  const path = target.path && target.path !== '.' ? ` under ${target.path}` : '';
  const passes = scope.fix
    ? 'four lenses, independent verification, then a patch and validation pass per confirmed finding'
    : scope.deep
      ? 'four lenses plus an independent verification pass'
      : 'one reviewer pass';
  return `Reviewing ${files}${path} in ${where} — ${passes}.`;
}

export async function runHostReview(request: HostReviewRequest): Promise<HostReviewResult> {
  const result: HostReviewResult = { segments: [] };
  const emit = (text: string): void => {
    result.segments.push(text);
    request.onSegment?.(text);
  };

  const runOptions: ReviewRunOptions = {
    signal: request.signal,
    onTarget: (target) => {
      result.target = target;
      // Progress is only meaningful to a host that renders as segments arrive.
      // A host that prints once at the end (print/headless) has no silence to
      // break, and prepending a "starting now" line there would change a
      // scripted output surface to say something already in `data.target`.
      if (!request.onSegment) return;
      // An empty target's own "no changes" text says everything this would, and
      // says it as the outcome rather than as a promise of work about to start.
      if (target.changedFiles.length === 0 && !target.diff.trim()) return;
      emit(reviewStartSegment(target, request.scope));
    },
  };

  try {
    // `--fix` implies `--deep`: only verified findings are ever patched, and
    // verification only exists on the deep path.
    if (request.scope.fix && !request.fixRunner) throw new Error(FIX_REQUIRES_APPLY_HOST);
    const fixRunner = request.scope.fix ? request.fixRunner : undefined;
    const deep = request.scope.deep || request.scope.fix;

    const review = deep
      ? await runDeepReview(request.runner, request.scope, request.workspace, runOptions)
      : await runSingleReview(request.runner, request.scope, request.workspace, runOptions);
    result.target = review.target;
    result.report = review.report;
    if (request.signal?.aborted) {
      result.cancelled = true;
      emit(REVIEW_CANCELLED_NOTICE);
      return result;
    }
    emit(review.text);
    if (!fixRunner) return result;

    const confirmed = review.report.findings.filter(
      (finding) => finding.verification === 'confirmed',
    );
    if (confirmed.length === 0) {
      emit('No confirmed findings are eligible for automatic fixes.');
      return result;
    }
    result.fix = await applyReviewFixes(fixRunner, confirmed, { signal: request.signal });
    // No separate cancellation notice here: `renderFixResult` already reports a
    // cancelled pass, and it has to be read anyway — this pass commits, so what
    // landed before the cancel matters more than the cancel.
    result.cancelled = result.fix.cancelled;
    emit(renderFixResult(result.fix));
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    emit(`✕ review failed: ${result.error}`);
    return result;
  }
}

/**
 * Machine-readable projection of one review run.
 *
 * This is a maintained output contract (`--output-format json` and
 * `stream-json`), so it is deliberately a projection of the existing domain
 * types rather than a parallel shape: `findings` are `ReviewFinding` values
 * verbatim and `coverage` is the pipeline's own `ReviewCoverage`. The only
 * reshaping is the target, which drops the unified diff — it is already the
 * input the caller supplied and can be megabytes.
 */
export interface ReviewJsonTarget {
  kind: ReviewTarget['kind'];
  baseSha: string;
  headSha?: string;
  /** Path scope, relative to the workspace. Absent when the whole change was reviewed. */
  path?: string;
  changedFiles: string[];
}

export interface ReviewJsonReport {
  verdict: ReviewVerdict;
  target?: ReviewJsonTarget;
  findings: ReviewFinding[];
  coverage?: ReviewCoverage;
}

export function reviewReportJson(result: HostReviewResult): ReviewJsonReport {
  return {
    // A run with no report at all is inconclusive by definition; hosts that
    // reject on `result.error` never reach this branch.
    verdict: result.report?.verdict ?? 'inconclusive',
    target: result.target
      ? {
          kind: result.target.kind,
          baseSha: result.target.baseSha,
          headSha: result.target.headSha,
          path: result.target.path,
          changedFiles: result.target.changedFiles,
        }
      : undefined,
    findings: result.report?.findings ?? [],
    coverage: result.report?.coverage,
  };
}
