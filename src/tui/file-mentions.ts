import { existsSync, statSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import fg from 'fast-glob';
import { loadGitignore } from '../tools/gitignore.js';

export interface ActiveFileMention {
  start: number;
  end: number;
  query: string;
  quoted: boolean;
}

export interface FileMentionCandidate {
  path: string;
  kind: 'file' | 'directory';
  desc: string;
}

const DEFAULT_IGNORE = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/.claude/worktrees/**',
];

function isMentionBoundary(input: string, index: number): boolean {
  if (index === 0) return true;
  const prev = input[index - 1];
  return /[\s([{<"']/.test(prev);
}

export function normalizeMentionPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function resolveWorkspaceMentionPath(
  workspace: string,
  mentionPath: string,
): { filePath: string; relativePath: string } | null {
  const root = resolve(workspace);
  const normalized = mentionPath.replace(/\\/g, '/');
  const candidate = isAbsolute(normalized) ? normalized : resolve(root, normalized);
  const filePath = resolve(candidate);
  const rel = relative(root, filePath);

  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return { filePath, relativePath: normalizeMentionPath(rel) };
}

export function findActiveFileMention(input: string): ActiveFileMention | null {
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i] !== '@') continue;
    if (!isMentionBoundary(input, i)) continue;

    const rest = input.slice(i + 1);
    if (rest.startsWith('"')) {
      const query = rest.slice(1);
      if (query.includes('"')) return null;
      return { start: i, end: input.length, query, quoted: true };
    }

    if (/\s/.test(rest)) return null;
    return { start: i, end: input.length, query: rest, quoted: false };
  }
  return null;
}

export function replaceActiveFileMention(
  input: string,
  mention: ActiveFileMention,
  replacementPath: string,
): string {
  const needsQuotes = mention.quoted || /\s/.test(replacementPath);
  const mentionText = needsQuotes ? `@"${replacementPath}" ` : `@${replacementPath} `;
  return input.slice(0, mention.start) + mentionText + input.slice(mention.end);
}

export function getFileMentionCandidates(
  workspace: string,
  query: string,
  limit = 50,
): FileMentionCandidate[] {
  const normalizedQuery = normalizeMentionPath(query).toLowerCase();
  const gitignore = loadGitignore(workspace).patterns;
  const ignore = [...DEFAULT_IGNORE, ...gitignore];

  let entries: string[];
  try {
    entries = fg.sync('**/*', {
      cwd: workspace,
      dot: true,
      onlyFiles: false,
      unique: true,
      ignore,
    });
  } catch {
    return [];
  }

  const scored: Array<FileMentionCandidate & { score: number }> = [];
  for (const entry of entries) {
    const display = normalizeMentionPath(entry);
    const lower = display.toLowerCase();
    const base = lower.split('/').pop() ?? lower;

    let score: number | null = null;
    if (!normalizedQuery) score = 3;
    else if (lower === normalizedQuery) score = 0;
    else if (lower.startsWith(normalizedQuery)) score = 1;
    else if (base.startsWith(normalizedQuery)) score = 2;
    else if (lower.includes(normalizedQuery)) score = 4;
    if (score === null) continue;

    const resolved = resolveWorkspaceMentionPath(workspace, display);
    if (!resolved || !existsSync(resolved.filePath)) continue;

    try {
      const stat = statSync(resolved.filePath);
      const kind = stat.isDirectory() ? 'directory' : 'file';
      scored.push({
        path: kind === 'directory' ? `${display}/` : display,
        kind,
        desc: kind === 'directory' ? 'directory' : `${stat.size} bytes`,
        score,
      });
    } catch {
      // Ignore races with filesystem changes.
    }
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return scored.slice(0, limit).map(({ score, ...item }) => item);
}
