import fg from 'fast-glob';

/**
 * Convert a glob pattern to a regex. Supports * (any chars) and ** (same as *).
 * The pattern is anchored at both ends (^...$).
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/**
 * A pattern in the form fast-glob can read, which on Windows is not the form a caller writes.
 *
 * fast-glob treats `\` as an escape character, so a Windows pattern spelled with backslashes
 * (`C:\ws\**\*.ts`) parses as a single escaped token: its base comes back as `.` and the walk
 * matches nothing. An absolute Glob therefore found no files at all, and a relative one
 * (`src\*.ts`) escaped the directory it named. The separators are converted first, then the
 * pattern is re-escaped by `convertPathToPattern` and handed to fast-glob.
 *
 * Only on Windows: a backslash in a POSIX pattern is a real escape, and converting it would read
 * `\*` as a star.
 */
function posixPattern(pattern: string): string {
  return process.platform === 'win32' ? pattern.replaceAll('\\', '/') : pattern;
}

/**
 * The static leading directories of a pattern, as fast-glob reports them.
 *
 * The directories a walk starts from, and therefore what a Glob is judged to reach: the base of
 * `../**` is `..`, and the base of `.{.,x}/*` is its parent. Returned in a form `path.resolve`
 * reads, so the caller can resolve each one against the roots it serves rather than trusting the
 * pattern's own spelling of it.
 */
function basesOfPattern(pattern: string): string[] {
  try {
    return fg.generateTasks([pattern]).map((task) => task.base);
  } catch {
    return [];
  }
}

/**
 * A base is a path rather than a fragment of a glob, which is what makes converting it as one
 * safe. A base that is anything else is left alone rather than escaped into literal text.
 */
function isPlainBase(base: string): boolean {
  return !/[*?!()[\]{}]/.test(base);
}

/**
 * A pattern fast-glob reads, with its static leading directories converted by the library's own
 * `convertPathToPattern`.
 *
 * The whole pattern cannot simply be converted: `convertPathToPattern` escapes the glob's own
 * syntax too (`{`, `,`, `@`, `(`), which would turn a brace expansion or an extglob the caller
 * wrote into literal text. The static base is a Windows path, where those characters are the
 * path's, so it is converted on its own and the dynamic tail is left exactly as written.
 */
export function fastGlobPattern(pattern: string): string {
  const posix = posixPattern(pattern);
  const [base] = basesOfPattern(posix);
  // A base that is not a prefix of the pattern cannot be spliced onto one: `.` is glob-parent's
  // answer for `**/*`, and there is nothing in the pattern for it to replace.
  if (!base || !isPlainBase(base) || !posix.startsWith(base)) return posix;
  return `${fg.convertPathToPattern(base)}${posix.slice(base.length)}`;
}

/**
 * The static leading directories of a pattern, in a form fast-glob can read.
 *
 * Same conversion as {@link fastGlobPattern}, so the two agree on where a pattern starts — the
 * walk and the judgment of what it reaches have to name the same directory.
 */
export function fastGlobBases(pattern: string): string[] {
  return basesOfPattern(posixPattern(pattern));
}
