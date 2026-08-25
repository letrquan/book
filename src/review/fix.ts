import { onAbort } from '../async.js';
import type { ReviewFinding } from './types.js';
import { formatFinding } from './parse-findings.js';
import {
  REVIEW_CANCELLED,
  stopNonTerminal,
  type ReviewAgentHandle,
  type ReviewAgentRunner,
} from './orchestration.js';

/** `--fix` orchestration with an exact-evidence validation gate. */

export interface FixApplyResult {
  status: 'applied' | 'conflicted' | 'not_applied';
  commit?: string;
  error?: string;
}

export interface FixEvidence {
  id: string;
  verificationState: 'unverified' | 'verified' | 'rejected' | 'inconclusive';
  verdict?: 'pass' | 'fail' | 'inconclusive';
  reviewNotes?: string;
}

export interface FixAgentRunner extends ReviewAgentRunner {
  findPatchCandidateEvidence(agentId: string): Promise<FixEvidence | undefined>;
  getEvidence(evidenceId: string): Promise<FixEvidence | undefined>;
  apply(agentId: string, evidenceId: string): Promise<FixApplyResult>;
}

export interface FixRunResult {
  attempted: number;
  applied: number;
  failed: number;
  findings: ReviewFinding[];
  messages: string[];
  /** Set when the run stopped early because the host cancelled it. */
  cancelled?: boolean;
}

export interface FixRunOptions {
  maxFixes?: number;
  /**
   * Cancels the run. Checked between findings and while waiting on a patcher or
   * validator, because this pass edits and commits: a cancel that only took
   * effect between findings would let an in-flight patcher keep writing.
   */
  signal?: AbortSignal;
}

const FIX_TIMEOUT_MS = 10 * 60 * 1000;

function buildFixPrompt(finding: ReviewFinding): string {
  return [
    'Implement a minimal, targeted fix for exactly one verified review finding.',
    'Do not refactor unrelated code. Follow existing project conventions.',
    '',
    formatFinding(finding),
    '',
    'When finished, return a concise summary. The manager will commit and publish the exact',
    'patch candidate as evidence after your run completes.',
  ].join('\n');
}

function buildValidatorPrompt(patcherId: string, evidenceId: string): string {
  return [
    `Independently validate evidence ${evidenceId} produced by patcher agent ${patcherId}.`,
    `Call EvidenceList with includeUnverified=true and ids=["${evidenceId}"].`,
    'Inspect the exact diff, run relevant named checks, and call EvidenceReview for that exact',
    'evidence id with pass, fail, or inconclusive. Never edit or approve your own evidence.',
  ].join('\n');
}

function terminalFailure(handle: ReviewAgentHandle): string | undefined {
  return handle.status === 'completed'
    ? undefined
    : (handle.error ?? `agent ended with status ${handle.status}`);
}

export async function applyReviewFixes(
  runner: FixAgentRunner,
  confirmed: readonly ReviewFinding[],
  options: FixRunOptions = {},
): Promise<FixRunResult> {
  const findings = confirmed.slice(0, options.maxFixes ?? 10);
  const result: FixRunResult = {
    attempted: findings.length,
    applied: 0,
    failed: 0,
    findings: [...findings],
    messages: [],
  };

  /** Stop whichever agent is in flight so a cancel lands mid-pass, not after it. */
  const waitFor = async (handle: ReviewAgentHandle): Promise<ReviewAgentHandle> => {
    const release = onAbort(options.signal, () => {
      // Recorded here, not only at the top of the loop: an abort that lands
      // while the last finding's patcher or validator is running would
      // otherwise end the pass with `cancelled` unset, reporting the agent it
      // just stopped as an ordinary patch failure and the run as complete.
      result.cancelled = true;
      void stopNonTerminal(runner, [handle], REVIEW_CANCELLED);
    });
    try {
      return await runner.wait(handle.id, FIX_TIMEOUT_MS);
    } finally {
      release();
    }
  };

  for (const finding of findings) {
    if (options.signal?.aborted) {
      result.cancelled = true;
      result.messages.push(`Stopped before fixing ${finding.file}: ${REVIEW_CANCELLED}.`);
      break;
    }
    try {
      const patcher = await runner.spawn('patcher', buildFixPrompt(finding), {
        description: `review-fix: ${finding.id}`,
      });
      const settled = await waitFor(patcher);
      if (!['completed', 'failed', 'stopped', 'interrupted'].includes(settled.status)) {
        await runner.stop?.(settled.id, 'review fix timed out');
      }
      const patchFailure = terminalFailure(settled);
      if (patchFailure) {
        // A patcher we stopped ourselves is a cancellation, not a failed fix.
        if (result.cancelled) {
          result.messages.push(`Stopped while fixing ${finding.file}: ${REVIEW_CANCELLED}.`);
          break;
        }
        result.failed++;
        result.messages.push(`Failed to patch ${finding.file}: ${patchFailure}`);
        continue;
      }

      const candidate = await runner.findPatchCandidateEvidence(patcher.id);
      if (!candidate) {
        result.failed++;
        result.messages.push(`Fix for ${finding.file} produced no exact patch-candidate evidence.`);
        continue;
      }

      const validator = await runner.spawn(
        'validator',
        buildValidatorPrompt(patcher.id, candidate.id),
        {
          description: `review-verify-fix: ${finding.id}`,
          evidenceIds: [candidate.id],
        },
      );
      const validation = await waitFor(validator);
      if (!['completed', 'failed', 'stopped', 'interrupted'].includes(validation.status)) {
        await runner.stop?.(validation.id, 'review fix validation timed out');
      }
      const validationFailure = terminalFailure(validation);
      if (validationFailure) {
        if (result.cancelled) {
          // The patch candidate exists but was never independently approved, so
          // it is deliberately left unapplied.
          result.messages.push(`Stopped while validating ${finding.file}: ${REVIEW_CANCELLED}.`);
          break;
        }
        result.failed++;
        result.messages.push(`Validation failed for ${finding.file}: ${validationFailure}`);
        continue;
      }

      const reviewed = await runner.getEvidence(candidate.id);
      if (reviewed?.verificationState !== 'verified' || reviewed.verdict !== 'pass') {
        result.failed++;
        const notes = reviewed?.reviewNotes ? `: ${reviewed.reviewNotes}` : '';
        result.messages.push(
          `Validator did not approve the fix for ${finding.file} (${reviewed?.verdict ?? reviewed?.verificationState ?? 'missing verdict'}${notes}).`,
        );
        continue;
      }

      const applied = await runner.apply(patcher.id, candidate.id);
      if (applied.status === 'applied') {
        result.applied++;
        result.messages.push(
          `Applied fix for ${finding.file}${applied.commit ? ` (${applied.commit})` : ''}.`,
        );
      } else {
        result.failed++;
        result.messages.push(
          `Fix for ${finding.file} was not applied (${applied.status}${applied.error ? `: ${applied.error}` : ''}).`,
        );
      }
    } catch (error) {
      result.failed++;
      result.messages.push(
        `Fix for ${finding.file} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // `attempted` means "findings whose outcome is known". A cancel can land
  // mid-finding, so it is recomputed rather than left at the planned count.
  if (result.cancelled) result.attempted = result.applied + result.failed;
  return result;
}

export function renderFixResult(result: FixRunResult): string {
  const header = result.cancelled
    ? `Fix pass cancelled after applying ${result.applied} of ${result.findings.length} verified fixes.`
    : `Applied ${result.applied} of ${result.attempted} verified fixes.`;
  return result.messages.length === 0 ? header : [header, ...result.messages].join('\n');
}
