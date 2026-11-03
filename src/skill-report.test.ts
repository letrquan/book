import { describe, expect, it } from 'vitest';
import { buildSkillReport } from './skill-report.js';

describe('buildSkillReport', () => {
  it('renders redacted catalog, prompt, tool, validation, and lifecycle evidence', () => {
    const report = buildSkillReport({
      catalogDigest: 'catalog',
      skills: [
        {
          id: 'skill',
          version: '1',
          descriptorDigest: 'descriptor',
          resourceDigest: 'resource',
          name: 'review',
          description: 'Review changes',
          metadata: {},
          lifetime: 'run',
          path: '/skills/review/SKILL.md',
          rootPath: '/skills/review',
          source: 'project',
          rootKind: 'book',
          activation: 'auto',
          execution: 'inherit',
          invocationCount: 0,
          entryByteSize: 10,
          entryMtimeMs: 1,
          resources: [],
          issues: [{ code: 'bad', message: 'Broken', severity: 'error' }],
          valid: false,
          shadowed: [],
        },
      ],
      active: [
        {
          skillId: 'active-skill',
          skillName: 'active-review',
          version: '1',
          descriptorDigest: 'active-descriptor',
          resourceDigest: 'active-resource',
          reason: 'model',
          bodyDigest: 'active-body-digest',
          bodyByteSize: 20,
          activatedAt: 1,
          activatedAtTurn: 1,
          expires: 'run',
          source: 'user',
          rootKind: 'agents',
          path: '/skills/active-review/SKILL.md',
          resources: [],
        },
      ],
      previous: [
        {
          skillId: 'previous-skill',
          skillName: 'previous-review',
          version: '1',
          descriptorDigest: 'previous-descriptor',
          resourceDigest: 'previous-resource',
          reason: 'user',
          bodyDigest: 'previous-body-digest',
          bodyByteSize: 20,
          activatedAt: 1,
          activatedAtTurn: 1,
          expires: 'turn',
          expiresAtTurn: 2,
          source: 'project',
          rootKind: 'book',
          path: '/skills/previous-review/SKILL.md',
          resources: [],
        },
      ],
      effectiveTools: ['Read'],
      promptCatalog: {
        budgetChars: 100,
        visibleCount: 2,
        included: ['review'],
        omitted: ['deploy'],
        collapsed: [],
        charCount: 80,
      },
      events: [
        {
          type: 'skill_activation_blocked',
          timestamp: 1,
          skill: 'review',
          details: { code: 'bad' },
        },
      ],
    });

    expect(report).toContain('Catalog: catalog');
    expect(report).toContain('Omitted: deploy');
    expect(report).toContain('Read');
    expect(report).toContain('Active frames');
    expect(report).toContain('active-review: model');
    expect(report).toContain('Previous frames');
    expect(report).toContain('previous-review: user');
    expect(report).toContain('bad: Broken');
    expect(report).toContain('skill_activation_blocked: review (bad)');
    expect(report).not.toContain('SKILL INSTRUCTIONS');
  });
});
