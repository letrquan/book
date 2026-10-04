import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'path';
import { glob } from 'tinyglobby';
import { throwIfAborted, yieldToEventLoop } from '../async.js';
import { loadGitignore } from '../tools/gitignore.js';
import { globIgnorePatternsWithinLimit } from '../tools/glob-regex.js';

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

/** A file's size in bytes, or 0 when it cannot be read: a mention list is a hint, not a gate. */
async function fileSizeBytes(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

export async function getFileMentionCandidates(
  workspace: string,
  query: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<FileMentionCandidate[]> {
  const normalizedQuery = normalizeMentionPath(query).toLowerCase();
  const gitignore = loadGitignore(workspace).patterns;
  const ignore = globIgnorePatternsWithinLimit([...DEFAULT_IGNORE, ...gitignore]);

  let entries: string[];
  try {
    entries = await glob('**/*', {
      cwd: workspace,
      dot: true,
      onlyFiles: false,
      ignore,
      // A pattern naming a directory returns that directory, not everything inside it — which is
      // the whole point of walking for mentions.
      expandDirectories: false,
    });
  } catch {
    return [];
  }
  throwIfAborted(signal);

  const scored: Array<FileMentionCandidate & { score: number }> = [];
  for (let index = 0; index < entries.length; index++) {
    // A directory is the one entry the walk spells with a trailing `/`, and it is the only thing
    // telling a directory from a file. The slash is stripped for the match below — a query of
    // `src` should find `src/` — and put back on the candidate, which is the path the input
    // spells the mention with.
    const entry = entries[index];
    const isDirectory = entry.endsWith('/');
    const display = normalizeMentionPath(isDirectory ? entry.slice(0, -1) : entry);
    const lower = display.toLowerCase();
    const base = lower.split('/').pop() ?? lower;

    let score: number | null = null;
    if (!normalizedQuery) score = 3;
    else if (lower === normalizedQuery) score = 0;
    else if (lower.startsWith(normalizedQuery)) score = 1;
    else if (base.startsWith(normalizedQuery)) score = 2;
    else if (lower.includes(normalizedQuery)) score = 4;

    if (score !== null) {
      scored.push({
        path: isDirectory ? `${display}/` : display,
        kind: isDirectory ? 'directory' : 'file',
        desc: '',
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
  // Sized after the cut, so a wide walk does not pay for a stat per entry it will not list.
  const candidates: FileMentionCandidate[] = [];
  for (const { path, kind } of scored.slice(0, limit)) {
    candidates.push({
      path,
      kind,
      desc:
        kind === 'directory'
          ? 'directory'
          : `${await fileSizeBytes(resolve(workspace, path))} bytes`,
    });
  }
  return candidates;
}
