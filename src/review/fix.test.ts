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
    const result = await applyReviewFixes(runner, findings, { maxFixes: 10 });
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

describe('applyReviewFixes cancellation', () => {
  function cancellingRunner(controller: AbortController, cancelOn: string) {
    const base = makeRunner();
    return {
      ...base,
      async wait(agentId: string) {
        if (agentId === cancelOn) {
          controller.abort();
          return { id: agentId, status: 'stopped' };
        }
        return base.wait(agentId);
      },
    } as FixAgentRunner & { applied: string[]; stopped: string[] };
  }

  it('reports a cancel that lands while the last finding is being patched', async () => {
    const controller = new AbortController();
    // agent-0 is the only finding's patcher, so the loop ends without ever
    // re-reaching its top-of-iteration cancellation check.
    const runner = cancellingRunner(controller, 'agent-0');

    const result = await applyReviewFixes(runner, [finding], { signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(result.applied).toBe(0);
    // A patcher we stopped ourselves is not a failed fix.
    expect(result.failed).toBe(0);
    expect(result.messages).toEqual(['Stopped while fixing src/a.ts: review cancelled.']);
    expect(renderFixResult(result)).toContain('Fix pass cancelled after applying 0 of 1');
  });

  it('reports a cancel that lands during validation', async () => {
    const controller = new AbortController();
    const runner = cancellingRunner(controller, 'agent-1');

    const result = await applyReviewFixes(runner, [finding], { signal: controller.signal });

    expect(result.cancelled).toBe(true);
    // The patch candidate was never independently approved, so nothing applied.
    expect(runner.applied).toEqual([]);
    expect(result.messages).toEqual(['Stopped while validating src/a.ts: review cancelled.']);
  });

  it('stops the agent it was waiting on', async () => {
    const controller = new AbortController();
    const runner = cancellingRunner(controller, 'agent-0');

    await applyReviewFixes(runner, [finding], { signal: controller.signal });

    expect(runner.stopped).toEqual(['agent-0']);
  });

  it('counts only findings whose outcome is known as attempted', async () => {
    const controller = new AbortController();
    const findings = [finding, { ...finding, id: 'f2', file: 'src/b.ts' }];
    const runner = cancellingRunner(controller, 'agent-0');

    const result = await applyReviewFixes(runner, findings, { signal: controller.signal });

    expect(result.attempted).toBe(0);
    expect(result.findings).toHaveLength(2);
  });
});
