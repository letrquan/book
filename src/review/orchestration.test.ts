import { describe, expect, it } from 'vitest';
import { runDeepReview, type ReviewAgentRunner } from './orchestration.js';

function verdictText(): string {
  return JSON.stringify({
    verdicts: [
      { findingId: 'finding-1', state: 'confirmed', reason: 'real' },
      { findingId: 'finding-2', state: 'rejected', reason: 'not real' },
    ],
  });
}

function makeRunner(
  reviewerResults: string[],
  verifierResult: string,
): ReviewAgentRunner & { spawned: string[]; waited: string[] } {
  const spawned: string[] = [];
  const waited: string[] = [];
  let spawnIndex = 0;
  return {
    spawned,
    waited,
    async spawn(agent, _prompt, _description) {
      spawned.push(agent);
      return { id: `agent-${spawnIndex++}`, status: 'queued' };
    },
    async wait(id) {
      waited.push(id);
      // Reviewers are the first four ids; the verifier is the last.
      if (id === 'agent-4') return { id, status: 'completed', result: verifierResult };
      const index = Number(id.slice('agent-'.length));
      return { id, status: 'completed', result: reviewerResults[index] };
    },
  };
}

describe('runDeepReview', () => {
  it('fans out specialized reviewers and runs independent verification', async () => {
    const finding1 = JSON.stringify({
      findings: [
        {
          severity: 'critical',
          category: 'correctness',
          file: 'src/a.ts',
          line: 1,
          summary: 'real bug',
          evidence: 'x',
          failure: 'fails',
          suggestedFix: 'guard',
          confidence: 90,
        },
      ],
    });
    const finding2 = JSON.stringify({
      findings: [
        {
          severity: 'major',
          category: 'security',
          file: 'src/b.ts',
          line: 2,
          summary: 'false alarm',
          evidence: 'y',
          failure: 'fails',
          suggestedFix: 'fix',
          confidence: 90,
        },
      ],
    });

    const runner = makeRunner([finding1, finding2, '{}', '{}'], verdictText());
    const result = await runDeepReview(runner, { deep: true, fix: false, help: false });

    expect(runner.spawned.filter((agent) => agent === 'explorer')).toHaveLength(5);
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]).toMatchObject({ id: 'finding-1', verification: 'confirmed' });
  });

  it('returns clean when no candidates survive', async () => {
    const runner = makeRunner(['{}', '{}', '{}', '{}'], '{}');
    const result = await runDeepReview(runner, { deep: true, fix: false, help: false });
    expect(result.report.verdict).toBe('clean');
    expect(result.text).toContain('no confirmed findings');
  });
});
