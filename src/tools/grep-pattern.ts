/**
 * What the portable Grep backend does with ripgrep's inline flag groups.
 *
 * ripgrep's regex syntax has global inline flags — `(?i)hello` — that JavaScript's `RegExp` lacks,
 * so `new RegExp('(?i)hello')` throws "Invalid group". A model that knows ripgrep writes them, and
 * ripgrep runs them; the portable backend maps the ones it can onto `RegExp` flags and names the
 * ones it cannot.
 */

/** The inline flag letters that have a `RegExp` flag of the same meaning here. */
const TRANSLATABLE_FLAGS = new Set(['i', 's', 'm']);

/** A leading global flag group: `(?i)`, `(?is)`. Scoped `(?i:…)` and `(?:…)` do not match. */
const LEADING_FLAG_GROUP = /^\(\?([A-Za-z]+)\)/;

/** Any global flag group, including the negated and unsupported forms: `(?x)`, `(?-i)`, `(?i-s)`. */
const FLAG_GROUP = /^\(\?([A-Za-z]*-[A-Za-z]*|[A-Za-z]+)\)/;

export interface PortablePattern {
  /** The pattern with its leading flag groups removed. */
  source: string;
  /** The flags to compile it with: the caller's own plus the translated ones, each once. */
  flags: string;
}

/**
 * Strips the leading `(?i)`, `(?s)`, `(?m)` groups (alone or together: `(?is)`, `(?i)(?s)`) and
 * merges their letters into `baseFlags` without repeating any: `new RegExp(p, 'gii')` throws
 * "Invalid flags", and `{pattern: '(?i)x', i: true}` is an ordinary call.
 *
 * A leading group holding any other letter is left in place for the compile to reject, and so is
 * everything that is not a bare `(?letters)` group.
 */
export function portablePattern(pattern: string, baseFlags: string): PortablePattern {
  const flags = new Set(baseFlags);
  let source = pattern;
  for (;;) {
    const group = LEADING_FLAG_GROUP.exec(source);
    if (!group || ![...group[1]].every((letter) => TRANSLATABLE_FLAGS.has(letter))) break;
    for (const letter of group[1]) flags.add(letter);
    source = source.slice(group[0].length);
  }
  return { source, flags: [...flags].join('') };
}

/**
 * The first inline flag group in a pattern the portable engine rejected, or undefined. Escaped
 * parentheses and character classes are skipped, so `\(?i)` and `[(?i)]` are not found.
 */
function firstInlineFlagGroup(pattern: string): string | undefined {
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '\\') {
      index++;
    } else if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
    } else if (char === '(' && pattern[index + 1] === '?') {
      const group = FLAG_GROUP.exec(pattern.slice(index));
      if (group) return group[0];
    }
  }
  return undefined;
}

/**
 * The reason the portable engine cannot run a pattern, in the words the model is told.
 * `rgError` is ripgrep's own message when ripgrep was asked first and rejected it too.
 */
export function describeInvalidPattern(pattern: string, rgError?: string): string {
  const construct = firstInlineFlagGroup(pattern);
  const reason = construct
    ? `\nThe inline flag group ${construct} is not supported by the portable regex engine: only ` +
      'leading (?i), (?s) and (?m) are. Use i: true for case-insensitive search (and ' +
      'multiline: true for patterns that cross lines).'
    : '';
  const fromRipgrep = rgError ? `\nripgrep said:\n${rgError}` : '';
  return `Invalid regex: ${pattern}${reason}${fromRipgrep}`;
}
