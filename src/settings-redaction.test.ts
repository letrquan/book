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

/**
 * `book config list` dumps the resolved document into terminal scrollback and
 * pasted bug reports. `clientId` is a public identifier by design and stays
 * visible - that is what makes "no client id configured" diagnosable - but a
 * client secret and the free-form headers that ride along with the bearer token
 * are not.
 */
describe('auth settings redaction', () => {
  const auth = {
    profile: 'gateway',
    profiles: {
      gateway: {
        clientId: 'public-client-id',
        clientSecret: 'sk-confidential',
        headers: { 'X-Gateway-Key': 'sk-gateway' },
        baseUrl: 'https://gateway.example.com/v1',
      },
    },
  };

  it('hides the secret and headers in a whole-document dump', () => {
    const serialized = JSON.stringify(redactSettingsForDisplay({ auth }));

    expect(serialized).not.toContain('sk-confidential');
    expect(serialized).not.toContain('sk-gateway');
    // Still diagnosable.
    expect(serialized).toContain('public-client-id');
    expect(serialized).toContain('https://gateway.example.com/v1');
  });

  it.each([
    ['auth', auth],
    ['auth.profiles', auth.profiles],
    ['auth.profiles.gateway', auth.profiles.gateway],
    ['auth.profiles.gateway.clientSecret', auth.profiles.gateway.clientSecret],
    ['auth.profiles.gateway.headers', auth.profiles.gateway.headers],
  ])('hides them for a targeted `book config get %s`', (path, value) => {
    const serialized = JSON.stringify(redactSettingValue(path, value));
    expect(serialized).not.toContain('sk-confidential');
    expect(serialized).not.toContain('sk-gateway');
  });

  it('leaves the client id readable for a targeted get', () => {
    expect(redactSettingValue('auth.profiles.gateway.clientId', 'public-client-id')).toBe(
      'public-client-id',
    );
  });
});
