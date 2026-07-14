import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.js';
import {
  buildModelOptions,
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
});
