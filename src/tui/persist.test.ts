import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveSettings } from '../settings-loader.js';
import {
  persistSettingLocal,
  persistSettingsLocal,
  persistPermissionRuleLocal,
  persistSettingGlobal,
  persistSettingsGlobal,
  persistAgentProfileModel,
  persistSkillActivationLocal,
  persistSkillExecutionLocal,
  persistSkillsEnabledLocal,
  readSettingsLocal,
  readSettingsGlobal,
  removeProviderLocal,
  removeProviderGlobal,
  clearLocalSettings,
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

describe('persistAgentProfileModel', () => {
  it('keeps dotted profile names as literal keys and persists inherit', () => {
    expect(persistAgentProfileModel(dir, 'code.review', 'gateway/model.v2').ok).toBe(true);
    expect(persistAgentProfileModel(dir, 'code.review').ok).toBe(true);
    expect(readSettingsLocal(dir)).toMatchObject({
      agents: { profiles: { 'code.review': { model: 'inherit' } } },
    });
  });
});

describe('persistSkillActivationLocal', () => {
  it('keeps dotted skill names as literal override keys', () => {
    expect(persistSkillActivationLocal(dir, 'release.v2', 'manual').ok).toBe(true);
    expect(readSettingsLocal(dir)).toMatchObject({
      skills: { overrides: { 'release.v2': 'manual' } },
    });
  });

  it('persists consent policies and the global switch independently', () => {
    expect(persistSkillExecutionLocal(dir, 'release.v2', 'ask').ok).toBe(true);
    expect(persistSkillsEnabledLocal(dir, false).ok).toBe(true);
    expect(readSettingsLocal(dir)).toMatchObject({
      skills: { enabled: false, execution: { 'release.v2': 'ask' } },
    });
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

describe('global scope (~/.book/settings.json)', () => {
  // The global helpers resolve their path via os.homedir(), which reads HOME on
  // POSIX and USERPROFILE on Windows. Point both at a temp dir so writes land in
  // an isolated fake home instead of the developer's real ~/.book.
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'book-home-'));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it('writes provider and model to the global settings.json, not the workspace', () => {
    const provider = {
      type: 'openai',
      apiKey: 'secret',
      models: { 'deepseek-chat': { label: 'DeepSeek' } },
    };
    expect(
      persistSettingsGlobal({
        'provider.gateway': provider,
        model: 'gateway/deepseek-chat',
      }).ok,
    ).toBe(true);

    const globalPath = join(home, '.book', 'settings.json');
    expect(existsSync(globalPath)).toBe(true);
    expect(readSettingsGlobal()).toEqual({
      provider: { gateway: provider },
      model: 'gateway/deepseek-chat',
    });
    // Nothing should have been written to the project-local layer.
    expect(existsSync(join(dir, '.book', 'settings.local.json'))).toBe(false);
  });

  it('a global provider resolves for any workspace', () => {
    persistSettingGlobal('provider.gateway', {
      type: 'openai',
      apiKey: 'secret',
      models: { 'deepseek-chat': { label: 'DeepSeek' } },
    });
    const resolved = resolveSettings(dir);
    expect(resolved.provider.gateway.apiKey).toBe('secret');
  });

  it('removeProviderGlobal drops the provider and a global default that targets it', () => {
    persistSettingsGlobal({
      'provider.gateway': {
        type: 'openai',
        apiKey: 'secret',
        models: { m: { label: 'M' } },
      },
      model: 'gateway/m',
    });

    const result = removeProviderGlobal('gateway');
    expect(result).toEqual({
      ok: true,
      providerId: 'gateway',
      removedModelCount: 1,
      localDefaultCleared: true,
      localProviderExisted: true,
    });
    expect(readSettingsGlobal()).toEqual({});
  });

  it('removeProviderGlobal reports a missing provider against the global path', () => {
    const result = removeProviderGlobal('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('~/.book/settings.json');
  });

  it('clearLocalSettings removes a stale local model so the global default wins', () => {
    // Simulate a folder used before the change: a per-project model override.
    persistSettingLocal(dir, 'model', 'old/x');
    persistSettingGlobal('model', 'new/y');

    // Local shadows global for scalars — this is the pre-clear regression.
    expect(resolveSettings(dir).model).toBe('old/x');

    expect(clearLocalSettings(dir, ['model']).ok).toBe(true);

    // With the stale override gone, the folder inherits the global default.
    expect(resolveSettings(dir).model).toBe('new/y');
    expect(readSettingsLocal(dir).model).toBeUndefined();
  });

  it('clearLocalSettings prunes a stale local provider and empties its registry', () => {
    persistSettingsLocal(dir, {
      'provider.gateway': { type: 'openai', apiKey: 'old', models: { m: { label: 'M' } } },
      model: 'gateway/m',
    });
    persistSettingGlobal('provider.gateway', {
      type: 'openai',
      apiKey: 'new',
      models: { m: { label: 'M' } },
    });

    expect(clearLocalSettings(dir, ['provider.gateway', 'model']).ok).toBe(true);

    // The emptied provider registry is pruned, leaving no local overrides.
    expect(readSettingsLocal(dir)).toEqual({});
    expect((resolveSettings(dir).provider.gateway as { apiKey: string }).apiKey).toBe('new');
  });

  it('clearLocalSettings is a no-op when the local file is absent', () => {
    expect(clearLocalSettings(dir, ['model']).ok).toBe(true);
    expect(existsSync(join(dir, '.book', 'settings.local.json'))).toBe(false);
  });
});
