import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ReviewScope } from './types.js';

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ReviewTarget {
  kind: 'working-tree' | 'committed-range';
  baseSha: string;
  headSha?: string;
  path?: string;
  diff: string;
  changedFiles: string[];
}

const MAX_REVIEW_DIFF_BYTES = 20 * 1024 * 1024;

function git(workspace: string, args: string[], allowExitCodes: number[] = []): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd: workspace, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
        if (!error || allowExitCodes.includes(code)) {
          resolvePromise({ stdout, stderr, code });
          return;
        }
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
      },
    );
  });
}

function splitZeroDelimited(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

function normalizePath(workspace: string, raw: string): string {
  const absolute = resolve(workspace, raw);
  const root = resolve(workspace);
  const local = relative(root, absolute).replaceAll('\\', '/');
  if (isAbsolute(raw) && (local.startsWith('../') || local === '..')) {
    throw new Error(`Review path is outside the workspace: ${raw}`);
  }
  if (local.startsWith('../') || local === '..') {
    throw new Error(`Review path is outside the workspace: ${raw}`);
  }
  if (existsSync(absolute) && !statSync(absolute).isFile() && !statSync(absolute).isDirectory()) {
    throw new Error(`Review path must resolve to a file or directory: ${raw}`);
  }
  return local || '.';
}

async function resolveCommit(workspace: string, ref: string): Promise<string> {
  return (await git(workspace, ['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim();
}

function targetPath(scope: ReviewScope): string | undefined {
  if (!scope.target || scope.target.includes('...')) return undefined;
  return scope.target;
}

async function validatePath(workspace: string, path: string): Promise<void> {
  if (existsSync(resolve(workspace, path))) return;
  const tracked = await git(workspace, ['ls-files', '--cached', '--', path]);
  if (tracked.stdout.trim()) return;
  throw new Error(`Review path does not exist or is not tracked: ${path}`);
}

function ensureDiffSize(diff: string): string {
  const bytes = Buffer.byteLength(diff, 'utf8');
  if (bytes > MAX_REVIEW_DIFF_BYTES) {
    throw new Error(
      `Review target diff is too large (${bytes} bytes; maximum ${MAX_REVIEW_DIFF_BYTES} bytes). Narrow the review scope or use a smaller range.`,
    );
  }
  return diff;
}

function untrackedDiff(file: string, body: string): string {
  if (body.includes('\0')) {
    return [
      `diff --git a/dev/null b/${file}`,
      'new file mode 100644',
      'Binary files /dev/null and b/' + file + ' differ',
    ].join('\n');
  }
  const lines = body.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) {
    return [`diff --git a/dev/null b/${file}`, 'new file mode 100644'].join('\n');
  }
  return [
    `diff --git a/dev/null b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

export async function resolveReviewTarget(
  workspace: string,
  scope: ReviewScope,
): Promise<ReviewTarget> {
  if (scope.error) throw new Error(scope.error);
  const rawPath = targetPath(scope);
  const path = rawPath ? normalizePath(workspace, rawPath) : undefined;
  if (path && path !== '.') await validatePath(workspace, path);
  const pathArgs = path ? ['--', path] : [];

  if (scope.target?.includes('...')) {
    if (scope.base) throw new Error('Use either --base or a <base>...<head> range, not both.');
    const parts = scope.target.split('...');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid review range: ${scope.target}`);
    }
    const [baseRef, headRef] = parts as [string, string];
    const baseSha = (await git(workspace, ['merge-base', baseRef, headRef])).stdout.trim();
    const headSha = await resolveCommit(workspace, headRef);
    const [files, diff] = await Promise.all([
      git(workspace, ['diff', '--name-only', '-z', baseSha, headSha, ...pathArgs]),
      git(workspace, [
        'diff',
        '--binary',
        '--full-index',
        '--unified=5',
        baseSha,
        headSha,
        ...pathArgs,
      ]),
    ]);
    return {
      kind: 'committed-range',
      baseSha,
      headSha,
      path,
      changedFiles: splitZeroDelimited(files.stdout),
      diff: ensureDiffSize(diff.stdout),
    };
  }

  if (!scope.target?.includes('...') && scope.target && !path) {
    throw new Error(`Invalid review path: ${scope.target}`);
  }

  const baseSha = scope.base
    ? (await git(workspace, ['merge-base', 'HEAD', scope.base])).stdout.trim()
    : await resolveCommit(workspace, 'HEAD');
  const [trackedFiles, trackedDiff, untrackedFiles] = await Promise.all([
    git(workspace, ['diff', '--name-only', '-z', baseSha, ...pathArgs]),
    git(workspace, ['diff', '--binary', '--full-index', '--unified=5', baseSha, ...pathArgs]),
    git(workspace, ['ls-files', '--others', '--exclude-standard', '-z', ...pathArgs]),
  ]);

  const untracked = splitZeroDelimited(untrackedFiles.stdout);
  const untrackedDiffs = await Promise.all(
    untracked.map(async (file) => {
      try {
        const body = readFileSync(resolve(workspace, file), 'utf8');
        return untrackedDiff(file, body);
      } catch {
        return `diff --git a/dev/null b/${file}\nBinary or unreadable untracked file: ${file}`;
      }
    }),
  );
  return {
    kind: 'working-tree',
    baseSha,
    path,
    changedFiles: [...new Set([...splitZeroDelimited(trackedFiles.stdout), ...untracked])],
    diff: ensureDiffSize([trackedDiff.stdout, ...untrackedDiffs].filter(Boolean).join('\n')),
  };
}

export function renderReviewTarget(target: ReviewTarget): string {
  const range = target.headSha
    ? `${target.baseSha}..${target.headSha}`
    : `${target.baseSha}..working-tree snapshot`;
  return [
    '## Immutable review target',
    `Range: ${range}`,
    target.path ? `Path: ${target.path}` : 'Path: entire change',
    'Changed files:',
    target.changedFiles.length
      ? target.changedFiles.map((file) => `- ${file}`).join('\n')
      : '(none)',
    '',
    'Review exactly the unified diff below. Use Read only for surrounding context.',
    'Do not run GitDiff to select a different target and do not review unrelated changes.',
    '',
    '```diff',
    target.diff,
    '```',
  ].join('\n');
}
