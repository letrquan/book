import type { ReviewFinding } from './types.js';
import { formatFinding } from './parse-findings.js';
import type { ReviewAgentHandle, ReviewAgentRunner } from './orchestration.js';

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
  maxFixes = 10,
): Promise<FixRunResult> {
  const findings = confirmed.slice(0, maxFixes);
  const result: FixRunResult = {
    attempted: findings.length,
    applied: 0,
    failed: 0,
    findings: [...findings],
    messages: [],
  };

  for (const finding of findings) {
    try {
      const patcher = await runner.spawn('patcher', buildFixPrompt(finding), {
        description: `review-fix: ${finding.id}`,
      });
      const settled = await runner.wait(patcher.id, FIX_TIMEOUT_MS);
      if (!['completed', 'failed', 'stopped', 'interrupted'].includes(settled.status)) {
        await runner.stop?.(settled.id, 'review fix timed out');
      }
      const patchFailure = terminalFailure(settled);
      if (patchFailure) {
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
      const validation = await runner.wait(validator.id, FIX_TIMEOUT_MS);
      if (!['completed', 'failed', 'stopped', 'interrupted'].includes(validation.status)) {
        await runner.stop?.(validation.id, 'review fix validation timed out');
      }
      const validationFailure = terminalFailure(validation);
      if (validationFailure) {
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

  return result;
}

export function renderFixResult(result: FixRunResult): string {
  const header = `Applied ${result.applied} of ${result.attempted} verified fixes.`;
  return result.messages.length === 0 ? header : [header, ...result.messages].join('\n');
}
