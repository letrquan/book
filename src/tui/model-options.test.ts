import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveModelProviderConfig } from '../config.js';
import { buildContextReport } from '../context-report.js';
import { resolveContextWindow } from '../models.js';
import { discoverModels } from '../provider/model-discovery.js';
import { loadSettingsFile, mergeSettings } from '../settings-loader.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { defaultConfig } from '../test/fixtures.js';
import {
  advisorPickerWarnings,
  buildModelOptions,
  parseModelIds,
  providerConfigForSave,
  providerConfigFromDraft,
  validateBaseUrl,
  validateModelId,
  validateProviderId,
} from './model-options.js';

describe('buildModelOptions', () => {
  it('adds configured provider models with labels and provider identity', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.gateway = {
      type: 'openai',
      models: {
        'vendor/model.v2': { label: 'Model V2', effort: false },
      },
    };
    const option = buildModelOptions(settings).find(
      (item) => item.id === 'gateway/vendor/model.v2',
    );
    expect(option).toEqual({
      id: 'gateway/vendor/model.v2',
      label: 'Model V2',
      effort: false,
      custom: true,
      providerId: 'gateway',
    });
  });
});

describe('advisorPickerWarnings', () => {
  const options = buildModelOptions(DEFAULT_SETTINGS);
  const listed = options[0].id;

  it('says nothing when the advisor is off or is a listed model', () => {
    expect(advisorPickerWarnings(undefined, options, undefined)).toEqual([]);
    expect(advisorPickerWarnings(listed, options, undefined)).toEqual([]);
  });

  it('flags a saved advisor that matches no model in the list', () => {
    // The mistyped id that motivated the picker: `/advisor claude` saved verbatim.
    expect(advisorPickerWarnings('claude', options, undefined)).toEqual([
      'Current advisor "claude" is not in your model list.',
    ]);
  });

  it('names BOOK_ADVISOR_MODEL when it will outrank the choice at the next launch', () => {
    expect(advisorPickerWarnings(listed, options, 'gateway/big')).toEqual([
      'BOOK_ADVISOR_MODEL is set to "gateway/big" — it overrides advisorModel on next startup.',
    ]);
    expect(advisorPickerWarnings('claude', options, 'gateway/big')).toHaveLength(2);
  });

  it('treats an empty override as unset', () => {
    expect(advisorPickerWarnings(listed, options, '')).toEqual([]);
  });
});

describe('BYOK validation and provider merge', () => {
  it('normalizes identifiers and provider URLs', () => {
    expect(validateProviderId(' OpenRouter ')).toBe('openrouter');
    expect(validateModelId(' vendor/model.v2 ')).toBe('vendor/model.v2');
    expect(validateBaseUrl('openai', 'https://example.test/v1/')).toBe('https://example.test/v1');
    expect(() => validateProviderId('bad.provider')).toThrow();
  });

  it('merges discovered models and preserves existing metadata', () => {
    const provider = providerConfigFromDraft(
      {
        providerId: 'gateway',
        type: 'openai',
        baseURL: 'https://example.test/v1',
        apiKey: 'key',
        models: [{ id: 'model-a', label: 'API Label' }, { id: 'model-b' }],
        activeModelId: 'model-a',
        activeLabel: 'Custom Label',
      },
      {
        type: 'openai',
        models: {
          'model-a': { contextWindow: 1000 },
          old: { label: 'Old' },
        },
      },
    );
    expect(provider.models).toEqual({
      'model-a': { contextWindow: 1000, label: 'Custom Label' },
      'model-b': {},
      old: { label: 'Old' },
    });
  });

  it('replaces a refreshed catalog while preserving returned model metadata', () => {
    const provider = providerConfigFromDraft(
      {
        providerId: 'gateway',
        type: 'openai',
        baseURL: 'https://example.test/v1',
        apiKey: 'key',
        models: [{ id: 'model-a' }],
        activeModelId: 'model-a',
      },
      {
        type: 'openai',
        models: {
          'model-a': { contextWindow: 1000 },
          removed: { label: 'Removed' },
        },
      },
      true,
    );
    expect(provider.models).toEqual({ 'model-a': { contextWindow: 1000 } });
  });

  it('splits a hand-typed model list and rejects an empty one', () => {
    expect(parseModelIds(' deepseek-chat , deepseek-reasoner ')).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    expect(parseModelIds('a\nb\na')).toEqual(['a', 'b']);
    expect(() => parseModelIds('  ,  ')).toThrow('Enter at least one model ID.');
  });

  it('marks hand-entered models and keeps them across a refresh', () => {
    const added = providerConfigFromDraft(
      {
        providerId: 'gateway',
        type: 'openai',
        baseURL: '',
        apiKey: '',
        models: [{ id: 'hidden-model' }],
        activeModelId: 'hidden-model',
        manual: true,
      },
      {
        type: 'openai',
        baseURL: 'https://example.test/v1',
        apiKey: '{env:GATEWAY_KEY}',
        models: { 'model-a': {} },
      },
    );
    // An empty draft credential leaves the configured one alone.
    expect(added.baseURL).toBe('https://example.test/v1');
    expect(added.apiKey).toBe('{env:GATEWAY_KEY}');
    expect(added.models).toEqual({ 'model-a': {}, 'hidden-model': { manual: true } });

    const refreshed = providerConfigFromDraft(
      {
        providerId: 'gateway',
        type: 'openai',
        baseURL: 'https://example.test/v1',
        apiKey: 'key',
        models: [{ id: 'model-b' }],
        activeModelId: 'model-b',
      },
      { type: 'openai', models: added.models },
      true,
    );
    expect(refreshed.models).toEqual({ 'hidden-model': { manual: true }, 'model-b': {} });
  });

  it('persists a discovered contextWindow and omits the key when there is none', () => {
    const provider = providerConfigFromDraft({
      providerId: 'anthropic',
      type: 'anthropic',
      baseURL: 'https://api.anthropic.com',
      apiKey: 'key',
      models: [{ id: 'claude-sonnet-5-5', contextWindow: 1_000_000 }, { id: 'no-limit' }],
      activeModelId: 'claude-sonnet-5-5',
    });
    expect(provider.models['claude-sonnet-5-5']).toEqual({ contextWindow: 1_000_000 });
    expect(Object.hasOwn(provider.models['no-limit'], 'contextWindow')).toBe(false);
  });

  it('keeps a hand-set contextWindow over a discovered one on refresh and on re-add', () => {
    const draft = {
      providerId: 'anthropic',
      type: 'anthropic' as const,
      baseURL: 'https://api.anthropic.com',
      apiKey: 'key',
      models: [{ id: 'claude-sonnet-5-5', contextWindow: 1_000_000 }],
      activeModelId: 'claude-sonnet-5-5',
    };
    const existing = {
      type: 'anthropic' as const,
      models: { 'claude-sonnet-5-5': { contextWindow: 400_000 } },
    };
    expect(providerConfigFromDraft(draft, existing, true).models).toEqual(existing.models);
    expect(providerConfigFromDraft(draft, existing).models).toEqual(existing.models);
  });

  it('fills a discovered contextWindow only where the existing entry has none', () => {
    const provider = providerConfigFromDraft(
      {
        providerId: 'anthropic',
        type: 'anthropic',
        baseURL: 'https://api.anthropic.com',
        apiKey: 'key',
        models: [{ id: 'claude-sonnet-5-5', contextWindow: 1_000_000 }],
        activeModelId: 'claude-sonnet-5-5',
      },
      { type: 'anthropic', models: { 'claude-sonnet-5-5': { label: 'Mine' } } },
      true,
    );
    expect(provider.models['claude-sonnet-5-5']).toEqual({
      label: 'Mine',
      contextWindow: 1_000_000,
    });
  });

  it('retires the legacy lowercase base URL key when writing a new one', () => {
    const provider = providerConfigFromDraft(
      {
        providerId: 'gateway',
        type: 'openai',
        baseURL: 'https://new.test/v1',
        apiKey: 'key',
        models: [{ id: 'model-a' }],
        activeModelId: 'model-a',
      },
      { type: 'openai', baseUrl: 'https://old.test/v1', models: {} },
    );
    expect(provider.baseURL).toBe('https://new.test/v1');
    expect(provider.baseUrl).toBeUndefined();
  });

  it('drops the manual marker once discovery returns the same model', () => {
    const provider = providerConfigFromDraft(
      {
        providerId: 'gateway',
        type: 'openai',
        baseURL: 'https://example.test/v1',
        apiKey: 'key',
        models: [{ id: 'hidden-model', label: 'Now Listed' }],
        activeModelId: 'hidden-model',
      },
      { type: 'openai', models: { 'hidden-model': { manual: true } } },
      true,
    );
    expect(provider.models).toEqual({ 'hidden-model': { label: 'Now Listed' } });
  });
});

// Finding 8: the picker lists the resolved providers, which carry whatever a workspace layer
// contributed. A refresh or a hand-typed model must write only what the user's own file holds.
describe('providerConfigForSave', () => {
  const own = {
    type: 'openai' as const,
    baseURL: 'https://user.example/v1',
    apiKey: '{env:USER_KEY}',
    models: { mine: { label: 'Mine' }, typed: { manual: true as const } },
  };
  // What the picker sends back: values read from the merged provider.
  const fromPicker = {
    providerId: 'work',
    type: 'anthropic' as const,
    baseURL: 'https://workspace.example/v1',
    apiKey: 'workspace-key',
    models: [{ id: 'discovered' }],
    activeModelId: 'discovered',
    activate: false,
  };

  it('does not write a merged type, origin or key to the user file on a refresh', () => {
    const saved = providerConfigForSave({ ...fromPicker, replaceModels: true }, own);

    expect(saved.type).toBe('openai');
    expect(saved.baseURL).toBe('https://user.example/v1');
    expect(saved.apiKey).toBe('{env:USER_KEY}');
    // The catalog is the point of a refresh: discovered models, plus the hand-typed one.
    expect(Object.keys(saved.models).sort()).toEqual(['discovered', 'typed']);
  });

  it('does not write a merged type, origin or key when adding a hand-typed model', () => {
    const saved = providerConfigForSave({ ...fromPicker, manual: true }, own);

    expect(saved).toMatchObject({
      type: 'openai',
      baseURL: 'https://user.example/v1',
      apiKey: '{env:USER_KEY}',
    });
    expect(Object.keys(saved.models).sort()).toEqual(['discovered', 'mine', 'typed']);
  });

  it('never carries a workspace-contributed model into the user file', () => {
    // `extra` exists only in the merged provider the picker listed; `own` does not have it.
    const saved = providerConfigForSave({ ...fromPicker, manual: true }, own);

    expect(saved.models.extra).toBeUndefined();
  });

  it('writes what the wizard was given: it is the user filling the form in', () => {
    const saved = providerConfigForSave({ ...fromPicker }, own);

    expect(saved).toMatchObject({
      type: 'anthropic',
      baseURL: 'https://workspace.example/v1',
      apiKey: 'workspace-key',
    });
  });

  it('builds a new provider from the draft alone when the user has none', () => {
    const saved = providerConfigForSave({ ...fromPicker, replaceModels: true }, undefined);

    expect(saved).toMatchObject({ type: 'anthropic', baseURL: 'https://workspace.example/v1' });
  });
});

// #416: discovery -> persisted settings -> loader -> the window /context shows.
describe('discovered Anthropic context windows reach the resolver', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'book-discovery-window-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('resolves the reported window as declared, and falls back to the family table without one', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'claude-sonnet-5-5', max_input_tokens: 1_000_000, max_tokens: 128_000 },
              { id: 'claude-sonnet-4-5-20250929', max_input_tokens: 200_000, max_tokens: 64_000 },
              { id: 'claude-haiku-4-5-20251001' },
            ],
          }),
          { status: 200 },
        ),
    );
    const models = await discoverModels({
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'key',
      retry: { ...defaultConfig().retry, maxAttempts: 0, requestTimeoutMs: 100 },
      fetchImpl: fetchImpl as typeof fetch,
    });
    const provider = providerConfigFromDraft({
      providerId: 'anth',
      type: 'anthropic',
      baseURL: 'https://api.anthropic.com',
      apiKey: 'key',
      models,
      activeModelId: 'claude-sonnet-5-5',
    });

    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ provider: { anth: provider } }));
    const loaded = loadSettingsFile(file);
    expect(loaded).not.toBeNull();
    const config = defaultConfig({ settings: mergeSettings(DEFAULT_SETTINGS, loaded!) });

    const resolve = (id: string) => {
      const resolved = resolveModelProviderConfig(config, `anth/${id}`);
      return { resolved, resolution: resolveContextWindow(resolved) };
    };

    const sonnet = resolve('claude-sonnet-5-5');
    expect(sonnet.resolution).toEqual({ window: 1_000_000, source: 'declared' });
    // The output limit must not reach request sizing or the compaction reserve.
    expect(sonnet.resolved.modelInfo?.maxOutputTokens).toBeUndefined();
    expect(resolve('claude-sonnet-4-5-20250929').resolution).toEqual({
      window: 200_000,
      source: 'declared',
    });
    expect(resolve('claude-haiku-4-5-20251001').resolution.source).toBe('family');

    const report = buildContextReport([], {
      model: 'claude-sonnet-5-5',
      maxTokens: sonnet.resolution.window,
      windowSource: sonnet.resolution.source,
      commandCount: 0,
      hasClaudeMdLoader: false,
    });
    expect(report).toContain('Model context budget: 1,000,000 tokens (claude-sonnet-5-5)');
    expect(report).not.toContain('assumed default');
  });
});
