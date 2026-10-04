import { dirname } from 'node:path';
import picomatch from 'picomatch';
import { convertPathToPattern } from 'tinyglobby';

/**
 * Convert a glob pattern to a regex. Supports * (any chars) and ** (same as *).
 * The pattern is anchored at both ends (^...$).
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/**
 * The longest pattern handed to picomatch, the matcher tinyglobby walks with.
 *
 * A brace group expands into one alternative each, and deeply nested ones — `{a,` ten thousand
 * times — compile into a disjunction that overflows V8's regexp stack. The process aborts there,
 * below the reach of any `try`, so a pattern long enough to do it is refused before the matcher
 * sees it. 10 000 characters is the limit the walk enforced before it (`Input length (40000),
 * exceeds max characters (10000)`), so a pattern that was answered then is still answered.
 */
export const MAX_GLOB_PATTERN_LENGTH = 10_000;

/** Whether picomatch can be handed this pattern at all. */
export function globPatternWithinLimit(pattern: string): boolean {
  return pattern.length <= MAX_GLOB_PATTERN_LENGTH;
}

/**
 * The ignore list a walk can be handed: the entries the matcher is able to compile.
 *
 * A walk compiles every entry of its `ignore` option exactly as it compiles the pattern, and
 * those entries are the repository's own `.gitignore` — `loadGitignore` hands them straight to the
 * Glob tool, to Grep's include walk and to the file-mention walk. One line of ten thousand nested
 * braces takes the process down there exactly as it does in a pattern, so it is dropped here, on
 * its length and before any walk is handed a list.
 *
 * Dropping an entry widens the walk by whatever that entry ignored, so a `.gitignore` the matcher
 * cannot read is walked around rather than obeyed — the price of the process still being there to
 * report the result.
 */
export function globIgnorePatternsWithinLimit(patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => globPatternWithinLimit(pattern));
}

/**
 * A pattern in the form tinyglobby can read, which on Windows is not the form a caller writes.
 *
 * tinyglobby treats `\` as an escape character, so a Windows pattern spelled with backslashes
 * (`C:\ws\**\*.ts`) parses as a single escaped token: its base comes back as `.` and the walk
 * matches nothing. An absolute Glob therefore found no files at all, and a relative one
 * (`src\*.ts`) escaped the directory it named. The separators are converted first, then the
 * pattern is re-escaped by `convertPathToPattern` and handed to the walk.
 *
 * Only on Windows: a backslash in a POSIX pattern is a real escape, and converting it would read
 * `\*` as a star.
 */
function posixPattern(pattern: string): string {
  return process.platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern;
}

/** The characters that make a pattern dynamic. A brace is not one: those are enumerated instead. */
const DYNAMIC_CHARACTER = /[!()*+@[\]\\]/;

/** How many ways one anchor may be spelled out before it is read as it stands. */
const MAX_BASE_ALTERNATIVES = 1024;

/** A path segment naming the parent directory, however the anchor spells one. */
const PARENT_SEGMENT = /(?:^|[/,{(])\.\.(?:[/,)}]|$)/;

interface BraceGroup {
  /** The text between the braces. */
  body: string;
  /** The index just past the closing brace. */
  end: number;
}

/** The brace group opening at `start`, or null when it is never closed. */
function readBraceGroup(anchor: string, start: number): BraceGroup | null {
  let depth = 0;
  for (let index = start; index < anchor.length; index++) {
    const char = anchor[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0)
      return { body: anchor.slice(start + 1, index), end: index + 1 };
  }
  return null;
}

/**
 * A brace group's alternatives, split on the commas that belong to it alone.
 *
 * `a,{b,c}` is two alternatives and `{a,b` inside another group is one, so the nesting decides
 * which commas are separators; a comma behind a backslash is part of the text.
 */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '\\') {
      current += char + (body[index + 1] ?? '');
      index++;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Every way the leading anchor of a pattern can be spelled, or null when there are more than
 * {@link MAX_BASE_ALTERNATIVES} of them — thirty `{a,b}` groups ask for a billion, and a caller
 * has no such pattern.
 */
function expandAnchor(anchor: string): string[] | null {
  let spelled: string[] = [''];
  for (let index = 0; index < anchor.length;) {
    const char = anchor[index];
    if (char === '\\') {
      const escaped = anchor.slice(index, index + 2);
      spelled = spelled.map((prefix) => prefix + escaped);
      index += 2;
      continue;
    }
    if (char !== '{') {
      spelled = spelled.map((prefix) => prefix + char);
      index++;
      continue;
    }
    const group = readBraceGroup(anchor, index);
    const parts = group ? splitAlternatives(group.body) : [];
    // A group with no comma of its own (`{1..3}`, `{-}`) is a range or a literal, not an
    // enumeration: the matcher reads it as it stands and the anchor keeps it whole.
    if (group === null || parts.length < 2) {
      const literal = group ? anchor.slice(index, group.end) : char;
      spelled = spelled.map((prefix) => prefix + literal);
      index = group ? group.end : index + 1;
      continue;
    }
    const expanded: string[] = [];
    for (const prefix of spelled) {
      for (const part of parts) {
        const nested = expandAnchor(part);
        if (!nested) return null;
        expanded.push(...nested.map((tail) => prefix + tail));
        if (expanded.length > MAX_BASE_ALTERNATIVES) return null;
      }
    }
    spelled = expanded;
    index = group.end;
  }
  return spelled;
}

/** The index of the first dynamic character: everything before it is the anchor a walk starts in. */
function anchorEnd(pattern: string): number {
  // picomatch reads a leading `!` as a negation and scans on past it, so the base is the same one.
  const start = pattern[0] === '!' && pattern[1] !== '(' ? 1 : 0;
  for (let index = start; index < pattern.length; index++) {
    if (pattern[index] === '\\') {
      index++;
      continue;
    }
    if (DYNAMIC_CHARACTER.test(pattern[index])) return index;
  }
  return pattern.length;
}

/**
 * The static leading directory of one spelled-out pattern.
 *
 * picomatch's own answer, with the two forms it has no word for: a pattern holding no glob names a
 * file, and what it starts from is the directory holding that file; a pattern ending in `/` names
 * the directory itself.
 */
function baseOfPattern(pattern: string): string {
  if (pattern.endsWith('/')) return pattern.replace(/\/+$/, '') || '/';
  const scan = picomatch.scan(pattern);
  return scan.isGlob ? scan.base || '.' : dirname(pattern) || '.';
}

/**
 * The static leading directories of a pattern, as picomatch reports them — one per way the walk
 * can start.
 *
 * The directories a walk starts from, and therefore what a Glob is judged to reach: the base of
 * `../**` is `..`, and the base of `.{.,x}/*` is its parent, which the anchor spelled out — `.`
 * plus the group's own `.` — is `..`. So each way a brace group in the anchor can be written is a
 * base of its own (`src/{a,{b,../..}}/*` starts from `src/a`, `src/b` and `src/../..`) and the
 * walk can start from any of them. A pattern that names nothing literally — a leading globstar, a
 * leading brace group, anything whose first segment is already dynamic — starts where it stands,
 * which is `.`.
 * Returned in a form `path.resolve` reads, so the caller can resolve each one against the roots it
 * serves rather than trusting the pattern's own spelling of it.
 */
function basesOfPattern(pattern: string): string[] {
  if (!globPatternWithinLimit(pattern)) return [];
  const end = anchorEnd(pattern);
  if (end === 0) return ['.'];
  const anchor = pattern.slice(0, end);
  const spelled = expandAnchor(anchor);
  // An anchor too large to spell out is read as it stands, which leaves it the literal prefix
  // every alternative starts with. One that names a parent anywhere in it is then reported
  // unreadable instead: the enumeration that would show the climb is the one that could not run.
  if (!spelled && PARENT_SEGMENT.test(anchor)) return [];
  const tail = pattern.slice(end);
  const bases = new Set<string>();
  for (const alternative of spelled ?? [anchor]) bases.add(baseOfPattern(alternative + tail));
  return [...bases];
}

/**
 * A base is a path rather than a fragment of a glob, which is what makes converting it as one
 * safe. A base that is anything else is left alone rather than escaped into literal text.
 */
function isPlainBase(base: string): boolean {
  return !/[*?!()[\]{}]/.test(base);
}

/**
 * A pattern tinyglobby reads, with its static leading directories converted by the library's own
 * `convertPathToPattern`.
 *
 * The whole pattern cannot simply be converted: `convertPathToPattern` escapes the glob's own
 * syntax too (`{`, `,`, `@`, `(`), which would turn a brace expansion or an extglob the caller
 * wrote into literal text. The static base is a Windows path, where those characters are the
 * path's, so it is converted on its own and the dynamic tail is left exactly as written.
 */
export function globWalkPattern(pattern: string): string {
  const posix = posixPattern(pattern);
  const [base] = basesOfPattern(posix);
  // A base that is not a prefix of the pattern cannot be spliced onto one: `.` is what a pattern
  // that names nothing literally reports for `**/*`, and there is nothing in the pattern for it to
  // replace.
  if (!base || !isPlainBase(base) || !posix.startsWith(base)) return posix;
  return `${convertPathToPattern(base)}${posix.slice(base.length)}`;
}

/**
 * The static leading directories of a pattern, in a form the walk can read.
 *
 * Same conversion as {@link globWalkPattern}, so the two agree on where a pattern starts — the
 * walk and the judgment of what it reaches have to name the same directory.
 */
export function globWalkBases(pattern: string): string[] {
  return basesOfPattern(posixPattern(pattern));
}
