import { describe, expect, it } from 'vitest';
import { evaluateStabilization } from './verify-stabilization.js';

function workflowRun(id: number, conclusion: string | null = 'success') {
  return {
    id,
    conclusion,
    created_at: `2026-07-${String(id).padStart(2, '0')}T00:00:00Z`,
    event: 'push',
    head_sha: `${id}`.repeat(40).slice(0, 40),
    html_url: `https://example.test/runs/${id}`,
  };
}

describe('evaluateStabilization', () => {
  it('passes after the required consecutive green runs with no open regressions', () => {
    const report = evaluateStabilization(
      [workflowRun(3), workflowRun(2), workflowRun(1)],
      new Map([
        ['regression:lifecycle', []],
        ['regression:accounting', []],
      ]),
      3,
    );

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('holds when any run in the window is unsuccessful', () => {
    const report = evaluateStabilization(
      [workflowRun(3), workflowRun(2, 'failure'), workflowRun(1)],
      new Map(),
      3,
    );

    expect(report.ok).toBe(false);
    expect(report.problems).toContain(
      'The CI window contains 1 non-successful run(s): 2 (failure).',
    );
  });

  it('holds until enough completed runs exist', () => {
    const report = evaluateStabilization([workflowRun(1)], new Map(), 3);

    expect(report.ok).toBe(false);
    expect(report.problems).toContain('Only 1 of 3 required CI runs are available.');
  });

  it('holds for open regression issues but ignores pull requests', () => {
    const report = evaluateStabilization(
      [workflowRun(3), workflowRun(2), workflowRun(1)],
      new Map([
        [
          'regression:lifecycle',
          [
            {
              number: 10,
              title: 'Cancellation finalizes as completed',
              html_url: 'https://example.test/issues/10',
            },
            {
              number: 11,
              title: 'Fix cancellation status',
              html_url: 'https://example.test/pulls/11',
              pull_request: {},
            },
          ],
        ],
      ]),
      3,
    );

    expect(report.ok).toBe(false);
    expect(report.blockingRegressions.map((issue) => issue.number)).toEqual([10]);
  });

  it('does not count pull-request CI runs toward the main stabilization window', () => {
    const pullRequestRun = { ...workflowRun(4), event: 'pull_request' };
    const report = evaluateStabilization(
      [pullRequestRun, workflowRun(3), workflowRun(2), workflowRun(1)],
      new Map(),
      3,
    );

    expect(report.ok).toBe(true);
    expect(report.runWindow.map((run) => run.id)).toEqual([3, 2, 1]);
  });
});
