import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, parse, resolve } from 'path';
import { resolveBookHome } from './book-home.js';

export type ProjectInstructionLayer = 'user' | 'project' | 'local' | 'rule';

export interface ProjectInstructionSource {
  path: string;
  layer: ProjectInstructionLayer;
  body: string;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function readSource(path: string, layer: ProjectInstructionLayer): ProjectInstructionSource | null {
  try {
    if (!isFile(path)) return null;
    const body = readFileSync(path, 'utf-8').trim();
    return body ? { path, layer, body } : null;
  } catch {
    return null;
  }
}

function realPathOf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function ancestorsFromRoot(workspace: string): string[] {
  const dirs: string[] = [];
  const root = parse(resolve(workspace)).root;
  let current = resolve(workspace);

  while (true) {
    dirs.push(current);
    if (current === root) break;
    current = dirname(current);
  }

  return dirs.reverse();
}

export function discoverProjectInstructions(
  workspace: string,
  homeDir?: string,
): ProjectInstructionSource[] {
  const sources: ProjectInstructionSource[] = [];
  const workspaceRoot = resolve(workspace);
  const systemHome = homeDir ?? homedir();
  const bookHome = homeDir ? join(homeDir, '.book') : resolveBookHome();
  const localPath = join(workspaceRoot, 'CLAUDE.local.md');
  // Only whether the file exists matters here (an empty one is the same file as any link to it,
  // and every copy of it is skipped alike), so it is not read: `add` reads it once, below.
  const localKey = isFile(localPath) ? realPathOf(localPath) : undefined;
  const loaded = new Set<string>();
  const add = (path: string, layer: ProjectInstructionLayer) => {
    const source = readSource(path, layer);
    if (!source) return;
    // A file is loaded once, at its first scope. `$HOME` is an ancestor of almost every
    // workspace, so the walk below meets `~/.claude/CLAUDE.md` again, and a workspace inside
    // `BOOK_HOME` meets its `AGENTS.md`; both stay user instructions (#430). Real paths, so a
    // linked home, or a CLAUDE.md linked to the AGENTS.md beside it, counts once too.
    // The one exception to first-load-wins is CLAUDE.local.md (#524): a project-layer file that
    // is the same file (a committed `CLAUDE.md -> CLAUDE.local.md`) is the copy dropped, so the
    // file loads once, as local, after every project file, which the repository cannot then
    // override with a later `.claude/CLAUDE.md`. User-layer files are not affected.
    const key = realPathOf(path);
    if (layer === 'project' && key === localKey) return;
    if (loaded.has(key)) return;
    loaded.add(key);
    sources.push(source);
  };

  add(join(systemHome, '.claude', 'CLAUDE.md'), 'user');
  add(join(bookHome, 'AGENTS.md'), 'user');

  for (const dir of ancestorsFromRoot(workspaceRoot)) {
    add(join(dir, 'AGENTS.md'), 'project');
    add(join(dir, 'CLAUDE.md'), 'project');
    add(join(dir, '.claude', 'CLAUDE.md'), 'project');
  }

  add(localPath, 'local');

  // ponytail: rules are standing guidance; add glob/frontmatter matching when path-specific activation matters.
  try {
    for (const entry of readdirSync(join(workspaceRoot, '.claude', 'rules'), {
      encoding: 'utf-8',
    }).sort()) {
      if (entry.endsWith('.md')) {
        add(join(workspaceRoot, '.claude', 'rules', entry), 'rule');
      }
    }
  } catch {
    // Missing or unreadable rules dir is fine.
  }

  return sources;
}

/**
 * Neutralize fence markup a source file might contain. Without this a repo file
 * could close the fence early — or forge a `<source>` header — and have the rest
 * of its body read as prompt-level instruction rather than workspace policy.
 */
function neutralizeFenceTags(body: string): string {
  return body.replace(/<(\/?)(project-instructions|source)\b/gi, '&lt;$1$2');
}

/**
 * Only the quote can break out of the attribute. Leave the rest of the path
 * verbatim so evaluation placeholders such as `<evaluation-workspace>` and
 * ordinary paths containing `&` stay readable.
 */
function escapeAttribute(value: string): string {
  return value.replace(/"/g, '&quot;');
}

/**
 * Wrap every source in an explicit fence. The fence, not a markdown heading, is
 * the trust boundary: injected files carry their own `#` headings, which break
 * straight out of a `## Project instructions` section.
 */
export function renderProjectInstructions(sources: ProjectInstructionSource[]): string {
  if (sources.length === 0) return '';

  const lines = [
    '## Project instructions',
    'Loaded in merge order; later sources override earlier sources.',
    '',
    '<project-instructions>',
  ];

  for (const source of sources) {
    lines.push(
      `<source path="${escapeAttribute(source.path)}" scope="${source.layer}">`,
      neutralizeFenceTags(source.body),
      '</source>',
    );
  }

  lines.push('</project-instructions>');
  return lines.join('\n');
}

// Compatibility alias for callers that imported the original CLAUDE.md-only API.
export const discoverClaudeMd = discoverProjectInstructions;
