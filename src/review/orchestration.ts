import { dedupeFindings, filterLowConfidence, rankFindings } from './findings.js';
import {
  isStructuredReviewReport,
  parseReviewReport,
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
import type { ReviewCoverageEntry, ReviewFinding, ReviewReport, ReviewScope } from './types.js';

/** Fan-out review orchestration with explicit operational coverage. */

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

async function stopNonTerminal(
  runner: ReviewAgentRunner,
  handles: readonly ReviewAgentHandle[],
): Promise<void> {
  if (!runner.stop) return;
  await Promise.allSettled(
    handles
      .filter((handle) => !TERMINAL_STATUSES.has(handle.status))
      .map((handle) => runner.stop!(handle.id, 'review orchestration failed')),
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
): Promise<SingleReviewResult> {
  if (scope.error) throw new Error(scope.error);
  const target = await resolveReviewTarget(workspace, scope);
  const empty = emptyTargetReport(target);
  if (empty) return empty;

  const handle = await runner.spawn('reviewer', buildSingleReviewPrompt(workspace, target), {
    description: 'review: single',
  });
  const settled = await runner.wait(handle.id, REVIEW_TIMEOUT_MS);
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

  const parsed = parseReviewReport(settled.result ?? '');
  const structured = isStructuredReviewReport(settled.result ?? '');
  const findings = reindex(rankFindings(filterLowConfidence(dedupeFindings(parsed.findings))));
  const coverage: ReviewCoverageEntry = {
    id: 'single',
    status: structured ? 'completed' : 'unstructured',
    findings: findings.length,
    error: structured ? undefined : 'reviewer did not return the required JSON report',
  };
  const report: ReviewReport = {
    verdict: structured ? parsed.verdict : 'inconclusive',
    findings,
    coverage: { reviewers: [coverage] },
  };
  const text = [
    renderCoverageWarnings([coverage]),
    renderReviewReport(report),
    structured ? '' : renderRawOutput('reviewer', settled.result),
  ]
    .filter(Boolean)
    .join('\n\n');
  return { target, report, text };
}

function renderCoverageWarnings(entries: readonly ReviewCoverageEntry[]): string {
  const incomplete = entries.filter((entry) => entry.status !== 'completed');
  if (incomplete.length === 0) return '';
  return [
    'Coverage warning: review is inconclusive because required passes did not complete.',
    ...incomplete.map(
      (entry) => `- ${entry.id}: ${entry.status}${entry.error ? ` — ${entry.error}` : ''}`,
    ),
  ].join('\n');
}

export async function runDeepReview(
  runner: ReviewAgentRunner,
  scope: ReviewScope,
  workspace: string,
): Promise<DeepReviewResult> {
  if (scope.error) throw new Error(scope.error);
  const target = await resolveReviewTarget(workspace, scope);
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
  try {
    const spawnResults = await Promise.allSettled(
      REVIEW_LENSES.map((lens) =>
        runner.spawn('reviewer', buildReviewerPrompt(lens, workspace, target), {
          description: `review: ${lens.id}`,
        }),
      ),
    );
    const spawnFailures: ReviewCoverageEntry[] = [];
    spawnResults.forEach((result, index) => {
      const lens = REVIEW_LENSES[index]!;
      if (result.status === 'fulfilled') {
        spawned.push(result.value);
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
      const parsed = parseReviewReport(result.value.result ?? '');
      const structured = isStructuredReviewReport(result.value.result ?? '');
      reviewerCoverage.push({
        id: lensId,
        status: structured ? 'completed' : 'unstructured',
        findings: parsed.findings.length,
        error: structured ? undefined : 'reviewer did not return the required JSON report',
      });
      if (!structured) {
        const raw = renderRawOutput(lensId, result.value.result);
        if (raw) rawOutputs.push(raw);
      }
      rawFindings.push(...parsed.findings);
      if (structured) reviewerVerdicts.push(parsed.verdict);
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

    const verifier = await runner.spawn(
      'reviewer',
      buildVerificationPrompt(candidates, loadReviewConfig(workspace), target),
      { description: 'review: verify' },
    );
    spawned.push(verifier);
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
  }
}
