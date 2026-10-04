import { isAbsolute, posix, resolve } from 'node:path';
import picomatch from 'picomatch';
import { convertPathToPattern, escapePath } from 'tinyglobby';
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
 * list alike, because a walk compiles all of them through the same matcher.
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

/**
 * The ignore list a walk can be handed: entries the matcher is able to compile, spelled the way it
 * reads them.
 *
 * A walk compiles every entry of its `ignore` option exactly as it compiles the pattern, and those
 * entries are the repository's own `.gitignore` — `loadGitignore` hands them straight to the Glob
 * tool, to Grep's include walk and to the file-mention walk. One line of ten thousand nested braces
 * takes the process down there exactly as it does in a pattern, so it is dropped here, before any
 * walk is handed a list. Dropping one widens the walk by whatever it ignored, so each one is logged
 * through the debug logger: the `.gitignore` the matcher cannot read is walked around rather than
 * obeyed, and that is worth being able to see.
 *
 * A root-anchored entry (`/build`, `/build/`, `/build/**`) is also respelled, because the walk
 * reads it as an absolute path: tinyglobby normalizes `/build` against the walk's `cwd` into
 * `../../../build`, which moves the crawl root to `/` — the walk then lists every directory from
 * the filesystem root down to the workspace, and the line still ignores nothing. Git means the
 * entry relative to the repository root, which is the directory the walk starts in, so it becomes
 * `build` plus `build/**` (measured: the crawl root stays at `cwd`, and `build` is pruned with
 * everything under it). Only the walk boundary rewrites an entry; `loadGitignore` still returns the
 * file's own lines to everything else that reads them.
 */
export function globWalkIgnore(patterns: readonly string[]): string[] {
  const walkable: string[] = [];
  for (const pattern of patterns) {
    const refusal = globPatternRefusal(pattern);
    if (refusal) {
      log.warn(
        `glob: ignoring an ignore entry picomatch cannot compile, so the walk covers what it ignored — ${refusal}`,
      );
      continue;
    }
    walkable.push(...walkIgnoreEntry(pattern));
  }
  return walkable;
}

/**
 * One `.gitignore` entry in the spelling a walk reads, as the entries that make it work.
 *
 * Everything that is not anchored to the walk's root already is one entry, which is returned as it
 * stands: a leading `!` (a negation, other than the extglob `!(`) is kept, and a glob character
 * anywhere in the entry is left for the matcher.
 */
function walkIgnoreEntry(entry: string): string[] {
  const negated = entry.startsWith('!') && !entry.startsWith('!(');
  const body = negated ? entry.slice(1) : entry;
  if (!body.startsWith('/')) return [entry];
  const relative = body.replace(/^\/+/, '').replace(/\/+$/, '');
  // `/` alone names the repository root, which is the walk's `cwd` itself: nothing to ignore.
  if (!relative) return [];
  const anchored = `${negated ? '!' : ''}${relative}`;
  return relative.endsWith('/**') ? [anchored] : [anchored, `${anchored}/**`];
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
 */
export function globWalkPattern(pattern: string): string {
  const posix = posixPattern(pattern);
  const base = staticBaseOfPattern(posix);
  // A base that is not a prefix of the pattern cannot be spliced onto one: `**/*` starts where it
  // stands, and there is nothing in the pattern for a base to replace.
  if (!base || !posix.startsWith(base)) return posix;
  return `${convertPathToPattern(base)}${posix.slice(base.length)}`;
}

/**
 * A pattern with the separators tinyglobby reads, which on Windows is not the form a caller writes.
 *
 * Only on Windows: a backslash in a POSIX pattern is a real escape, and converting it would read
 * `\*` as a star.
 */
function posixPattern(pattern: string): string {
  return process.platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern;
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

/**
 * The named directories a pattern's parts open with: everything but its last segment, up to the
 * first segment that has to be matched.
 *
 * This is tinyglobby's own `commonPath` for a single pattern, and it is why a brace group in the
 * first segment (`{a,b}` then a separator) walks the workspace while `src/*.ts` walks `src`: the
 * group is a segment that has to be matched, so the named run ends before it. A pattern ending in
 * a globstar drops that globstar and the segment before it, which is why `src/**` walks the
 * workspace and not `src`.
 */
function leadingPartsOfPattern(pattern: string): string[] {
  const parts = splitPatternParts(pattern);
  const leading: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === '**' && !parts[index + 1]) {
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
  const leadingParts = leadingPartsOfPattern(pattern);
  return leadingParts.length ? posix.join(...leadingParts) : '';
}

/**
 * The directory a walk of this pattern answers from, as the walk itself computes it.
 *
 * `normalizePattern` first, then the choice `buildCrawler` makes from what is left. Getting this
 * wrong is a permission bypass rather than a wrong answer, so every step here is measured against
 * the walk (see `globWalkScope` and its tests):
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
 *   segments, is the directory the walk answers from. Every entry it returns is inside it, because
 *   entries are matched against it as `cwd`-relative paths and no matcher can turn the named run
 *   into something else.
 */
function walkScopeOfPattern(pattern: string, cwd: string): string {
  // The `cwd` as tinyglobby reads it: resolved, and in one separator.
  const walkCwd = resolve(cwd).replaceAll('\\', '/');
  const escapedCwd = escapePath(walkCwd);
  const body = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  const normalized = isAbsolute(body.replace(ESCAPING_BACKSLASHES, ''))
    ? posix.relative(escapedCwd, body)
    : posix.normalize(body);

  const parts = splitPatternParts(normalized);
  const parentDirectory = PARENT_DIRECTORY.exec(normalized)?.[0];
  if (!parentDirectory) {
    // No climb: this is the crawl root the walk starts from, and the two agree.
    return ensureNonDriveRelativePath(posix.join(walkCwd, ...leadingPartsOfPattern(normalized)));
  }
  const climb = (parentDirectory.length + 1) / 3;
  const cwdParts = escapedCwd.split('/');
  // How much of the climb cancels against the tail of the `cwd`: the `..` and the segment it steps
  // onto are the same directory, so the pattern lands back inside.
  let cancelled = 0;
  while (
    cancelled < climb &&
    parts[cancelled + climb] === cwdParts[cwdParts.length + cancelled - climb]
  ) {
    cancelled++;
  }
  const uncancelled = new Array<string>(climb - cancelled).fill('..');
  // The pattern is matched from the directory the climb lands on, with the cancelled hops dropped
  // out of both, so its remaining named segments are what confine the entries it returns.
  const named = [];
  for (const part of parts.slice(climb + cancelled)) {
    if (isDynamicPart(part)) break;
    named.push(part);
  }
  return ensureNonDriveRelativePath(posix.join(walkCwd, ...uncancelled, ...named));
}

/**
 * The directory a walk of this pattern answers from — or null when picomatch cannot be handed the
 * pattern at all.
 *
 * The walk's own answer to that question (see {@link walkScopeOfPattern}), so a caller judging what
 * a Glob reaches is judging the directory the walk really uses rather than how the pattern reads.
 * It is a superset of every entry the walk can return, which is what a permission judgment needs:
 * one directory, and nothing it names is outside it. It is absolute, so a caller can resolve it
 * against the roots it serves rather than re-anchoring a `..` to a root the pattern never named.
 *
 * Where the walk *searches* from is this directory or an ancestor of it: a pattern that climbs
 * makes tinyglobby start from the directory the climb lands on, so it lists that directory's
 * subtree on the way to the one it answers from, and only what the pattern matches comes back
 * (measured; the `globWalkScope` tests walk both). A pattern that does not climb starts where it
 * answers from.
 *
 * Assumes the options the Glob tool walks with: `expandDirectories: false` (a pattern naming a
 * directory is not walked as a subtree) and a single pattern. Both only ever narrow the walk to a
 * subtree of what is reported here.
 */
export function globWalkScope(pattern: string, cwd: string): string | null {
  if (globPatternRefusal(pattern)) return null;
  return walkScopeOfPattern(posixPattern(pattern), cwd);
}
