import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseFrontmatter } from './frontmatter.js';

/**
 * A skill definition loaded from .book/skills/<name>/SKILL.md or
 * ~/.book/skills/<name>/SKILL.md.
 */
export interface Skill {
  /** Name used in the skill listing and for invocation. */
  name: string;
  /** Human-readable description (from frontmatter). */
  description: string;
  /** When the model should invoke this skill (from frontmatter). */
  whenToUse?: string;
  /** Restrict which tools this skill can use. */
  allowedTools?: string[];
  /** Override model for this skill. */
  model?: string;
  /** The raw Markdown body — injected as prompt when invoked. */
  body: string;
  /** Source directory. */
  source: 'user' | 'project';
  /** Number of times this skill has been invoked (for budget tracking). */
  invocationCount: number;
}

/**
 * Load a single SKILL.md file. Returns null if the file doesn't exist
 * or is malformed.
 */
function loadSkillFile(dirPath: string, source: 'user' | 'project'): Skill | null {
  const skillDir = dirPath;
  const skillMetaPath = join(skillDir, 'SKILL.md');

  if (!existsSync(skillMetaPath)) {
    // Try flat variant: <dirname>.skill.md at the parent level
    const parentDir = join(skillDir, '..');
    const flatName = join(parentDir, `${skillDir.split(/[/\\]/).pop()}.skill.md`);
    if (existsSync(flatName)) {
      const raw = readFileSync(flatName, 'utf-8');
      const { body, frontmatter } = parseFrontmatter(raw);
      const name = String(frontmatter.name || skillDir.split(/[/\\]/).pop() || '');
      if (!name) return null;
      return {
        name,
        description: (frontmatter.description as string) || name,
        whenToUse: frontmatter.when_to_use as string | undefined,
        allowedTools: Array.isArray(frontmatter.tools)
          ? (frontmatter.tools as string[])
          : undefined,
        model: frontmatter.model as string | undefined,
        body,
        source,
        invocationCount: 0,
      };
    }
    return null;
  }

  if (!statSync(skillMetaPath).isFile()) return null;

  const raw = readFileSync(skillMetaPath, 'utf-8');
  const { body, frontmatter } = parseFrontmatter(raw);
  const name = String(frontmatter.name || skillDir.split(/[/\\]/).pop() || '');
  if (!name) return null;

  return {
    name,
    description: (frontmatter.description as string) || name,
    whenToUse: frontmatter.when_to_use as string | undefined,
    allowedTools: Array.isArray(frontmatter.tools)
      ? (frontmatter.tools as string[])
      : undefined,
    model: frontmatter.model as string | undefined,
    body,
    source,
    invocationCount: 0,
  };
}

/**
 * Discover all skills from the conventional directories.
 *
 * Search order (project wins on name collision):
 *   1. ~/.book/skills/<name>/SKILL.md  (user)
 *   2. .book/skills/<name>/SKILL.md    (project)
 *
 * Also supports flat variant: ~/.book/skills/<name>.skill.md
 */
export function discoverSkills(workspace: string): Skill[] {
  const userDir = join(homedir(), '.book', 'skills');
  const projectDir = join(workspace, '.book', 'skills');

  const byName = new Map<string, Skill>();

  for (const dir of [userDir, projectDir]) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { encoding: 'utf-8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        // Subdirectory: <name>/SKILL.md
        const source = dir === userDir ? 'user' : 'project';
        const skill = loadSkillFile(fullPath, source);
        if (skill) byName.set(skill.name, skill);
      } else if (entry.endsWith('.skill.md')) {
        // Flat file: <name>.skill.md
        const source = dir === userDir ? 'user' : 'project';
        const raw = readFileSync(fullPath, 'utf-8');
        const { body, frontmatter } = parseFrontmatter(raw);
        const name = entry.replace(/\.skill\.md$/, '');
        const skill: Skill = {
          name,
          description: (frontmatter.description as string) || name,
          whenToUse: frontmatter.when_to_use as string | undefined,
          allowedTools: Array.isArray(frontmatter.tools)
            ? (frontmatter.tools as string[])
            : undefined,
          model: frontmatter.model as string | undefined,
          body,
          source,
          invocationCount: 0,
        };
        byName.set(name, skill);
      }
    }
  }

  return Array.from(byName.values());
}

/**
 * Generate a compact text listing of available skills for injection into the
 * system prompt.
 *
 * @param skills - All discovered skills
 * @param budgetChars - Max chars for the listing (default 1536 from maxSkillDescriptionChars)
 * @returns A compact markdown string
 */
export function generateSkillListing(
  skills: Skill[],
  budgetChars = 1536,
): string {
  if (skills.length === 0) return '';

  // Sort by invocation count descending (most-used first).
  const sorted = [...skills].sort((a, b) => b.invocationCount - a.invocationCount);

  const lines: string[] = [];
  lines.push('## Available skills');
  lines.push(
    'You have skills available. To invoke one, respond with the InvokeSkill tool.',
  );

  let remainingBudget = budgetChars - lines.join('\n').length;

  for (const skill of sorted) {
    const description = skill.description || skill.name;
    const whenToUse = skill.whenToUse ? `  when: ${skill.whenToUse}` : '';
    const entryText = `- **${skill.name}**: ${description}`;
    const fullText = whenToUse ? `${entryText}\n${whenToUse}` : entryText;

    if (fullText.length > remainingBudget) {
      // Collapse to bare name to save space.
      const bare = `- **${skill.name}**`;
      if (bare.length <= remainingBudget) {
        lines.push(bare);
        remainingBudget -= bare.length + 1;
      }
      // If even the bare name doesn't fit, stop listing.
      break;
    }

    lines.push(fullText);
    remainingBudget -= fullText.length + 1;
  }

  return lines.join('\n');
}
