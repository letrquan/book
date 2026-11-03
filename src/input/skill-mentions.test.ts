import { describe, expect, it } from 'vitest';
import type { Skill } from '../skills.js';
import {
  findActiveSkillMention,
  getSkillMentionCandidates,
  replaceActiveSkillMention,
} from './skill-mentions.js';

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'agents:/skills/wayfinder/SKILL.md',
    version: 'unversioned',
    descriptorDigest: 'descriptor',
    resourceDigest: 'resources',
    name: 'wayfinder',
    description: 'Plan a huge chunk of work',
    metadata: {},
    lifetime: 'run',
    path: '/skills/wayfinder/SKILL.md',
    rootPath: '/skills/wayfinder',
    source: 'user',
    rootKind: 'agents',
    activation: 'manual',
    execution: 'inherit',
    invocationCount: 0,
    entryByteSize: 0,
    entryMtimeMs: 0,
    resources: [],
    issues: [],
    valid: true,
    shadowed: [],
    ...overrides,
  };
}

describe('skill mention autocomplete', () => {
  it('finds an active mention at prompt boundaries', () => {
    expect(findActiveSkillMention('$way')).toEqual({ start: 0, end: 4, query: 'way' });
    expect(findActiveSkillMention('please use $way')).toEqual({ start: 11, end: 15, query: 'way' });
    expect(findActiveSkillMention('price$way')).toBeNull();
    expect(findActiveSkillMention('$way now')).toBeNull();
  });

  it('ranks valid explicitly invocable skills and omits blocked entries', () => {
    const candidates = getSkillMentionCandidates(
      [
        skill(),
        skill({ name: 'other-way', description: 'Another workflow' }),
        skill({ name: 'invalid-way', valid: false }),
        skill({ name: 'off-way', activation: 'off' }),
        skill({ name: 'denied-way', execution: 'deny' }),
      ],
      'way',
    );

    expect(candidates.map((candidate) => candidate.name)).toEqual(['wayfinder', 'other-way']);
  });

  it('replaces only the active mention and leaves a trailing space', () => {
    const input = 'please use $way';
    const mention = findActiveSkillMention(input);
    expect(mention).not.toBeNull();
    expect(replaceActiveSkillMention(input, mention!, 'wayfinder')).toBe('please use $wayfinder ');
  });
});
