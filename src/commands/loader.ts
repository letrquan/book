import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';
import { parseFrontmatter } from '../frontmatter.js';
import type { SlashCommand } from '../types.js';

/**
 * Load a single .md command file. Returns null if the file doesn't exist.
 */
function loadCommandFile(
  filePath: string,
  source: 'user' | 'project',
): SlashCommand | null {
  if (!existsSync(filePath) || extname(filePath) !== '.md') return null;
  const raw = readFileSync(filePath, 'utf-8');
  const { body, frontmatter } = parseFrontmatter(raw);
  const name = filePath.split(/[/\\]/).pop()!.replace(/\.md$/, '');
  return {
    name,
    description: (frontmatter.description as string) || name,
    argumentHint: frontmatter['argument-hint'] as string | undefined,
    arguments: Array.isArray(frontmatter.arguments)
      ? (frontmatter.arguments as string[])
      : typeof frontmatter.arguments === 'string'
        ? (frontmatter.arguments as string).split(/[,\s]+/).filter(Boolean)
        : undefined,
    allowedTools: Array.isArray(frontmatter['allowed-tools'])
      ? (frontmatter['allowed-tools'] as string[])
      : undefined,
    model: frontmatter.model as string | undefined,
    body,
    source,
  };
}

/**
 * Discover all slash commands from the conventional directories.
 *
 * Search order (project wins on name collision):
 *   1. ~/.book/commands/*.md  (user)
 *   2. .book/commands/*.md    (project)
 *
 * Project commands with the same name as a user command override the user one.
 */
export function discoverCommands(workspace: string): SlashCommand[] {
  const userDir = join(homedir(), '.book', 'commands');
  const projectDir = join(workspace, '.book', 'commands');

  const byName = new Map<string, SlashCommand>();

  // User commands first (lowest priority).
  for (const dir of [userDir, projectDir]) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const source = dir === userDir ? 'user' : 'project';
      const cmd = loadCommandFile(fullPath, source);
      if (cmd) {
        byName.set(cmd.name, cmd); // project overrides user via set
      }
    }
  }

  return Array.from(byName.values());
}

// Re-export resolveCommandBody from resolve.ts for backward compatibility.
export { resolveCommandBody } from './resolve.js';

/**
 * Generate a compact text listing of available commands for injection into the
 * system prompt. Commands with disableModelInvocation are excluded.
 *
 * Pattern: mirror generateSkillListing from src/skills.ts.
 */
export function generateCommandListing(
  commands: SlashCommand[],
  budgetChars: number = 1024,
): string {
  const visible = commands.filter((c) => c.source !== undefined); // all commands are visible
  if (visible.length === 0) return '';

  const lines: string[] = [];
  lines.push('## Available slash commands');
  lines.push(
    'The user can invoke these by typing /name at the prompt. When the user invokes a slash command, execute its instructions below.',
  );

  let remaining = budgetChars - lines.join('\n').length;

  for (const cmd of visible) {
    const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
    const entry = `- **/${cmd.name}${hint}**: ${cmd.description}`;
    if (entry.length > remaining) {
      // Try bare name
      const bare = `- **/${cmd.name}**`;
      if (bare.length <= remaining) {
        lines.push(bare);
        remaining -= bare.length + 1;
      }
      break;
    }
    lines.push(entry);
    remaining -= entry.length + 1;
  }

  return lines.join('\n');
}
