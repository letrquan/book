import { describe, expect, it } from 'vitest';
import { applyReviewFixes, renderFixResult, type FixAgentRunner, type FixEvidence } from './fix.js';
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

function makeRunner(): FixAgentRunner & {
  applied: string[];
  spawnedOptions: unknown[];
  stopped: string[];
} {
  const applied: string[] = [];
  const spawnedOptions: unknown[] = [];
  const stopped: string[] = [];
  let id = 0;
  let evidence: FixEvidence = { id: 'evidence-1', verificationState: 'unverified' };
  return {
    applied,
    spawnedOptions,
    stopped,
    async spawn(_agent, _prompt, options) {
      spawnedOptions.push(options);
      return { id: `agent-${id++}`, status: 'queued' };
    },
    async wait(agentId) {
      if (agentId === 'agent-1')
        evidence = { ...evidence, verificationState: 'verified', verdict: 'pass' };
      return { id: agentId, status: 'completed', result: 'done' };
    },
    async findPatchCandidateEvidence() {
      return evidence;
    },
    async getEvidence() {
      return evidence;
    },
    async apply(agentId, _evidenceId) {
      applied.push(agentId);
      return { status: 'applied', commit: 'abc123' };
    },
    async stop(agentId) {
      stopped.push(agentId);
    },
  };
}

describe('applyReviewFixes', () => {
  it('patches, validates, and applies each confirmed finding', async () => {
    const runner = makeRunner();
    const result = await applyReviewFixes(runner, [finding]);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(runner.applied).toEqual(['agent-0']);
    expect(runner.spawnedOptions[1]).toMatchObject({ evidenceIds: ['evidence-1'] });
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

  it('stops a patcher when the bounded wait returns a nonterminal handle', async () => {
    const runner = makeRunner();
    runner.wait = async (agentId) => ({ id: agentId, status: 'running' });
    const result = await applyReviewFixes(runner, [finding]);
    expect(result).toMatchObject({ applied: 0, failed: 1 });
    expect(runner.stopped).toEqual(['agent-0']);
  });

  it('stops a validator when validation times out', async () => {
    const runner = makeRunner();
    runner.wait = async (agentId) => ({
      id: agentId,
      status: agentId === 'agent-0' ? 'completed' : 'running',
    });
    const result = await applyReviewFixes(runner, [finding]);
    expect(result).toMatchObject({ applied: 0, failed: 1 });
    expect(runner.stopped).toEqual(['agent-1']);
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
