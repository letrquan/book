import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { BUILTIN_AGENTS } from './profiles.js';
import { resolveAgentProfile } from './profile-resolver.js';

describe('resolveAgentProfile', () => {
  it('uses invocation, profile, definition, then parent model precedence', () => {
    const config = defaultConfig({ model: 'parent-model' });
    config.modelSelection = 'parent-selection';
    config.settings.agents.profiles.explorer = { model: 'profile-model' };
    const definition = { ...BUILTIN_AGENTS[0], model: 'definition-model' };

    expect(resolveAgentProfile(definition, config).resolvedModel).toBe('profile-model');
    expect(resolveAgentProfile(definition, config, 'invocation-model').resolvedModel).toBe(
      'invocation-model',
    );
    config.settings.agents.profiles.explorer = { model: 'inherit' };
    expect(resolveAgentProfile(definition, config).resolvedModel).toBe('parent-selection');
    config.settings.agents.profiles.explorer = {};
    expect(resolveAgentProfile({ ...definition, model: undefined }, config).resolvedModel).toBe(
      'parent-selection',
    );
  });

  it('does not count a level its config merely sends as chosen (#245)', () => {
    const explorer = BUILTIN_AGENTS[0];
    // A managed child's own config: `high` is sent because its catalog lists it, not chosen.
    const child = defaultConfig({ effort: 'high', effortExplicit: true, effortChosen: false });
    expect(resolveAgentProfile(explorer, child)).toMatchObject({
      effort: 'high',
      effortExplicit: false,
    });
    const session = defaultConfig({ effort: 'high', effortExplicit: true });
    expect(resolveAgentProfile(explorer, session).effortExplicit).toBe(true);
  });

  it('leaves explorer turns unlimited by default and preserves explicit limits', () => {
    const config = defaultConfig({ maxTurns: undefined });
    const explorer = BUILTIN_AGENTS[0];

    expect(resolveAgentProfile(explorer, config).maxTurns).toBeUndefined();

    config.maxTurns = 9;
    expect(resolveAgentProfile(explorer, config).maxTurns).toBe(9);

    const definition = { ...explorer, maxTurns: 8 };
    expect(resolveAgentProfile(definition, config).maxTurns).toBe(8);

    config.settings.agents.profiles.explorer = { maxTurns: 7 };
    expect(resolveAgentProfile(definition, config).maxTurns).toBe(7);
  });

  it('uses valid profile effort and ignores invalid definition values', () => {
    const config = defaultConfig({ effort: 'high' });
    const explorer = BUILTIN_AGENTS[0];
    config.settings.agents.profiles.explorer = { effort: 'low' };
    expect(resolveAgentProfile(explorer, config).effort).toBe('low');

    config.settings.agents.profiles.explorer = {};
    expect(resolveAgentProfile({ ...explorer, effort: 'unsupported' }, config).effort).toBe('high');
  });

  it('says whether a level was chosen for the agent rather than defaulted (#245)', () => {
    const config = defaultConfig({ effort: 'high', effortExplicit: false });
    const explorer = BUILTIN_AGENTS[0];
    expect(resolveAgentProfile(explorer, config).effortExplicit).toBe(false);
    expect(resolveAgentProfile({ ...explorer, effort: 'low' }, config).effortExplicit).toBe(true);

    config.settings.agents.profiles.explorer = { effort: 'medium' };
    expect(resolveAgentProfile(explorer, config).effortExplicit).toBe(true);

    config.settings.agents.profiles.explorer = {};
    expect(resolveAgentProfile(explorer, { ...config, effortExplicit: true }).effortExplicit).toBe(
      true,
    );
  });
});
