import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, parse, resolve } from 'path';
import { resolveBookHome } from './book-home.js';

export type ProjectInstructionLayer = 'user' | 'project' | 'local' | 'rule';

export interface ProjectInstructionSource {
  path: string;
  layer: ProjectInstructionLayer;
  body: string;
}

function readSource(path: string, layer: ProjectInstructionLayer): ProjectInstructionSource | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    const body = readFileSync(path, 'utf-8').trim();
    return body ? { path, layer, body } : null;
  } catch {
    return null;
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
  const add = (path: string, layer: ProjectInstructionLayer) => {
    const source = readSource(path, layer);
    if (source) sources.push(source);
  };

  add(join(systemHome, '.claude', 'CLAUDE.md'), 'user');
  add(join(bookHome, 'AGENTS.md'), 'user');

  for (const dir of ancestorsFromRoot(workspaceRoot)) {
    add(join(dir, 'AGENTS.md'), 'project');
    add(join(dir, 'CLAUDE.md'), 'project');
    add(join(dir, '.claude', 'CLAUDE.md'), 'project');
  }

  add(join(workspaceRoot, 'CLAUDE.local.md'), 'local');

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

// Compatibility aliases for callers that imported the original CLAUDE.md-only API.
export const discoverClaudeMd = discoverProjectInstructions;
export const renderClaudeMd = renderProjectInstructions;
export type ClaudeMdLayer = ProjectInstructionLayer;
export type ClaudeMdSource = ProjectInstructionSource;
