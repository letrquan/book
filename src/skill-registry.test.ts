import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SkillSettings } from './settings.js';
import { SkillRegistry, SkillRegistryError } from './skill-registry.js';

let workspace: string;

function settings(overrides: Partial<SkillSettings> = {}): SkillSettings {
  return {
    enabled: true,
    overrides: {},
    execution: {},
    ...overrides,
  };
}

function writeSkill(
  name: string,
  options: {
    body?: string;
    frontmatter?: string[];
    resources?: Record<string, string>;
  } = {},
): string {
  const root = join(workspace, '.book', 'skills', name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: Use the ${name} workflow`,
      ...(options.frontmatter ?? []),
      '---',
      options.body ?? `Follow the ${name} procedure.`,
    ].join('\n'),
  );
  for (const [path, content] of Object.entries(options.resources ?? {})) {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function registry(skillSettings = settings()): SkillRegistry {
  return new SkillRegistry(workspace, skillSettings, {
    includeUser: false,
    projectRoot: workspace,
  });
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-skill-registry-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('SkillRegistry', () => {
  it('keeps bodies lazy and injects them only through an activation frame', () => {
    writeSkill('review', { body: 'Review carefully.' });
    const skills = registry();
    const descriptor = skills.list()[0];

    expect(descriptor).not.toHaveProperty('body');
    skills.beginRun('$review');
    skills.grantConsent('review');
    const frame = skills.activate('review', 'user', 0);
    expect(frame.body).toBe('Review carefully.');
    expect(frame.descriptorDigest).toBe(descriptor.descriptorDigest);
    expect(skills.renderActivePolicy(1)).toContain('--- BEGIN SKILL INSTRUCTIONS ---');
    expect(skills.inspect(1).active[0]).not.toHaveProperty('body');
  });

  it('requires an explicit mention for manual skills', () => {
    writeSkill('review');
    const skills = registry(settings({ overrides: { review: 'manual' } }));
    skills.beginRun('review this change');

    expect(() => skills.activate('review', 'model', 0)).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'skill_explicit_only' }),
    );

    skills.beginRun('$review this change');
    skills.grantConsent('review');
    expect(skills.activate('review', 'user', 0).reason).toBe('user');
  });

  it('applies the global disable switch as a hard ceiling', () => {
    writeSkill('review');
    const skills = registry(settings({ enabled: false }));

    expect(skills.list()[0].activation).toBe('off');
    expect(skills.beginRun('$review')).toEqual([]);
    expect(() => skills.activate('review', 'user', 0)).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'skill_disabled' }),
    );
  });

  it('reloads the effective catalog when the global switch changes live', () => {
    writeSkill('review');
    const skills = registry();
    expect(skills.get('review')?.activation).toBe('manual');

    skills.updateSettings(settings({ enabled: false }));
    expect(skills.get('review')?.activation).toBe('off');
    expect(() => skills.activate('review', 'user', 0)).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'skill_disabled' }),
    );
  });

  it('enforces execution denial before reading the body', () => {
    writeSkill('review');
    const skills = registry(
      settings({ overrides: { review: 'auto' }, execution: { review: 'deny' } }),
    );
    expect(() => skills.activate('review', 'model', 0)).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'skill_execution_denied' }),
    );
  });

  it('requires host consent for project-sourced instructions', () => {
    writeSkill('review');
    const skills = registry(settings({ overrides: { review: 'auto' } }));
    expect(skills.activationPolicy('review', 'model')).toBe('ask');
    expect(skills.activationPolicy('review', 'user')).toBe('allow');
    expect(() => skills.activate('review', 'model', 0)).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'skill_consent_required' }),
    );
    skills.grantConsent('review');
    expect(skills.activate('review', 'model', 0).skillName).toBe('review');
    expect(skills.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'skill_consent_requested',
        'skill_consent_granted',
        'skill_activation_applied',
      ]),
    );
  });

  it('reports prompt omissions, effective tools, reloads, and redacted policy evidence', () => {
    for (let index = 0; index < 12; index++) {
      writeSkill(`review-${index}`, {
        body: `Body ${index}`,
        frontmatter: [`when_to_use: ${'x'.repeat(80)}`],
      });
    }
    const skills = registry(
      settings({
        overrides: Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => [`review-${index}`, 'auto'] as const),
        ),
      }),
    );
    skills.recordPromptCatalog(1_000);
    skills.recordEffectiveTools(['Read', 'InvokeSkill', 'Read']);

    const snapshot = skills.inspect();
    expect(snapshot.promptCatalog?.omitted.length).toBeGreaterThan(0);
    expect(snapshot.promptCatalog).not.toHaveProperty('text');
    expect(snapshot.effectiveTools).toEqual(['InvokeSkill', 'Read']);
    expect(snapshot.events.some((event) => event.type === 'skill_reloaded')).toBe(true);
    expect(
      snapshot.events.find((event) => event.type === 'skill_discovered')?.details,
    ).toMatchObject({
      requestedActivation: 'auto',
      effectiveActivation: 'auto',
      requestedExecution: 'inherit',
      effectiveExecution: 'inherit',
    });
  });

  it('expires turn-scoped frames after the next model step', () => {
    writeSkill('review', { frontmatter: ['lifetime: turn'] });
    const skills = registry(settings({ overrides: { review: 'auto' } }));
    skills.grantConsent('review');
    skills.activate('review', 'model', 0);

    expect(skills.activeFrames(1)).toHaveLength(1);
    expect(skills.activeFrames(2)).toHaveLength(0);
    expect(skills.previousFrames()).toHaveLength(1);
    expect(skills.events.at(-1)?.type).toBe('skill_activation_expired');
  });

  it('reads only declared unchanged text resources from active skills', () => {
    const root = writeSkill('review', {
      resources: { 'references/checklist.md': 'Check every edge case.' },
    });
    const skills = registry();
    skills.activate('review', 'user', 0);

    expect(skills.readResource('review', 'references/checklist.md').content).toContain(
      'every edge case',
    );
    expect(() => skills.readResource('review', '../secret.txt')).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'skill_resource_not_found' }),
    );

    writeFileSync(
      join(root, 'references', 'checklist.md'),
      'Changed after discovery with more text.',
    );
    expect(() => skills.readResource('review', 'references/checklist.md')).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'skill_resource_changed' }),
    );
  });

  it('detects same-size resource substitution even when timestamps are restored', () => {
    const root = writeSkill('review', {
      resources: { 'references/checklist.md': 'original-content' },
    });
    const skills = registry();
    const declared = skills.get('review')!.resources[0];
    skills.activate('review', 'user', 0);
    const path = join(root, 'references', 'checklist.md');
    writeFileSync(path, 'replaced-content');
    const timestamp = new Date(declared.mtimeMs);
    utimesSync(path, timestamp, timestamp);

    expect(() => skills.readResource('review', 'references/checklist.md')).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'skill_resource_changed' }),
    );
  });

  it('rejects a declared resource replaced through a symlinked directory', () => {
    const root = writeSkill('review', {
      resources: { 'references/checklist.md': 'original-content' },
    });
    const skills = registry();
    skills.activate('review', 'user', 0);
    const replacement = join(workspace, 'replacement-references');
    mkdirSync(replacement, { recursive: true });
    writeFileSync(join(replacement, 'checklist.md'), 'original-content');
    rmSync(join(root, 'references'), { recursive: true, force: true });
    symlinkSync(
      replacement,
      join(root, 'references'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() => skills.readResource('review', 'references/checklist.md')).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'resource_escape' }),
    );
  });

  it('fails closed when the body disappears after discovery', () => {
    const root = writeSkill('review', { body: 'Review carefully.' });
    const skills = registry();
    unlinkSync(join(root, 'SKILL.md'));

    expect(() => skills.activate('review', 'user', 0)).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'skill_load_failed' }),
    );
    expect(skills.activeFrames()).toHaveLength(0);
  });

  it('fails closed when a declared resource is deleted after discovery', () => {
    const root = writeSkill('review', {
      resources: { 'references/checklist.md': 'Check every edge case.' },
    });
    const skills = registry();
    skills.grantConsent('review');
    skills.activate('review', 'user', 0);
    unlinkSync(join(root, 'references', 'checklist.md'));

    expect(() => skills.readResource('review', 'references/checklist.md')).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({ code: 'skill_resource_unreadable' }),
    );
  });

  it('expires active frames and refreshes digests on reload', () => {
    const root = writeSkill('review', { body: 'First body.' });
    const skills = registry();
    const before = skills.catalogDigest();
    skills.activate('review', 'user', 0);

    writeFileSync(
      join(root, 'SKILL.md'),
      ['---', 'name: review', 'description: Updated review workflow', '---', 'Second body.'].join(
        '\n',
      ),
    );
    skills.reload();

    expect(skills.activeFrames()).toHaveLength(0);
    expect(skills.previousFrames()).toHaveLength(1);
    expect(skills.catalogDigest()).not.toBe(before);
    expect(skills.list()[0].description).toBe('Updated review workflow');
  });

  it('bounds previous activation frame history and keeps inspection body-free', () => {
    writeSkill('review');
    const skills = registry();
    for (let index = 0; index < 120; index++) {
      skills.beginRun('$review');
      skills.activate('review', 'user', index);
      skills.endRun();
    }

    expect(skills.previousFrames()).toHaveLength(100);
    expect(skills.inspect().previous).toHaveLength(100);
    expect(skills.inspect().previous[0]).not.toHaveProperty('body');
  });
});
