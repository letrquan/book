import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { bookSettingsSchema, DEFAULT_SETTINGS } from './settings.js';

describe('settings schema', () => {
  it('validates compactEffort with valid levels and rejects invalid levels', () => {
    expect(bookSettingsSchema.safeParse({ compactEffort: 'low' }).success).toBe(true);
    expect(bookSettingsSchema.safeParse({ compactEffort: 'extreme' }).success).toBe(false);
  });
});

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

  it('never defaults an object schema with .default(), which skips its field defaults', () => {
    // Zod 4's `.default(value)` returns `value` without parsing it, so an object defaulted to `{}`
    // would come back bare. Object schemas take `.prefault({})` instead; this walks every schema
    // reachable from the settings root so a new section cannot reintroduce the mistake.
    const offenders: string[] = [];
    const walk = (schema: z.ZodType, path: string): void => {
      const def = schema.def as unknown as Record<string, unknown> & { type: string };
      switch (def.type) {
        case 'object':
          for (const [key, value] of Object.entries(def.shape as Record<string, z.ZodType>)) {
            walk(value, `${path}.${key}`);
          }
          break;
        case 'default': {
          const inner = def.innerType as z.ZodType;
          if ((inner.def as { type: string }).type === 'object') offenders.push(path);
          walk(inner, path);
          break;
        }
        case 'prefault':
        case 'optional':
        case 'nullable':
          walk(def.innerType as z.ZodType, path);
          break;
        case 'record':
          walk(def.valueType as z.ZodType, `${path}.*`);
          break;
        case 'array':
          walk(def.element as z.ZodType, `${path}[]`);
          break;
        case 'union':
          (def.options as z.ZodType[]).forEach((option) => walk(option, path));
          break;
      }
    };

    walk(bookSettingsSchema, 'settings');

    expect(offenders).toEqual([]);
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
