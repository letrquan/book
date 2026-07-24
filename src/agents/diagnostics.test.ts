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
        'literal-inherit',
        'missing-profile',
        'readonly-mutation',
        'unknown-tool',
      ]),
    );
  });
});
