import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ReviewScope } from './types.js';
import { buildChildEnv } from '../child-env.js';
import { hardenedGitArgs } from '../tools/git.js';

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

/**
 * The two flags that close the routes a checkout owns for producing a diff: `diff.external` names
 * a program to produce it, and a `.gitattributes` `textconv` line names one per file. On the
 * command as well as in the config, so the guarantee does not rest on the `-c` overrides being
 * consulted for this subcommand.
 */
const DIFF_ARGS = ['--no-ext-diff', '--no-textconv'] as const;

/**
 * A read-only report, and this module's git calls all are one: none of them changes the
 * repository, and none of them is a tool call the operator can be asked about, so a checkout's
 * own `.git/config` must not be able to make one run a program. `hardenedGitArgs` is the same
 * hardening the read-only Git tools carry — `core.fsmonitor` is a command `git diff` and
 * `git ls-files` execute, and `core.pager` a command git runs to page what they print. A pager
 * and a credential prompt it cannot wait on come with it, as in `readOnlyGit`.
 */
function git(workspace: string, args: string[], allowExitCodes: number[] = []): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      hardenedGitArgs(args),
      {
        cwd: workspace,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        env: buildChildEnv(process.env, { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }),
      },
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

/**
 * A ref that starts with `-` is an option to git rather than a ref, so a ref may not start with
 * one: `--is-ancestor` in that position changes what `merge-base` reports instead of naming a
 * commit. This is defense in depth, not a known code-execution path — the refs here are typed by
 * the operator rather than chosen by a model, and git has no option on these subcommands that
 * runs a program. Checked before anything is spawned, so a rejected ref costs no git call.
 */
function gitRef(ref: string): string {
  if (ref.startsWith('-')) throw new Error(`Invalid git ref: ${ref}`);
  return ref;
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

/** An entry that is not a regular file, and so is reported without opening it. */
function unreadableUntrackedDiff(file: string): string {
  return `diff --git a/dev/null b/${file}\nBinary or unreadable untracked file: ${file}`;
}

/**
 * A link, named as one. The target is reported because it is text on the entry itself, and the
 * target's *contents* are not read: `readFileSync` follows the link, so an untracked link to a
 * file outside the repository would paste that file into the review diff.
 */
function untrackedSymlinkDiff(file: string, linkTarget: string): string {
  return [
    `diff --git a/dev/null b/${file}`,
    'new file mode 120000',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    `+symlink -> ${linkTarget}`,
  ].join('\n');
}

export async function resolveReviewTarget(
  workspace: string,
  scope: ReviewScope,
): Promise<ReviewTarget> {
  if (scope.error) throw new Error(scope.error);
  if (scope.base) gitRef(scope.base);
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
    const base = gitRef(baseRef);
    const head = gitRef(headRef);
    const baseSha = (await git(workspace, ['merge-base', base, head])).stdout.trim();
    const headSha = await resolveCommit(workspace, head);
    const [files, diff] = await Promise.all([
      git(workspace, ['diff', ...DIFF_ARGS, '--name-only', '-z', baseSha, headSha, ...pathArgs]),
      git(workspace, [
        'diff',
        ...DIFF_ARGS,
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
    git(workspace, ['diff', ...DIFF_ARGS, '--name-only', '-z', baseSha, ...pathArgs]),
    git(workspace, [
      'diff',
      ...DIFF_ARGS,
      '--binary',
      '--full-index',
      '--unified=5',
      baseSha,
      ...pathArgs,
    ]),
    git(workspace, ['ls-files', '--others', '--exclude-standard', '-z', ...pathArgs]),
  ]);

  const untracked = splitZeroDelimited(untrackedFiles.stdout);
  const untrackedDiffs = await Promise.all(
    untracked.map(async (file) => {
      const filePath = resolve(workspace, file);
      try {
        // What the entry is, not what it opens: a link resolves through itself, so reading one
        // would paste a file from outside the repository into the diff, and a FIFO blocks the
        // open until a writer arrives, which a synchronous read never sees. `lstat` answers
        // about the entry itself, and the entry can have changed since git listed it.
        const stats = lstatSync(filePath);
        if (stats.isSymbolicLink()) return untrackedSymlinkDiff(file, readlinkSync(filePath));
        if (!stats.isFile()) return unreadableUntrackedDiff(file);
        return untrackedDiff(file, readFileSync(filePath, 'utf8'));
      } catch {
        return unreadableUntrackedDiff(file);
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
