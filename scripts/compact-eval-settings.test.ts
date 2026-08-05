import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { AgentConfig } from '../src/types/runtime.js';
import { createCompactEvaluationSettings } from './compact-eval.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createCompactEvaluationSettings', () => {
  it('resolves probe and reducer providers from secret references in isolated Book home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'book-compact-settings-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const bookHome = join(root, 'book-home');
    await Promise.all([mkdir(workspace), mkdir(bookHome)]);
    vi.stubEnv('BOOK_HOME', bookHome);
    vi.stubEnv('BOOK_EVAL_PROBE_API_KEY', 'probe-key');
    vi.stubEnv('BOOK_EVAL_COMPACT_API_KEY', 'compact-key');

    const probeConfig = {
      apiKey: 'probe-key',
      baseUrl: 'https://probe.example/v1',
      model: 'probe-model-id',
      provider: 'openai',
      modelInfo: { contextWindow: 64_000, maxOutputTokens: 8_192 },
      retry: { maxAttempts: 3, watchdog: false },
      effort: 'medium',
      effortExplicit: true,
    } as AgentConfig;
    const compactConfig = {
      apiKey: 'compact-key',
      baseUrl: 'https://compact.example/v1',
      model: 'compact-model-id',
      provider: 'anthropic',
      modelInfo: { contextWindow: 128_000, maxOutputTokens: 16_000 },
      retry: { maxAttempts: 3, watchdog: false },
    } as AgentConfig;
    await writeFile(
      join(bookHome, 'settings.json'),
      JSON.stringify(createCompactEvaluationSettings(probeConfig, compactConfig), null, 2),
      'utf8',
    );

    expect(
      loadConfig(workspace, { modelOverride: 'evaluation-probe/probe-model-id' }),
    ).toMatchObject({
      apiKey: 'probe-key',
      baseUrl: 'https://probe.example/v1',
      model: 'probe-model-id',
      provider: 'openai',
      effort: 'medium',
      effortExplicit: true,
      modelInfo: { contextWindow: 64_000, maxOutputTokens: 8_192 },
    });
    expect(
      loadConfig(workspace, { modelOverride: 'evaluation-compact/compact-model-id' }),
    ).toMatchObject({
      apiKey: 'compact-key',
      baseUrl: 'https://compact.example/v1',
      model: 'compact-model-id',
      provider: 'anthropic',
      modelInfo: { contextWindow: 128_000, maxOutputTokens: 16_000 },
    });
  });
});
