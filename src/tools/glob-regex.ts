import { isAbsolute, posix, resolve } from 'node:path';
import picomatch from 'picomatch';
import { convertPathToPattern } from 'tinyglobby';
import { createDebugLogger } from '../debug-log.js';

/**
 * Convert a glob pattern to a regex. Supports * (any chars) and ** (same as *).
 * The pattern is anchored at both ends (^...$).
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

const log = createDebugLogger('tools:glob');

/**
 * The longest pattern handed to picomatch, the matcher tinyglobby walks with.
 *
 * The limit is the one `micromatch` enforced before this walk (`Input length (40000), exceeds max
 * characters (10000)`), so a pattern that was answered then is still answered. It is not what keeps
 * the process alive, though — see {@link MAX_GLOB_GROUP_DEPTH}.
 */
export const MAX_GLOB_PATTERN_LENGTH = 10_000;

/**
 * How deeply one pattern may nest a group, and how many it may open.
 *
 * The length limit is not the guard that matters. Two patterns well inside it take the process
 * down, measured against this walk (`glob('…', { expandDirectories: false })`):
 *
 * - `'!('.repeat(2500) + ')'.repeat(2500)` — 7500 characters, refused by nothing: picomatch
 *   compiles it in 201 ms and then *matching* one path against it aborts Node with
 *   `FATAL ERROR: RegExpCompiler Allocation failed`, which is below the reach of any `catch`.
 * - `'+('.repeat(3300) + ')'.repeat(3300)` — 9900 characters: picomatch's own parse takes 145 s,
 *   so the call blocks the event loop for minutes. It is a cubic cost in the nesting depth — 32
 *   deep compiles in 5 ms, 256 in 74 ms, 2000 in 38 s — which is what makes a depth bound the
 *   bound that matters.
 *
 * So the shape of a pattern is refused as well as its length: a nesting 32 deep, or 256 groups of
 * any kind. No real pattern is near either. A brace group is no help to an attacker here —
 * picomatch folds `{a,b}` into a regex alternation and compiles `{a,b}` × 200 (400 groups) in 2 ms —
 * so the count is a backstop for the shapes above, not a brace-expansion budget.
 */
export const MAX_GLOB_GROUP_DEPTH = 32;
export const MAX_GLOB_GROUPS = 256;

/**
 * Why picomatch cannot be handed this pattern, in the words the tools report, or null when it can.
 *
 * Applied to a Glob pattern, to Grep's include pattern and to every entry of a walk's `ignore`
 * list alike, because a walk compiles all of them through the same matcher. A pattern that reaches
 * a walk has to be judged in the spelling the walk compiles — see {@link globWalkPlan}: `\` is an
 * escape to picomatch and a separator to the walk, so the two spellings of `x\{a,b\}` open and close
 * a different number of groups.
 */
export function globPatternRefusal(pattern: string): string | null {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    return `Pattern is too long: a glob pattern may be at most ${MAX_GLOB_PATTERN_LENGTH} characters (this one is ${pattern.length})`;
  }
  let depth = 0;
  let deepest = 0;
  let groups = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    // An escaped character is a literal: `\(`, `\{` and `\[` open nothing.
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '(' || char === '{' || char === '[') {
      groups++;
      depth++;
      if (depth > deepest) deepest = depth;
      if (groups > MAX_GLOB_GROUPS) {
        return `Pattern has too many groups: a glob pattern may open at most ${MAX_GLOB_GROUPS} of them (this one opens more)`;
      }
      if (depth > MAX_GLOB_GROUP_DEPTH) {
        return `Pattern nests groups too deeply: a glob pattern may nest at most ${MAX_GLOB_GROUP_DEPTH} deep (this one nests ${deepest})`;
      }
    } else if (char === ')' || char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
    }
  }
  return null;
}

/** Whether picomatch can be handed this pattern at all. */
export function globPatternWithinLimit(pattern: string): boolean {
  return globPatternRefusal(pattern) === null;
}

/** Told that an entry was dropped, with the entry itself and why. */
export type IgnoreDropReporter = (entry: string, reason: string) => void;

/**
 * The default {@link IgnoreDropReporter}: one line per dropped entry through the debug logger, which
 * prints only when `BOOK_DEBUG=1`. It names the entry, because the entry is the whole of what is
 * being reported — `.gitignore` line 12, say — and the walk it no longer obeys is on every tool that
 * reads the file, so it is logged per walk and not once per entry list.
 */
const logIgnoreDrop: IgnoreDropReporter = (entry, reason) => {
  log.warn(
    `glob: dropping a .gitignore entry the walk cannot obey — ${reason}: ${JSON.stringify(entry)}`,
  );
};

/**
 * The ignore list a walk can be handed: entries the matcher is able to compile, spelled the way it
 * reads them.
 *
 * A walk compiles every entry of its `ignore` option exactly as it compiles the pattern, and those
 * entries are the repository's own `.gitignore` — `loadGitignore` hands them straight to the Glob
 * tool, to Grep's include walk and to the file-mention walk. One line of ten thousand nested braces
 * takes the process down there exactly as it does in a pattern, so it is dropped here, before any
 * walk is handed a list. Dropping one widens the walk by whatever it ignored, so each one is named
 * to the {@link IgnoreDropReporter}: the `.gitignore` the matcher cannot read is walked around
 * rather than obeyed, and that is worth being able to see.
 *
 * Three more entries are dropped for the same reason — not because they cannot be compiled, but
 * because the walk reads them as something other than what git means:
 *
 * - An entry whose walk form opens with a `..` hop (`../x`, `/../x`, `a/../..`) moves the crawl root
 *   out of the workspace, so the walk lists that subtree on the way, and it still ignores nothing: the
 *   ignore list is matched against `cwd`-relative paths, and `../x` cannot name one. `posix.normalize`
 *   collapses `/..` the same way it collapses `a/..`, so a root-anchored entry is checked in the
 *   spelling the respelling below would hand the walk.
 * - `!(x)` is an extglob to picomatch, so as an ignore entry it matches everything *except* `x` — the
 *   reverse of the negated literal git reads it as, and it can empty a walk (measured: a two-entry
 *   workspace went from two results to none).
 * - `/` and `/.` name the repository root, which is the walk's `cwd` itself; respelling them to `.`
 *   would have the walk ignore its own root and answer nothing.
 *
 * A root-anchored entry (`/build`, `/build/`, `/build/**`) is also respelled, because the walk
 * reads it as an absolute path: tinyglobby normalizes `/build` against the walk's `cwd` into
 * `../../../build`, which moves the crawl root to `/` — the walk then lists every directory from
 * the filesystem root down to the workspace, and the line still ignores nothing. Git means the
 * entry relative to the repository root, which is the directory the walk starts in, so it becomes
 * `build` plus `build/**` (measured: the crawl root stays at `cwd`, and `build` is pruned with
 * everything under it). Only the walk boundary rewrites an entry; `loadGitignore` still returns the
 * file's own lines to everything else that reads them.
 *
 * A directory-only entry (`build/`, `/build/`) means what git means — that directory and everything
 * under it, but not a *file* named `build` — and the walk cannot be told that: it strips the trailing
 * `/` off an entry before matching it, so `build/` and `build` are the same entry. It is spelled
 * `build/**` plus one more globstar, which matches only what is *inside* the directory and not the
 * name itself. The walk cannot prune with that spelling: the ignored directory is read once and its
 * entries are dropped as it goes (measured on a tree of 1600 directories: three `readdir` calls
 * instead of two). The other spelling that covers the inside, `build/**`, also matches the bare name
 * — the file git keeps.
 */
export function globWalkIgnore(
  patterns: readonly string[],
  report: IgnoreDropReporter = logIgnoreDrop,
): string[] {
  const walkable: string[] = [];
  for (const pattern of patterns) {
    const refusal = globPatternRefusal(pattern);
    if (refusal) {
      report(pattern, `${refusal}, so the walk covers what it ignored`);
      continue;
    }
    if (pattern.startsWith('!(')) {
      report(
        pattern,
        'picomatch reads `!(` as an extglob, so as an ignore entry it matches everything but what it names',
      );
      continue;
    }
    const climb = climbOutOfWalk(pattern);
    if (climb) {
      report(
        pattern,
        `${climb}, so the walk would read outside the workspace and still ignore nothing`,
      );
      continue;
    }
    walkable.push(...walkIgnoreEntry(pattern));
  }
  return walkable;
}

/**
 * Why an entry would move a walk's crawl root out of the directory it starts in, or null when it
 * would not.
 *
 * Checked on the entry as the walk would read it, which is the entry with a root-anchoring `/`
 * dropped — the repository root is the directory the walk starts in, so `/../x` is `../x` — and then
 * lexically collapsed the way `posix.normalize` collapses it in `normalizePattern`. `..foo` and
 * `..c` are directories that begin with two dots, not hops, and are kept.
 */
function climbOutOfWalk(entry: string): string | null {
  const spelling = entry.replace(/^!/, '').replace(/^\/+/, '');
  const normalized = posix.normalize(spelling).split('/');
  return normalized[0] === '..' ? 'the walk reads it as a climb out of its own root' : null;
}

/**
 * One `.gitignore` entry in the spelling a walk reads, as the entries that make it work.
 *
 * A leading `!` (a negation, other than the extglob `!(`, which is dropped before this) is kept, and
 * a glob character anywhere in the entry is left for the matcher. An entry that is not anchored to
 * the walk's root is already one entry the matcher reads where it stands; a directory-only one is the
 * exception, because the walk strips the trailing `/` off it and reads it as the bare name.
 */
function walkIgnoreEntry(entry: string): string[] {
  const negated = entry.startsWith('!') && !entry.startsWith('!(');
  const bang = negated ? '!' : '';
  const body = negated ? entry.slice(1) : entry;
  const relative = body.replace(/^\/+/, '').replace(/\/+$/, '');
  const dirOnly = body.endsWith('/') && !relative.endsWith('/**');
  if (!body.startsWith('/')) return dirOnly ? [`${bang}${relative}/**/*`] : [entry];
  // `/` and `/.` alone name the repository root, which is the walk's `cwd` itself: nothing to ignore.
  if (!relative || relative === '.') return [];
  const anchored = `${bang}${relative}`;
  if (dirOnly) return [`${anchored}/**/*`];
  return relative.endsWith('/**') ? [anchored] : [anchored, `${anchored}/**`];
}

/**
 * The pattern a walk is handed, and whether picomatch can be handed it at all.
 */
export interface GlobWalkPlan {
  /** The pattern in the spelling the walk reads — the string picomatch compiles. */
  pattern: string;
  /** Why the matcher cannot be handed that pattern, in the words the tools report, or null. */
  refusal: string | null;
  /**
   * Every directory the walk of {@link pattern} can return a result from — one per alternative of a
   * leading group, all of which have to be judged — or null when the pattern is refused.
   */
  scopes: string[] | null;
}

/**
 * What to hand a walk of this pattern from this directory, and whether it can be handed at all.
 *
 * The judgment and the walk are made from one pattern, so they cannot disagree: whatever the walk is
 * handed is the string that is judged, and both read it as the walk does. A refusal is reported
 * before the walk rather than by it, so the words the caller sees name the shape of the pattern
 * instead of a permission refusal that misfiled it (see `readToolTarget`).
 */
export function globWalkPlan(
  pattern: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): GlobWalkPlan {
  const walked = globWalkPattern(pattern, cwd, platform);
  const refusal = globPatternRefusal(walked);
  return {
    pattern: walked,
    refusal,
    scopes: refusal ? null : confinedDirectoriesOfPattern(walked, cwd),
  };
}

/**
 * A pattern in the form tinyglobby can read, which on Windows is not the form a caller writes.
 *
 * tinyglobby treats `\` as an escape character, so a Windows pattern spelled with backslashes
 * (`C:\ws\**\*.ts`) parses as a single escaped token: the walk matches nothing. An absolute Glob
 * therefore found no files at all, and a relative one (`src\*.ts`) escaped the directory it named.
 * The separators are converted first, then the leading base is re-escaped by `convertPathToPattern`
 * and spliced back onto the dynamic tail.
 *
 * Only on Windows: a backslash in a POSIX pattern is a real escape, and converting it would read
 * `\*` as a star.
 *
 * An absolute pattern inside the walk's own directory is handed to the walk as the part of it below
 * that directory. tinyglobby makes an absolute pattern relative by comparing it against an
 * *escaped* `cwd` (`escapePath`), so a workspace whose path holds a glob character — `project (2)`,
 * `repo[x]`, anything checked out under one — reads every absolute pattern as a climb into its
 * parent and then answers nothing at all: measured, a `src/a.ts` behind `project (2)` came back
 * empty for `<workspace>/src/*.ts` and one file for `src/*.ts`. Relative to the real `cwd` there is
 * nothing to climb, so this is the same walk with the metacharacters out of the comparison.
 */
export function globWalkPattern(
  pattern: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const spelled = posixPattern(pattern, platform);
  const body = spelled.endsWith('/') ? spelled.slice(0, -1) : spelled;
  const relative = isAbsolute(body.replace(ESCAPING_BACKSLASHES, ''))
    ? posix.relative(walkCwdOf(cwd), body)
    : '';
  if (relative) return relative;
  const base = staticBaseOfPattern(body);
  // A base that is not a prefix of the pattern cannot be spliced onto one: `**/*` starts where it
  // stands, and there is nothing in the pattern for a base to replace.
  if (!base || !body.startsWith(base)) return body;
  return `${convertPathToPattern(base)}${body.slice(base.length)}`;
}

/**
 * A pattern with the separators tinyglobby reads, which on Windows is not the form a caller writes.
 *
 * Only on Windows: a backslash in a POSIX pattern is a real escape, and converting it would read
 * `\*` as a star. The platform is a parameter so that the Windows spelling is judged on any platform
 * (the judgement does not have a platform-dependent code path of its own — it reads what
 * `globWalkPattern` handed the walk).
 */
function posixPattern(pattern: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern;
}

/** The `cwd` as the walk reads it: resolved, and in one separator. */
function walkCwdOf(cwd: string): string {
  return resolve(cwd).replaceAll('\\', '/');
}

/** The leading `..` run of a normalized pattern, however many are in it. */
const PARENT_DIRECTORY = /^(\/?\.\.)+/;
/** The backslashes that only escape a glob character, which do not hide an absolute path. */
const ESCAPING_BACKSLASHES = /\\(?=[()[\]{}!*+?@|])/g;
/** A drive letter alone, which `posix.join` would read as a path segment rather than a root. */
const DRIVE_RELATIVE_PATH = /^[A-Za-z]:$/;

function ensureNonDriveRelativePath(path: string): string {
  return path.replace(DRIVE_RELATIVE_PATH, (match) => `${match}/`);
}

/**
 * A scope as a path: joined and normalized, so a caller is handed `/ws/..c/b` rather than the
 * `/ws/c/../..c/b` it was built from. Normalizing cannot lose a hop — `posix.join` steps a `..` only
 * when a whole segment is one, which leaves `..c` (a name the walk matches) where it was.
 */
function scopePath(cwd: string, ...segments: readonly string[]): string {
  return ensureNonDriveRelativePath(posix.normalize(posix.join(cwd, ...segments)));
}

/**
 * One pattern split into the parts tinyglobby walks it part by part.
 *
 * Its own `splitPattern`, which is what decides where a walk stops descending: a pattern with no
 * usable part list is walked as the single part it spells, and that part contains a `/` — which is
 * what makes a leading globstar start where it stands rather than at a named directory.
 */
function splitPatternParts(pattern: string): string[] {
  const parts = picomatch.scan(pattern, { parts: true }).parts;
  return parts?.length ? parts : [pattern];
}

/** Whether a segment has to be matched rather than looked for by name. */
function isDynamicPart(part: string): boolean {
  const scan = picomatch.scan(part);
  return scan.isGlob || scan.negated;
}

/** The most alternatives a leading group is broken into before the run stops naming them. */
const MAX_LEADING_ALTERNATIVES = 64;

/**
 * The named directories a pattern's parts open with: everything but its last segment, up to the
 * first segment that has to be matched.
 *
 * This is tinyglobby's own `commonPath` for a single pattern (`{ popTrailingGlobstar: true }`), and it
 * is where a walk *searches* from, which is why a brace group in the first segment (`{a,b}` then a
 * separator) walks the workspace while `src/*.ts` walks `src`: the group is a segment that has to be
 * matched, so the named run ends before it. A pattern ending in a globstar drops that globstar and
 * the segment before it, which is why `src/**` searches the workspace and not `src`.
 */
function leadingPartsOfParts(parts: readonly string[], popTrailingGlobstar: boolean): string[] {
  const leading: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (popTrailingGlobstar && part === '**' && !parts[index + 1]) {
      leading.pop();
      break;
    }
    if (index === parts.length - 1 || isDynamicPart(part)) break;
    leading.push(part);
  }
  return leading;
}

/**
 * The named leading directories of a pattern, as a path: the part of it the walk never has to
 * match. Empty when the walk starts where the pattern stands (a globstar, `*.ts`).
 */
function staticBaseOfPattern(pattern: string): string {
  const leadingParts = leadingPartsOfParts(splitPatternParts(pattern), false);
  return leadingParts.length ? posix.join(...leadingParts) : '';
}

/** Whether a directory is inside another, or is it. */
function holds(root: string, path: string): boolean {
  const relativePath = posix.relative(root, path);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('../') && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

/**
 * Every directory a walk of this pattern can answer from, one run per alternative of the first
 * group it names, as the walk itself computes it.
 *
 * `normalizePattern` first, then the choice `buildCrawler` makes from what is left. Getting this
 * wrong is a permission bypass rather than a wrong answer, so every step here is measured against the
 * walk (see {@link globWalkScopes} and its tests):
 *
 * - The pattern is normalized first, which is a purely *lexical* collapse of `.` and `..`. It is
 *   what makes a globstar followed by two parent hops a climb even though the first segment is a
 *   glob: `posix.normalize` drops the `*` and the `..` beside it, and the walk runs as a leading
 *   `../`. A brace group is not touched — the segment `..}}` is not `..` — so a `..` spelled inside
 *   one keeps the walk inside the directory in front of it.
 * - An absolute pattern is made relative to the `cwd` first, so one naming a directory elsewhere
 *   arrives as a leading `..` run, and an absolute path the `cwd` itself ends in arrives without
 *   one: `<workspace>/src/*.ts` walks `src`, not the workspace.
 * - That run is a climb, and it cancels only against the tail of the `cwd`: `../ws/src/*.ts` from
 *   `/a/ws` is the same directory as `src/*.ts`, and both walk `/a/ws/src`.
 * - What is left of the climb that did not cancel, plus the named run of the pattern's remaining
 *   segments, is a directory the walk answers from: entries are matched against the `cwd`-relative
 *   path they have, and no matcher can turn the named run into something else.
 *
 * The named run of a *search* drops the segment in front of a trailing globstar — that is the
 * directory the walk reads from on its way, which it may answer from anything under. The run a
 * judgment needs does not: `src/**` answers from `src` and not from the workspace (measured, with a
 * symlinked `src`, and through the permission layer's `guarded` answer).
 *
 * Every run here is inside the directory the walk searches from, and a run that is not — a group
 * spelling a `..` hop, `{..,src}/*` — is dropped, because no entry can have it: the walk formats
 * every entry as a `cwd`-relative path of a file *inside* the tree it searched.
 */
function confinedDirectoriesOfPattern(pattern: string, cwd: string): string[] {
  const walkCwd = walkCwdOf(cwd);
  const body = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  const normalized = isAbsolute(body.replace(ESCAPING_BACKSLASHES, ''))
    ? posix.relative(walkCwd, body)
    : posix.normalize(body);

  const parts = splitPatternParts(normalized);
  const parentDirectory = PARENT_DIRECTORY.exec(normalized)?.[0];
  // The count of hops the walk itself works from. It is read off the leading `..` run of the
  // *pattern*, which is where the run really is: a segment that begins with two dots and then does
  // not stop (`....`, `..c`) is a directory, not one and a half hops, and counting it as one used to
  // hand `new Array(1.6666666666666667)` to a walk — a RangeError that took the run down — and to
  // answer for `../..c/b/c/**` with a directory the walk never reads.
  const climb = leadingClimbOfParts(parts);
  const cwdParts = walkCwd.split('/');
  // The count of hops the walk itself works from, read off the leading `..` run of the *pattern*,
  // which is where the run really is: a segment that begins with two dots and then does not stop
  // (`....`, `..c`, `..foo`) is a name the walk climbs one hop toward and then matches, not one and
  // a half hops to step over. It is the walk's own count, so it is fractional for those — and it is
  // this number, read as a whole, that used to hand `new Array(1.6666666666666667)` to a hop list
  // and take the run down with a RangeError.
  const walkedClimb = ((parentDirectory?.length ?? 0) + 1) / 3;
  let cancelled = 0;
  while (
    Number.isInteger(walkedClimb) &&
    cancelled < walkedClimb &&
    parts[cancelled + walkedClimb] !== undefined &&
    parts[cancelled + walkedClimb] === cwdParts[cwdParts.length + cancelled - walkedClimb]
  ) {
    cancelled++;
  }
  // Where the walk reads from, which holds every entry it can return. It is one of two directories,
  // and which one is the walk's own choice: the directory the climb lands on (which it also makes
  // its search directory when the climb leaves the `cwd`), or the named run of the pattern as the
  // caller wrote it, which is where a walk starts once it has cancelled its way back in.
  // The climb as the walk spells it *after* it has cancelled: the hops that cancelled against the
  // tail of the `cwd` are gone from it, which is why `../ws/src/*.ts` does not climb at all.
  const potentialRoot = scopePath(walkCwd, parentDirectory?.slice(cancelled * 3) ?? '');
  const climbedOutOfCwd = potentialRoot[0] !== '.' && walkCwd.length > potentialRoot.length;
  const searchesFrom = climbedOutOfCwd
    ? potentialRoot
    : scopePath(walkCwd, ...leadingPartsOfParts(parts, true));

  if (!parentDirectory) {
    // No climb: the directory the walk searches from is the directory it answers from.
    return confinedRunsWithin(searchesFrom, leadingRunsOfParts(parts), walkCwd);
  }
  if (cancelled > 0) {
    // The walk rewrites the pattern as it cancels a hop against the tail of the `cwd`, so what it
    // filters with no longer spells what the caller wrote — `../..c/b/c/**` from a `cwd` ending in
    // `b/c` becomes `**`, matched from `<cwd>/../..c/b` — and a matcher that has lost its named run
    // can match anything under the directory the walk reads. Nothing narrower than that directory
    // can be said to hold every entry.
    return [searchesFrom];
  }
  // The climb is still in the pattern, so its hops are in front of the run and the entries sit under
  // the pattern's named segments measured from the directory it lands on.
  if (!Number.isInteger(walkedClimb)) {
    // A run that is only partly a hop names the directory after the hop (`..foo/*` reads the parent
    // and matches `..foo` in it), so nothing inside that directory is named and the directory the
    // walk reads is all there is. Counting it as a hop rather than as a name is the walk's reading,
    // and it is the reason this is not answered from the workspace: the walk lists the parent.
    return [searchesFrom];
  }
  const hops = new Array<string>(walkedClimb).fill('..');
  return confinedRunsWithin(
    searchesFrom,
    leadingRunsOfParts(parts.slice(climb)).map((run) => [...hops, ...run]),
    walkCwd,
  );
}

/** The leading `..` run of a split pattern: one hop per segment that is exactly `..`. */
function leadingClimbOfParts(parts: readonly string[]): number {
  let climb = 0;
  while (parts[climb] === '..') climb++;
  return climb;
}

/**
 * The named directories a pattern's parts open with, one run per alternative of the first group it
 * names: `['src']` for a pattern under `src`, `['link']` and `['src']` for `{link,src}` followed by
 * a globstar, `[]` for a leading globstar. The last segment is never part of a run: `src/notes.txt`
 * answers from `src`.
 *
 * The alternatives are what a group *in the first segment* means to a permission judgment: the group
 * is matched, so the walk answers from wherever the alternative names, and both have to be judged.
 * They are enumerated with the walk's own brace expansion and dropped past
 * {@link MAX_LEADING_ALTERNATIVES} — an unenumerated group names nothing, so the run stops in front
 * of it, which is the wider and so the safer answer.
 */
function leadingRunsOfParts(parts: readonly string[]): string[][] {
  let runs: string[][] = [[]];
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    const alternatives = alternativesOfGroup(part);
    if (alternatives) {
      if (runs.length * alternatives.length > MAX_LEADING_ALTERNATIVES) break;
      runs = runs.flatMap((run) => alternatives.map((alternative) => [...run, alternative]));
      continue;
    }
    // A segment that has to be matched rather than looked for by name ends the run: the walk never
    // starts inside it, so nothing in it can be named as a directory the results are held in.
    if (isDynamicPart(part)) break;
    for (const run of runs) run.push(part);
  }
  return runs;
}

/**
 * The alternatives of a segment spelled as one plain brace group, or null when it is not one.
 *
 * A group that holds a range (`{1..12}`) or a nested group is not enumerated: either way the
 * alternative count is not bounded by what is written, and the caller's answer is then the run in
 * front of the group.
 */
function alternativesOfGroup(part: string): string[] | null {
  if (part.length < 5 || !part.startsWith('{') || !part.endsWith('}')) return null;
  const body = part.slice(1, -1);
  if (!body.includes(',') || /\.\./.test(body)) return null;
  const alternatives: string[] = [];
  let nested = 0;
  let current = '';
  for (const char of body) {
    if (char === '{' || char === '(' || char === '[') nested++;
    else if (char === '}' || char === ')' || char === ']') nested--;
    if (char === ',' && nested === 0) {
      alternatives.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  alternatives.push(current);
  // An alternative the walk has to match names no directory, so a group of nothing but those is a
  // group to stop in front of.
  const named = alternatives.filter(
    (alternative) => !alternative.includes('/') && !isDynamicPart(alternative),
  );
  return named.length ? named : null;
}

/** The runs as directories, keeping the ones the walk's own root holds, or that root when none is. */
function confinedRunsWithin(root: string, runs: readonly string[][], walkCwd: string): string[] {
  const held = [
    ...new Set(
      runs.map((run) => scopePath(walkCwd, ...run)).filter((directory) => holds(root, directory)),
    ),
  ];
  return held.length ? held : [root];
}

/**
 * Every directory a walk of this pattern can answer from — or null when picomatch cannot be handed
 * the pattern at all.
 *
 * The walk's own answer to that question (see {@link confinedDirectoriesOfPattern}), so a caller
 * judging what a Glob reaches is judging the directory the walk really uses rather than how the
 * pattern reads. Every entry it returns is inside one of these, which is what a permission judgment
 * needs: it judges each, and the worst one decides. They are absolute, so a caller can resolve them
 * against the roots it serves rather than re-anchoring a `..` to a root the pattern never named.
 *
 * Where the walk *searches* from is one of them or an ancestor of them, so a pattern that climbs
 * makes tinyglobby start from the directory the climb lands on and list that directory's subtree on
 * the way to the one it answers from; only what the pattern matches comes back (measured; the
 * `globWalkScopes` tests walk both).
 *
 * Assumes the options the Glob tool walks with: `expandDirectories: false` (a pattern naming a
 * directory is not walked as a subtree) and a single pattern. Both only ever narrow the walk to a
 * subtree of what is reported here.
 */
export function globWalkScopes(
  pattern: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  return globWalkPlan(pattern, cwd, platform).scopes;
}
