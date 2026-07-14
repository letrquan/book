import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { persistSettingLocal, persistPermissionRuleLocal, readSettingsLocal } from './persist.js';

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
    const provider = readSettingsLocal(dir).provider as Record<string, any>;
    expect(provider.openrouter.type).toBe('openai');
    expect(provider.openrouter.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(provider.openrouter.models['deepseek-chat'].contextWindow).toBe(128000);
  });

  it('returns {ok:false, error} on a bad workspace rather than throwing', () => {
    const badWorkspace = join(dir, 'not-a-directory');
    writeFileSync(badWorkspace, 'not a directory');

    const r = persistSettingLocal(badWorkspace, 'model', 'x');
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
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
