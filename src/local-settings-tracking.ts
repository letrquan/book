import { existsSync, lstatSync, realpathSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { commonDirOf, gitDirOf, indexFilesOf, objectNameBytes, readGitIndex } from './git-index.js';
import { isUncSpelling, reachesUncPath } from './unc-path.js';

/**
 * Whether git tracks a `.book/settings.local.json`.
 *
 * The local settings layer is the user's own: gitignored, and written by the user or by Book for
 * them. `.gitignore` says nothing about a file already in the index, and a local file a repository
 * ships isn't local, so a tracked one is no layer at all. Book neither reads nor writes it, for any
 * key, and says so once. An untracked file, ignored or not, is the layer it always was.
 *
 * The question goes to the index, read from its files (`git-index.ts`): git is never spawned, so
 * no program the repository configures runs, and settings resolution, which is synchronous, can
 * ask. It is asked of the file where its name stands and where it really is, so a link cannot move
 * a tracked file out of sight, and of every repository above it. The nearest repository that
 * cannot answer counts as tracking the file: the rule can only cost a read, never grant one.
 */
export type LocalSettingsTracking =
  | { state: 'untracked' }
  /** `direct`: the index lists the file under its own name, not the file a link reaches. */
  | { state: 'tracked'; direct: boolean }
  /** The nearest repository's index could not be read. */
  | { state: 'unknown'; repository: string };

const MODE_SUBMODULE = 0o160000;
const MODE_SPARSE_DIRECTORY = 0o040000;

/**
 * Two spellings of one file on some file system compare equal in this form: normalized, with its
 * ASCII letters lowercased. Applied everywhere, and not only where the file system folds (Linux has
 * case-insensitive mounts too), because an extra match costs only a read.
 */
function comparable(path: string): string {
  return path.normalize('NFC').replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** An index path, stored as one character per byte (`GitIndexEntry.path`), as text. */
function indexPathText(path: string): string {
  return /[\x80-\xff]/.test(path) ? Buffer.from(path, 'latin1').toString('utf-8') : path;
}

/** Whether a repository lists `target` (in {@link comparable} form) in one of its index files. */
function indexLists(gitDir: string, target: string, nearest: boolean): boolean {
  const nameBytes = objectNameBytes(commonDirOf(gitDir));
  // Entries are sorted by bytes, and the all-lowercase spelling of an ASCII path is the last of its
  // spellings in that order, so nothing past it can match. Anything else has no such bound. Every
  // spelling of an ASCII path has its length too, which spares most entries the comparison.
  const ascii = !/[\u0080-\uffff]/.test(target);
  const past = ascii ? (path: string): boolean => path > target : undefined;
  for (const file of indexFilesOf(gitDir)) {
    for (const entry of readGitIndex(file, nameBytes, past) ?? []) {
      // A directory the index folds, or a submodule with no `.git` of its own below it (a nearer
      // repository would have been asked instead): what lies below cannot be told from here. Only
      // the nearest repository's say: every submodule is an entry of the repository above it.
      const folds =
        nearest && (entry.mode === MODE_SPARSE_DIRECTORY || entry.mode === MODE_SUBMODULE);
      if (ascii && !folds && entry.path.length !== target.length) continue;
      const path = comparable(indexPathText(entry.path));
      if (path === target) return true;
      if (folds && target.startsWith(path.endsWith('/') ? path : `${path}/`)) return true;
    }
  }
  return false;
}

/**
 * The git dir of the repository whose `.git` entry is in `root`; `undefined` when git would not
 * take that entry as one (a `.git` directory with no `HEAD`). Throws when it names a place that
 * does not exist or cannot be told.
 */
function gitDirOfRepository(root: string): string | undefined {
  const gitDir = gitDirOf(root);
  if (reachesUncPath(gitDir)) throw new Error(`${root} has its git directory on a network share`);
  if (existsSync(join(gitDir, 'HEAD'))) return gitDir;
  if (gitDir === join(root, '.git')) return undefined;
  throw new Error(`the .git file in ${root} names a directory that does not exist`);
}

/** Every directory at or above `start` with a `.git` entry, nearest first. Follows no `.git` link. */
function* gitRootsAbove(start: string): Generator<string> {
  let directory = start;
  while (true) {
    let hasEntry = false;
    try {
      hasEntry = lstatSync(join(directory, '.git'), { throwIfNoEntry: false }) !== undefined;
    } catch {
      // A directory that cannot be searched has nothing to say.
    }
    if (hasEntry) yield directory;
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

function realPathOf(path: string): string | undefined {
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

/**
 * What git says about the file at `path`, whether or not it exists: a save would create one the
 * index may already list. Never throws.
 */
export function localSettingsTracking(path: string): LocalSettingsTracking {
  const literal = resolve(path);
  // A link to a share is not followed to find out where it goes. A workspace that is on one is the
  // user's choice, and goes on to the repository, where `git-index.ts` declines to read it.
  if (!isUncSpelling(literal) && reachesUncPath(literal)) {
    return { state: 'unknown', repository: dirname(literal) };
  }
  const real = realPathOf(literal);
  let unknown: LocalSettingsTracking | undefined;
  for (const location of real !== undefined && real !== literal ? [literal, real] : [literal]) {
    let nearest = true;
    for (const root of gitRootsAbove(dirname(location))) {
      try {
        const gitDir = gitDirOfRepository(root);
        if (gitDir === undefined) continue;
        const target = comparable(relative(root, location).split(sep).join('/'));
        if (indexLists(gitDir, target, nearest)) {
          return { state: 'tracked', direct: location === literal };
        }
      } catch {
        if (nearest) unknown ??= { state: 'unknown', repository: root };
      }
      nearest = false;
    }
  }
  return unknown ?? { state: 'untracked' };
}

/** The sentence for a file git does not leave to the user: no path and no full stop. */
function describeTracking(tracking: LocalSettingsTracking): string | undefined {
  switch (tracking.state) {
    case 'untracked':
      return undefined;
    case 'tracked':
      return (
        "git tracks it, and a local file a repository ships isn't local, so Book neither reads " +
        'nor writes it. Review it, then run ' +
        (tracking.direct
          ? '`git rm --cached .book/settings.local.json`'
          : '`git rm --cached` on the file it links to') +
        ' to make it your own'
      );
    case 'unknown':
      return (
        `Book could not read the git index of ${tracking.repository}, so it cannot tell whether ` +
        'git tracks this file, and neither reads nor writes it. `git status` shows what is wrong'
      );
  }
}

/** Why Book will not write the local settings file at `path`, or undefined when it may. */
export function localSettingsRefusal(path: string): string | undefined {
  return describeTracking(localSettingsTracking(path));
}

/**
 * Why Book is not reading the local settings file at `path`, or undefined when it is, or when
 * there is no file to read. What every reader of the local layer asks first.
 */
export function unreadLocalSettingsReason(path: string): string | undefined {
  const literal = resolve(path);
  if ((isUncSpelling(literal) || !reachesUncPath(literal)) && !existsSync(literal)) {
    return undefined;
  }
  return localSettingsRefusal(literal);
}

/** Whether `path` has the shape of a workspace's local settings file. */
export function isLocalSettingsPath(path: string): boolean {
  const parts = resolve(path).split(sep);
  return parts.at(-1) === 'settings.local.json' && parts.at(-2) === '.book';
}
