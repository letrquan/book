import { dedupeFindings, filterLowConfidence, rankFindings } from './findings.js';
import { parseReviewReport, renderReviewReport } from './parse-findings.js';
import { buildReviewerPrompt, REVIEW_LENSES } from './prompts.js';
import {
  applyVerification,
  buildVerificationPrompt,
  parseVerificationVerdicts,
} from './verify-findings.js';
import type { ReviewFinding, ReviewReport, ReviewScope } from './types.js';

/**
 * Deep review orchestration.
 *
 * Fan out specialized read-only reviewers, collapse and rank their findings,
 * then run an independent falsification pass before returning. The runner
 * interface is deliberately small so the TUI can adapt the real manager while
 * unit tests inject fakes.
 */

export interface ReviewAgentHandle {
  id: string;
  result?: string;
  error?: string;
  status: string;
}

export interface ReviewAgentRunner {
  spawn(agent: string, prompt: string, description?: string): Promise<ReviewAgentHandle>;
  wait(id: string): Promise<ReviewAgentHandle>;
}

export interface DeepReviewResult {
  report: ReviewReport;
  text: string;
}

function argsFromScope(scope: ReviewScope): string {
  const parts: string[] = [];
  if (scope.base) parts.push(`--base ${scope.base}`);
  if (scope.target) parts.push(scope.target);
  return parts.join(' ');
}

function terminalText(handle: ReviewAgentHandle): string | undefined {
  if (handle.status === 'failed') return handle.error ?? handle.result;
  return handle.result;
}

/** Assign stable, collision-free ids after merging independently parsed reports. */
function reindex(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.map((finding, index) => ({ ...finding, id: `finding-${index + 1}` }));
}

export async function runDeepReview(
  runner: ReviewAgentRunner,
  scope: ReviewScope,
  workspace?: string,
): Promise<DeepReviewResult> {
  const args = argsFromScope(scope);
  const reviewerIds: string[] = [];

  // Phase 1: parallel specialized reviewers.
  const spawns = REVIEW_LENSES.map((lens) =>
    runner.spawn('explorer', buildReviewerPrompt(lens, args, workspace), `review: ${lens.id}`),
  );
  const spawned = await Promise.all(spawns);
  spawned.forEach((handle) => reviewerIds.push(handle.id));

  const settled = await Promise.all(reviewerIds.map((id) => runner.wait(id)));
  const rawFindings = settled.flatMap((handle) => {
    const text = terminalText(handle);
    return text ? parseReviewReport(text).findings : [];
  });

  const candidates = reindex(rankFindings(filterLowConfidence(dedupeFindings(rawFindings))));

  if (candidates.length === 0) {
    return {
      report: { verdict: 'clean', findings: [] },
      text: 'Deep review complete: no confirmed findings.',
    };
  }

  // Phase 2: independent falsification.
  const verifier = await runner.spawn(
    'explorer',
    buildVerificationPrompt(candidates),
    'review: verify',
  );
  const verifiedHandle = await runner.wait(verifier.id);
  const verdicts = parseVerificationVerdicts(terminalText(verifiedHandle) ?? '');
  const verified = applyVerification(candidates, verdicts);
  const ranked = rankFindings(verified);

  const verdict = ranked.some(
    (finding) => finding.verification === 'confirmed' && finding.severity === 'critical',
  )
    ? 'blocking'
    : ranked.some((finding) => finding.verification === 'confirmed')
      ? 'recommend'
      : ranked.length > 0
        ? 'inconclusive'
        : 'clean';

  const report: ReviewReport = { verdict, findings: ranked };
  return { report, text: renderReviewReport(report) };
}
