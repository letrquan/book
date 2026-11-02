import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runEvaluationProcess } from './eval-process.js';
import type { EvalTask } from './edit-eval-fixtures.js';
import {
  createEditEvaluationSettings,
  formatTaskCost,
  runEditEvalTask,
  summarizeEditEvalCost,
} from './edit-eval.js';

vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('./eval-process.js', () => ({
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

const TASK: EvalTask = {
  name: 'parent-task',
  category: 'test',
  files: { 'value.txt': 'before' },
  instruction: 'Change value.txt.',
  verify: () => true,
};

describe('runEditEvalTask', () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockReset();
    vi.mocked(runEvaluationProcess).mockReset();
  });

  it('returns a task failure when provider configuration cannot be resolved', async () => {
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error('missing provider key');
    });

    await expect(runEditEvalTask(TASK)).resolves.toMatchObject({
      success: false,
      runError: 'missing provider key',
    });
    expect(runEvaluationProcess).not.toHaveBeenCalled();
  });

  it('passes a secret reference and resolved provider settings into the isolated worker', async () => {
    const config = {
      apiKey: 'resolved-secret',
      baseUrl: 'https://provider.example/v1',
      model: 'model-id',
      modelSelection: 'gateway/model-id',
      provider: 'openai',
      maxTokens: 8192,
      maxTokensExplicit: false,
      effort: 'high',
      effortExplicit: false,
      modelInfo: { editFormat: 'whole', contextWindow: 64_000 },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        totalBudgetMs: 5_000,
        requestTimeoutMs: 30_000,
        streamStallTimeoutMs: 10_000,
        toolRetries: 1,
        watchdog: true,
      },
    } as never;
    vi.mocked(loadConfig).mockReturnValue(config);
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        name: TASK.name,
        category: TASK.category,
        success: true,
        verified: true,
        durationMs: 1,
        mutationCalls: { Edit: 1 },
        failuresByCode: {},
        toolCalls: 1,
        attribution: {
          eligible: true,
          reasons: [],
        },
      }),
      stderr: '',
      ...controls,
    } as never);

    await expect(runEditEvalTask(TASK)).resolves.toMatchObject({
      success: true,
      verified: true,
      mutationCalls: { Edit: 1 },
      controls,
    });
    expect(runEvaluationProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        timeoutMs: expect.any(Number),
        env: { BOOK_API_KEY: 'resolved-secret' },
      }),
    );
    const options = vi.mocked(runEvaluationProcess).mock.calls[0]?.[0];
    expect(options?.args?.[2]).toMatch(/edit-eval-worker\.ts$/);
    expect(createEditEvaluationSettings(config)).toMatchObject({
      model: 'evaluation/model-id',
      provider: {
        evaluation: {
          type: 'openai',
          baseURL: 'https://provider.example/v1',
          apiKey: '{env:BOOK_API_KEY}',
          models: {
            'model-id': { editFormat: 'whole', contextWindow: 64_000 },
          },
        },
      },
      agents: { mode: 'off' },
    });
    expect(createEditEvaluationSettings(config)).not.toHaveProperty('maxTokens');
    expect(createEditEvaluationSettings(config)).not.toHaveProperty('effort');
  });

  it('preserves explicit max-token and effort overrides', () => {
    const settings = createEditEvaluationSettings({
      model: 'model-id',
      baseUrl: 'https://provider.example/v1',
      provider: 'openai',
      maxTokens: 4096,
      maxTokensExplicit: true,
      effort: 'medium',
      effortExplicit: true,
      retry: { watchdog: false },
    } as never);

    expect(settings).toMatchObject({ maxTokens: 4096, effort: 'medium' });
  });

  it('rejects worker success without eligible run evidence', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      apiKey: 'key',
      baseUrl: 'https://provider.example/v1',
      model: 'model-id',
      provider: 'openai',
      retry: {},
    } as never);
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        name: TASK.name,
        category: TASK.category,
        success: true,
        verified: true,
        durationMs: 1,
        mutationCalls: {},
        failuresByCode: {},
        toolCalls: 0,
      }),
      stderr: '',
      ...controls,
    } as never);

    await expect(runEditEvalTask(TASK)).resolves.toMatchObject({
      success: false,
      runError: 'Edit evaluation worker returned success without eligible run evidence.',
    });
  });

  it('rejects malformed worker task results', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      apiKey: 'key',
      baseUrl: 'https://provider.example/v1',
      model: 'model-id',
      provider: 'openai',
      retry: {},
    } as never);
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({
        name: TASK.name,
        category: TASK.category,
        success: false,
        verified: false,
        durationMs: 1,
        mutationCalls: [],
        failuresByCode: {},
        toolCalls: 0,
      }),
      stderr: '',
      ...controls,
    } as never);

    await expect(runEditEvalTask(TASK)).resolves.toMatchObject({
      success: false,
      runError: 'Edit evaluation worker returned a malformed or mismatched task result.',
    });
  });

  describe('cost on a model with no price (#663)', () => {
    const completed = (result: Record<string, unknown>) => {
      vi.mocked(loadConfig).mockReturnValue({
        apiKey: 'key',
        baseUrl: 'https://provider.example/v1',
        model: 'model-id',
        provider: 'openai',
        retry: {},
      } as never);
      vi.mocked(runEvaluationProcess).mockResolvedValue({
        status: 'completed',
        stdout: JSON.stringify({
          name: TASK.name,
          category: TASK.category,
          success: true,
          verified: true,
          durationMs: 1,
          mutationCalls: { Edit: 1 },
          failuresByCode: {},
          toolCalls: 1,
          attribution: { eligible: true, reasons: [] },
          ...result,
        }),
        stderr: '',
        ...controls,
      } as never);
    };

    it('accepts a passing task whose cost is unknown', async () => {
      completed({ costUsd: null, costStatus: 'unknown' });
      await expect(runEditEvalTask(TASK)).resolves.toMatchObject({
        success: true,
        costUsd: null,
        costStatus: 'unknown',
      });
    });

    it('accepts a task that carries its dollars', async () => {
      completed({ costUsd: 0.0012, costStatus: 'known' });
      await expect(runEditEvalTask(TASK)).resolves.toMatchObject({
        success: true,
        costUsd: 0.0012,
        costStatus: 'known',
      });
    });

    it('rejects a cost that is not a number or a known status', async () => {
      completed({ costUsd: 'free', costStatus: 'known' });
      await expect(runEditEvalTask(TASK)).resolves.toMatchObject({
        success: false,
        runError: 'Edit evaluation worker returned a malformed or mismatched task result.',
      });
      completed({ costUsd: 0.1, costStatus: 'free' });
      await expect(runEditEvalTask(TASK)).resolves.toMatchObject({ success: false });
    });

    it('hands the worker the rate the settings declare, so a priced router model reads as known', () => {
      const pricing = { in: 0.14, out: 0.28 };
      const settings = createEditEvaluationSettings({
        baseUrl: 'https://provider.example/v1',
        model: 'cmc/deepseek/deepseek-v4.1-flash',
        provider: 'openai',
        retry: {},
        modelInfo: { pricing },
      } as never);
      expect(settings).toMatchObject({
        provider: {
          evaluation: { models: { 'cmc/deepseek/deepseek-v4.1-flash': { pricing } } },
        },
      });
    });

    it('shows a task cost as dollars, an estimate, or unknown', () => {
      expect(formatTaskCost({ costUsd: 0.0012, costStatus: 'known' })).toBe('$0.0012');
      expect(formatTaskCost({ costUsd: 0.0012, costStatus: 'estimated' })).toBe('$0.0012 (est.)');
      expect(formatTaskCost({ costUsd: null, costStatus: 'unknown' })).toBe('unknown');
      expect(formatTaskCost({})).toBe('unavailable');
    });

    it('sums the run cost when every task is priced, and says how many are not when some are not', () => {
      const task = (costUsd: number | null | undefined, costStatus?: 'known' | 'unknown') =>
        ({ name: 'n', category: 'c', costUsd, costStatus }) as never;
      expect(summarizeEditEvalCost([task(0.001, 'known'), task(0.002, 'known')])).toBe('$0.0030');
      const unpriced = summarizeEditEvalCost([task(null, 'unknown'), task(null, 'unknown')]);
      expect(unpriced).toContain('unknown (2 of 2 tasks on a model with no price');
      expect(unpriced).toContain('provider.<id>.models.<model>.pricing');
      expect(summarizeEditEvalCost([task(0.001, 'known'), task(undefined)])).toContain(
        'unknown (1 of 2 tasks',
      );
    });
  });
});
