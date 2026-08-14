import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import type { ManagedAgentDef } from './profiles.js';
import { collectAgentDiagnostics } from './diagnostics.js';

function profile(overrides: Partial<ManagedAgentDef> = {}): ManagedAgentDef {
  return {
    name: 'custom',
    description: 'Custom',
    role: 'custom',
    isolation: 'workspace-readonly',
    allowedTools: ['Read'],
    body: 'Custom',
    source: 'project',
    ...overrides,
  };
}

describe('collectAgentDiagnostics', () => {
  it('reports unsafe, unknown, duplicate, stale, and invalid profile settings', () => {
    const config = defaultConfig();
    config.settings.provider.gateway = {
      type: 'openai',
      models: { valid: {} },
    };
    config.settings.agents.profiles.custom = { model: 'inherit' };
    config.settings.agents.profiles.missing = { model: 'gateway/absent' };
    const diagnostics = collectAgentDiagnostics(config, [
      profile({ allowedTools: ['Read', 'Write'], unknownTools: ['Mystery'] }),
      profile(),
    ]);

    expect(diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'duplicate-profile',
        'invalid-model',
        'missing-profile',
        'readonly-mutation',
        'unknown-tool',
      ]),
    );
  });

  it('reports a definition suppressed by a reserved built-in', () => {
    const diagnostics = collectAgentDiagnostics(defaultConfig(), [
      profile({
        name: 'reviewer',
        role: 'reviewer',
        source: 'builtin',
        suppressedOverride: 'project',
      }),
    ]);
    const reserved = diagnostics.find((item) => item.code === 'reserved-profile');
    expect(reserved?.message).toContain('reviewer is a reserved built-in agent');
    expect(reserved?.message).toContain('project definition');
    expect(reserved?.message).toContain('agents.profiles.reviewer');
  });

  it('stays quiet when no reserved profile was overridden', () => {
    const diagnostics = collectAgentDiagnostics(defaultConfig(), [
      profile({ name: 'reviewer', role: 'reviewer', source: 'builtin' }),
    ]);
    expect(diagnostics.some((item) => item.code === 'reserved-profile')).toBe(false);
  });
});
