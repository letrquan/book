import type { ReviewFinding } from './types.js';
import { formatFinding } from './parse-findings.js';
import type { ReviewAgentHandle, ReviewAgentRunner } from './orchestration.js';

/**
 * `--fix` orchestration.
 *
 * Only *confirmed* findings are turned into patches. Each fix flows through the
 * existing managed-agent worktree pipeline: patcher produces an isolated patch,
 * a distinct validator records a pass/fail verdict, then the runner applies the
 * verified candidate. `apply` is expected to refuse unverified candidates (the
 * real manager enforces this with a distinct-validator lock).
 */

export interface FixApplyResult {
  status: 'applied' | 'conflicted' | 'not_applied';
  commit?: string;
  error?: string;
}

export interface FixAgentRunner extends ReviewAgentRunner {
  apply(agentId: string): Promise<FixApplyResult>;
}

export interface FixRunResult {
  attempted: number;
  applied: number;
  failed: number;
  findings: ReviewFinding[];
  messages: string[];
}

function buildFixPrompt(finding: ReviewFinding): string {
  return [
    'Implement a minimal, targeted fix for exactly one verified review finding.',
    'Do not refactor unrelated code. Follow existing project conventions.',
    '',
    formatFinding(finding),
    '',
    'When finished, publish the patch candidate as evidence and return a concise summary.',
  ].join('\n');
}

function buildValidatorPrompt(patcherId: string): string {
  return [
    `Independently validate the patch candidate produced by patcher agent ${patcherId}.`,
    'Use EvidenceList to find its patch candidate, inspect the diff, run any relevant',
    'named Check, and use EvidenceReview to record a pass or fail verdict.',
    'Never approve your own evidence and never edit the patch.',
  ].join('\n');
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
    let patcher: ReviewAgentHandle;
    try {
      patcher = await runner.spawn('patcher', buildFixPrompt(finding), `review-fix: ${finding.id}`);
      const settled = await runner.wait(patcher.id);
      if (settled.status === 'failed') {
        result.failed++;
        result.messages.push(
          `Failed to patch ${finding.file}: ${settled.error ?? 'unknown error'}`,
        );
        continue;
      }

      const validator = await runner.spawn(
        'validator',
        buildValidatorPrompt(patcher.id),
        `review-verify-fix: ${finding.id}`,
      );
      await runner.wait(validator.id);

      const applied = await runner.apply(patcher.id);
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
  if (result.messages.length === 0) return header;
  return [header, ...result.messages].join('\n');
}
