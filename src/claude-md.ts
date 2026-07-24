import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, parse, resolve } from 'path';

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
  homeDir = homedir(),
): ProjectInstructionSource[] {
  const sources: ProjectInstructionSource[] = [];
  const workspaceRoot = resolve(workspace);
  const add = (path: string, layer: ProjectInstructionLayer) => {
    const source = readSource(path, layer);
    if (source) sources.push(source);
  };

  add(join(homeDir, '.claude', 'CLAUDE.md'), 'user');
  add(join(homeDir, '.book', 'AGENTS.md'), 'user');

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

export function renderProjectInstructions(sources: ProjectInstructionSource[]): string {
  if (sources.length === 0) return '';

  const lines = [
    '## Project instructions',
    'Loaded in merge order; later sections override earlier sections.',
  ];

  for (const source of sources) {
    lines.push('', `### ${source.layer}: ${source.path}`, source.body);
  }

  return lines.join('\n');
}

// Compatibility aliases for callers that imported the original CLAUDE.md-only API.
export const discoverClaudeMd = discoverProjectInstructions;
export const renderClaudeMd = renderProjectInstructions;
export type ClaudeMdLayer = ProjectInstructionLayer;
export type ClaudeMdSource = ProjectInstructionSource;
