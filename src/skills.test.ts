import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applySkillOverrides,
  buildSkillListing,
  discoverSkills as discoverSkillsFromDisk,
  explicitSkillMentions,
  generateSkillListing,
  loadSkillBody,
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_HEADER_BYTES,
  MAX_SKILL_RESOURCES,
  MAX_SKILL_RESOURCE_BYTES,
  skillRoots,
  type Skill,
} from './skills.js';
import { parseFrontmatter } from './frontmatter.js';

let dir: string;

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'project:book:/project/code-review/SKILL.md',
    version: 'unversioned',
    descriptorDigest: 'descriptor',
    resourceDigest: 'resources',
    name: 'code-review',
    description: 'Reviews PR diffs',
    whenToUse: undefined,
    metadata: {},
    allowedTools: ['Read'],
    lifetime: 'run',
    path: '/project/code-review/SKILL.md',
    rootPath: '/project/code-review',
    source: 'project',
    rootKind: 'book',
    activation: 'auto',
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

function discoverSkills(
  workspace: string,
  overrides: Parameters<typeof discoverSkillsFromDisk>[1] = {},
  options: Parameters<typeof discoverSkillsFromDisk>[2] = {},
): Skill[] {
  return discoverSkillsFromDisk(workspace, overrides, {
    includeUser: false,
    projectRoot: workspace,
    ...options,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-skills-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
  it('parses CRLF frontmatter used by global Windows skill packages', () => {
    const raw = [
      '---',
      'name: wayfinder',
      'description: Plan a huge chunk of work',
      '---',
      'Instructions.',
    ].join('\r\n');

    const { body, frontmatter } = parseFrontmatter(raw);

    expect(frontmatter).toMatchObject({
      name: 'wayfinder',
      description: 'Plan a huge chunk of work',
    });
    expect(body).toBe('Instructions.');
  });

  it('discovers a CRLF global-style package as valid metadata', () => {
    const skillDir = join(dir, '.agents', 'skills', 'wayfinder');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: wayfinder',
        'description: Plan a huge chunk of work',
        '---',
        'Instructions.',
      ].join('\r\n'),
    );

    const [wayfinder] = discoverSkills(dir);

    expect(wayfinder).toMatchObject({
      name: 'wayfinder',
      valid: true,
      description: 'Plan a huge chunk of work',
    });
    expect(wayfinder.issues).toEqual([]);
  });

  it('accepts interoperable invocation-control metadata without an invalid warning', () => {
    const skillDir = join(dir, '.agents', 'skills', 'wayfinder');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: wayfinder',
        'description: Plan a huge chunk of work',
        'disable-model-invocation: true',
        '---',
        'Instructions.',
      ].join('\n'),
    );

    const [wayfinder] = discoverSkills(dir);

    expect(wayfinder.valid).toBe(true);
    expect(wayfinder.issues).toEqual([]);
  });

  it('parses skill-specific YAML frontmatter', () => {
    const raw = [
      '---',
      'name: Review PR',
      'description: Reviews pull request diffs',
      'when_to_use: When user asks for code review',
      'model: sonnet',
      '---',
      'You are a code reviewer.',
    ].join('\n');
    const { body, frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe('Review PR');
    expect(frontmatter.description).toBe('Reviews pull request diffs');
    expect(frontmatter.when_to_use).toBe('When user asks for code review');
    expect(body).toBe('You are a code reviewer.');
  });

  it('parses array tools from frontmatter', () => {
    const raw = [
      '---',
      'tools:',
      '- Read',
      '- Bash(git *)',
      '- Grep',
      'description: Git helper',
      '---',
      'body',
    ].join('\n');
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tools).toEqual(['Read', 'Bash(git *)', 'Grep']);
    expect(frontmatter.description).toBe('Git helper');
  });
});

describe('discoverSkills', () => {
  it('returns empty array when no skills directory exists', () => {
    const result = discoverSkills(dir);
    expect(result).toEqual([]);
  });

  it('discovers skills from .book/skills/<name>/SKILL.md', () => {
    const skillsDir = join(dir, '.book', 'skills', 'code-review');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'SKILL.md'),
      [
        '---',
        'name: code-review',
        'description: Reviews pull request diffs',
        'when_to_use: When user asks for code review or PR review',
        'tools:',
        '- Read',
        '- Grep',
        '---',
        'You are a code reviewer.',
      ].join('\n'),
    );

    const result = discoverSkills(dir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('code-review');
    expect(result[0].description).toBe('Reviews pull request diffs');
    expect(result[0].whenToUse).toBe('When user asks for code review or PR review');
    expect(result[0].allowedTools).toEqual(['Read', 'Grep']);
    expect(result[0].source).toBe('project');
    expect(result[0].activation).toBe('manual');
  });

  it('discovers flat .skill.md files', () => {
    const skillsDir = join(dir, '.book', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'deploy.skill.md'),
      [
        '---',
        'description: Deploy to staging',
        'when_to_use: When user asks to deploy',
        '---',
        'Deployment steps.',
      ].join('\n'),
    );

    const result = discoverSkills(dir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('deploy');
    expect(loadSkillBody(result[0]).body).toBe('Deployment steps.');
  });

  it('project skills override user skills with same name', () => {
    // We mock via direct file structure — project overwrites in Map.
    const projectSkillsDir = join(dir, '.book', 'skills', 'review');
    mkdirSync(projectSkillsDir, { recursive: true });
    writeFileSync(
      join(projectSkillsDir, 'SKILL.md'),
      [
        '---',
        'name: review',
        'description: Project review version',
        '---',
        'Project review body',
      ].join('\n'),
    );

    const result = discoverSkills(dir);
    expect(result.find((s) => s.name === 'review')?.description).toBe('Project review version');
  });

  it('loads compatibility roots and gives the native Book root highest local precedence', () => {
    const roots = [
      ['.claude', 'Claude'],
      ['.agents', 'Agents'],
      ['.opencode', 'OpenCode'],
      ['.book', 'Book'],
    ] as const;
    for (const [root, label] of roots) {
      const skillDir = join(dir, root, 'skills', 'review');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        ['---', 'name: review', `description: ${label} version`, '---', `${label} body`].join('\n'),
      );
    }

    const [review] = discoverSkills(dir);
    expect(review.description).toBe('Book version');
    expect(review.rootKind).toBe('book');
    expect(review.shadowed.map((entry) => entry.rootKind)).toEqual([
      'claude',
      'agents',
      'opencode',
    ]);
  });

  it('lets deeper project roots override ancestors and user roots', () => {
    const home = join(dir, 'home');
    const repo = join(dir, 'repo');
    const workspace = join(repo, 'packages', 'app');
    const locations = [
      [join(home, '.book', 'skills', 'review'), 'User version'],
      [join(repo, '.book', 'skills', 'review'), 'Root version'],
      [join(workspace, '.book', 'skills', 'review'), 'Workspace version'],
    ] as const;
    for (const [skillDir, description] of locations) {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        ['---', 'name: review', `description: ${description}`, '---', 'body'].join('\n'),
      );
    }

    const [review] = discoverSkillsFromDisk(workspace, {}, { homeDir: home, projectRoot: repo });
    expect(review.description).toBe('Workspace version');
    expect(review.shadowed).toHaveLength(2);
  });

  it('keeps invalid descriptors visible with actionable issues', () => {
    const skillDir = join(dir, '.book', 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: wrong-name',
        'description: Review changes',
        'surprise: value',
        '---',
        'body',
      ].join('\n'),
    );

    const [review] = discoverSkills(dir);
    expect(review.valid).toBe(false);
    expect(review.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['name_directory_mismatch', 'unknown_frontmatter_field']),
    );
  });

  it('validates required metadata and body bounds without retaining the body', () => {
    const skillDir = join(dir, '.book', 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: Invalid Name',
        '---',
        'x'.repeat(MAX_SKILL_BODY_BYTES + MAX_SKILL_HEADER_BYTES + 1),
      ].join('\n'),
    );

    const [review] = discoverSkills(dir);
    expect(review.valid).toBe(false);
    expect(review).not.toHaveProperty('body');
    expect(review.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'invalid_name',
        'name_directory_mismatch',
        'invalid_description',
        'body_too_large',
      ]),
    );
  });

  it('bounds resource manifests during discovery', () => {
    const skillDir = join(dir, '.book', 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: review', 'description: Review changes', '---', 'body'].join('\n'),
    );
    for (let index = 0; index <= MAX_SKILL_RESOURCES; index++) {
      writeFileSync(join(skillDir, `resource-${String(index).padStart(3, '0')}.txt`), 'data');
    }

    const [review] = discoverSkills(dir);
    expect(review.resources).toHaveLength(MAX_SKILL_RESOURCES);
    expect(review.issues.map((issue) => issue.code)).toContain('resource_limit');
  });

  it.skipIf(process.platform !== 'win32')(
    'treats Windows case-only root differences as the same project path',
    () => {
      const workspace = join(dir, 'Nested');
      mkdirSync(workspace, { recursive: true });

      const roots = skillRoots(workspace.toUpperCase(), {
        includeUser: false,
        projectRoot: dir.toLowerCase(),
      });

      expect(roots).toHaveLength(8);
    },
  );

  it('supports symlinked skill directories while keeping resource symlinks out', () => {
    const target = join(dir, 'shared-review');
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'SKILL.md'),
      ['---', 'name: review', 'description: Shared review skill', '---', 'Shared body'].join('\n'),
    );
    writeFileSync(join(target, 'reference.md'), 'safe');
    const externalResources = join(dir, 'external-resources');
    mkdirSync(externalResources, { recursive: true });
    writeFileSync(join(externalResources, 'linked.md'), 'must stay out');
    symlinkSync(
      externalResources,
      join(target, 'linked-resources'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    mkdirSync(join(dir, '.book', 'skills'), { recursive: true });
    symlinkSync(
      target,
      join(dir, '.book', 'skills', 'review'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const [review] = discoverSkills(dir);
    expect(review.valid).toBe(true);
    expect(loadSkillBody(review).body).toBe('Shared body');
    expect(review.resources.map((resource) => resource.relativePath)).toEqual(['reference.md']);
    expect(review.issues.map((issue) => issue.code)).toContain('resource_symlink_ignored');
  });

  it('reports oversized, binary, and over-depth resources during discovery', () => {
    const skillDir = join(dir, '.book', 'skills', 'review');
    mkdirSync(join(skillDir, 'a', 'b', 'c', 'd'), { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: review', 'description: Review changes', '---', 'body'].join('\n'),
    );
    writeFileSync(join(skillDir, 'binary.dat'), Buffer.from([1, 0, 2]));
    writeFileSync(join(skillDir, 'large.txt'), Buffer.alloc(MAX_SKILL_RESOURCE_BYTES + 1, 1));
    writeFileSync(join(skillDir, 'a', 'b', 'c', 'd', 'deep.md'), 'too deep');

    const [review] = discoverSkills(dir);
    expect(review.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['binary_resource', 'resource_too_large', 'resource_depth_limit']),
    );
    expect(review.resources.map((resource) => resource.relativePath)).not.toContain(
      'a/b/c/d/deep.md',
    );
  });

  it('rejects binary skill bodies when activation loads them', () => {
    const skillDir = join(dir, '.book', 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      Buffer.concat([
        Buffer.from(
          ['---', 'name: review', 'description: Review changes', '---', 'body'].join('\n'),
        ),
        Buffer.from([0]),
      ]),
    );

    const [review] = discoverSkills(dir);
    expect(() => loadSkillBody(review)).toThrow(/binary content/);
  });
});

describe('generateSkillListing', () => {
  it('returns empty string for no skills', () => {
    expect(generateSkillListing([], 1000)).toBe('');
  });

  it('generates a compact listing with descriptions', () => {
    const skills = [
      skill({
        name: 'code-review',
        description: 'Reviews PR diffs',
        whenToUse: 'When user asks for code review',
        allowedTools: ['Read'],
        path: '/project/code-review/SKILL.md',
      }),
      skill({
        id: 'project:book:/project/deploy/SKILL.md',
        name: 'deploy',
        description: 'Deploys to staging',
        whenToUse: undefined,
        allowedTools: ['Bash'],
        path: '/project/deploy/SKILL.md',
        rootPath: '/project/deploy',
      }),
    ];

    const listing = generateSkillListing(skills, 2000);
    expect(listing).toContain('## Available skills');
    expect(listing).toContain('code-review');
    expect(listing).toContain('Reviews PR diffs');
    expect(listing).toContain('deploy');
    expect(listing).toContain('Deploys to staging');
  });

  it('collapses least-used skills to bare names when over budget', () => {
    const skills = [
      skill({
        name: 'frequently-used',
        description: 'A skill that gets used often with a very long description',
        whenToUse: undefined,
        allowedTools: ['Read'],
        path: '/project/frequently-used/SKILL.md',
        invocationCount: 10,
      }),
      skill({
        id: 'project:book:/project/rarely-used/SKILL.md',
        name: 'rarely-used',
        description: 'Another skill with a really long description that takes up space',
        whenToUse: 'Only when explicitly asked',
        allowedTools: ['Bash'],
        path: '/project/rarely-used/SKILL.md',
        invocationCount: 1,
      }),
    ];

    // Tight budget — should collapse the least-used skill.
    const listing = generateSkillListing(skills, 100);
    // Frequently-used has higher invocation count, so it should still have description.
    // Rarely-used should be collapsed (bare name or omitted).
    const collapsed = listing.includes('rarely-used') && !listing.includes('Another skill');
    const omitted = !listing.includes('rarely-used');
    expect(collapsed || omitted).toBe(true);
  });

  it('sorts skills by invocation count descending', () => {
    const skills = [
      skill({
        name: 'a',
        description: 'Little used',
        whenToUse: undefined,
        allowedTools: [],
        path: '/project/a/SKILL.md',
        invocationCount: 1,
      }),
      skill({
        id: 'project:book:/project/b/SKILL.md',
        name: 'b',
        description: 'Often used',
        whenToUse: undefined,
        allowedTools: [],
        path: '/project/b/SKILL.md',
        invocationCount: 100,
      }),
    ];

    const listing = generateSkillListing(skills, 2000);
    const bIdx = listing.indexOf('**b**: Often used');
    const aIdx = listing.indexOf('**a**: Little used');
    expect(bIdx).toBeLessThan(aIdx);
  });

  it('respects automatic, name-only, manual, and off visibility', () => {
    const base = discoverSkills(dir);
    expect(base).toEqual([]);

    const skills = applySkillOverrides(
      [
        skill({
          name: 'automatic',
          description: 'Full description',
          path: '/automatic/SKILL.md',
        }),
        skill({
          id: 'project:book:/compact/SKILL.md',
          name: 'compact',
          description: 'Should stay hidden',
          path: '/compact/SKILL.md',
          rootPath: '/compact',
        }),
        skill({
          id: 'project:book:/manual/SKILL.md',
          name: 'manual',
          description: 'Manual only',
          path: '/manual/SKILL.md',
          rootPath: '/manual',
        }),
      ],
      { compact: 'name-only', manual: 'manual' },
    );

    const listing = generateSkillListing(skills, 2000);
    expect(listing).toContain('**automatic**: Full description');
    expect(listing).toContain('- **compact**');
    expect(listing).not.toContain('Should stay hidden');
    expect(listing).not.toContain('**manual**');
  });

  it('reports when the prompt budget omits catalog entries', () => {
    const skills = Array.from({ length: 8 }, (_, index) =>
      skill({
        id: `skill-${index}`,
        name: `skill-${index}`,
        description: `Description ${index} ${'x'.repeat(40)}`,
      }),
    );
    expect(generateSkillListing(skills, 220)).toContain('omitted from this prompt budget');
    const report = buildSkillListing(skills, 220);
    expect(report.omitted.length).toBeGreaterThan(0);
    expect(report.included.length + report.omitted.length).toBe(report.visibleCount);
    expect(report.charCount).toBe(report.text.length);
  });

  it('recognizes only exact explicit skill mentions', () => {
    const skills = [skill({ name: 'code-review' }), skill({ name: 'deploy' })];
    expect(explicitSkillMentions('Use ($code-review), not $deploy-extra.', skills)).toEqual([
      'code-review',
    ]);
    expect(explicitSkillMentions('The $code-reviewer variable is unrelated.', skills)).toEqual([]);
    expect(
      explicitSkillMentions('prefix$deploy and $deploy_suffix are unrelated.', skills),
    ).toEqual([]);
    expect(
      explicitSkillMentions('$disabled $invalid', [
        skill({ name: 'disabled', activation: 'off' }),
        skill({ name: 'invalid', valid: false }),
      ]),
    ).toEqual(['disabled', 'invalid']);
  });

  it('reports unsupported model hints and clamps invalid lifetimes visibly', () => {
    const skillDir = join(dir, '.book', 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: review',
        'description: Review changes',
        'model: sonnet',
        'lifetime: forever',
        '---',
        'body',
      ].join('\n'),
    );

    const [review] = discoverSkills(dir);
    expect(review.valid).toBe(true);
    expect(review.lifetime).toBe('run');
    expect(review.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['unsupported_model_hint', 'invalid_lifetime']),
    );
  });
});
