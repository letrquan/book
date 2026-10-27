/**
 * Harness tags: the markup Book's prompts are built from, which text from outside the harness — a
 * repository file, another session's message (#620) — must never be able to open or close. Text
 * like that is neutralized before it reaches a prompt: the `<` of each harness tag is rewritten so
 * the tag no longer reads as markup, and everything else is left as written.
 *
 * TODO(#620): fold homoglyphs and fullwidth brackets (`＜`, `‹`), and a space after the `<`,
 * before matching, as Claude Code does; until then only the ASCII spellings are caught.
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
   * - `harness` (the default): `<` becomes `<\\`, and the tag is found however it is spelled in a
   *   JSON string (`<`, `\/`, `/`, an escaped letter), so it stays neutral after the
   *   string is decoded as well as read as written;
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

// A `<` that may begin a tag, however a JSON string spells each character: the `<`, any backslashes
// a writer put after it, an optional `/`, then the run of tag-name characters, any of them written
// as a `\u00XX` escape. The run is decoded and checked against the tag list in code: a regex of
// every escaped spelling of every name would be long and slow. Neither the backslashes nor the
// name may swallow an escape that is not a name character (`<`), or the `<` it spells would
// be skipped over unchecked.
const LESS_THAN = String.raw`(?:<|\\u003[cC])`;
const BACKSLASHES = String.raw`(?:\\(?!u00))*`;
const SLASH = String.raw`(?:\/|\\\/|\\u002[fF])`;
const ESCAPED_NAME_CHAR = String.raw`\\u00(?:2[dD]|3[0-9aA]|[46][1-9a-fA-F]|[57][0-9aA]|5[fF])`;
const NAME_CHAR = `(?:[A-Za-z0-9_:-]|${ESCAPED_NAME_CHAR})`;
const SPELLED_TAG = new RegExp(`(${LESS_THAN})${BACKSLASHES}(${SLASH})?(${NAME_CHAR}+)`, 'g');

/** The tag name a run of name characters spells once its escapes are decoded, case folded. */
function decodedTagName(raw: string): string {
  const decoded = raw
    .replace(/\\u00([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .toLowerCase();
  return /^[a-z0-9_:-]*/.exec(decoded)?.[0] ?? '';
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
  return text.replace(
    SPELLED_TAG,
    (match: string, lessThan: string, slash: string | undefined, name: string) => {
      const decoded = decodedTagName(name);
      const harness =
        names.has(decoded) ||
        prefixes.some((prefix) => decoded.startsWith(prefix) && decoded.length > prefix.length);
      // Two backslashes: read as written the tag is `<\\name`, and decoded from a JSON string it
      // is `<\name`. Neither is markup. Backslashes already there are folded into these two.
      return harness ? `${lessThan}\\\\${slash ?? ''}${name}` : match;
    },
  );
}
