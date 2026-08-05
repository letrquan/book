import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvaluationProcess } from '../src/harness/evaluation/runner.js';
import { evaluateSkillActivation } from '../src/skill-evaluation.js';
import { runSkillEvaluationIsolated } from './skill-eval.js';

vi.mock('../src/harness/evaluation/runner.js', () => ({
  runEvaluationProcess: vi.fn(),
  evaluationControlsFromResult: vi.fn((result) => ({
    evaluationDate: result.evaluationDate,
    randomSeed: result.randomSeed,
    runtimeRevision: result.runtimeRevision,
    fixtureRevision: result.fixtureRevision,
    fixtureRevisionStatus: result.fixtureRevisionStatus,
  })),
}));

const controls = {
  evaluationDate: '2026-08-05',
  randomSeed: 'seed-1',
  runtimeRevision: 'runtime-1',
  fixtureRevision: 'fixture-1',
  fixtureRevisionStatus: 'captured' as const,
};

describe('skill eval CLI', () => {
  beforeEach(() => {
    vi.mocked(runEvaluationProcess).mockReset();
  });

  it('ships the isolated worker entrypoint', () => {
    expect(existsSync(fileURLToPath(new URL('./skill-eval-worker.ts', import.meta.url)))).toBe(
      true,
    );
  });

  it('parses observations inside the bounded evaluation worker', async () => {
    const report = evaluateSkillActivation([]);
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: `${JSON.stringify(report)}\n`,
      stderr: '',
      ...controls,
    } as never);

    await expect(runSkillEvaluationIsolated('observations.jsonl')).resolves.toEqual({
      ...report,
      evaluation: {
        evidenceKind: 'offline-observation',
        providerRunEligibility: 'not-applicable',
        controls,
      },
    });
    expect(runEvaluationProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        timeoutMs: 30_000,
        maxOutputBytes: 16 * 1024 * 1024,
      }),
    );
    const options = vi.mocked(runEvaluationProcess).mock.calls[0]?.[0];
    expect(options?.args?.[2]).toMatch(/skill-eval-worker\.ts$/);
    expect(options?.args?.at(-1)).toBe('observations');
  });

  it('reports worker process failures without treating them as rollout evidence', async () => {
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'failed',
      stdout: '',
      stderr: 'invalid observation input',
    } as never);

    await expect(runSkillEvaluationIsolated('broken.json')).rejects.toThrow(
      'invalid observation input',
    );
  });

  it('rejects malformed worker reports', async () => {
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: '{"rolloutReady":true}\n',
      stderr: '',
      ...controls,
    } as never);

    await expect(runSkillEvaluationIsolated('observations.jsonl')).rejects.toThrow(
      'unsupported report schema',
    );
  });

  it('rejects reports missing required aggregate evidence', async () => {
    const report = evaluateSkillActivation([]);
    const { truePositives: _truePositives, ...malformed } = report;
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: `${JSON.stringify(malformed)}\n`,
      stderr: '',
      ...controls,
    } as never);

    await expect(runSkillEvaluationIsolated('observations.jsonl')).rejects.toThrow(
      'unsupported report schema',
    );
  });
});
