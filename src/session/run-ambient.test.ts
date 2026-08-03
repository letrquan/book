import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { createRegistry } from '../tools/registry.js';
import { toolSuccess } from '../tools/result.js';
import type { ToolDefinition } from '../types/tools.js';
import { createRunAmbientSnapshot } from './run-ambient.js';

function tool(name: string, description = `${name} description`): ToolDefinition {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    execute: async () => toolSuccess('ok'),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createRunAmbientSnapshot', () => {
  it('creates a stable fingerprint independent of tool registration order and capture time', () => {
    const firstRegistry = createRegistry();
    firstRegistry.registerAll([tool('Beta'), tool('Alpha')]);
    const secondRegistry = createRegistry();
    secondRegistry.registerAll([tool('Alpha'), tool('Beta')]);

    const first = createRunAmbientSnapshot(defaultConfig(), firstRegistry, 10);
    const second = createRunAmbientSnapshot(defaultConfig(), secondRegistry, { capturedAt: 20 });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.capturedAt).toBe(10);
    expect(second.capturedAt).toBe(20);
    expect(first.tools.names).toEqual(['Alpha', 'Beta']);
  });

  it('changes when the effective tool contract or managed-agent mode changes', () => {
    const baselineRegistry = createRegistry();
    baselineRegistry.register(tool('ReadLike'));
    const changedRegistry = createRegistry();
    changedRegistry.register(tool('ReadLike', 'Changed provider-facing description'));
    const baselineConfig = defaultConfig();
    const changedConfig = defaultConfig();
    changedConfig.settings.agents.mode = 'off';

    const baseline = createRunAmbientSnapshot(baselineConfig, baselineRegistry, { capturedAt: 1 });
    const changedTool = createRunAmbientSnapshot(baselineConfig, changedRegistry, {
      capturedAt: 1,
    });
    const changedMode = createRunAmbientSnapshot(changedConfig, baselineRegistry, {
      capturedAt: 1,
    });

    expect(changedTool.tools.fingerprint).not.toBe(baseline.tools.fingerprint);
    expect(changedTool.fingerprint).not.toBe(baseline.fingerprint);
    expect(changedMode.settings.agentsMode).toBe('off');
    expect(changedMode.fingerprint).not.toBe(baseline.fingerprint);
  });

  it('changes when the resolved initial permission mode changes', () => {
    const registry = createRegistry();
    const config = defaultConfig();

    const defaultMode = createRunAmbientSnapshot(config, registry, {
      capturedAt: 1,
      permissionMode: 'default',
    });
    const planMode = createRunAmbientSnapshot(config, registry, {
      capturedAt: 1,
      permissionMode: 'plan',
    });

    expect(defaultMode.policies.permissionMode).toBe('default');
    expect(planMode.policies.permissionMode).toBe('plan');
    expect(planMode.fingerprint).not.toBe(defaultMode.fingerprint);
  });

  it('redacts credential values and declares inputs that are not frozen yet', () => {
    const registry = createRegistry();
    const firstConfig = defaultConfig({ apiKey: 'first-secret' });
    const secondConfig = defaultConfig({ apiKey: 'second-secret' });
    firstConfig.settings.provider.gateway = {
      type: 'openai',
      apiKey: 'settings-secret-one',
      models: {},
    };
    secondConfig.settings.provider.gateway = {
      type: 'openai',
      apiKey: 'settings-secret-two',
      models: {},
    };

    const first = createRunAmbientSnapshot(firstConfig, registry, { capturedAt: 1 });
    const second = createRunAmbientSnapshot(secondConfig, registry, { capturedAt: 1 });
    const serialized = JSON.stringify(first);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(serialized).not.toContain('first-secret');
    expect(serialized).not.toContain('settings-secret-one');
    expect(first).toMatchObject({
      schemaVersion: 1,
      completeness: 'partial',
      bookHome: { isolation: 'shared' },
      missingSources: expect.arrayContaining([
        'book_home_isolation',
        'command_registry',
        'skill_registry',
        'mcp_registry',
        'random_seed',
      ]),
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.tools.names)).toBe(true);
  });

  it('attributes an explicit BOOK_HOME without claiming content isolation', () => {
    const registry = createRegistry();
    vi.stubEnv('BOOK_HOME', './isolated-book-home');

    const snapshot = createRunAmbientSnapshot(defaultConfig(), registry, { capturedAt: 1 });

    expect(snapshot.bookHome.isolation).toBe('configured');
    expect(snapshot.missingSources).toContain('book_home_isolation');
    expect(snapshot.completeness).toBe('partial');
  });
});
