import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, parse, resolve } from 'path';

export type ClaudeMdLayer = 'user' | 'project' | 'local' | 'rule';

export interface ClaudeMdSource {
  path: string;
  layer: ClaudeMdLayer;
  body: string;
}

function readSource(path: string, layer: ClaudeMdLayer): ClaudeMdSource | null {
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

export function discoverClaudeMd(workspace: string, homeDir = homedir()): ClaudeMdSource[] {
  const sources: ClaudeMdSource[] = [];
  const workspaceRoot = resolve(workspace);
  const add = (path: string, layer: ClaudeMdLayer) => {
    const source = readSource(path, layer);
    if (source) sources.push(source);
  };

  add(join(homeDir, '.claude', 'CLAUDE.md'), 'user');

  for (const dir of ancestorsFromRoot(workspaceRoot)) {
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

export function renderClaudeMd(sources: ClaudeMdSource[]): string {
  if (sources.length === 0) return '';

  const lines = [
    '## CLAUDE.md instructions',
    'Loaded in merge order; later sections override earlier sections.',
  ];

  for (const source of sources) {
    lines.push('', `### ${source.layer}: ${source.path}`, source.body);
  }

  return lines.join('\n');
}
