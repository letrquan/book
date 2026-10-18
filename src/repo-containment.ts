import { existsSync, realpathSync } from 'fs';
import { basename, dirname, join, parse, relative, resolve } from 'path';
import { renderUntrustedText } from './hook-approvals.js';
import { isOutside } from './tools/path-utils.js';

/**
 * Repository containment for the project files a repository can commit as links (#539, #543):
 * instruction files, REVIEW.md and project command files. A repository can commit any of them as
 * a link to `~/.ssh/id_rsa`, and the target would be sent to the provider as prompt text. Each
 * loader checks the real path of what it found against the real path of the repository root, and
 * reports what it refused through `formatSkippedNotice`. This module imports no loader.
 */

/** Why a project file must not load: its real path left the root, or it is not Markdown. */
export type RefusalReason = 'outside' | 'not-markdown';

/** A project file that was not loaded. */
export interface SkippedProjectFile {
  /** Where the file was found. */
  path: string;
  /** Its real path. */
  target: string;
  /** The real path of the directory it had to stay inside. */
  root: string;
  reason: RefusalReason;
}

/**
 * The native real path, else the JS one (`realpathSync.native` throws on some Windows volumes
 * where the JS version works), else `undefined`.
 */
export function tryRealPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    // Fall through to the JS implementation.
  }
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** `resolve(workspace)` and each directory above it, from the filesystem root down. */
export function ancestorsFromRoot(workspace: string): string[] {
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

/**
 * The git repository root: the nearest directory, walking up the logical path from the
 * workspace, with a `.git` entry (a directory, or a file for a linked worktree or a submodule).
 * Like `git rev-parse --show-toplevel`, a linked worktree is its own root, not its main
 * checkout (which `findGitRoot` in `memory-store.ts` maps it to, on purpose, for memory keying).
 * Only stats files; git is never spawned.
 */
export function findRepositoryRoot(workspace: string): string | undefined {
  for (const dir of ancestorsFromRoot(workspace).reverse()) {
    if (existsSync(join(dir, '.git'))) return dir;
  }
  return undefined;
}

/** The directory project files are measured from: the repository root, else the workspace. */
export function projectContainmentRoot(workspace: string): string {
  return findRepositoryRoot(workspace) ?? resolve(workspace);
}

/**
 * Why a project file must not load: its real path leaves `rootReal`, or it is not Markdown. The
 * second check is what stops a link to a secret inside the repository (`CLAUDE.md -> .env`,
 * `-> .book/settings.local.json`); a regular `CLAUDE.md`, `REVIEW.md` or command file always
 * passes it.
 */
export function refusalFor(rootReal: string, fileReal: string): RefusalReason | undefined {
  if (isOutside(rootReal, fileReal)) return 'outside';
  if (!basename(fileReal).toLowerCase().endsWith('.md')) return 'not-markdown';
  return undefined;
}

/**
 * The one-line start-up warning for a skipped file, `kind` being what it is ("project
 * instructions", "project command", "review instructions"). The path is shown relative to the
 * workspace when it is inside it. The target and the names along the way are
 * repository-authored: no control characters.
 */
export function formatSkippedNotice(
  kind: string,
  workspace: string,
  entry: SkippedProjectFile,
): string {
  const workspaceRoot = resolve(workspace);
  const shown = !isOutside(workspaceRoot, entry.path)
    ? relative(workspaceRoot, entry.path)
    : entry.path;
  const head =
    `⚠  Skipped ${kind} ${renderUntrustedText(shown, 400)}: it links to ` +
    renderUntrustedText(entry.target, 400);
  return entry.reason === 'not-markdown'
    ? `${head}, which is not a Markdown (.md) file.`
    : `${head}, outside ${renderUntrustedText(entry.root, 400)}.`;
}
