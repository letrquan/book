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
import { runDeepReview, runSingleReview, type ReviewAgentRunner } from './orchestration.js';
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
}

export interface HostReviewResult {
  /** Human-readable output, in emission order. */
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
}

/** Raised when a `--fix` scope reaches a host that cannot apply patches. */
export const FIX_REQUIRES_APPLY_HOST =
  '--fix requires a host that can apply verified patches; no fix runner was provided.';

export async function runHostReview(request: HostReviewRequest): Promise<HostReviewResult> {
  const result: HostReviewResult = { segments: [] };
  const emit = (text: string): void => {
    result.segments.push(text);
    request.onSegment?.(text);
  };

  try {
    if (request.scope.fix) {
      // `--fix` implies `--deep`: only verified findings are ever patched.
      if (!request.fixRunner) throw new Error(FIX_REQUIRES_APPLY_HOST);
      const deep = await runDeepReview(request.runner, request.scope, request.workspace);
      result.target = deep.target;
      result.report = deep.report;
      emit(deep.text);
      const confirmed = deep.report.findings.filter(
        (finding) => finding.verification === 'confirmed',
      );
      if (confirmed.length === 0) {
        emit('No confirmed findings are eligible for automatic fixes.');
        return result;
      }
      result.fix = await applyReviewFixes(request.fixRunner, confirmed);
      emit(renderFixResult(result.fix));
      return result;
    }

    const review = request.scope.deep
      ? await runDeepReview(request.runner, request.scope, request.workspace)
      : await runSingleReview(request.runner, request.scope, request.workspace);
    result.target = review.target;
    result.report = review.report;
    emit(review.text);
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
