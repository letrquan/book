import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewReportJson, runHostReview, type HostReviewResult } from './host.js';
import type { FixAgentRunner } from './fix.js';
import type { ReviewAgentHandle, ReviewAgentRunner } from './orchestration.js';
import type { ReviewScope } from './types.js';

/**
 * `runHostReview` resolves a real target before spawning anything, so these run
 * against a throwaway git repository and script only the agent runner.
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
  workspace = mkdtempSync(join(tmpdir(), 'book-review-host-'));
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

function scope(overrides: Partial<ReviewScope> = {}): ReviewScope {
  return { deep: false, fix: false, help: false, ...overrides };
}

function findingJson(summary = 'off-by-one in the loop bound'): string {
  return JSON.stringify({
    verdict: 'recommend',
    findings: [
      {
        severity: 'major',
        category: 'correctness',
        file: 'a.ts',
        line: 1,
        summary,
        evidence: 'export const value = 2;',
        failure: 'callers observe 2 where 1 is required',
        suggestedFix: 'restore the original constant',
        confidence: 90,
      },
    ],
  });
}

function verdictJson(state: 'confirmed' | 'rejected'): string {
  return JSON.stringify({
    verdicts: [{ findingId: 'finding-1', state, reason: 'checked the code path' }],
  });
}

/** Runner that answers every pass with a scripted result, keyed by spawn order. */
function scriptedRunner(
  results: string[],
): ReviewAgentRunner & { prompts: string[]; agents: string[] } {
  const prompts: string[] = [];
  const agents: string[] = [];
  return {
    prompts,
    agents,
    async spawn(agent, prompt) {
      agents.push(agent);
      prompts.push(prompt);
      return { id: `agent-${agents.length - 1}`, status: 'queued' };
    },
    async wait(id) {
      const index = Number(id.slice('agent-'.length));
      return { id, status: 'completed', result: results[index] };
    },
  };
}

describe('runHostReview — sequencing shared by every host', () => {
  it('runs one reviewer pass by default and reports its findings', async () => {
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({ scope: scope(), workspace, runner });

    expect(result.error).toBeUndefined();
    expect(runner.agents).toEqual(['reviewer']);
    expect(result.report?.findings.map((finding) => finding.summary)).toEqual([
      'off-by-one in the loop bound',
    ]);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toContain('Verdict: recommend');
  });

  it('hands the reviewer a host-resolved immutable target instead of a scope string', async () => {
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({ scope: scope(), workspace, runner });

    expect(runner.prompts[0]).toContain('## Immutable review target');
    expect(runner.prompts[0]).toContain('- a.ts');
    expect(runner.prompts[0]).toContain('export const value = 2;');
    expect(runner.prompts[0]).toContain('Do not run GitDiff to select a different target');
    expect(result.target?.baseSha).toBe(git(workspace, 'rev-parse', 'HEAD'));
    expect(result.target?.changedFiles).toEqual(['a.ts']);
  });

  it('runs every lens plus the independent verification pass for --deep', async () => {
    const runner = scriptedRunner([
      findingJson(),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      verdictJson('confirmed'),
    ]);

    const result = await runHostReview({ scope: scope({ deep: true }), workspace, runner });

    expect(runner.agents).toHaveLength(5);
    expect(result.report?.verdict).toBe('recommend');
    expect(result.report?.findings[0]?.verification).toBe('confirmed');
    expect(result.report?.coverage?.verifier?.status).toBe('completed');
  });

  it('drops a finding the verifier falsifies', async () => {
    const runner = scriptedRunner([
      findingJson(),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      verdictJson('rejected'),
    ]);

    const result = await runHostReview({ scope: scope({ deep: true }), workspace, runner });

    expect(result.report?.findings).toEqual([]);
    expect(result.report?.verdict).toBe('clean');
  });

  it('keeps coverage fail-closed when a lens returns unusable output', async () => {
    const runner = scriptedRunner([
      findingJson(),
      'I could not produce JSON, sorry.',
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      verdictJson('confirmed'),
    ]);

    const result = await runHostReview({ scope: scope({ deep: true }), workspace, runner });

    expect(result.report?.verdict).toBe('inconclusive');
    expect(result.segments[0]).toContain('Coverage warning');
    expect(result.report?.coverage?.reviewers.map((entry) => entry.status)).toContain(
      'unstructured',
    );
  });

  it('emits segments progressively and returns them in the same order', async () => {
    const seen: string[] = [];
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({
      scope: scope(),
      workspace,
      runner,
      onSegment: (segment) => seen.push(segment),
    });

    expect(seen).toEqual(result.segments);
  });
});

describe('runHostReview — failures are reported, never swallowed', () => {
  it('captures a scope parse error instead of reviewing something else', async () => {
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({
      scope: scope({ error: 'Missing value for --base.' }),
      workspace,
      runner,
    });

    expect(result.error).toBe('Missing value for --base.');
    expect(result.segments).toEqual(['✕ review failed: Missing value for --base.']);
    expect(runner.agents).toEqual([]);
  });

  it('captures an unresolvable target', async () => {
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({
      scope: scope({ base: 'refs/heads/does-not-exist' }),
      workspace,
      runner,
    });

    expect(result.error).toBeTruthy();
    expect(result.segments[0]).toContain('✕ review failed:');
    expect(runner.agents).toEqual([]);
  });

  it('reports a clean run when the target has no changes at all', async () => {
    git(workspace, 'checkout', '--', 'a.ts');
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({ scope: scope(), workspace, runner });

    expect(runner.agents).toEqual([]);
    expect(result.report?.verdict).toBe('clean');
    expect(result.segments[0]).toContain('no changes');
  });
});

describe('runHostReview — --fix stays evidence-gated', () => {
  function fixRunner(base: ReviewAgentRunner, applied: string[]): FixAgentRunner {
    return {
      ...base,
      async spawn(agent, prompt, options) {
        return base.spawn(agent, prompt, options);
      },
      async findPatchCandidateEvidence() {
        return { id: 'evidence-1', verificationState: 'verified', verdict: 'pass' };
      },
      async getEvidence() {
        return { id: 'evidence-1', verificationState: 'verified', verdict: 'pass' };
      },
      async apply(agentId, evidenceId) {
        applied.push(`${agentId}:${evidenceId}`);
        return { status: 'applied', commit: 'abc1234' };
      },
    };
  }

  it('refuses to run at all when the host cannot apply patches', async () => {
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({
      scope: scope({ fix: true, deep: true }),
      workspace,
      runner,
    });

    expect(result.error).toContain('--fix requires a host that can apply verified patches');
    // Nothing was spawned: a host that cannot apply must not burn a deep review.
    expect(runner.agents).toEqual([]);
  });

  it('patches only verifier-confirmed findings', async () => {
    const applied: string[] = [];
    const runner = scriptedRunner([
      findingJson(),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      verdictJson('confirmed'),
      'patched',
      'validated',
    ]);

    const result = await runHostReview({
      scope: scope({ fix: true, deep: true }),
      workspace,
      runner,
      fixRunner: fixRunner(runner, applied),
    });

    expect(runner.agents.slice(5)).toEqual(['patcher', 'validator']);
    expect(applied).toEqual(['agent-5:evidence-1']);
    expect(result.fix?.applied).toBe(1);
    expect(result.segments.at(-1)).toContain('Applied 1 of 1 verified fixes.');
  });

  it('skips the patcher entirely when nothing was confirmed', async () => {
    const runner = scriptedRunner([
      findingJson(),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      verdictJson('rejected'),
    ]);

    const result = await runHostReview({
      scope: scope({ fix: true, deep: true }),
      workspace,
      runner,
      fixRunner: fixRunner(runner, []),
    });

    expect(runner.agents).toHaveLength(5);
    expect(result.fix).toBeUndefined();
    expect(result.segments.at(-1)).toBe('No confirmed findings are eligible for automatic fixes.');
  });
});

describe('reviewReportJson', () => {
  it('projects the run into the documented shape without the diff', async () => {
    const runner = scriptedRunner([findingJson()]);
    const result = await runHostReview({ scope: scope(), workspace, runner });

    const json = reviewReportJson(result);

    expect(Object.keys(json).sort()).toEqual(['coverage', 'findings', 'target', 'verdict']);
    expect(json.verdict).toBe('recommend');
    expect(json.target).toEqual({
      kind: 'working-tree',
      baseSha: git(workspace, 'rev-parse', 'HEAD'),
      headSha: undefined,
      path: undefined,
      changedFiles: ['a.ts'],
    });
    // The findings are the domain objects verbatim, not a parallel shape.
    expect(json.findings).toEqual(result.report?.findings);
    expect(json.findings[0]).toMatchObject({
      id: 'finding-1',
      severity: 'major',
      category: 'correctness',
      file: 'a.ts',
      line: 1,
      confidence: 90,
    });
    expect(JSON.stringify(json)).not.toContain('diff --git');
  });

  it('carries the verification state and coverage of a deep review', async () => {
    const runner = scriptedRunner([
      findingJson(),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      verdictJson('confirmed'),
    ]);
    const result = await runHostReview({ scope: scope({ deep: true }), workspace, runner });

    const json = reviewReportJson(result);

    expect(json.findings[0]?.verification).toBe('confirmed');
    expect(json.coverage?.reviewers.map((entry) => entry.id)).toEqual([
      'correctness',
      'security',
      'simplification',
      'efficiency',
    ]);
    expect(json.coverage?.verifier?.status).toBe('completed');
  });

  it('is inconclusive and empty for a run that never produced a report', () => {
    const failed: HostReviewResult = { segments: ['✕ review failed: boom'], error: 'boom' };

    expect(reviewReportJson(failed)).toEqual({
      verdict: 'inconclusive',
      target: undefined,
      findings: [],
      coverage: undefined,
    });
  });
});

describe('runHostReview — target scoping is resolved by the host', () => {
  it('uses the merge base with --base', async () => {
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-qm', 'second');
    const base = git(workspace, 'rev-parse', 'HEAD~1');
    git(workspace, 'branch', 'baseline', base);
    writeFileSync(join(workspace, 'a.ts'), 'export const value = 3;\n', 'utf8');
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({ scope: scope({ base: 'baseline' }), workspace, runner });

    expect(result.target?.baseSha).toBe(base);
    expect(runner.prompts[0]).toContain('export const value = 3;');
  });

  it('resolves a <base>...<head> range to a committed range', async () => {
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-qm', 'second');
    const head = git(workspace, 'rev-parse', 'HEAD');
    const base = git(workspace, 'rev-parse', 'HEAD~1');
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({
      scope: scope({ target: `${base}...${head}` }),
      workspace,
      runner,
    });

    expect(result.target?.kind).toBe('committed-range');
    expect(result.target?.baseSha).toBe(base);
    expect(result.target?.headSha).toBe(head);
  });

  it('restricts the target to a path scope', async () => {
    writeFileSync(join(workspace, 'b.ts'), 'export const other = 1;\n', 'utf8');
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({ scope: scope({ target: 'a.ts' }), workspace, runner });

    expect(result.target?.path).toBe('a.ts');
    expect(result.target?.changedFiles).toEqual(['a.ts']);
    expect(runner.prompts[0]).not.toContain('b.ts');
  });

  it('rejects a path that escapes the workspace', async () => {
    const runner = scriptedRunner([findingJson()]);

    const result = await runHostReview({
      scope: scope({ target: '../outside' }),
      workspace,
      runner,
    });

    expect(result.error).toContain('outside the workspace');
    expect(runner.agents).toEqual([]);
  });
});

describe('runHostReview — REVIEW.md calibration', () => {
  it('injects the repository calibration into the reviewer prompt', async () => {
    writeFileSync(
      join(workspace, 'REVIEW.md'),
      'Treat missing ownership comments as major in this repository.\n',
      'utf8',
    );
    const runner = scriptedRunner([findingJson()]);

    await runHostReview({ scope: scope(), workspace, runner });

    expect(runner.prompts[0]).toContain('## Review instructions (REVIEW.md)');
    expect(runner.prompts[0]).toContain('Treat missing ownership comments as major');
  });

  it('injects it into the verification pass too', async () => {
    writeFileSync(join(workspace, 'REVIEW.md'), 'Ignore generated files under dist/.\n', 'utf8');
    const runner = scriptedRunner([
      findingJson(),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      JSON.stringify({ verdict: 'clean', findings: [] }),
      verdictJson('confirmed'),
    ]);

    await runHostReview({ scope: scope({ deep: true }), workspace, runner });

    expect(runner.prompts[4]).toContain('Ignore generated files under dist/.');
  });
});

describe('runHostReview — a pass that never finishes', () => {
  it('marks a non-terminal reviewer as timed out and stops it', async () => {
    const stopped: string[] = [];
    const runner: ReviewAgentRunner = {
      async spawn(): Promise<ReviewAgentHandle> {
        return { id: 'agent-0', status: 'queued' };
      },
      async wait(id) {
        return { id, status: 'running' };
      },
      async stop(id) {
        stopped.push(id);
      },
    };

    const result = await runHostReview({ scope: scope(), workspace, runner });

    expect(stopped).toEqual(['agent-0']);
    expect(result.report?.verdict).toBe('inconclusive');
    expect(result.segments[0]).toContain('Coverage warning');
  });
});
