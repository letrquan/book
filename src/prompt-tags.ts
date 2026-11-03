/**
 * Harness tags: the markup Book's prompts are built from, which text from outside the harness — a
 * repository file, another session's message (#620) — must never be able to open or close. Text
 * like that is neutralized before it reaches a prompt: the `<` of each harness tag is rewritten so
 * the tag no longer reads as markup, and everything else is left as written.
 *
 * The default rewrite finds a tag however it is spelled (#654): with a fullwidth or lookalike
 * bracket, slash or hyphen (`＜`, `﹤`, `‹`, `⁄`, `‐`), in fullwidth letters, with an invisible
 * character anywhere in it (a format character, as in `<system\u200b-reminder>`, a variation
 * selector, a Hangul filler), with whitespace after the `<` or around the `/` when it ends as a tag
 * does (`< /source>`, never `i < source.length`), and with any of those characters written as a
 * JSON string escape. Letters fold by NFKC only: a Cyrillic `ѕ` in `<ѕystem-reminder>` is left as
 * written.
 */

/**
 * Every tag Book's own prompts use as structure, from a grep of `src/`, plus the reasoning tags a
 * model's text carries and Claude Code's harness tags, which a message relayed from a Claude Code
 * session may hold.
 */
export const HARNESS_TAGS: readonly string[] = Object.freeze([
  // Book's prompt structure.
  'session-state',
  'project-instructions',
  'source',
  'memory-index',
  'previous-summary',
  'conversation',
  'approved-plan',
  'background-shell-completion',
  'subagent_notification',
  // Reasoning, which Book strips from a model's text or replays as reasoning.
  'think',
  'thinking',
  'reasoning_context',
  // Cross-session messaging (#620), and the rest of Claude Code's envelope family.
  'cross-session-message',
  'agent-message',
  'teammate-message',
  'task-notification',
  // Claude Code's harness tags.
  'system-reminder',
  'function_results',
  'tool_use_error',
  'persisted-output',
  'user-prompt-submit-hook',
]);

/** Namespaces every tag of which is a harness tag: Claude Code's tool-call markup. */
export const HARNESS_TAG_PREFIXES: readonly string[] = Object.freeze(['antml:']);

export interface NeutralizeTagsOptions {
  /** The tags to neutralize; {@link HARNESS_TAGS} and {@link HARNESS_TAG_PREFIXES} by default. */
  tags?: readonly string[];
  /**
   * How a tag's `<` is rewritten:
   * - `harness` (the default): `<` becomes `<\\`, and the tag is found however it is spelled (see
   *   above), in a JSON string too (`\u003c`, `\/`, `\u002f`, an escaped letter), so it stays
   *   neutral after the string is decoded as well as read as written;
   * - `backslash`: `<` becomes `<\`, as written only. Claude Code's sender-side escape of its
   *   envelope tag, kept byte for byte for interop;
   * - `entity`: `<` becomes `&lt;`, as written only. The project-instructions fence's rewrite.
   */
  style?: 'harness' | 'backslash' | 'entity';
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An opener or closer of one of `tags`, as written: `<name` or `</name`, case folded. */
function literalTagPattern(tags: readonly string[]): RegExp {
  return new RegExp(`<(\\/?)(${tags.map(escapeRegExp).join('|')})\\b`, 'gi');
}

/** Brackets that read as `<` and that NFKC leaves alone. */
const LESS_THAN_LOOKALIKES = '\u2039\u27e8\u3008\u276c\u276e\u2770\u02c2\u1438\u29fc';
/** Brackets that read as `>` and that NFKC leaves alone. */
const GREATER_THAN_LOOKALIKES = '\u203a\u27e9\u3009\u276d\u276f\u2771\u02c3\u1433\u29fd';
/** Slashes that read as `/` and that NFKC leaves alone (it folds the fullwidth one). */
const SLASH_LOOKALIKES = '\u2044\u2215\u29f8\u2571';
/**
 * Hyphens and dashes that read as `-` in a tag's name and that NFKC leaves alone (it folds the
 * fullwidth and small hyphen-minus, and the non-breaking hyphen to U+2010).
 */
const HYPHEN_LOOKALIKES = '\u2010\u2012\u2013\u2014\u2015\u2043\u2212';

/**
 * Every character that reads as `<`: the ASCII one, the four NFKC folds to it (`＜`, `﹤`, and
 * U+2329 and U+FE3F, through U+3008), and the lookalikes above.
 */
const LESS_THAN_READINGS = `<\ufe64\uff1c\u2329\ufe3f${LESS_THAN_LOOKALIKES}`;
/** Every character that reads as `>`, the same way. */
const GREATER_THAN_READINGS = `>\ufe65\uff1e\u232a\ufe40${GREATER_THAN_LOOKALIKES}`;

/** Every character that reads as an angle bracket: a name that must never draw a tag strips them. */
export const ANGLE_BRACKETS = `${LESS_THAN_READINGS}${GREATER_THAN_READINGS}`;

/** What each lookalike reads as. */
const LOOKALIKES = new Map<string, string>([
  ...[...LESS_THAN_LOOKALIKES].map((char): [string, string] => [char, '<']),
  ...[...GREATER_THAN_LOOKALIKES].map((char): [string, string] => [char, '>']),
  ...[...SLASH_LOOKALIKES].map((char): [string, string] => [char, '/']),
  ...[...HYPHEN_LOOKALIKES].map((char): [string, string] => [char, '-']),
]);

/** Where a tag may begin: a character that reads as `<`, or a JSON `\uXXXX` escape. */
const OPENER = new RegExp(`[${LESS_THAN_READINGS}]|\\\\u[0-9A-Fa-f]{4}`, 'g');
/**
 * Characters a reader does not see: format characters (zero-width spaces and joiners, word
 * joiners, the BOM, tag text) and the other default-ignorable ones (variation selectors, the
 * combining grapheme joiner, Mongolian variation selectors, Hangul fillers).
 */
const INVISIBLE_CHARACTER = /^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u;
const WHITESPACE = /^\s+$/;
const NAME_CHARACTERS = /^[A-Za-z0-9_:-]+$/;
const HEX_CODE_UNIT = /^[0-9A-Fa-f]{4}$/;
/**
 * What a backslash folds to when a writer did not type it after the `<` as one — a fullwidth `＼`,
 * an escaped `\u005c` — so the rewrite never drops it: nothing a tag is made of.
 */
const OPAQUE = '\u0000';

/** One character of the text: where it ends as written, and what matching reads it as. */
interface Unit {
  end: number;
  /** NFKC, the lookalikes folded, invisible characters gone: `''` for an invisible one. */
  read: string;
  /** A `\` that starts no `\uXXXX` escape: one of the backslashes a writer may put after a `<`. */
  backslash: boolean;
}

/** A character, folded for matching: NFKC, then the lookalikes, then invisible characters dropped. */
function foldCharacter(char: string): string {
  if (char.length === 1 && char.charCodeAt(0) < 0x80) return char;
  let folded = '';
  for (const part of char.normalize('NFKC')) {
    if (INVISIBLE_CHARACTER.test(part)) continue;
    const read = LOOKALIKES.get(part) ?? part;
    folded += read === '\\' ? OPAQUE : read;
  }
  return folded;
}

/**
 * The code unit a JSON `\uXXXX` escape at `at` spells, or undefined when none starts there. As JSON
 * reads it, a backslash an odd run of backslashes comes before is itself escaped: `\\u0073` is
 * a backslash and the letters `u0073`, not an `s`.
 */
function escapedCodeUnit(text: string, at: number): number | undefined {
  if (text.charCodeAt(at) !== 0x5c || text.charCodeAt(at + 1) !== 0x75) return undefined;
  const hex = text.slice(at + 2, at + 6);
  if (!HEX_CODE_UNIT.test(hex)) return undefined;
  let before = 0;
  while (before < at && text.charCodeAt(at - before - 1) === 0x5c) before++;
  return before % 2 === 0 ? parseInt(hex, 16) : undefined;
}

/**
 * The character at `at`, read as a model may read it: a JSON `\uXXXX` escape (or a surrogate pair
 * of them) as the character it spells, and every character folded.
 */
function readUnit(text: string, at: number): Unit {
  const code = escapedCodeUnit(text, at);
  if (code !== undefined) {
    let end = at + 6;
    let point = code;
    const low = code >= 0xd800 && code <= 0xdbff ? escapedCodeUnit(text, end) : undefined;
    if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
      point = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      end += 6;
    }
    const char = String.fromCodePoint(point);
    return { end, read: char === '\\' ? OPAQUE : foldCharacter(char), backslash: false };
  }
  if (text.charCodeAt(at) === 0x5c) return { end: at + 1, read: '\\', backslash: true };
  const char = String.fromCodePoint(text.codePointAt(at)!);
  return { end: at + char.length, read: foldCharacter(char), backslash: false };
}

/** What follows a `<`: the name of the tag it would open or close, and how it was spelled. */
interface SpelledTag {
  /** The name as matching reads it, lower-cased. */
  name: string;
  /** Where the name ends in the text. */
  end: number;
  /** Where the backslashes a writer put after the `<` are: the rewrite folds them into its two. */
  backslashes: number[];
  /** Whether whitespace stood between the `<`, the `/` and the name. */
  spaced: boolean;
}

/**
 * The tag a `<` ending at `at` begins: after it, invisible characters, whitespace and the
 * backslashes a writer put there, an optional `/` with whitespace after it too, then the run of
 * name characters. Undefined when no name follows.
 */
function readTag(text: string, at: number): SpelledTag | undefined {
  const backslashes: number[] = [];
  let spaced = false;
  let slash = false;
  let index = at;
  while (index < text.length) {
    const unit = readUnit(text, index);
    if (unit.read === '' || (unit.backslash && !slash)) {
      if (unit.backslash) backslashes.push(index);
    } else if (WHITESPACE.test(unit.read)) {
      spaced = true;
    } else if (unit.read === '/' && !slash) {
      slash = true;
    } else {
      break;
    }
    index = unit.end;
  }
  let name = '';
  while (index < text.length) {
    const unit = readUnit(text, index);
    if (unit.read !== '' && !NAME_CHARACTERS.test(unit.read)) break;
    name += unit.read;
    index = unit.end;
  }
  return name ? { name: name.toLowerCase(), end: index, backslashes, spaced } : undefined;
}

/**
 * Whether the name ending at `at` is followed as a tag's is: by `>`, `/>`, or whitespace and an
 * attribute (`name=`). A spelling with whitespace in it counts only then: a space is how code
 * compares (`i < source.length`), and how a shell redirects (`cmd < /source/in.txt`).
 */
function endsLikeTag(text: string, at: number): boolean {
  let state: 'name' | 'gap' | 'attribute' | 'equals' | 'slash' = 'name';
  let index = at;
  while (index < text.length) {
    const { read, end } = readUnit(text, index);
    index = end;
    if (read === '') continue;
    if (state === 'slash') return read === '>';
    if (WHITESPACE.test(read)) {
      if (state === 'name') state = 'gap';
      else if (state === 'attribute') state = 'equals';
      continue;
    }
    if (state === 'name' || state === 'gap') {
      if (read === '>') return true;
      if (read === '/') state = 'slash';
      else if (state === 'gap' && NAME_CHARACTERS.test(read)) state = 'attribute';
      else return false;
      continue;
    }
    if (state === 'attribute' && NAME_CHARACTERS.test(read)) continue;
    return read === '=';
  }
  return false;
}

/**
 * Neutralize the opener and closer of every tag in `options.tags` (by default every harness tag)
 * so text from outside the harness cannot open, close or forge one. Only the `<` is rewritten:
 * the rest of the text, the tag's name and attributes included, stays as written.
 */
export function neutralizeTags(text: string, options: NeutralizeTagsOptions = {}): string {
  const style = options.style ?? 'harness';
  const tags = options.tags ?? HARNESS_TAGS;
  if (style === 'entity') return text.replace(literalTagPattern(tags), '&lt;$1$2');
  if (style === 'backslash') return text.replace(literalTagPattern(tags), '<\\$1$2');
  const names = new Set(tags.map((tag) => tag.toLowerCase()));
  const prefixes = options.tags ? [] : HARNESS_TAG_PREFIXES;
  const isHarnessTag = (name: string) =>
    names.has(name) ||
    prefixes.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
  let neutral = '';
  let copied = 0;
  for (const match of text.matchAll(OPENER)) {
    const opener = readUnit(text, match.index);
    if (opener.read !== '<') continue;
    const tag = readTag(text, opener.end);
    if (!tag || !isHarnessTag(tag.name)) continue;
    if (tag.spaced && !endsLikeTag(text, tag.end)) continue;
    // Two backslashes after the `<`: read as written the tag is `<\\name`, and decoded from a JSON
    // string it is `<\name`. Neither is markup. Backslashes already there are folded into these
    // two; everything else, whitespace and invisible characters included, stays as written.
    neutral += `${text.slice(copied, opener.end)}\\\\`;
    copied = opener.end;
    for (const backslash of tag.backslashes) {
      neutral += text.slice(copied, backslash);
      copied = backslash + 1;
    }
  }
  return copied === 0 ? text : neutral + text.slice(copied);
}
