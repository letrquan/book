import { existsSync, realpathSync } from 'fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'path';
import { resolveBookHome } from './book-home.js';
import {
  commonDirOf,
  gitDirOf,
  indexFilesOf,
  objectNameBytes,
  readGitIndex,
  type GitIndexEntry,
} from './git-index.js';
import { isOutside } from './tools/path-utils.js';
import { reachesUncPath } from './unc-path.js';

/**
 * Files a repository ships under Book's home.
 *
 * Book's home (`resolveBookHome`: `BOOK_HOME`, else `~/.book`) holds the user's own configuration
 * and the decisions they made about the input a repository declares. It can also lie inside a
 * repository: the home directory is itself a checkout (`HOME=/app` with the project cloned at
 * `/app`), or `BOOK_HOME` names a directory in one. A file that repository tracks there is the
 * repository's content, not the user's, so each reader of the home takes it as such: the settings
 * file only as the project layer (and only when it is the workspace's own project file), and every
 * other file not at all. A reader of a directory (`commands/`, `agents/`, `skills/`, the memory
 * tree, the managed-agents store) takes one the repository ships anything in as the repository's
 * whole. Other untracked files there, which Book or the user wrote, are read as before; a dotfiles
 * repository at `~` that does not track `~/.book` changes nothing.
 *
 * "Ships" is decided by the repository the workspace belongs to (the nearest `.git` at or above
 * it, the home directory's own included), from its index: a file is shipped when the index lists
 * it, or lists one of its ancestors as a link, a submodule or a sparse directory. The home is
 * measured both where it really is and where its own name stands, so a home that is a tracked link
 * is shipped whole. A repository whose index cannot be read ships everything under the home.
 */
export interface ShippedHomeFiles {
  /** Book's home, as given (`resolveBookHome()` by default). */
  readonly home: string;
  /** The root of the repository that ships them. */
  readonly repository: string;
  /** Whether the repository's index could not be read, so every file under the home counts. */
  readonly unreadable: boolean;
  /** Whether the repository tracks the home itself (a link, a submodule), so all of it counts. */
  readonly whole: boolean;
  /** The shipped paths under the home, `/`-separated and sorted; empty when it ships it whole. */
  readonly paths: readonly string[];
  /** Whether the repository ships `path`, a path under the home. False for any other path. */
  ships(path: string): boolean;
  /** Whether it ships `dir`, a directory under the home, or anything inside it. */
  shipsAnyUnder(dir: string): boolean;
}

/**
 * Real path of `path`, or `undefined`; never resolved through a UNC location. `tryRealPath` in
 * `repo-containment.ts` does the same, but importing it would close an import cycle
 * (`repo-containment` → `hook-approvals` → `workspace-trust` → here).
 */
function realPathOf(path: string): string | undefined {
  if (reachesUncPath(path)) return undefined;
  try {
    return realpathSync.native(path);
  } catch {
    // Fall through to the JS implementation (some Windows volumes).
  }
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** The real path of the nearest existing ancestor of `path` (or itself), with the rest appended. */
function realOrNearest(path: string): string | undefined {
  const absolute = resolve(path);
  const rest: string[] = [];
  let current = absolute;
  while (true) {
    const real = realPathOf(current);
    if (real !== undefined) return rest.length ? join(real, ...rest.reverse()) : real;
    const parent = dirname(current);
    if (parent === current) return undefined;
    rest.push(basename(current));
    current = parent;
  }
}

/** The nearest directory at or above `dir` with a `.git` entry. */
function repositoryRootOf(dir: string): string | undefined {
  const root = parse(dir).root;
  let current = dir;
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    if (current === root) return undefined;
    current = dirname(current);
  }
}

/** `child` relative to `root`, `/`-separated; `undefined` when it is not inside it. */
function inside(root: string, child: string): string | undefined {
  return isOutside(root, child) ? undefined : relative(root, child).split(sep).join('/');
}

/** Paths fold case where the file system usually does (Windows, macOS); ASCII letters only. */
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin';

/** `path` with its ASCII letters lowercased where case folds. */
function folded(path: string): string {
  return FOLDS_CASE ? path.replace(/[A-Z]+/g, (letters) => letters.toLowerCase()) : path;
}

/** A path as the index stores it: UTF-8 bytes, one character each, case folded where it folds. */
function indexForm(path: string): string {
  return folded(Buffer.from(path, 'utf-8').toString('latin1'));
}

/** Whether `ancestor` names a directory above `path` (both in index form, no trailing `/`). */
function isAbove(ancestor: string, path: string): boolean {
  return ancestor === '' || path.startsWith(`${ancestor}/`);
}

/**
 * Collects what the index lists at or above the home (`prefixes`, repository-relative, index
 * form). An entry at or above a prefix ships the whole home; one below it ships that path.
 */
function classify(
  entries: GitIndexEntry[],
  prefixes: string[],
): { whole: boolean; shipped: Set<string> } {
  let whole = false;
  const shipped = new Set<string>();
  for (const entry of entries) {
    const path = folded(entry.path);
    // A sparse index's directory entry ends in `/`.
    const name = path.endsWith('/') ? path.slice(0, -1) : path;
    if (name === '') continue;
    for (const prefix of prefixes) {
      if (name === prefix || isAbove(name, prefix)) whole = true;
      else if (isAbove(prefix, name))
        shipped.add(prefix === '' ? name : name.slice(prefix.length + 1));
    }
  }
  return { whole, shipped };
}

/**
 * Whether an index entry `path` sorts after everything at or below each of `prefixes`, so the
 * read can stop there: everything under `p/` sorts before `p0` (`/` is 0x2F, `0` is 0x30). Where
 * case folds, the all-lowercase spelling of a prefix is the last of its spellings in byte order,
 * so it bounds them all; a prefix with a byte past ASCII has spellings this does not fold, and no
 * bound.
 */
function pastAll(prefixes: string[]): (path: string) => boolean {
  const unbounded = (prefix: string) =>
    prefix === '' || (FOLDS_CASE && /[^\x00-\x7f]/.test(prefix));
  if (prefixes.some(unbounded)) return () => false;
  const bound = prefixes.map((prefix) => `${prefix}0`).sort()[prefixes.length - 1];
  return (path) => path >= bound;
}

function shippedFiles(
  home: string,
  repository: string,
  whole: boolean,
  shipped: Set<string>,
  unreadable: boolean,
): ShippedHomeFiles {
  const homeAbsolute = resolve(home);
  const underHome = (path: string): string | undefined => {
    const rel = inside(homeAbsolute, resolve(path));
    return rel === undefined ? undefined : indexForm(rel);
  };
  return {
    home,
    repository,
    unreadable,
    whole,
    paths: [...shipped].sort().map((path) => Buffer.from(path, 'latin1').toString('utf-8')),
    ships(path) {
      const rel = underHome(path);
      if (rel === undefined) return false;
      if (whole) return true;
      for (const entry of shipped) if (entry === rel || isAbove(entry, rel)) return true;
      return false;
    },
    shipsAnyUnder(dir) {
      const rel = underHome(dir);
      if (rel === undefined) return false;
      if (whole) return true;
      for (const entry of shipped) {
        if (entry === rel || isAbove(entry, rel) || isAbove(rel, entry)) return true;
      }
      return false;
    },
  };
}

/**
 * The files under `home` that the repository `workspace` belongs to ships, or `undefined` when it
 * ships none (the home is outside that repository, the workspace is in no repository, or the index
 * lists nothing there). Reads files only; git is never spawned (`git-index.ts`).
 */
export function shippedHomeFiles(
  workspace: string,
  home: string = resolveBookHome(),
): ShippedHomeFiles | undefined {
  // A share is never probed: listing or resolving it can reach the host it names.
  if (reachesUncPath(home) || reachesUncPath(workspace)) return undefined;
  const workspaceReal = realOrNearest(workspace);
  const repository = workspaceReal && repositoryRootOf(workspaceReal);
  if (!repository) return undefined;

  // Where the home really is, and where its own name stands (a link to it counts there).
  const homeAbsolute = resolve(home);
  const locations = [
    realOrNearest(homeAbsolute),
    (() => {
      const parent = realOrNearest(dirname(homeAbsolute));
      return parent === undefined ? undefined : join(parent, basename(homeAbsolute));
    })(),
  ];
  const prefixes = [
    ...new Set(
      locations.flatMap((location) => {
        const rel = location === undefined ? undefined : inside(repository, location);
        return rel === undefined ? [] : [indexForm(rel)];
      }),
    ),
  ];
  if (prefixes.length === 0) return undefined;

  let entries: GitIndexEntry[];
  try {
    const gitDir = gitDirOf(repository);
    const nameBytes = objectNameBytes(commonDirOf(gitDir));
    const past = pastAll(prefixes);
    entries = indexFilesOf(gitDir).flatMap((file) => readGitIndex(file, nameBytes, past) ?? []);
  } catch {
    return shippedFiles(home, repository, true, new Set(), true);
  }
  const { whole, shipped } = classify(entries, prefixes);
  if (!whole && shipped.size === 0) return undefined;
  return shippedFiles(home, repository, whole, shipped, false);
}
