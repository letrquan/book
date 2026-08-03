import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, normalize } from 'path';
import { resolveSettings, mergeSettings, loadSettingsFile } from './settings-loader.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from './settings.js';

let dir: string;
let userDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-settings-'));
  userDir = mkdtempSync(join(tmpdir(), 'book-user-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

describe('loadSettingsFile', () => {
  it('returns null for missing file', () => {
    expect(loadSettingsFile(join(dir, 'nonexistent.json'))).toBeNull();
  });

  it('throws on invalid JSON', () => {
    writeFileSync(join(dir, 'bad.json'), '{invalid');
    expect(() => loadSettingsFile(join(dir, 'bad.json'))).toThrow(/Invalid JSON/);
  });

  it('throws on schema validation failure', () => {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ maxTurns: 'not-a-number' }));
    expect(() => loadSettingsFile(join(dir, 'bad.json'))).toThrow(/Invalid settings/);
  });

  it('loads a valid settings file', () => {
    writeFileSync(
      join(dir, 'good.json'),
      JSON.stringify({ model: 'gpt-4o', maxTurns: 10, theme: 'paper-ink' }),
    );
    const result = loadSettingsFile(join(dir, 'good.json'));
    expect(result?.model).toBe('gpt-4o');
    expect(result?.maxTurns).toBe(10);
    expect(result?.theme).toBe('paper-ink');
  });

  it('keeps compact provider registry metadata', () => {
    writeFileSync(
      join(dir, 'provider.json'),
      JSON.stringify({
        model: 'openrouter/deepseek-chat',
        provider: {
          openrouter: {
            type: 'openai',
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: '{env:OPENROUTER_API_KEY}',
            models: {
              'deepseek-chat': {
                label: 'DeepSeek Chat',
                contextWindow: 128000,
                maxOutputTokens: 8192,
                effort: false,
              },
            },
          },
        },
      }),
    );
    const result = loadSettingsFile(join(dir, 'provider.json'));
    const model = result?.provider.openrouter.models['deepseek-chat'];
    expect(result?.provider.openrouter.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(model?.contextWindow).toBe(128000);
    expect(model?.effort).toBe(false);
  });
});

describe('mergeSettings', () => {
  it('scalar override wins', () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    const result = mergeSettings(base, { model: 'gpt-5' });
    expect(result.model).toBe('gpt-5');
  });

  it('arrays concatenate', () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    base.permissions.deny = ['Read(./.env)'];
    const result = mergeSettings(base, {
      permissions: { allow: [], ask: [], deny: ['Bash(curl *)'] },
    });
    expect(result.permissions.deny).toEqual(['Read(./.env)', 'Bash(curl *)']);
  });

  it('nested objects merge recursively while explicitly supplied arrays replace', () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    base.sandbox.filesystem.denyWrite = ['/etc'];
    const result = mergeSettings(base, {
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true,
        excludedCommands: [],
        allowUnsandboxedCommands: true,
        filesystem: { allowWrite: ['/tmp'], denyWrite: [], denyRead: [] },
        network: { allowedDomains: [], deniedDomains: [] },
      },
    });
    expect(result.sandbox.enabled).toBe(true);
    expect(result.sandbox.filesystem.denyWrite).toEqual([]);
    expect(result.sandbox.filesystem.allowWrite).toEqual(['/tmp']);
  });

  it('undefined values do not override', () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    base.model = 'gpt-4o';
    const result = mergeSettings(base, { model: undefined });
    expect(result.model).toBe('gpt-4o');
  });

  it('merges nested memory settings without losing defaults', () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    const result = mergeSettings(base, {
      memory: { autoSave: false },
    } as Partial<ResolvedSettings>);
    expect(result.memory.enabled).toBe(true);
    expect(result.memory.autoSave).toBe(false);
    expect(result.memory.requireApproval).toBe(true);
  });

  it('merges the thinking visibility setting without losing its default', () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    const result = mergeSettings(base, {
      ui: { showThinking: false },
    } as Partial<ResolvedSettings>);
    expect(result.ui.showThinking).toBe(false);
  });
});

describe('resolveSettings — layered merging', () => {
  it('returns defaults when no settings files exist', () => {
    const result = resolveSettings(dir);
    expect(result.permissions.allow).toEqual([]);
    expect(result.sandbox.enabled).toBe(false);
    expect(result.memory).toEqual({ enabled: true, autoSave: true, requireApproval: true });
  });

  it('loads user settings from BOOK_HOME', () => {
    const bookHome = join(userDir, 'isolated-book-home');
    mkdirSync(bookHome, { recursive: true });
    writeFileSync(join(bookHome, 'settings.json'), JSON.stringify({ model: 'isolated-model' }));
    vi.stubEnv('BOOK_HOME', bookHome);

    expect(resolveSettings(dir).model).toBe('isolated-model');
  });

  it('project overrides user', () => {
    const userSettingsDir = join(userDir, '.book');
    mkdirSync(userSettingsDir, { recursive: true });
    writeFileSync(
      join(userSettingsDir, 'settings.json'),
      JSON.stringify({ model: 'user-model', maxTurns: 5 }),
    );

    const projectSettingsDir = join(dir, '.book');
    mkdirSync(projectSettingsDir, { recursive: true });
    writeFileSync(
      join(projectSettingsDir, 'settings.json'),
      JSON.stringify({ model: 'project-model' }),
    );

    vi.stubEnv('BOOK_HOME', userSettingsDir);

    const result = resolveSettings(dir);
    expect(result.model).toBe('project-model');
    expect(result.maxTurns).toBe(5);
  });

  it('local overrides project', () => {
    const projectSettingsDir = join(dir, '.book');
    mkdirSync(projectSettingsDir, { recursive: true });
    writeFileSync(
      join(projectSettingsDir, 'settings.json'),
      JSON.stringify({ model: 'project-model', maxTurns: 10 }),
    );
    writeFileSync(
      join(projectSettingsDir, 'settings.local.json'),
      JSON.stringify({ model: 'local-model' }),
    );

    const result = resolveSettings(dir);
    expect(result.model).toBe('local-model');
    expect(result.maxTurns).toBe(10); // project value preserved
  });

  it('permission rules concatenate across scopes', () => {
    const projectSettingsDir = join(dir, '.book');
    mkdirSync(projectSettingsDir, { recursive: true });
    writeFileSync(
      join(projectSettingsDir, 'settings.json'),
      JSON.stringify({
        permissions: { deny: ['Read(./.env)'] },
      }),
    );
    writeFileSync(
      join(projectSettingsDir, 'settings.local.json'),
      JSON.stringify({
        permissions: { deny: ['Bash(curl *)'], allow: ['Bash(git *)'] },
      }),
    );

    const result = resolveSettings(dir);
    expect(result.permissions.deny).toEqual(['Read(./.env)', 'Bash(curl *)']);
    expect(result.permissions.allow).toEqual(['Bash(git *)']);
  });

  it('additionalDirectories concatenate across scopes', () => {
    const projectSettingsDir = join(dir, '.book');
    mkdirSync(projectSettingsDir, { recursive: true });
    writeFileSync(
      join(projectSettingsDir, 'settings.json'),
      JSON.stringify({ additionalDirectories: ['../shared'] }),
    );
    writeFileSync(
      join(projectSettingsDir, 'settings.local.json'),
      JSON.stringify({ additionalDirectories: ['../private'] }),
    );

    const result = resolveSettings(dir);
    expect(result.additionalDirectories).toEqual([normalize('../shared'), normalize('../private')]);
  });

  it('normalizes and deduplicates additionalDirectories across scopes', () => {
    const projectSettingsDir = join(dir, '.book');
    mkdirSync(projectSettingsDir, { recursive: true });
    writeFileSync(
      join(projectSettingsDir, 'settings.json'),
      JSON.stringify({ additionalDirectories: ['../shared', '../shared/.'] }),
    );
    writeFileSync(
      join(projectSettingsDir, 'settings.local.json'),
      JSON.stringify({ additionalDirectories: ['../shared'] }),
    );

    expect(resolveSettings(dir).additionalDirectories).toEqual([normalize('../shared')]);
  });

  it('replaces unregistered arrays instead of concatenating them', () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    base.sandbox.excludedCommands = ['first'];
    const result = mergeSettings(base, {
      sandbox: { ...base.sandbox, excludedCommands: ['second'] },
    });
    expect(result.sandbox.excludedCommands).toEqual(['second']);
  });

  it('accepts injectable user and settings paths', () => {
    const userPath = join(userDir, 'user.json');
    const projectPath = join(dir, 'project.json');
    const localPath = join(dir, 'local.json');
    writeFileSync(userPath, JSON.stringify({ model: 'user', additionalDirectories: ['../one'] }));
    writeFileSync(projectPath, JSON.stringify({ model: 'project' }));
    writeFileSync(localPath, JSON.stringify({ maxTurns: 12 }));

    const result = resolveSettings(dir, undefined, {
      userSettingsPath: userPath,
      projectSettingsPath: projectPath,
      localSettingsPath: localPath,
    });
    expect(result.model).toBe('project');
    expect(result.maxTurns).toBe(12);
    expect(result.additionalDirectories).toEqual([normalize('../one')]);
  });

  it('rejects malformed settings files with clear error', () => {
    const projectSettingsDir = join(dir, '.book');
    mkdirSync(projectSettingsDir, { recursive: true });
    writeFileSync(join(projectSettingsDir, 'settings.json'), '{broken json');

    expect(() => resolveSettings(dir)).toThrow(/Invalid JSON/);
  });

  it('ad-hoc override path (--settings) takes highest priority', () => {
    const projectSettingsDir = join(dir, '.book');
    mkdirSync(projectSettingsDir, { recursive: true });
    writeFileSync(
      join(projectSettingsDir, 'settings.json'),
      JSON.stringify({ model: 'project-model' }),
    );

    const overridePath = join(dir, 'override.json');
    writeFileSync(overridePath, JSON.stringify({ model: 'override-model', maxTurns: 3 }));

    const result = resolveSettings(dir, overridePath);
    expect(result.model).toBe('override-model');
    expect(result.maxTurns).toBe(3);
  });

  it('does not allow project or local settings to select bypass as the default mode', () => {
    const userPath = join(userDir, 'user.json');
    const projectPath = join(dir, 'project.json');
    const localPath = join(dir, 'local.json');
    writeFileSync(userPath, JSON.stringify({ defaultMode: 'plan' }));
    writeFileSync(projectPath, JSON.stringify({ defaultMode: 'bypassPermissions' }));
    writeFileSync(localPath, JSON.stringify({ defaultMode: 'bypassPermissions' }));

    const result = resolveSettings(dir, undefined, {
      userSettingsPath: userPath,
      projectSettingsPath: projectPath,
      localSettingsPath: localPath,
    });
    expect(result.defaultMode).toBe('plan');
  });

  it('preserves a global bypass-disable ceiling across lower-trust layers', () => {
    const userPath = join(userDir, 'user.json');
    const projectPath = join(dir, 'project.json');
    writeFileSync(userPath, JSON.stringify({ disableBypassPermissionsMode: true }));
    writeFileSync(projectPath, JSON.stringify({ disableBypassPermissionsMode: false }));

    const result = resolveSettings(dir, undefined, {
      userSettingsPath: userPath,
      projectSettingsPath: projectPath,
    });
    expect(result.disableBypassPermissionsMode).toBe(true);
  });
});
