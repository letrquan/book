import { existsSync, lstatSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'path';
import { gitDirOf, visitGitIndex } from './git-index.js';
import { shellArgument } from './shell-argument.js';
import { isUncSpelling, reachesUncPath } from './unc-path.js';

/**
 * Whether git tracks a `.book/settings.local.json`.
 *
 * The local settings layer is the user's own: gitignored, and written by the user or by Book for
 * them. `.gitignore` says nothing about a file already in the index, and a local file a repository
 * ships isn't local. Book does not read a tracked one, except for restrictions, which still apply
 * (the whitelist is the loader's: `loadLocalSettingsFile`), does not write it, and says so once. An
 * untracked file, ignored or not, is the layer it always was, and the rule must not cost the user
 * that layer unless git really lists that very file. So:
 *
 * - The question goes to the index, read from its files (`git-index.ts`): git is never spawned, so
 *   no program the repository configures runs, and settings resolution, which is synchronous, can
 *   ask. Every repository at or above the file is asked, since whichever lists it ships it.
 * - An entry counts only if it names this file. A path that isn't this file isn't this file, so
 *   another spelling never counts by how it reads. Where a file system may fold names, an entry
 *   that could be another spelling of the path counts if the disk says it reaches this file; what a
 *   file system folds (case, Unicode equivalents, a short name) is the file system's to say.
 * - A link cannot move a tracked file out of sight: the file is also asked about where a link takes
 *   it, when that is inside the workspace's repository or a link that repository tracks led there.
 *   A link of the user's own to somewhere else is their setup, whatever tracks the far end.
 * - The nearest repository that cannot answer counts as listing the file, and the reason says so.
 */
export type LocalSettingsTracking =
  | { state: 'untracked' }
  | {
      state: 'tracked';
      /** The root of the repository that lists it. */
      repository: string;
      /** The path as that index lists it, `/`-separated: repository-authored text. */
      path: string;
      /** The workspace is that repository's root, and the entry is the file's own name. */
      direct: boolean;
    }
  /** The nearest repository's index could not be read. */
  | { state: 'unknown'; repository: string };

const MODE_LINK = 0o120000;

/** An index path, stored as one character per byte (`GitIndexEntry.path`), as text. */
function indexPathText(path: string): string {
  return /[\x80-\xff]/.test(path) ? Buffer.from(path, 'latin1').toString('utf-8') : path;
}

/** Text as the index stores it. */
function indexPathOf(text: string): string {
  return Buffer.from(text, 'utf-8').toString('latin1');
}

/** Whether two paths reach one directory entry: the file system's say, never the spelling's. */
function reachSameEntry(left: string, right: string): boolean {
  if (reachesUncPath(left) || reachesUncPath(right)) return false;
  try {
    const a = lstatSync(left, { bigint: true, throwIfNoEntry: false });
    const b = lstatSync(right, { bigint: true, throwIfNoEntry: false });
    return a !== undefined && b !== undefined && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** One path in a repository, in the forms an index entry is compared with. */
interface Wanted {
  absolute: string;
  /** As the index would store it. */
  exact: string;
  /** The same, lowercased, for an ASCII path. */
  lowered: string | undefined;
  /** How many `/` it has: no file system folds one away. */
  depth: number;
}

function slashes(path: string): number {
  let count = 0;
  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) count += 1;
  return count;
}

function wantedIn(root: string, absolute: string): Wanted {
  const exact = indexPathOf(relative(root, absolute).split(sep).join('/'));
  return {
    absolute,
    exact,
    lowered: /[\x80-\xff]/.test(exact) ? undefined : exact.toLowerCase(),
    depth: slashes(exact),
  };
}

/** The last name in `path` in the other case, or undefined when it has no letters to change. */
function otherCaseOf(path: string): string | undefined {
  const name = basename(path);
  const upper = name.toUpperCase();
  const other = upper === name ? name.toLowerCase() : upper;
  return other === name ? undefined : join(dirname(path), other);
}

/**
 * Whether another spelling of `location` can reach it here. Windows and macOS are taken as yes,
 * since what they fold goes beyond case, and even a case-sensitive macOS volume folds Unicode
 * equivalents. Anywhere else (a case-insensitive Linux mount, a casefold directory) the disk is
 * asked, for each name below `root`: a name and its other case reaching one entry. A link can't
 * fake that: `lstat` sees the link, not what it points at.
 */
function spellingsMayAlias(root: string, location: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  for (let path = location; path !== root && path !== dirname(path); path = dirname(path)) {
    const other = otherCaseOf(path);
    if (other !== undefined && reachSameEntry(path, other)) return true;
  }
  return false;
}

/**
 * Whether the entry `path` names `wanted`: the very bytes or, where spellings may alias, an entry
 * the disk says reaches the same place. Only plain ASCII is ruled out by reading it: ASCII folds
 * only to ASCII, but any other byte, or a `~` (a Windows short name), can spell anything.
 */
function namesPath(root: string, path: string, wanted: Wanted, spellingsAlias: boolean): boolean {
  if (path === wanted.exact) return true;
  if (!spellingsAlias) return false;
  if (wanted.lowered !== undefined && !/[\x80-\xff~]/.test(path)) {
    if (path.length !== wanted.lowered.length || path.toLowerCase() !== wanted.lowered) {
      return false;
    }
  } else if (slashes(path) !== wanted.depth) {
    return false;
  }
  return reachSameEntry(join(root, indexPathText(path)), wanted.absolute);
}

interface IndexAnswer {
  /** The entry that names the file, in the index's own form. */
  listedAs?: string;
  /** The index lists a link where the file's folder should be. */
  folderIsTrackedLink: boolean;
}

function askIndex(gitDir: string, root: string, location: string): IndexAnswer {
  const file = wantedIn(root, location);
  const folder = wantedIn(root, dirname(location));
  const spellingsAlias = spellingsMayAlias(root, location);
  const answer: IndexAnswer = { folderIsTrackedLink: false };
  visitGitIndex(
    gitDir,
    (path, mode) => {
      if (namesPath(root, path, file, spellingsAlias)) {
        answer.listedAs = path;
        return true;
      }
      if (mode === MODE_LINK && namesPath(root, path, folder, spellingsAlias)) {
        answer.folderIsTrackedLink = true;
      }
      return false;
    },
    // Entries are sorted by bytes, so nothing past the very bytes can be them. A spelling can sort
    // anywhere: a byte past ASCII sorts after every ASCII one.
    spellingsAlias ? undefined : (path) => path > file.exact,
  );
  return answer;
}

/**
 * The git dir of the repository whose `.git` entry is in `root`; `undefined` when git would not
 * take that entry as one (a `.git` directory with no `HEAD`). Throws when it names a place that
 * does not exist or cannot be told. Nothing that reaches a UNC location is touched (#579).
 */
function gitDirOfRepository(root: string): string | undefined {
  const gitDir = gitDirOf(root);
  const head = join(gitDir, 'HEAD');
  if (reachesUncPath(head)) throw new Error(`${root} has its git directory on a network share`);
  if (existsSync(head)) return gitDir;
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

interface RepositoriesAnswer {
  tracking: LocalSettingsTracking;
  /** The nearest repository, readable or not. */
  nearest?: string;
  folderIsTrackedLink: boolean;
}

/** What the repositories at or above `start` say about the file at `location`. */
function askRepositories(location: string, start: string): RepositoriesAnswer {
  let nearest: string | undefined;
  let unknown: LocalSettingsTracking | undefined;
  let folderIsTrackedLink = false;
  for (const root of gitRootsAbove(start)) {
    try {
      const gitDir = gitDirOfRepository(root);
      if (gitDir === undefined) continue;
      const answer = askIndex(gitDir, root, location);
      if (answer.listedAs !== undefined) {
        const path = indexPathText(answer.listedAs);
        const tracking: LocalSettingsTracking = {
          state: 'tracked',
          repository: root,
          path,
          direct: false,
        };
        return { tracking, nearest: nearest ?? root, folderIsTrackedLink };
      }
      if (nearest === undefined) folderIsTrackedLink = answer.folderIsTrackedLink;
    } catch {
      // Only the nearest repository's index decides. One further up has nothing to say about a
      // repository inside it, and a broken one must not cost every project below it its settings.
      if (nearest === undefined) unknown = { state: 'unknown', repository: root };
    }
    nearest ??= root;
  }
  return { tracking: unknown ?? { state: 'untracked' }, nearest, folderIsTrackedLink };
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

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * What git says about the local settings file at `path`, whether or not it exists: a save would
 * create one the index may already list. Never throws.
 */
export function localSettingsTracking(path: string): LocalSettingsTracking {
  const literal = resolve(path);
  // A link to a share is not followed to find out where it goes. A workspace that is on one is the
  // user's choice, and goes on to the repository, where `git-index.ts` declines to read it.
  if (!isUncSpelling(literal) && reachesUncPath(literal)) {
    return { state: 'unknown', repository: dirname(literal) };
  }

  // The repository is found from where the workspace really is, as git does. What is left of the
  // path is `.book` and the file, either of which can be a link.
  const folderName = basename(dirname(literal));
  const workspace = dirname(dirname(literal));
  const realWorkspace = realPathOf(workspace) ?? workspace;
  const where = join(realWorkspace, folderName, basename(literal));
  // A real `.book` with a `.git` of its own is a repository (a submodule); a linked one is not
  // that here: where it leads is the question below.
  let folderIsLink = false;
  try {
    folderIsLink = lstatSync(dirname(where), { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  } catch {
    // Nothing there to follow.
  }
  const here = askRepositories(where, folderIsLink ? realWorkspace : dirname(where));
  if (here.tracking.state === 'tracked') {
    const direct =
      here.tracking.repository === realWorkspace &&
      here.tracking.path === posix.join(folderName, basename(literal));
    return { ...here.tracking, direct };
  }

  const real = realPathOf(literal);
  if (real === undefined || real === where || here.nearest === undefined) return here.tracking;
  if (!here.folderIsTrackedLink && !isInside(here.nearest, real)) return here.tracking;
  const there = askRepositories(real, dirname(real));
  return there.tracking.state === 'untracked' ? here.tracking : there.tracking;
}

/** What may go on a command line from an index path: repository-authored, so a whitelist. */
const PASTEABLE_INDEX_PATH = /^[A-Za-z0-9_@+=:,./ -]+$/;

/** The remedy for a tracked file, or null when its names cannot be pasted safely. */
function removeFromIndexCommand(tracking: {
  repository: string;
  path: string;
  direct: boolean;
}): string | null {
  const path = PASTEABLE_INDEX_PATH.test(tracking.path) ? shellArgument(tracking.path) : null;
  if (path === null) return null;
  if (tracking.direct) return `git rm --cached ${path}`;
  const repository = shellArgument(tracking.repository);
  return repository === null ? null : `git -C ${repository} rm --cached -- ${path}`;
}

/** A path for a terminal: below the workspace, its names can be a repository's (a submodule's). */
function printable(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

/** The sentence for a file Book does not treat as local: no path and no full stop. */
function describeTracking(tracking: LocalSettingsTracking): string | undefined {
  switch (tracking.state) {
    case 'untracked':
      return undefined;
    case 'tracked': {
      const command = removeFromIndexCommand(tracking);
      return (
        "git tracks it, and a local file a repository ships isn't local, so Book does not read " +
        'it, except for restrictions, which still apply, and does not write it. Review it, then ' +
        (command === null
          ? `remove it from the index of ${printable(tracking.repository)} with \`git rm --cached\``
          : `run \`${command}\``) +
        ' to make it your own'
      );
    }
    case 'unknown':
      return (
        `Book could not read the git index of ${printable(tracking.repository)}, so it cannot tell ` +
        'whether git tracks this file. It does not read it, except for restrictions, which still ' +
        'apply, and does not write it. `git status` shows what is wrong'
      );
  }
}

/**
 * Why Book will not write the local settings file at `path`, or undefined when it may. Asks git
 * whether or not the file exists, since a save would create it.
 */
export function localSettingsRefusal(path: string): string | undefined {
  return describeTracking(localSettingsTracking(path));
}

/**
 * Why Book is not reading the local settings file at `path` as the user's own: the one question
 * whether that file is a layer. Undefined when it is, and when there is no file to read, so absent
 * means no index is parsed and nothing is refused.
 */
export function unreadLocalSettingsReason(path: string): string | undefined {
  const literal = resolve(path);
  if ((isUncSpelling(literal) || !reachesUncPath(literal)) && !existsSync(literal)) {
    return undefined;
  }
  return localSettingsRefusal(literal);
}

/**
 * Whether a path has the *shape* of a root's Book-local settings file or directory, whatever root
 * is being asked about: the last segment is `.book`, or `settings.local.json` under one.
 *
 * The cheap half of `isBookLocalSettingsPath`, and the half worth running for every file a Grep
 * lists, because the rest of that answer costs a `realpath` per root. Sound rather than exact — a
 * `.book` somewhere below a root has the shape without being that root's — which is what a
 * prefilter has to be.
 */
export function hasBookLocalSettingsShape(
  canonicalPath: string,
  options: { directory?: boolean } = {},
): boolean {
  const parts = canonicalPath.toLowerCase().split(/[\\/]/);
  if (parts[parts.length - 1] === '.book') return options.directory === true;
  return parts[parts.length - 2] === '.book' && parts[parts.length - 1] === 'settings.local.json';
}
