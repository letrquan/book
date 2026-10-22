import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, parse, relative, resolve } from 'path';
import { renderUntrustedText } from './hook-approvals.js';
import { isOutside } from './tools/path-utils.js';
import { reachesUncPath } from './unc-path.js';

/**
 * Repository containment for the project files a repository can commit as links (#539, #543):
 * instruction files, REVIEW.md and project command files. A repository can commit any of them as
 * a link to `~/.ssh/id_rsa`, and the target would be sent to the provider as prompt text. Each
 * loader checks the real path of what it found against the real path of the repository root, and
 * reports what it refused through `formatSkippedNotice`. An `@path` mention follows Read's
 * boundary instead (`src/input/input-expansion.ts`, #567). This module imports no loader.
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
 * where the JS version works), else `undefined`. Also `undefined`, before anything is resolved,
 * for a Windows path that is, or reaches through a link, a UNC location (`reachesUncPath`), so no
 * containment check sends a request to a host a repository named (#567).
 */
export function tryRealPath(path: string): string | undefined {
  if (reachesUncPath(path)) return undefined;
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
 * The git repository root, as a real path: the nearest directory, walking up the real path of
 * `dir`, with a `.git` entry (a directory, or a file for a linked worktree or a submodule). Like
 * `git rev-parse --show-toplevel`, which starts from the real working directory, so the root
 * always contains the real path of `dir`, and a workspace opened through a link finds the
 * repository it is really in. A linked worktree is its own root, not its main checkout (which
 * `findGitRoot` in `memory-store.ts` maps it to, on purpose, for memory keying). Only stats
 * files; git is never spawned.
 *
 * A `.git` at the real path of `home` (the user's home directory by default, read on every call)
 * is a dotfiles repository, not a project: it is no repository (`undefined`, and the walk stops),
 * so a project under the home directory without its own `.git` is measured as one in no
 * repository, not from the whole home directory. Unlike the git consumers'
 * {@link ignoresHomeRepository}, this holds for `dir` being the home directory too: a file found
 * in the home directory while the workspace is in a repository of its own is the user's, not
 * checked against the home directory (`claude-md.ts`).
 */
export function findRepositoryRoot(dir: string, home?: string): string | undefined {
  // Its ancestors are probed for `.git` below, which would reach the share as well.
  if (reachesUncPath(dir)) return undefined;
  for (const candidate of ancestorsFromRoot(tryRealPath(dir) ?? resolve(dir)).reverse()) {
    if (existsSync(join(candidate, '.git'))) {
      return isUserHome(candidate, home) ? undefined : candidate;
    }
  }
  return undefined;
}

/**
 * The real path of `home`, the user's home directory when not given (read on every call, from
 * `USERPROFILE` on Windows), or `undefined` when there is none or it does not resolve.
 */
function userHomeReal(home: string | undefined): string | undefined {
  let path = home;
  if (path === undefined) {
    try {
      path = homedir();
    } catch {
      return undefined;
    }
  }
  return path ? tryRealPath(path) : undefined;
}

/** Whether the real path `real` is that of `home`, the user's home directory when not given. */
export function isUserHome(real: string, home: string | undefined): boolean {
  const homeReal = userHomeReal(home);
  // `relative`, so the comparison ignores case where the platform's paths do (Windows).
  return homeReal !== undefined && relative(homeReal, real) === '';
}

/**
 * The home-directory rule for the repository a workspace is in (#567, #579): whether the
 * repository whose top directory git or a `.git` walk found at `top`, starting from `workspace`,
 * is a dotfiles repository to ignore. It is when `top` is the user's home directory (`home` when
 * given) and `workspace` is not, which is a project below the home directory with no `.git` of its
 * own (the walk would have stopped there). A workspace that is the home directory itself is in
 * that repository. Both paths are compared as real paths, as `isUserHome` does.
 *
 * This is the rule git applies to Book's own calls through {@link homeGitCeiling}, for the
 * callers that decide without git: the prompt's git line, the TUI status poll, and managed-agent
 * isolation. Containment (`findRepositoryRoot`) asks about every directory a file was found in,
 * the home directory among them, so it keeps its own rule: a `.git` at the home directory is
 * never a repository there.
 */
export function ignoresHomeRepository(top: string, workspace: string, home?: string): boolean {
  const homeReal = userHomeReal(home);
  if (homeReal === undefined) return false;
  const topReal = tryRealPath(top) ?? resolve(top);
  const workspaceReal = tryRealPath(workspace) ?? resolve(workspace);
  return relative(homeReal, topReal) === '' && relative(homeReal, workspaceReal) !== '';
}

/**
 * The `GIT_CEILING_DIRECTORIES` entry Book's own git calls carry (`hardenedGitEnv`): the real path
 * of the user's home directory (`home` when given) when it holds a `.git`, else `undefined`, so a
 * repository above a home directory without one is still found. Git never stops at the directory
 * it starts in, so a workspace that is the home directory still finds its repository, while a
 * project below it with no `.git` of its own finds none: {@link ignoresHomeRepository}, applied
 * by git. A real path, so the entry matches whether or not the list starts with the empty entry
 * that turns off git's own resolution of the entries after it.
 */
export function homeGitCeiling(home?: string): string | undefined {
  const homeReal = userHomeReal(home);
  return homeReal !== undefined && existsSync(join(homeReal, '.git')) ? homeReal : undefined;
}

/** The directory project files are measured from: the repository root, else the workspace. */
export function projectContainmentRoot(workspace: string, home?: string): string {
  return findRepositoryRoot(workspace, home) ?? resolve(workspace);
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
