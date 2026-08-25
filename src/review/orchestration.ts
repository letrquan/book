import { dedupeFindings, filterLowConfidence, rankFindings } from './findings.js';
import {
  isStructuredReviewReport,
  parseReviewReportDetailed,
  renderReviewReport,
} from './parse-findings.js';
import { buildReviewerPrompt, buildSingleReviewPrompt, REVIEW_LENSES } from './prompts.js';
import { loadReviewConfig } from './config.js';
import { resolveReviewTarget, type ReviewTarget } from './target.js';
import {
  applyVerification,
  buildVerificationPrompt,
  parseVerificationVerdicts,
} from './verify-findings.js';
import { onAbort } from '../async.js';
import type { ReviewCoverageEntry, ReviewFinding, ReviewReport, ReviewScope } from './types.js';

/** Fan-out review orchestration with explicit operational coverage. */

export const REVIEW_CANCELLED = 'review cancelled';

export interface ReviewRunOptions {
  /**
   * Fires once the immutable target is resolved and before any reviewer is
   * spawned, so a host can tell the user what is being reviewed instead of
   * going silent for the length of the run.
   */
  onTarget?: (target: ReviewTarget) => void;
  /**
   * Cancels the run. In-flight agents are stopped; because `stop` drives an
   * agent to a terminal status, the passes that were already waiting settle
   * normally and are recorded as incomplete coverage rather than hanging.
   */
  signal?: AbortSignal;
}

export interface ReviewAgentHandle {
  id: string;
  result?: string;
  error?: string;
  status: string;
  producedEvidenceIds?: string[];
}

export interface ReviewSpawnOptions {
  description?: string;
  evidenceIds?: string[];
}

export interface ReviewAgentRunner {
  spawn(agent: string, prompt: string, options?: ReviewSpawnOptions): Promise<ReviewAgentHandle>;
  wait(id: string, timeoutMs?: number): Promise<ReviewAgentHandle>;
  stop?(id: string, reason?: string): Promise<void>;
}

function failureResult(
  target: ReviewTarget,
  id: string,
  status: ReviewCoverageEntry['status'],
  error: string,
): SingleReviewResult {
  const report: ReviewReport = {
    verdict: 'inconclusive',
    findings: [],
    coverage: { reviewers: [{ id, status, findings: 0, error }] },
  };
  return {
    target,
    report,
    text: [renderCoverageWarnings(report.coverage!.reviewers), renderReviewReport(report)].join(
      '\n\n',
    ),
  };
}

export interface DeepReviewResult {
  report: ReviewReport;
  text: string;
  target: ReviewTarget;
}

export interface SingleReviewResult {
  report: ReviewReport;
  text: string;
  target: ReviewTarget;
}

const REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

/** Assign collision-free ids after merging independently parsed reports. */
function reindex(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.map((finding, index) => ({ ...finding, id: `finding-${index + 1}` }));
}

function coverageStatus(handle: ReviewAgentHandle): ReviewCoverageEntry['status'] {
  if (!TERMINAL_STATUSES.has(handle.status)) return 'timed_out';
  return handle.status === 'completed' ? 'completed' : 'failed';
}

/**
 * Best-effort stop for handles that may already be terminal.
 *
 * Never rejects: `Promise.allSettled` swallows the cases `stop` legitimately
 * throws on — an agent another Book process owns, or an id the manager has
 * already forgotten — which matters because every cancellation path calls this
 * from an abort handler nothing awaits.
 */
export async function stopNonTerminal(
  runner: ReviewAgentRunner,
  handles: readonly ReviewAgentHandle[],
  reason = 'review orchestration failed',
): Promise<void> {
  if (!runner.stop) return;
  await Promise.allSettled(
    handles
      .filter((handle) => !TERMINAL_STATUSES.has(handle.status))
      .map((handle) => runner.stop!(handle.id, reason)),
  );
}

function verdictCoverageIsComplete(
  findings: readonly ReviewFinding[],
  verdicts: readonly { findingId: string }[],
): boolean {
  if (verdicts.length !== findings.length) return false;
  const expected = new Set(findings.map((finding) => finding.id));
  const actual = new Set(verdicts.map((verdict) => verdict.findingId));
  return actual.size === expected.size && [...expected].every((id) => actual.has(id));
}

const MAX_RAW_OUTPUT_CHARS = 4000;

/**
 * Preserve a pass's prose when it failed the JSON contract.
 *
 * Reviews run in managed agents, so their raw output is not otherwise visible
 * anywhere. Dropping it would leave the user with "no structured findings were
 * returned" and no way to see what the reviewer actually said.
 */
function renderRawOutput(id: string, text: string | undefined): string {
  const body = (text ?? '').trim();
  if (!body) return '';
  const truncated =
    body.length > MAX_RAW_OUTPUT_CHARS
      ? `${body.slice(0, MAX_RAW_OUTPUT_CHARS)}\n… (truncated)`
      : body;
  return [`Raw ${id} output (did not satisfy the JSON contract):`, truncated].join('\n');
}

/**
 * A cancelled run is `inconclusive` with empty coverage, never `clean`.
 *
 * Hosts replace this text with their own cancellation notice, but the report
 * still has to be honest for the JSON projection: nothing was reviewed, so
 * nothing may be reported as reviewed and found fine.
 */
function cancelledDeepResult(target: ReviewTarget): DeepReviewResult {
  return {
    target,
    report: { verdict: 'inconclusive', findings: [], coverage: { reviewers: [] } },
    text: `Deep review cancelled: ${REVIEW_CANCELLED}.`,
  };
}

function emptyTargetReport(target: ReviewTarget): SingleReviewResult | undefined {
  if (target.changedFiles.length !== 0 || target.diff.trim()) return undefined;
  const report: ReviewReport = { verdict: 'clean', findings: [] };
  return {
    target,
    report,
    text: 'Review complete: the selected review target has no changes.',
  };
}

/** Run the ordinary one-pass review through the same immutable target boundary as deep review. */
export async function runSingleReview(
  runner: ReviewAgentRunner,
  scope: ReviewScope,
  workspace: string,
  options: ReviewRunOptions = {},
): Promise<SingleReviewResult> {
  if (scope.error) throw new Error(scope.error);
  const target = await resolveReviewTarget(workspace, scope);
  options.onTarget?.(target);
  const empty = emptyTargetReport(target);
  if (empty) return empty;
  if (options.signal?.aborted) return failureResult(target, 'single', 'failed', REVIEW_CANCELLED);

  const handle = await runner.spawn('reviewer', buildSingleReviewPrompt(workspace, target), {
    description: 'review: single',
  });
  const releaseAbort = onAbort(options.signal, () => {
    // `stop` rejects on a record another Book process owns, and on an id the
    // manager has forgotten. Nothing awaits this handler, and there is no
    // global unhandled-rejection guard, so an unswallowed rejection here would
    // take the whole CLI down on the keystroke meant to cancel one review.
    void stopNonTerminal(runner, [handle], REVIEW_CANCELLED);
  });
  let settled: ReviewAgentHandle;
  try {
    settled = await runner.wait(handle.id, REVIEW_TIMEOUT_MS);
  } finally {
    releaseAbort();
  }
  if (!TERMINAL_STATUSES.has(settled.status)) {
    await runner.stop?.(settled.id, 'review timed out');
    return failureResult(target, 'single', 'timed_out', 'reviewer timed out');
  }
  if (settled.status !== 'completed') {
    return failureResult(
      target,
      'single',
      'failed',
      settled.error ?? `agent ended with status ${settled.status}`,
    );
  }

  const parsed = parseReviewReportDetailed(settled.result ?? '');
  const structured = isStructuredReviewReport(settled.result ?? '');
  const findings = reindex(
    rankFindings(filterLowConfidence(dedupeFindings(parsed.report.findings))),
  );
  const coverage = passCoverage('single', structured, parsed.droppedFindings, findings.length);
  const report: ReviewReport = {
    verdict: coverage.status === 'completed' ? parsed.report.verdict : 'inconclusive',
    findings,
    coverage: { reviewers: [coverage] },
  };
  const text = [
    renderCoverageWarnings([coverage]),
    renderReviewReport(report),
    coverage.status === 'completed' ? '' : renderRawOutput('reviewer', settled.result),
  ]
    .filter(Boolean)
    .join('\n\n');
  return { target, report, text };
}

/**
 * Coverage for a pass that reached a terminal `completed` status.
 *
 * A pass is only `completed` when the envelope parsed *and* every finding it
 * claimed survived the per-finding contract. Dropping findings silently would
 * report a clean review for output the pipeline could not actually read.
 */
function passCoverage(
  id: string,
  structured: boolean,
  droppedFindings: number,
  findings: number,
): ReviewCoverageEntry {
  if (!structured) {
    return {
      id,
      status: 'unstructured',
      findings,
      droppedFindings: droppedFindings || undefined,
      error: 'reviewer did not return the required JSON report',
    };
  }
  if (droppedFindings > 0) {
    return {
      id,
      status: 'partial',
      findings,
      droppedFindings,
      error: `${droppedFindings} finding(s) were discarded for missing required fields (evidence, failure, suggestedFix, or a numeric confidence)`,
    };
  }
  return { id, status: 'completed', findings };
}

function renderCoverageWarnings(entries: readonly ReviewCoverageEntry[]): string {
  const incomplete = entries.filter((entry) => entry.status !== 'completed');
  if (incomplete.length === 0) return '';
  return [
    'Coverage warning: review is inconclusive because required passes did not complete.',
    ...incomplete.map((entry) => {
      const dropped = entry.droppedFindings ? ` [${entry.droppedFindings} finding(s) dropped]` : '';
      return `- ${entry.id}: ${entry.status}${dropped}${entry.error ? ` — ${entry.error}` : ''}`;
    }),
  ].join('\n');
}

export async function runDeepReview(
  runner: ReviewAgentRunner,
  scope: ReviewScope,
  workspace: string,
  options: ReviewRunOptions = {},
): Promise<DeepReviewResult> {
  if (scope.error) throw new Error(scope.error);
  const target = await resolveReviewTarget(workspace, scope);
  options.onTarget?.(target);
  if (target.changedFiles.length === 0 && !target.diff.trim()) {
    return {
      target,
      report: {
        verdict: 'clean',
        findings: [],
        coverage: { reviewers: [] },
      },
      text: 'Deep review complete: the selected review target has no changes.',
    };
  }

  const spawned: ReviewAgentHandle[] = [];
  const rawOutputs: string[] = [];
  const reviewerIds = new Map<string, string>();
  const releaseAbort = onAbort(options.signal, () => {
    void stopNonTerminal(runner, spawned, REVIEW_CANCELLED);
  });

  /**
   * Spawn and register in the same step.
   *
   * The abort subscription fires once and reads `spawned` at fire time, so a
   * handle that only appears after it fired would never be stopped — and a
   * spawn is not instant (plan creation and a required record write, both with
   * retries). Registering before the next `await`, and re-checking the signal
   * afterwards, closes that window from both sides: whichever of the two
   * happened first, the agent is stopped exactly once.
   */
  const spawnTracked = async (prompt: string, description: string): Promise<ReviewAgentHandle> => {
    const handle = await runner.spawn('reviewer', prompt, { description });
    spawned.push(handle);
    if (options.signal?.aborted) await stopNonTerminal(runner, [handle], REVIEW_CANCELLED);
    return handle;
  };

  try {
    // Checked before each fan-out as well as inside it: an abort that lands
    // between resolving the target and spawning has nothing to stop yet, and
    // would otherwise start the very agents the user just cancelled.
    if (options.signal?.aborted) return cancelledDeepResult(target);
    const spawnResults = await Promise.allSettled(
      REVIEW_LENSES.map((lens) =>
        spawnTracked(buildReviewerPrompt(lens, workspace, target), `review: ${lens.id}`),
      ),
    );
    const spawnFailures: ReviewCoverageEntry[] = [];
    spawnResults.forEach((result, index) => {
      const lens = REVIEW_LENSES[index]!;
      if (result.status === 'fulfilled') {
        // `spawned` is keyed by handle id, not by position, so the completion
        // order `spawnTracked` pushes in is fine.
        reviewerIds.set(result.value.id, lens.id);
      } else {
        spawnFailures.push({
          id: lens.id,
          status: 'failed',
          findings: 0,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
    // Without this the run would await four cancelled agents for the full
    // ten-minute pass timeout before noticing.
    if (options.signal?.aborted) return cancelledDeepResult(target);

    const waitResults = await Promise.allSettled(
      spawned.map((handle) => runner.wait(handle.id, REVIEW_TIMEOUT_MS)),
    );
    const reviewerCoverage: ReviewCoverageEntry[] = [...spawnFailures];
    const rawFindings: ReviewFinding[] = [];
    const reviewerVerdicts: ReviewReport['verdict'][] = [];
    for (let index = 0; index < waitResults.length; index++) {
      const result = waitResults[index]!;
      const handle = spawned[index]!;
      const lensId = reviewerIds.get(handle.id) ?? handle.id;
      if (result.status === 'rejected') {
        reviewerCoverage.push({
          id: lensId,
          status: 'failed',
          findings: 0,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        continue;
      }
      const status = coverageStatus(result.value);
      if (status !== 'completed') {
        if (status === 'timed_out') {
          await runner.stop?.(result.value.id, 'review pass timed out');
        }
        reviewerCoverage.push({
          id: lensId,
          status,
          findings: 0,
          error: result.value.error ?? `agent ended with status ${result.value.status}`,
        });
        continue;
      }
      const parsed = parseReviewReportDetailed(result.value.result ?? '');
      const structured = isStructuredReviewReport(result.value.result ?? '');
      const coverage = passCoverage(
        lensId,
        structured,
        parsed.droppedFindings,
        parsed.report.findings.length,
      );
      reviewerCoverage.push(coverage);
      if (coverage.status !== 'completed') {
        const raw = renderRawOutput(lensId, result.value.result);
        if (raw) rawOutputs.push(raw);
      }
      rawFindings.push(...parsed.report.findings);
      if (structured) reviewerVerdicts.push(parsed.report.verdict);
    }

    reviewerCoverage.sort(
      (left, right) =>
        REVIEW_LENSES.findIndex((lens) => lens.id === left.id) -
        REVIEW_LENSES.findIndex((lens) => lens.id === right.id),
    );
    const completeDiscovery = reviewerCoverage.every((entry) => entry.status === 'completed');
    const candidates = reindex(rankFindings(filterLowConfidence(dedupeFindings(rawFindings))));
    if (candidates.length === 0) {
      const report: ReviewReport = {
        verdict:
          completeDiscovery && reviewerVerdicts.every((verdict) => verdict === 'clean')
            ? 'clean'
            : 'inconclusive',
        findings: [],
        coverage: { reviewers: reviewerCoverage },
      };
      const warning = renderCoverageWarnings(reviewerCoverage);
      return {
        target,
        report,
        text: [warning || 'Deep review complete: no confirmed findings.', ...rawOutputs].join(
          '\n\n',
        ),
      };
    }

    if (options.signal?.aborted) return cancelledDeepResult(target);
    const verifier = await spawnTracked(
      buildVerificationPrompt(candidates, loadReviewConfig(workspace), target),
      'review: verify',
    );
    if (options.signal?.aborted) return cancelledDeepResult(target);
    const verifiedHandle = await runner.wait(verifier.id, REVIEW_TIMEOUT_MS);
    if (!TERMINAL_STATUSES.has(verifiedHandle.status)) {
      await runner.stop?.(verifiedHandle.id, 'review verification timed out');
    }
    const verifierState = coverageStatus(verifiedHandle);
    const verdicts =
      verifierState === 'completed' ? parseVerificationVerdicts(verifiedHandle.result ?? '') : [];
    const completeVerdicts = verdicts.length > 0 && verdictCoverageIsComplete(candidates, verdicts);
    const verifierCoverage: ReviewCoverageEntry = {
      id: 'verification',
      status: verifierState === 'completed' && !completeVerdicts ? 'unstructured' : verifierState,
      findings: verdicts.length,
      error:
        verifierState !== 'completed'
          ? (verifiedHandle.error ?? `agent ended with status ${verifiedHandle.status}`)
          : !completeVerdicts
            ? 'verifier did not return exactly one valid verdict for every candidate'
            : undefined,
    };
    if (verifierCoverage.status === 'unstructured') {
      const raw = renderRawOutput('verification', verifiedHandle.result);
      if (raw) rawOutputs.push(raw);
    }
    const verified = applyVerification(candidates, verdicts);
    const ranked = rankFindings(verified);
    const completeCoverage = completeDiscovery && verifierCoverage.status === 'completed';
    const verdict = !completeCoverage
      ? 'inconclusive'
      : ranked.some(
            (finding) => finding.verification === 'confirmed' && finding.severity === 'critical',
          )
        ? 'blocking'
        : ranked.some((finding) => finding.verification === 'confirmed')
          ? 'recommend'
          : ranked.length > 0
            ? 'inconclusive'
            : 'clean';
    const report: ReviewReport = {
      verdict,
      findings: ranked,
      coverage: { reviewers: reviewerCoverage, verifier: verifierCoverage },
    };
    const warning = renderCoverageWarnings([...reviewerCoverage, verifierCoverage]);
    return {
      target,
      report,
      text: [warning, renderReviewReport(report), ...rawOutputs].filter(Boolean).join('\n\n'),
    };
  } catch (error) {
    await stopNonTerminal(runner, spawned);
    throw error;
  } finally {
    releaseAbort();
  }
}
