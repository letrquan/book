import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { conversationCheckpointV2Schema } from './agent/compact.js';
import { legacyConfigSchema } from './config.js';
import {
  learnedModelWindowEntrySchema,
  looseModelWindowStoreSchema,
} from './model-window-store.js';
import { bookSettingsSchema, DEFAULT_SETTINGS } from './settings.js';
import { workspaceTrustSchema } from './workspace-trust.js';

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
      allowGitWrites: false,
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
    // Book parses a stored document with, so a new section cannot reintroduce the mistake.
    type Def = Record<string, unknown> & { type: string };
    const defOf = (schema: z.ZodType) => schema.def as unknown as Def;
    // Wrappers that pass `undefined` through to a default unchanged, so `.optional().default({})`
    // on an object is the same trap as `.default({})`.
    const WRAPPERS = new Set(['optional', 'nullable', 'readonly', 'nonoptional']);
    const unwrap = (schema: z.ZodType): z.ZodType => {
      const def = defOf(schema);
      return WRAPPERS.has(def.type) ? unwrap(def.innerType as z.ZodType) : schema;
    };
    // An object, or a union with an object among its options.
    const holdsObject = (schema: z.ZodType): boolean => {
      const def = defOf(unwrap(schema));
      if (def.type === 'object') return true;
      return def.type === 'union' && (def.options as z.ZodType[]).some(holdsObject);
    };
    const LEAVES = new Set(['string', 'number', 'boolean', 'literal', 'enum', 'unknown', 'any']);

    const offenders: string[] = [];
    const walk = (schema: z.ZodType, path: string): void => {
      const def = defOf(schema);
      switch (def.type) {
        case 'object':
          for (const [key, value] of Object.entries(def.shape as Record<string, z.ZodType>)) {
            walk(value, `${path}.${key}`);
          }
          return;
        case 'default': {
          const inner = def.innerType as z.ZodType;
          if (holdsObject(inner)) offenders.push(path);
          walk(inner, path);
          return;
        }
        case 'prefault':
        case 'catch':
          walk(def.innerType as z.ZodType, path);
          return;
        case 'record':
          walk(def.valueType as z.ZodType, `${path}.*`);
          return;
        case 'array':
          walk(def.element as z.ZodType, `${path}[]`);
          return;
        case 'union':
          (def.options as z.ZodType[]).forEach((option) => walk(option, path));
          return;
        case 'pipe':
          walk(def.in as z.ZodType, path);
          walk(def.out as z.ZodType, path);
          return;
        default:
          if (WRAPPERS.has(def.type)) return walk(def.innerType as z.ZodType, path);
          // A schema kind this walk does not know could hide a defaulted object beneath it.
          if (!LEAVES.has(def.type))
            throw new Error(`unhandled schema type ${def.type} at ${path}`);
      }
    };

    walk(bookSettingsSchema, 'settings');
    walk(workspaceTrustSchema, 'trust');
    walk(looseModelWindowStoreSchema, 'modelWindows');
    walk(learnedModelWindowEntrySchema, 'modelWindows.*');
    walk(legacyConfigSchema, 'bookrc');
    walk(conversationCheckpointV2Schema, 'checkpoint');

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

  it('accepts an unbounded integer setting beyond the safe-integer range, as Zod 3 did', () => {
    // A settings file that loaded before the Zod 4 upgrade must keep loading.
    expect(issuePaths({ maxTurns: 2 ** 60, continuation: { maxWallClockMs: 1e18 } })).toEqual([]);
    expect(
      issuePaths({ agents: { minFreeDiskBytes: 1e16, profiles: { p: { maxTurns: 1e17 } } } }),
    ).toEqual([]);
    const notInteger = bookSettingsSchema.safeParse({ maxTurns: 1.5 });
    expect(notInteger.success).toBe(false);
    expect(notInteger.error?.issues).toMatchObject([
      { code: 'invalid_type', expected: 'int', path: ['maxTurns'] },
    ]);
  });

  it('keeps a legacy .bookrc.json baseUrl exactly as written', () => {
    expect(legacyConfigSchema.parse({ baseUrl: ' http://x.com/v1 ' }).baseUrl).toBe(
      ' http://x.com/v1 ',
    );
    expect(legacyConfigSchema.parse({ baseUrl: 'localhost:1234' }).baseUrl).toBe('localhost:1234');
    expect(legacyConfigSchema.safeParse({ baseUrl: 'not a url' }).success).toBe(false);
  });

  it('strips unknown keys instead of rejecting them', () => {
    const parsed = bookSettingsSchema.parse({ nonsense: 1, sandbox: { alsoNonsense: true } });
    expect(parsed).not.toHaveProperty('nonsense');
    expect(parsed.sandbox).not.toHaveProperty('alsoNonsense');
  });
});
