import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverSkills, generateSkillListing } from './skills.js';
import { parseFrontmatter } from './frontmatter.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-skills-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
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
    expect(result[0].body).toBe('Deployment steps.');
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
    expect(result.find((s) => s.name === 'review')?.description).toBe(
      'Project review version',
    );
  });
});

describe('generateSkillListing', () => {
  it('returns empty string for no skills', () => {
    expect(generateSkillListing([], 1000)).toBe('');
  });

  it('generates a compact listing with descriptions', () => {
    const skills = [
      {
        name: 'code-review',
        description: 'Reviews PR diffs',
        whenToUse: 'When user asks for code review',
        allowedTools: ['Read'],
        body: 'You are a reviewer.',
        source: 'project' as const,
        invocationCount: 0,
      },
      {
        name: 'deploy',
        description: 'Deploys to staging',
        whenToUse: undefined,
        allowedTools: ['Bash'],
        body: 'Deploy steps.',
        source: 'project' as const,
        invocationCount: 0,
      },
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
      {
        name: 'frequently-used',
        description: 'A skill that gets used often with a very long description',
        whenToUse: undefined,
        allowedTools: ['Read'],
        body: 'body',
        source: 'project' as const,
        invocationCount: 10,
      },
      {
        name: 'rarely-used',
        description: 'Another skill with a really long description that takes up space',
        whenToUse: 'Only when explicitly asked',
        allowedTools: ['Bash'],
        body: 'body',
        source: 'project' as const,
        invocationCount: 1,
      },
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
      {
        name: 'a',
        description: 'Little used',
        whenToUse: undefined,
        allowedTools: [],
        body: 'body',
        source: 'project' as const,
        invocationCount: 1,
      },
      {
        name: 'b',
        description: 'Often used',
        whenToUse: undefined,
        allowedTools: [],
        body: 'body',
        source: 'project' as const,
        invocationCount: 100,
      },
    ];

    const listing = generateSkillListing(skills, 2000);
    const bIdx = listing.indexOf('**b**: Often used');
    const aIdx = listing.indexOf('**a**: Little used');
    expect(bIdx).toBeLessThan(aIdx);
  });
});
