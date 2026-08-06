import { describe, expect, it } from 'vitest';
import { redactSettingValue, redactSettingsForDisplay } from './settings-redaction.js';

describe('settings redaction', () => {
  it('redacts provider API keys without mutating input', () => {
    const settings = {
      provider: { gateway: { apiKey: 'secret', models: {} } },
      model: 'gateway/model',
    };
    expect(redactSettingsForDisplay(settings)).toEqual({
      provider: { gateway: { apiKey: '*** (stored)', models: {} } },
      model: 'gateway/model',
    });
    expect(settings.provider.gateway.apiKey).toBe('secret');
  });

  it('redacts direct, provider-record, and provider-map values', () => {
    expect(redactSettingValue('provider.gateway.apiKey', 'secret')).toBe('*** (stored)');
    expect(redactSettingValue('provider.gateway', { apiKey: 'secret', models: {} })).toEqual({
      apiKey: '*** (stored)',
      models: {},
    });
    expect(redactSettingValue('provider', { gateway: { apiKey: 'secret', models: {} } })).toEqual({
      gateway: { apiKey: '*** (stored)', models: {} },
    });
    expect(redactSettingValue('provider.gateway.baseURL', 'https://example.test')).toBe(
      'https://example.test',
    );
  });

  it('keeps the non-sensitive harness mode inspectable', () => {
    const settings = { harness: { mode: 'off' }, provider: {} };

    expect(redactSettingsForDisplay(settings)).toEqual(settings);
    expect(redactSettingValue('harness.mode', 'off')).toBe('off');
  });
});
