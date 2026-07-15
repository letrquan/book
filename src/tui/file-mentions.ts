import { isAbsolute, relative, resolve } from 'path';
import fg from 'fast-glob';
import { throwIfAborted, yieldToEventLoop } from '../async.js';
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
const SCORE_YIELD_INTERVAL = 256;

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

export async function getFileMentionCandidates(
  workspace: string,
  query: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<FileMentionCandidate[]> {
  const normalizedQuery = normalizeMentionPath(query).toLowerCase();
  const gitignore = loadGitignore(workspace).patterns;
  const ignore = [...DEFAULT_IGNORE, ...gitignore];

  let entries: fg.Entry[];
  try {
    entries = await fg('**/*', {
      cwd: workspace,
      dot: true,
      onlyFiles: false,
      unique: true,
      ignore,
      objectMode: true,
      stats: true,
    });
  } catch {
    return [];
  }
  throwIfAborted(signal);

  const scored: Array<FileMentionCandidate & { score: number }> = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const display = normalizeMentionPath(entry.path);
    const lower = display.toLowerCase();
    const base = lower.split('/').pop() ?? lower;

    let score: number | null = null;
    if (!normalizedQuery) score = 3;
    else if (lower === normalizedQuery) score = 0;
    else if (lower.startsWith(normalizedQuery)) score = 1;
    else if (base.startsWith(normalizedQuery)) score = 2;
    else if (lower.includes(normalizedQuery)) score = 4;

    if (score !== null) {
      const kind = entry.dirent.isDirectory() ? 'directory' : 'file';
      scored.push({
        path: kind === 'directory' ? `${display}/` : display,
        kind,
        desc: kind === 'directory' ? 'directory' : `${entry.stats?.size ?? 0} bytes`,
        score,
      });
    }

    if (index > 0 && index % SCORE_YIELD_INTERVAL === 0) await yieldToEventLoop(signal);
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  throwIfAborted(signal);
  return scored.slice(0, limit).map(({ score, ...item }) => item);
}
