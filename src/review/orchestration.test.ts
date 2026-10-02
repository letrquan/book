import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDeepReview, runSingleReview, type ReviewAgentRunner } from './orchestration.js';

/**
 * The orchestrator resolves a real review target before spawning anything, so
 * these tests run against a throwaway git repository with a dirty working tree
 * and script only the agent runner.
 */
let workspace: string;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-review-orchestration-'));
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'user.email', 'book-tests@example.invalid');
  git(workspace, 'config', 'user.name', 'Book Tests');
  writeFileSync(join(workspace, 'a.ts'), 'export const value = 1;\n', 'utf8');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-qm', 'initial');
  writeFileSync(join(workspace, 'a.ts'), 'export const value = 2;\n', 'utf8');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function scope() {
  return { deep: true, fix: false, help: false };
}

function verdictText(): string {
  return JSON.stringify({
    verdicts: [
      { findingId: 'finding-1', state: 'confirmed', reason: 'real' },
      { findingId: 'finding-2', state: 'rejected', reason: 'not real' },
    ],
  });
}

/** A verifier that reached no conclusion on the single candidate it was given. */
function unverifiedVerdictText(): string {
  return JSON.stringify({
    verdicts: [{ findingId: 'finding-1', state: 'inconclusive', reason: 'could not trace it' }],
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
    async spawn(agent, _prompt, _options) {
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

function findingJson(idSummary = 'real bug'): string {
  return JSON.stringify({
    verdict: 'recommend',
    findings: [
      {
        severity: 'major',
        category: 'correctness',
        file: 'src/a.ts',
        line: 1,
        summary: idSummary,
        evidence: 'x',
        failure: 'fails',
        suggestedFix: 'guard',
        confidence: 90,
      },
    ],
  });
}

/**
 * A reviewer report carrying one finding, so a test can vary the severity and
 * confidence independently of the verdict the reviewer claimed for itself.
 */
function reportJson(
  verdict: string,
  overrides: { severity?: string; confidence?: number; summary?: string } = {},
): string {
  return JSON.stringify({
    verdict,
    findings: [
      {
        severity: overrides.severity ?? 'major',
        category: 'correctness',
        file: 'src/a.ts',
        line: 1,
        summary: overrides.summary ?? 'real bug',
        evidence: 'x',
        failure: 'fails',
        suggestedFix: 'guard',
        confidence: overrides.confidence ?? 90,
      },
    ],
  });
}

const cleanReport = JSON.stringify({ verdict: 'clean', findings: [] });

function scriptedRunner(
  options: {
    reviewerResults?: string[];
    verifierResult?: string;
    reviewerStatus?: string;
    verifierStatus?: string;
  } = {},
): ReviewAgentRunner & { stopped: string[] } {
  let sequence = 0;
  const stopped: string[] = [];
  const reviewerResults = options.reviewerResults ?? [
    JSON.stringify({ verdict: 'clean', findings: [] }),
    JSON.stringify({ verdict: 'clean', findings: [] }),
    JSON.stringify({ verdict: 'clean', findings: [] }),
    JSON.stringify({ verdict: 'clean', findings: [] }),
  ];
  return {
    stopped,
    async spawn() {
      return { id: `scripted-${sequence++}`, status: 'queued' };
    },
    async wait(id) {
      const index = Number(id.slice('scripted-'.length));
      if (index === 4) {
        return {
          id,
          status: options.verifierStatus ?? 'completed',
          result: options.verifierResult,
        };
      }
      return {
        id,
        status: options.reviewerStatus ?? 'completed',
        result: reviewerResults[index],
        error: options.reviewerStatus === 'failed' ? 'provider failed' : undefined,
      };
    },
    async stop(id) {
      stopped.push(id);
    },
  };
}

/** Single-spawn runner for the one-pass review path. */
function singleRunner(result: string | undefined, status = 'completed'): ReviewAgentRunner {
  return {
    async spawn() {
      return { id: 'single-0', status: 'queued' };
    },
    async wait(id) {
      return { id, status, result };
    },
    async stop() {},
  };
}

describe('runSingleReview', () => {
  it('reports structured findings from one pass', async () => {
    const result = await runSingleReview(
      singleRunner(findingJson()),
      { deep: false, fix: false, help: false },
      workspace,
    );
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.verdict).toBe('recommend');
    expect(result.text).toContain('real bug');
    expect(result.text).not.toContain('Coverage warning');
  });

  it('preserves reviewer prose when the JSON contract is not met', async () => {
    const prose = 'I looked at the diff and everything seems fine, no JSON for you.';
    const result = await runSingleReview(
      singleRunner(prose),
      { deep: false, fix: false, help: false },
      workspace,
    );
    expect(result.report.verdict).toBe('inconclusive');
    expect(result.report.coverage?.reviewers[0]?.status).toBe('unstructured');
    expect(result.text).toContain('Coverage warning');
    // The raw output is not visible anywhere else — it must survive into the report.
    expect(result.text).toContain(prose);
  });

  it('short-circuits when the target has no changes', async () => {
    git(workspace, 'checkout', '--', 'a.ts');
    const result = await runSingleReview(
      singleRunner(findingJson()),
      { deep: false, fix: false, help: false },
      workspace,
    );
    expect(result.report.verdict).toBe('clean');
    expect(result.text).toContain('no changes');
  });

  it('never reports a clean review when findings were silently dropped', async () => {
    // A valid envelope whose only finding omits suggestedFix: the per-finding
    // contract rejects it, so the pipeline sees zero findings. Reporting that
    // as "clean" would hide a real finding the reviewer actually produced.
    const droppedOnly = JSON.stringify({
      verdict: 'clean',
      findings: [
        {
          severity: 'critical',
          category: 'correctness',
          file: 'src/a.ts',
          line: 1,
          summary: 'real bug the parser could not read',
          evidence: 'x',
          failure: 'fails',
          confidence: 90,
        },
      ],
    });
    const result = await runSingleReview(
      singleRunner(droppedOnly),
      { deep: false, fix: false, help: false },
      workspace,
    );
    expect(result.report.findings).toHaveLength(0);
    expect(result.report.verdict).toBe('inconclusive');
    const coverage = result.report.coverage?.reviewers[0];
    expect(coverage?.status).toBe('partial');
    expect(coverage?.droppedFindings).toBe(1);
    expect(result.text).toContain('Coverage warning');
    expect(result.text).toContain('1 finding(s) dropped');
    // The reviewer's actual text must survive so the dropped finding is recoverable.
    expect(result.text).toContain('real bug the parser could not read');
  });

  it('stays completed when every finding satisfies the contract', async () => {
    const result = await runSingleReview(
      singleRunner(findingJson()),
      { deep: false, fix: false, help: false },
      workspace,
    );
    expect(result.report.coverage?.reviewers[0]?.status).toBe('completed');
    expect(result.report.coverage?.reviewers[0]?.droppedFindings).toBeUndefined();
  });
});

describe('runSingleReview — the verdict follows the surviving findings', () => {
  const single = { deep: false, fix: false, help: false };

  it('does not carry a blocking verdict over from a finding that was filtered out', async () => {
    const result = await runSingleReview(
      singleRunner(reportJson('blocking', { confidence: 50 })),
      single,
      workspace,
    );
    expect(result.report.findings).toHaveLength(0);
    expect(result.report.verdict).toBe('clean');
  });

  it('escalates to blocking on a surviving critical finding even when the reviewer said clean', async () => {
    const result = await runSingleReview(
      singleRunner(reportJson('clean', { severity: 'critical', confidence: 95 })),
      single,
      workspace,
    );
    expect(result.report.verdict).toBe('blocking');
    expect(result.report.findings).toHaveLength(1);
  });

  it('recommends on a surviving non-critical finding even when the reviewer said clean', async () => {
    const result = await runSingleReview(
      singleRunner(reportJson('clean', { severity: 'major', confidence: 90 })),
      single,
      workspace,
    );
    expect(result.report.verdict).toBe('recommend');
  });

  it('says a reviewer reported its own review as inconclusive', async () => {
    const result = await runSingleReview(
      singleRunner(JSON.stringify({ verdict: 'inconclusive', findings: [] })),
      single,
      workspace,
    );
    expect(result.report.verdict).toBe('inconclusive');
    expect(result.text).toContain('a reviewer reported its review as inconclusive');
  });

  it('does not let that same inconclusive self-report mask a critical finding', async () => {
    // The regression from #372: a reviewer that cannot conclude said so, and
    // reported the critical anyway. Its uncertainty about its *review* is not
    // evidence against the finding it handed back.
    const result = await runSingleReview(
      singleRunner(reportJson('inconclusive', { severity: 'critical', confidence: 95 })),
      single,
      workspace,
    );
    expect(result.report.verdict).toBe('blocking');
    expect(result.report.findings).toHaveLength(1);
    expect(result.text).not.toContain('a reviewer reported its review as inconclusive');
  });
});

describe('runDeepReview', () => {
  it('fans out specialized reviewers and runs independent verification', async () => {
    const finding1 = JSON.stringify({
      verdict: 'recommend',
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
      verdict: 'recommend',
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
    const result = await runDeepReview(runner, scope(), workspace);

    expect(runner.spawned.filter((agent) => agent === 'reviewer')).toHaveLength(5);
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]).toMatchObject({ id: 'finding-1', verification: 'confirmed' });
  });

  it('returns clean when completed reviewers return structured clean reports', async () => {
    const clean = JSON.stringify({ verdict: 'clean', findings: [] });
    const runner = makeRunner([clean, clean, clean, clean], '{}');
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.verdict).toBe('clean');
    expect(result.text).toContain('no confirmed findings');
  });

  it('fails closed when every reviewer fails', async () => {
    const runner = scriptedRunner({ reviewerStatus: 'failed' });
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.verdict).toBe('inconclusive');
    expect(result.report.coverage?.reviewers.every((entry) => entry.status === 'failed')).toBe(
      true,
    );
    expect(result.text).toContain('Coverage warning');
  });

  it('stops reviewers whose bounded wait returns a nonterminal handle', async () => {
    const runner = scriptedRunner({ reviewerStatus: 'running' });
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.verdict).toBe('inconclusive');
    expect(runner.stopped).toHaveLength(4);
    expect(result.report.coverage?.reviewers.every((entry) => entry.status === 'timed_out')).toBe(
      true,
    );
  });

  it('marks malformed reviewer output as unstructured and preserves it', async () => {
    const runner = scriptedRunner({
      reviewerResults: ['not json at all', '{}', '{}', '{}'],
    });
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.verdict).toBe('inconclusive');
    expect(
      result.report.coverage?.reviewers.every((entry) => entry.status === 'unstructured'),
    ).toBe(true);
    expect(result.text).toContain('not json at all');
  });

  it('requires one verifier verdict for every candidate', async () => {
    const clean = JSON.stringify({ verdict: 'clean', findings: [] });
    const runner = scriptedRunner({
      reviewerResults: [findingJson('first bug'), findingJson('second bug'), clean, clean],
      verifierResult: JSON.stringify({
        verdicts: [{ findingId: 'finding-1', state: 'confirmed', reason: 'real' }],
      }),
    });
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.coverage?.verifier?.status).toBe('unstructured');
    expect(result.report.verdict).toBe('inconclusive');
    expect(result.report.findings[0]).toMatchObject({ verification: 'confirmed' });
  });

  it('stops a verifier that times out and caps the report at inconclusive', async () => {
    const clean = JSON.stringify({ verdict: 'clean', findings: [] });
    const runner = scriptedRunner({
      reviewerResults: [findingJson(), clean, clean, clean],
      verifierStatus: 'running',
    });
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.coverage?.verifier?.status).toBe('timed_out');
    expect(result.report.verdict).toBe('inconclusive');
    expect(runner.stopped).toContain('scripted-4');
  });

  it('short-circuits when the target has no changes', async () => {
    git(workspace, 'checkout', '--', 'a.ts');
    const runner = scriptedRunner();
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.verdict).toBe('clean');
    expect(result.text).toContain('no changes');
  });
});

describe('runDeepReview — the verdict follows the surviving findings', () => {
  it('is clean when the only blocking claim rested on a finding that was filtered out', async () => {
    const runner = makeRunner(
      [reportJson('blocking', { confidence: 50 }), cleanReport, cleanReport, cleanReport],
      '{}',
    );
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.verdict).toBe('clean');
    expect(result.text).toContain('no confirmed findings');
    expect(result.text).not.toContain('Coverage warning');
  });

  it('says a reviewer reported its own review as inconclusive', async () => {
    const runner = makeRunner(
      [
        JSON.stringify({ verdict: 'inconclusive', findings: [] }),
        cleanReport,
        cleanReport,
        cleanReport,
      ],
      '{}',
    );
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.verdict).toBe('inconclusive');
    expect(result.text).toContain('a reviewer reported its review as inconclusive');
    expect(result.text).not.toContain('no confirmed findings');
  });
});

describe('runDeepReview — a verifier verdict outranks a reviewer self-report', () => {
  it('names the verifier when it could neither confirm nor reject the finding', async () => {
    const runner = makeRunner(
      [
        reportJson('recommend', { severity: 'major', confidence: 90 }),
        cleanReport,
        cleanReport,
        cleanReport,
      ],
      unverifiedVerdictText(),
    );
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]).toMatchObject({ verification: 'inconclusive' });
    expect(result.report.verdict).toBe('inconclusive');
    expect(result.text).toContain('could neither confirm nor reject');
    expect(result.text).not.toContain('a reviewer reported');
  });

  it('does not let one lens being inconclusive mask a confirmed critical from another', async () => {
    const runner = makeRunner(
      [
        reportJson('blocking', { severity: 'critical', confidence: 95 }),
        JSON.stringify({ verdict: 'inconclusive', findings: [] }),
        cleanReport,
        cleanReport,
      ],
      JSON.stringify({
        verdicts: [{ findingId: 'finding-1', state: 'confirmed', reason: 'real' }],
      }),
    );
    const result = await runDeepReview(runner, scope(), workspace);
    expect(result.report.verdict).toBe('blocking');
    expect(result.report.findings[0]).toMatchObject({ verification: 'confirmed' });
  });
});

describe('review cancellation', () => {
  it('stops every lens agent a deep review had already spawned', async () => {
    const controller = new AbortController();
    const stopped: string[] = [];
    const spawnedIds: string[] = [];
    let sequence = 0;
    const runner: ReviewAgentRunner = {
      async spawn() {
        const id = `lens-${sequence++}`;
        spawnedIds.push(id);
        return { id, status: 'queued' };
      },
      async wait(id) {
        // Cancel once the whole fan-out is in flight, as a keypress would.
        if (id === 'lens-0') controller.abort();
        return { id, status: 'stopped' };
      },
      async stop(id) {
        stopped.push(id);
      },
    };

    await runDeepReview(runner, scope(), workspace, { signal: controller.signal });

    expect(spawnedIds).toHaveLength(4);
    expect([...stopped].sort()).toEqual(spawnedIds);
  });

  it('does not spawn the verifier for a review cancelled during discovery', async () => {
    const controller = new AbortController();
    const agents: string[] = [];
    const runner: ReviewAgentRunner = {
      async spawn(_agent, _prompt, options) {
        agents.push(options?.description ?? '');
        return { id: `agent-${agents.length - 1}`, status: 'queued' };
      },
      async wait(id) {
        controller.abort();
        return { id, status: 'completed', result: findingJson() };
      },
      async stop() {},
    };

    const result = await runDeepReview(runner, scope(), workspace, { signal: controller.signal });

    expect(agents).not.toContain('review: verify');
    // Nothing was verified, so nothing may be reported as a finding.
    expect(result.report.findings).toEqual([]);
    expect(result.report.verdict).toBe('inconclusive');
  });

  it('reports the target before spawning, even when the run is then cancelled', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const runner = scriptedRunner();

    await runDeepReview(runner, scope(), workspace, {
      signal: controller.signal,
      onTarget: (target) => {
        seen.push(...target.changedFiles);
        controller.abort();
      },
    });

    expect(seen).toEqual(['a.ts']);
  });
});
