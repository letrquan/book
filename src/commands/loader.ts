import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { parseFrontmatter } from '../frontmatter.js';
import type { SlashCommand } from '../types/commands.js';
import { resolveBookHome } from '../book-home.js';
import { shippedHomeFiles } from '../book-home-files.js';
import {
  formatSkippedNotice,
  projectContainmentRoot,
  refusalFor,
  tryRealPath,
  type SkippedProjectFile,
} from '../repo-containment.js';
import { isOutside } from '../tools/path-utils.js';
import { reachesUncPath } from '../unc-path.js';

/**
 * Load a single .md command file. Returns null if the file doesn't exist or can't be read. The command is named
 * after `filePath`; `readFrom` is the real path that was checked, when it is not `filePath`.
 */
function loadCommandFile(
  filePath: string,
  source: 'user' | 'project',
  readFrom: string = filePath,
): SlashCommand | null {
  if (!existsSync(readFrom) || extname(filePath) !== '.md') return null;
  let raw: string;
  try {
    raw = readFileSync(readFrom, 'utf-8');
  } catch {
    // An unreadable file is skipped, not thrown: discovery also runs for the start-up notices.
    return null;
  }
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

export interface CommandInspection {
  commands: SlashCommand[];
  /** Project command files that were found but refused (#543). */
  skipped: SkippedProjectFile[];
}

/**
 * Discovery plus the project command files it refused (#543). A repository can commit a command
 * file as a link to a file outside it, and the target would be sent to the provider when its
 * `/name` is run, so each entry of the project directory loads only when its real path is a
 * Markdown file inside the real path of the repository root (the workspace root with no
 * repository). That covers a linked `.book` or `.book/commands` directory, and the file is read
 * from the real path that was checked. User commands are the user's own and are never checked,
 * and neither are the entries of the project directory when it is the user directory (the
 * workspace is the home directory). A user directory the workspace's repository ships files in
 * (`book-home-files.ts`) is the repository's: it is not read as the user's, and when it is also
 * the project directory it is read, and checked, as that.
 *
 * Search order (project wins on name collision):
 *   1. ~/.book/commands/*.md  (user)
 *   2. .book/commands/*.md    (project)
 */
export function inspectCommands(workspace: string): CommandInspection {
  const userDir = join(resolveBookHome(), 'commands');
  const projectDir = join(workspace, '.book', 'commands');
  const userShipped = shippedHomeFiles(workspace)?.shipsAnyUnder(userDir) ?? false;
  const userReal = tryRealPath(userDir);
  const projectReal = tryRealPath(projectDir);
  const projectIsUserDir =
    !userShipped &&
    userReal !== undefined &&
    projectReal !== undefined &&
    !isOutside(userReal, projectReal) &&
    !isOutside(projectReal, userReal);
  // Fails closed: a project directory whose real path cannot be had is checked (and so skipped).
  const checked = !projectIsUserDir;
  const rootReal = checked ? tryRealPath(projectContainmentRoot(workspace)) : undefined;

  const byName = new Map<string, SlashCommand>();
  const skipped: SkippedProjectFile[] = [];

  // User commands first (lowest priority).
  for (const dir of userShipped ? [projectDir] : [userDir, projectDir]) {
    // A `.book` committed as a link to a network share is not listed: listing it would reach the
    // host (#567).
    if (dir === projectDir && reachesUncPath(dir)) continue;
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
      // Only a file inside the repository is read, by its real path; a name that links elsewhere
      // is reported, not followed.
      let readFrom = fullPath;
      if (dir === projectDir && checked) {
        const real = tryRealPath(fullPath);
        if (rootReal === undefined || real === undefined) continue;
        try {
          if (!statSync(real).isFile()) continue;
        } catch {
          continue;
        }
        const reason = refusalFor(rootReal, real);
        if (reason) {
          skipped.push({ path: fullPath, target: real, root: rootReal, reason });
          continue;
        }
        readFrom = real;
      } else {
        try {
          if (!statSync(fullPath).isFile()) continue;
        } catch {
          continue;
        }
      }
      const source = dir === userDir && !userShipped ? 'user' : 'project';
      const cmd = loadCommandFile(fullPath, source, readFrom);
      if (cmd) {
        byName.set(cmd.name, cmd); // project overrides user via set
      }
    }
  }

  return { commands: Array.from(byName.values()), skipped };
}

/**
 * Discover all slash commands from the conventional directories. Project commands with the same
 * name as a user command override the user one. See `inspectCommands` for what is refused.
 */
export function discoverCommands(workspace: string): SlashCommand[] {
  return inspectCommands(workspace).commands;
}

/** One start-up warning per project command file that was not loaded. */
export function collectSkippedCommandNotices(workspace: string): string[] {
  return inspectCommands(workspace).skipped.map((entry) =>
    formatSkippedNotice('project command', workspace, entry),
  );
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
  // No command bodies follow, and nothing downstream resolves a bare `/name`
  // string: the host expands an invoked command before the turn reaches the
  // model. Promising "execute its instructions below" taught a mechanism that
  // does not exist.
  lines.push(
    'The user can invoke these by typing /name. The host expands an invoked command into the conversation before it reaches you. If a message merely mentions a command name, treat it as a reference — do not attempt to execute the command yourself.',
  );

  let remaining = budgetChars - lines.join('\n').length;
  let shown = 0;

  for (const cmd of visible) {
    const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
    const entry = `- **/${cmd.name}${hint}**: ${cmd.description}`;
    if (entry.length > remaining) {
      // Try bare name
      const bare = `- **/${cmd.name}**`;
      if (bare.length <= remaining) {
        lines.push(bare);
        shown++;
        remaining -= bare.length + 1;
      }
      break;
    }
    lines.push(entry);
    shown++;
    remaining -= entry.length + 1;
  }

  if (shown < visible.length) lines.push(`- …and ${visible.length - shown} more not shown`);

  return lines.join('\n');
}
