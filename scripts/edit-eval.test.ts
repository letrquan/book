import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runEvaluationProcess } from '../src/harness/evaluation/runner.js';
import type { EvalTask } from './edit-eval-fixtures.js';
import { createEditEvaluationSettings, runEditEvalTask } from './edit-eval.js';

vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../src/harness/evaluation/runner.js', () => ({ runEvaluationProcess: vi.fn() }));

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
      }),
      stderr: '',
    } as never);

    await expect(runEditEvalTask(TASK)).resolves.toMatchObject({
      success: true,
      verified: true,
      mutationCalls: { Edit: 1 },
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
});
