import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.js';
import {
  buildModelOptions,
  parseModelIds,
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
