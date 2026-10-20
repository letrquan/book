import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
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

  // #429. A workspace at `$HOME` walks the user's own roots again as project roots, and a
  // project skill asks before the model may run it.
  it('keeps the user roots user-scoped for a workspace at the home directory', () => {
    const roots = skillRoots(dir, { homeDir: dir, projectRoot: dir });
    const at = (path: string) => roots.filter((root) => root.path === path);

    for (const path of [
      join(dir, '.claude', 'skills'),
      join(dir, '.agents', 'skills'),
      join(dir, '.book', 'skills'),
    ]) {
      expect(at(path).map((root) => root.source)).toEqual(['user']);
    }
    // The one project-only root at that directory is still a project root.
    expect(at(join(dir, '.opencode', 'skills')).map((root) => root.source)).toEqual(['project']);
  });

  describe('a home directory reached through a link (#449)', () => {
    let realHome: string;
    let linkedHome: string;

    function writeDemoSkill(root: string): string {
      const skillDir = join(root, '.claude', 'skills', 'demo');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        ['---', 'name: demo', 'description: Demo skill', '---', 'body'].join('\n'),
      );
      return join(skillDir, 'SKILL.md');
    }

    beforeEach(() => {
      realHome = join(dir, 'realhome');
      linkedHome = join(dir, 'linkhome');
      mkdirSync(realHome, { recursive: true });
      symlinkSync(realHome, linkedHome, 'junction');
    });

    it('counts the user roots once, as user roots, when the workspace is given by its real path', () => {
      writeDemoSkill(realHome);
      const options = {
        homeDir: linkedHome,
        bookHomeDir: join(linkedHome, '.book'),
        projectRoot: realHome,
      };

      const claudeRoots = skillRoots(realHome, options).filter((root) => root.kind === 'claude');
      expect(claudeRoots.map((root) => [root.source, root.path])).toEqual([
        ['user', join(linkedHome, '.claude', 'skills')],
      ]);

      const demos = discoverSkillsFromDisk(realHome, {}, options).filter(
        (found) => found.name === 'demo',
      );
      expect(demos.map((found) => [found.source, found.shadowed.length])).toEqual([['user', 0]]);
    });

    // The id keys consent and execution overrides. Comparing roots by real path must not move it
    // for a skill nothing folds: here a project skill under a linked directory.
    it('builds the id of a skill under a linked path from the path as written', () => {
      const realRepo = join(dir, 'realrepo');
      const linkedRepo = join(dir, 'linkrepo');
      mkdirSync(realRepo, { recursive: true });
      symlinkSync(realRepo, linkedRepo, 'junction');
      const skillDir = join(realRepo, '.book', 'skills', 'demo');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        ['---', 'name: demo', 'description: Demo skill', '---', 'body'].join('\n'),
      );

      const [demo] = discoverSkills(linkedRepo, {}, { projectRoot: linkedRepo });

      const asWritten = join(linkedRepo, '.book', 'skills', 'demo', 'SKILL.md');
      expect(demo.source).toBe('project');
      expect(demo.id).toBe(
        `book:${process.platform === 'win32' ? resolve(asWritten).toLowerCase() : resolve(asWritten)}`,
      );
    });

    it('keeps a skill id built from the path as written, not its real path', () => {
      const entry = writeDemoSkill(realHome);
      const linkedEntry = join(linkedHome, '.claude', 'skills', 'demo', 'SKILL.md');
      const options = {
        homeDir: linkedHome,
        bookHomeDir: join(linkedHome, '.book'),
        projectRoot: realHome,
      };

      const [demo] = discoverSkillsFromDisk(realHome, {}, options).filter(
        (found) => found.name === 'demo',
      );

      // Skill ids key consent and execution overrides, so they must not move when the roots are
      // compared by real path.
      const lowerOnWindows = (path: string) =>
        process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
      expect(demo.id).toBe(`claude:${lowerOnWindows(linkedEntry)}`);
      expect(demo.id).not.toBe(`claude:${lowerOnWindows(entry)}`);
    });
  });

  // Roots that alias each other *without* involving a user root keep the order and the winner
  // they had before roots were compared by real path (#449 review): the later root wins.
  describe('aliased roots that are not a project root folded into a user root', () => {
    function writeSkill(skillsDir: string, name: string, description: string): void {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(
        join(skillsDir, name, 'SKILL.md'),
        ['---', `name: ${name}`, `description: ${description}`, '---', 'body'].join('\n'),
      );
    }

    it('lets the .book root win when a repository links .claude/skills to .book/skills', () => {
      const repo = join(dir, 'repo');
      mkdirSync(join(repo, '.claude'), { recursive: true });
      writeSkill(join(repo, '.agents', 'skills'), 'deploy', 'Agents version');
      writeSkill(join(repo, '.book', 'skills'), 'deploy', 'Book version');
      symlinkSync(join(repo, '.book', 'skills'), join(repo, '.claude', 'skills'), 'junction');

      const roots = skillRoots(repo, { includeUser: false, projectRoot: repo });
      expect(roots.map((root) => root.kind)).toEqual(['claude', 'agents', 'opencode', 'book']);

      const deploy = discoverSkills(repo).filter((found) => found.name === 'deploy');
      expect(deploy.map((found) => [found.rootKind, found.description])).toEqual([
        ['book', 'Book version'],
      ]);
    });

    it('lets the book user root win when ~/.claude/skills links to ~/.book/skills', () => {
      const home = join(dir, 'home');
      const repo = join(dir, 'repo');
      mkdirSync(join(home, '.claude'), { recursive: true });
      mkdirSync(repo, { recursive: true });
      writeSkill(join(home, '.book', 'skills'), 'tidy', 'Tidy skill');
      symlinkSync(join(home, '.book', 'skills'), join(home, '.claude', 'skills'), 'junction');
      const options = { homeDir: home, bookHomeDir: join(home, '.book'), projectRoot: repo };

      const roots = skillRoots(repo, options).filter((root) => root.source === 'user');
      expect(roots.map((root) => root.kind)).toEqual(['claude', 'agents', 'opencode', 'book']);

      const [tidy, ...others] = discoverSkillsFromDisk(repo, {}, options).filter(
        (found) => found.name === 'tidy',
      );
      expect(others).toEqual([]);
      const entry = join(home, '.book', 'skills', 'tidy', 'SKILL.md');
      expect(tidy.rootKind).toBe('book');
      expect(tidy.id).toBe(
        `book:${process.platform === 'win32' ? resolve(entry).toLowerCase() : resolve(entry)}`,
      );
    });
  });

  // `BOOK_HOME` elsewhere: `<home>/.book/skills` is no user root, so it is a project root.
  it('keeps <home>/.book/skills a project root when BOOK_HOME is elsewhere', () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });

    const roots = skillRoots(dir, { homeDir: dir, bookHomeDir: elsewhere, projectRoot: dir });

    const at = (path: string) => roots.filter((root) => root.path === path);
    expect(at(join(dir, '.book', 'skills')).map((root) => root.source)).toEqual(['project']);
    expect(at(join(elsewhere, 'skills')).map((root) => root.source)).toEqual(['user']);
    // The user roots under home are still folded, as they are for any home-directory session.
    expect(at(join(dir, '.claude', 'skills')).map((root) => root.source)).toEqual(['user']);
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
    // Part of a file or command name the user picked, not a request for the skill.
    expect(
      explicitSkillMentions('/$deploy @$deploy.md docs/$deploy/x.md a\\$deploy x.$deploy', skills),
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

// A dotfiles repository at the home directory is no project (#567): taking it as the root, a
// project under the home directory without its own `.git` loaded skills from every directory
// between the home directory and itself.
describe('project skill roots and a dotfiles ~/.git', () => {
  let home: string;

  beforeEach(() => {
    home = join(dir, 'home');
    mkdirSync(join(home, '.git'), { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const projectRootsOf = (directory: string) => [
    join(directory, '.claude', 'skills'),
    join(directory, '.agents', 'skills'),
    join(directory, '.opencode', 'skills'),
    join(directory, '.book', 'skills'),
  ];

  function writeSkill(skillsDir: string, name: string): void {
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(
      join(skillsDir, name, 'SKILL.md'),
      ['---', `name: ${name}`, `description: The ${name} skill`, '---', 'body'].join('\n'),
    );
  }

  it('scans a project without its own .git, not the directories up to the home directory', () => {
    const proj = join(home, 'code', 'proj');
    mkdirSync(proj, { recursive: true });
    writeSkill(join(home, 'code', '.claude', 'skills'), 'outer');
    writeSkill(join(proj, '.claude', 'skills'), 'inner');

    const roots = skillRoots(proj, { includeUser: false }).map((root) => root.path);
    expect(roots).toEqual(projectRootsOf(proj));
    const names = discoverSkillsFromDisk(proj, {}, { includeUser: false }).map((s) => s.name);
    expect(names).toEqual(['inner']);
  });

  it('takes the home directory from the options when given', () => {
    const proj = join(home, 'code', 'proj');
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(dir, 'other-home'), { recursive: true });

    const rootsWith = (homeDir: string) =>
      skillRoots(proj, { includeUser: false, homeDir }).map((root) => root.path);
    expect(rootsWith(home)).toEqual(projectRootsOf(proj));
    expect(rootsWith(join(dir, 'other-home'))).toEqual([
      ...projectRootsOf(home),
      ...projectRootsOf(join(home, 'code')),
      ...projectRootsOf(proj),
    ]);
  });

  it('keeps a project with its own .git under the home directory scanned from its root', () => {
    const repo = join(home, 'repo');
    const pkg = join(repo, 'pkg');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(pkg, { recursive: true });
    writeSkill(join(repo, '.claude', 'skills'), 'repo-wide');

    const roots = skillRoots(pkg, { includeUser: false }).map((root) => root.path);
    expect(roots).toEqual([...projectRootsOf(repo), ...projectRootsOf(pkg)]);
    const names = discoverSkillsFromDisk(pkg, {}, { includeUser: false }).map((s) => s.name);
    expect(names).toEqual(['repo-wide']);
  });

  it.skipIf(process.platform === 'win32')('compares real paths: a home reached by a link', () => {
    const proj = join(home, 'proj');
    mkdirSync(proj, { recursive: true });
    symlinkSync(home, join(dir, 'home-link'));
    vi.stubEnv('HOME', join(dir, 'home-link'));
    vi.stubEnv('USERPROFILE', join(dir, 'home-link'));

    const roots = skillRoots(proj, { includeUser: false }).map((root) => root.path);
    expect(roots).toEqual(projectRootsOf(proj));
  });
});
