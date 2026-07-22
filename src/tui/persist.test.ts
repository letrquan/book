import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveSettings } from '../settings-loader.js';
import {
  persistSettingLocal,
  persistSettingsLocal,
  persistPermissionRuleLocal,
  readSettingsLocal,
  removeProviderLocal,
} from './persist.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-persist-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('persistSettingLocal', () => {
  it('returns ok and never throws/exits; writes a nested key to settings.local.json', () => {
    const r = persistSettingLocal(dir, 'model', 'claude-sonnet-5');
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();

    const localPath = join(dir, '.book', 'settings.local.json');
    expect(existsSync(localPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(localPath, 'utf-8'));
    expect(parsed.model).toBe('claude-sonnet-5');
  });

  it('merges with an existing local settings file without clobbering other keys', () => {
    persistSettingLocal(dir, 'model', 'claude-sonnet-5');
    persistSettingLocal(dir, 'maxTurns', 50);
    expect(readSettingsLocal(dir)).toEqual({ model: 'claude-sonnet-5', maxTurns: 50 });
  });

  it('writes nested provider registry keys', () => {
    persistSettingLocal(dir, 'provider.openrouter.type', 'openai');
    persistSettingLocal(dir, 'provider.openrouter.baseURL', 'https://openrouter.ai/api/v1');
    persistSettingLocal(dir, 'provider.openrouter.models.deepseek-chat.contextWindow', 128000);
    const provider = readSettingsLocal(dir).provider as {
      openrouter: {
        type: string;
        baseURL: string;
        models: Record<string, { contextWindow: number }>;
      };
    };
    expect(provider.openrouter.type).toBe('openai');
    expect(provider.openrouter.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(provider.openrouter.models['deepseek-chat'].contextWindow).toBe(128000);
  });

  it('writes multiple settings atomically without splitting model IDs on dots', () => {
    const provider = {
      type: 'openai',
      apiKey: 'secret',
      models: { 'vendor/model.v2': { label: 'Model V2' } },
    };
    expect(
      persistSettingsLocal(dir, {
        'provider.gateway': provider,
        model: 'gateway/vendor/model.v2',
      }).ok,
    ).toBe(true);
    expect(readSettingsLocal(dir)).toEqual({
      provider: { gateway: provider },
      model: 'gateway/vendor/model.v2',
    });
  });

  it('returns {ok:false, error} on a bad workspace rather than throwing', () => {
    const badWorkspace = join(dir, 'not-a-directory');
    writeFileSync(badWorkspace, 'not a directory');

    const r = persistSettingLocal(badWorkspace, 'model', 'x');
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('preserves malformed local settings instead of replacing them', () => {
    const localPath = join(dir, '.book', 'settings.local.json');
    expect(persistSettingLocal(dir, 'model', 'initial').ok).toBe(true);
    writeFileSync(localPath, '{broken', 'utf-8');

    const result = persistSettingLocal(dir, 'model', 'replacement');

    expect(result.ok).toBe(false);
    expect(readFileSync(localPath, 'utf-8')).toBe('{broken');
  });
});

describe('persistPermissionRuleLocal', () => {
  it('appends a rule to permissions.allow and dedupes exact repeats', () => {
    expect(persistPermissionRuleLocal(dir, 'allow', 'Bash(npm install)').ok).toBe(true);
    expect(persistPermissionRuleLocal(dir, 'allow', 'Bash(npm install)').ok).toBe(true); // dup
    expect(persistPermissionRuleLocal(dir, 'allow', 'Read(./.env)').ok).toBe(true);
    const perms = readSettingsLocal(dir).permissions as { allow: string[] };
    expect(perms.allow).toEqual(['Bash(npm install)', 'Read(./.env)']);
  });

  it('writes each list under its own permissions key', () => {
    persistPermissionRuleLocal(dir, 'deny', 'Bash(rm -rf)');
    persistPermissionRuleLocal(dir, 'ask', 'WebFetch');
    const perms = readSettingsLocal(dir).permissions as {
      allow: string[];
      deny: string[];
      ask: string[];
    };
    expect(perms.deny).toEqual(['Bash(rm -rf)']);
    expect(perms.ask).toEqual(['WebFetch']);
    expect(perms.allow).toBeUndefined();
  });
});

describe('removeProviderLocal', () => {
  function writeLocal(settings: Record<string, unknown>): string {
    persistSettingsLocal(dir, settings);
    return join(dir, '.book', 'settings.local.json');
  }

  it('removes the complete provider while preserving siblings and unrelated settings', () => {
    const localPath = writeLocal({
      model: 'gateway/custom',
      maxTurns: 42,
      theme: 'light',
      provider: {
        gateway: {
          type: 'openai',
          baseURL: 'https://gateway.test/v1',
          apiKey: 'top-secret',
          models: {
            custom: { label: 'Custom', maxOutputTokens: 8192 },
            second: { contextWindow: 128000 },
          },
        },
        other: {
          type: 'anthropic',
          apiKey: 'other-secret',
          models: { model: { label: 'Other' } },
        },
      },
    });

    expect(removeProviderLocal(dir, 'gateway')).toEqual({
      ok: true,
      providerId: 'gateway',
      removedModelCount: 2,
      localDefaultCleared: true,
      localProviderExisted: true,
    });
    expect(readSettingsLocal(dir)).toEqual({
      maxTurns: 42,
      theme: 'light',
      provider: {
        other: {
          type: 'anthropic',
          apiKey: 'other-secret',
          models: { model: { label: 'Other' } },
        },
      },
    });
    const serialized = readFileSync(localPath, 'utf-8');
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('Custom');
    expect(serialized.endsWith('\n')).toBe(true);
  });

  it('prunes the provider registry when the last local provider is removed', () => {
    writeLocal({ provider: { gateway: { type: 'openai', models: { custom: {} } } } });

    expect(removeProviderLocal(dir, 'gateway').ok).toBe(true);
    expect(readSettingsLocal(dir)).toEqual({});
  });

  it('keeps a local model selection that references another provider', () => {
    writeLocal({
      model: 'other/model',
      provider: {
        gateway: { type: 'openai', models: { custom: {} } },
        other: { type: 'openai', models: { model: {} } },
      },
    });

    const result = removeProviderLocal(dir, 'gateway');
    expect(result.ok && result.localDefaultCleared).toBe(false);
    expect(readSettingsLocal(dir).model).toBe('other/model');
  });

  it('rejects a missing local provider without rewriting the file', () => {
    const localPath = writeLocal({
      model: 'project-model',
      provider: { other: { type: 'openai', models: { model: {} } } },
    });
    const before = readFileSync(localPath, 'utf-8');

    const result = removeProviderLocal(dir, 'gateway');

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        localProviderExisted: false,
        error: expect.stringContaining('not configured'),
      }),
    );
    expect(readFileSync(localPath, 'utf-8')).toBe(before);
  });

  it('returns an error for an invalid workspace and does not throw', () => {
    const badWorkspace = join(dir, 'not-a-directory');
    writeFileSync(badWorkspace, 'not a directory');

    expect(removeProviderLocal(badWorkspace, 'gateway')).toEqual(
      expect.objectContaining({ ok: false, localProviderExisted: false }),
    );
  });

  it('reveals a lower-layer provider and removes stale local selection on restart', () => {
    writeLocal({
      model: 'gateway/local',
      provider: {
        gateway: {
          type: 'openai',
          apiKey: 'local-key',
          models: { local: { label: 'Local' } },
        },
      },
    });
    writeFileSync(
      join(dir, '.book', 'settings.json'),
      JSON.stringify(
        {
          model: 'project-model',
          provider: {
            gateway: {
              type: 'openai',
              apiKey: 'project-key',
              models: { inherited: { label: 'Inherited' } },
            },
          },
        },
        null,
        2,
      ) + '\n',
    );

    expect(removeProviderLocal(dir, 'gateway').ok).toBe(true);
    const restarted = resolveSettings(dir);

    expect(restarted.model).toBe('project-model');
    expect(restarted.provider.gateway.apiKey).toBe('project-key');
    expect(restarted.provider.gateway.models).toEqual({ inherited: { label: 'Inherited' } });
    expect(readSettingsLocal(dir)).toEqual({});
  });
});
