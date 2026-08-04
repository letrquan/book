import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { AgentConfig } from '../src/types/runtime.js';
import { createEditEvaluationSettings } from './edit-eval.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function resolveGeneratedSettings(parent: Partial<AgentConfig>): Promise<AgentConfig> {
  const root = await mkdtemp(join(tmpdir(), 'book-edit-settings-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const bookHome = join(root, 'book-home');
  await Promise.all([mkdir(workspace), mkdir(bookHome)]);
  vi.stubEnv('BOOK_HOME', bookHome);
  vi.stubEnv('BOOK_API_KEY', 'test-key');
  const settingsPath = join(bookHome, 'settings.json');
  await writeFile(
    settingsPath,
    JSON.stringify(
      createEditEvaluationSettings({
        apiKey: 'test-key',
        baseUrl: 'https://provider.example/v1',
        model: 'provider-model-id',
        maxTokens: 64_000,
        autoCompactEnabled: true,
        workspace,
        retry: {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 1_000,
          totalBudgetMs: 5_000,
          requestTimeoutMs: 30_000,
          streamStallTimeoutMs: 10_000,
          toolRetries: 1,
          watchdog: false,
        },
        ...parent,
      } as AgentConfig),
      null,
      2,
    ),
    'utf8',
  );
  return loadConfig(workspace, { settingsOverridePath: settingsPath });
}

describe('createEditEvaluationSettings', () => {
  it('preserves the provider-facing model ID and model metadata without forcing defaults', async () => {
    const config = await resolveGeneratedSettings({
      provider: 'openai',
      modelSelection: 'gateway/provider-model-id',
      maxTokensExplicit: false,
      effort: 'high',
      effortExplicit: false,
      modelInfo: {
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        editFormat: 'whole',
      },
    });

    expect(config).toMatchObject({
      model: 'provider-model-id',
      modelSelection: 'evaluation/provider-model-id',
      maxTokens: 16_000,
      maxTokensExplicit: false,
      effortExplicit: false,
      modelInfo: {
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        editFormat: 'whole',
      },
    });
  });

  it('retains explicitly configured output and effort options', async () => {
    const config = await resolveGeneratedSettings({
      provider: 'anthropic',
      maxTokens: 8_192,
      maxTokensExplicit: true,
      effort: 'medium',
      effortExplicit: true,
      modelInfo: { effort: { default: 'high', levels: ['medium', 'high'] } },
    });

    expect(config).toMatchObject({
      model: 'provider-model-id',
      provider: 'anthropic',
      maxTokens: 8_192,
      maxTokensExplicit: true,
      effort: 'medium',
      effortExplicit: true,
    });
  });
});
