import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookSettingsSchema, DEFAULT_SETTINGS, providerConfigSchema } from './settings.js';
import { SettingsRepository } from './settings-repository.js';

// Pins how the settings schemas fill defaults and reject documents, independent of the Zod
// version underneath. Zod 4's `.default()` returns its value without parsing it, so an object
// schema defaulted to `{}` would come back as a bare `{}` instead of its filled defaults.

// `compactStrategy` is optional in the schema and stays absent from an empty document, so the
// expectation for one omits it.
function withoutCompactStrategy({ compactStrategy: _strategy, ...rest }: typeof DEFAULT_SETTINGS) {
  return rest;
}

const schemaDefaults = withoutCompactStrategy(DEFAULT_SETTINGS);

describe('settings schema defaults', () => {
  it('fills every default for an empty document', () => {
    expect(bookSettingsSchema.parse({})).toEqual(schemaDefaults);
  });

  it('fills the inner defaults of a nested object given as {}', () => {
    const parsed = bookSettingsSchema.parse({
      sandbox: {},
      memory: { extraction: {} },
      agents: { ui: {}, routing: {} },
    });
    expect(parsed.sandbox).toEqual(DEFAULT_SETTINGS.sandbox);
    expect(parsed.memory.extraction).toEqual(DEFAULT_SETTINGS.memory.extraction);
    expect(parsed.agents.ui).toEqual({ enabled: true });
    expect(parsed.agents.routing).toEqual({ inlineSearchBudget: 3, exploreReminder: true });
  });

  it('fills the defaults a partial nested object leaves out', () => {
    const parsed = bookSettingsSchema.parse({
      sandbox: { filesystem: { allowWrite: ['/tmp'] }, network: {} },
      memory: { extraction: { idleHours: 1 } },
      retry: { maxAttempts: 5 },
      hooks: { SessionStart: [{ command: 'echo hi' }] },
    });
    expect(parsed.sandbox.filesystem).toEqual({
      allowWrite: ['/tmp'],
      denyWrite: [],
      denyRead: [],
    });
    expect(parsed.sandbox.network).toEqual({ allowedDomains: [], deniedDomains: [] });
    expect(parsed.memory.extraction).toEqual({
      ...DEFAULT_SETTINGS.memory.extraction,
      idleHours: 1,
    });
    expect(parsed.retry).toEqual({ ...DEFAULT_SETTINGS.retry, maxAttempts: 5 });
    expect(parsed.hooks.SessionStart).toEqual([{ command: 'echo hi', env: {} }]);
    expect(parsed.hooks.Stop).toEqual([]);
    expect(parsed.hooks.projectEntries).toEqual({});
  });

  it('fills provider and model defaults inside a record', () => {
    const parsed = bookSettingsSchema.parse({
      provider: { a: {}, b: { models: { m: { contextWindow: 1000 } } } },
      agents: { profiles: { p: { model: 'm' } } },
    });
    expect(parsed.provider.a).toEqual({ type: 'openai', models: {} });
    expect(parsed.provider.b).toEqual({ type: 'openai', models: { m: { contextWindow: 1000 } } });
    expect(parsed.agents.profiles).toEqual({ p: { model: 'm' } });
    expect(providerConfigSchema.parse({ baseUrl: 'http://x' })).toEqual({
      type: 'openai',
      baseUrl: 'http://x',
      models: {},
    });
  });

  it('does not share default values between parses', () => {
    const first = bookSettingsSchema.parse({});
    first.additionalDirectories.push('x');
    first.hooks.SessionStart.push({ command: 'y', env: {} });
    first.sandbox.filesystem.allowWrite.push('z');
    first.env.KEY = 'value';
    first.permissions.projectAllowRules.Read = 'approved';

    const second = bookSettingsSchema.parse({});
    expect(second.additionalDirectories).toEqual([]);
    expect(second.hooks.SessionStart).toEqual([]);
    expect(second.sandbox.filesystem.allowWrite).toEqual([]);
    expect(second.env).toEqual({});
    expect(second.permissions.projectAllowRules).toEqual({});
  });
});

describe('settings schema rejection', () => {
  function issuePaths(document: unknown): string[] {
    const result = bookSettingsSchema.safeParse(document);
    if (result.success) return [];
    return result.error.issues.map((issue) => issue.path.join('.'));
  }

  it('reports every invalid field by its path', () => {
    expect(issuePaths({ model: 1, retry: { maxAttempts: -1 }, effort: 'huge' })).toEqual([
      'model',
      'effort',
      'retry.maxAttempts',
    ]);
    expect(issuePaths({ hooks: { SessionStart: [{ matcher: 'x' }] } })).toEqual([
      'hooks.SessionStart.0.command',
    ]);
    expect(issuePaths({ agents: { checks: { unit: [] } } })).toEqual(['agents.checks.unit']);
  });

  it('validates record values under string keys', () => {
    expect(issuePaths({ permissions: { projectAllowRules: { Read: 'maybe' } } })).toEqual([
      'permissions.projectAllowRules.Read',
    ]);
    expect(issuePaths({ env: { A: 1 } })).toEqual(['env.A']);
    expect(
      issuePaths({ skills: { overrides: { review: 'auto' }, execution: { review: 'ask' } } }),
    ).toEqual([]);
    expect(issuePaths({ provider: { a: { type: 'gemini' } } })).toEqual(['provider.a.type']);
  });

  it('strips unknown keys instead of rejecting them', () => {
    const parsed = bookSettingsSchema.parse({ nonsense: 1, sandbox: { alsoNonsense: true } });
    expect(parsed).not.toHaveProperty('nonsense');
    expect(parsed.sandbox).not.toHaveProperty('alsoNonsense');
  });
});

describe('settings repository rejects an invalid document whole', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'book-settings-schema-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes nothing and names the field when one value in the mutation is invalid', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ model: 'kept' }, null, 2) + '\n');
    const repository = new SettingsRepository(path);

    const result = repository.set({ 'retry.baseDelayMs': 2000, 'retry.maxAttempts': 99 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.issuePath)).toEqual([
      'retry.maxAttempts',
    ]);
    expect(result.diagnostics[0].message).toMatch(/15/);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ model: 'kept' });
  });
});
