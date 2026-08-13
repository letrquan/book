import { describe, expect, it } from 'vitest';
import { applyReviewFixes, renderFixResult, type FixAgentRunner } from './fix.js';
import type { ReviewFinding } from './types.js';

const finding: ReviewFinding = {
  id: 'f1',
  severity: 'major',
  category: 'correctness',
  file: 'src/a.ts',
  line: 3,
  summary: 'bad',
  evidence: 'x',
  failure: 'fails',
  suggestedFix: 'guard',
  confidence: 90,
};

function makeRunner(): FixAgentRunner & { applied: string[] } {
  const applied: string[] = [];
  let id = 0;
  return {
    applied,
    async spawn() {
      return { id: `agent-${id++}`, status: 'queued' };
    },
    async wait(agentId) {
      return { id: agentId, status: 'completed', result: 'done' };
    },
    async apply(agentId) {
      applied.push(agentId);
      return { status: 'applied', commit: 'abc123' };
    },
  };
}

describe('applyReviewFixes', () => {
  it('patches, validates, and applies each confirmed finding', async () => {
    const runner = makeRunner();
    const result = await applyReviewFixes(runner, [finding]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(runner.applied).toHaveLength(1);
  });

  it('caps the number of fixes', async () => {
    const runner = makeRunner();
    const findings = Array.from({ length: 15 }, (_, index) => ({ ...finding, id: `f${index}` }));
    const result = await applyReviewFixes(runner, findings, 10);
    expect(result.attempted).toBe(10);
  });

  it('records failures from the apply result', async () => {
    const runner = makeRunner();
    runner.apply = async () => ({ status: 'conflicted', error: 'merge conflict' });
    const result = await applyReviewFixes(runner, [finding]);
    expect(result.failed).toBe(1);
  });
});

describe('renderFixResult', () => {
  it('summarizes applied and failed counts', () => {
    const text = renderFixResult({
      attempted: 1,
      applied: 1,
      failed: 0,
      findings: [],
      messages: [],
    });
    expect(text).toContain('Applied 1 of 1');
  });
});
