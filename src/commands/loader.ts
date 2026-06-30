import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';
import { parseFrontmatter } from '../frontmatter.js';

/**
 * A slash command loaded from a Markdown file in .book/commands/ or
 * ~/.book/commands/. Matches Claude Code's command loading model.
 */
export interface SlashCommand {
  /** File basename without extension — the command name invoked via /name */
  name: string;
  /** Human-readable description (from frontmatter `description`) */
  description: string;
  /** Argument hint shown in help (from frontmatter `argument-hint`) */
  argumentHint?: string;
  /** Restrict which tools this command can use (from frontmatter `allowed-tools`) */
  allowedTools?: string[];
  /** Override model for this command (from frontmatter `model`) */
  model?: string;
  /** The raw Markdown body — injected as the prompt when invoked. */
  body: string;
  /** Source directory for priority/debugging (user vs project). */
  source: 'user' | 'project';
}

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

/**
 * Resolve a command body by substituting arguments.
 *
 * `$ARGUMENTS` — all arguments joined
 * `$1`, `$2`, ... — positional arguments
 * `$*` — same as $ARGUMENTS
 */
export function resolveCommandBody(command: SlashCommand, args: string): string {
  const argv = args.trim().split(/\s+/).filter(Boolean);
  let body = command.body;
  body = body.replace(/\$ARGUMENTS|\$\*/g, args.trim());
  // Replace positional args $1..$9. Args beyond argv length become empty.
  for (let i = 1; i <= 9; i++) {
    const val = i <= argv.length ? argv[i - 1] : '';
    body = body.replace(new RegExp(`\\$${i}`, 'g'), val);
  }
  return body;
}
