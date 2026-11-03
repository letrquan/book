/**
 * Tool-call markup that a route left in the text of a reply (#667).
 *
 * A router that cannot parse a model's tool-call syntax passes it on as `content`. The turn then
 * calls no tool and reads as a finished answer: a run ended `completed` on a Grep that never ran.
 * DeepSeek V4 writes DSML, DeepSeek V3 its `<｜tool▁calls▁begin｜>` tokens, and Qwen and Hermes
 * models `<tool_call>` tags.
 *
 * The check is narrow on purpose. A reply counts only when it _ends_ with a block in one of these
 * shapes, because a reply that talks about the format (an answer about Qwen's template, the tests
 * of this very repository) is an answer. A tag mentioned in prose, a fenced example, and a block
 * inside a fence that was never closed do not count. The block is not parsed into a call either:
 * running something the model never sent through the API is a larger decision than refusing to
 * call the turn finished.
 *
 * Known limits, kept on purpose because nothing in the text tells them apart from the real thing:
 * an answer that ends with an unfenced, unindented `<tool_call>` block, or with unfenced DSML or
 * DeepSeek tokens, reads as markup; and fences are read line by line (three or more backticks or
 * tildes, any indentation), so one in a blockquote is not recognised.
 *
 * The regular expressions write the markers as escapes. `｜` is the fullwidth vertical line
 * `｜` and `▁` the lower one-eighth block `▁`; an ASCII `|` and `_` are accepted beside them,
 * since a route that re-encodes its output tends to flatten both.
 */

export type ToolMarkupFormat = 'dsml' | 'deepseek' | 'hermes';

export interface ToolMarkup {
  readonly format: ToolMarkupFormat;
  /** The format as a person names it, for a message. */
  readonly label: string;
  /** Whether the text ends with the block's closing tag, rather than being cut off before it. */
  readonly closed: boolean;
}

interface FormatSpec {
  readonly format: ToolMarkupFormat;
  readonly label: string;
  /** Every opening tag. Global, so `matchAll` walks them. */
  readonly open: RegExp;
  /** Every closing tag. Global too. */
  readonly close: RegExp;
  /** A closing tag at the very end of the text. */
  readonly closeAtEnd: RegExp;
  /**
   * Whether a block that was cut off before its closing tag still counts. Only for markers that prose
   * has no reason to contain: a lone `<tool_call>` can be a sentence about the tag.
   */
  readonly mayBeUnclosed: boolean;
  /**
   * Narrows the opening tags to those that can start a block where they stand, for a tag that prose
   * can contain as well. Code rather than a pattern: a lookbehind at the front of a pattern is tried
   * at every position, which is quadratic on a long run of spaces.
   */
  readonly startsBlock?: (text: string, index: number, length: number) => boolean;
}

/** Whether the line holds anything but spaces before `index`, looking back at most 200 characters. */
function narrationBefore(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0 && i >= index - 200; i--) {
    if (text[i] === '\n') return false;
    if (text[i] !== ' ' && text[i] !== '\t') return true;
  }
  return false;
}

/**
 * A `<tool_call>` that can start a block: the one that starts a line (what Qwen's template writes),
 * or one that follows other text on a line of its own with the block starting on the next. After
 * indentation, or with its content on the same line, it is a tag in a code sample or a sentence.
 */
function startsHermesBlock(text: string, index: number, length: number): boolean {
  if (index === 0 || text[index - 1] === '\n') return true;
  return (
    narrationBefore(text, index) && /^\r?\n/.test(text.slice(index + length, index + length + 2))
  );
}

// A DSML tag body is a name and a few attributes, so it is bounded (`{0,200}`) rather than allowed to
// swallow a paragraph that happens to lack a `<`.
const FORMATS: readonly FormatSpec[] = [
  {
    // `<｜DSML｜ calls>`, `<｜DSML｜function_calls>`, `<｜DSML｜ invoke name="Grep">`, … The whole
    // family rather than one tag name: the tag set differs between DeepSeek releases.
    format: 'dsml',
    label: 'DeepSeek DSML',
    open: /<[\uFF5C|]DSML[\uFF5C|][^<>\n]{0,200}>/g,
    close: /<\/[\uFF5C|]DSML[\uFF5C|][^<>\n]{0,200}>/g,
    closeAtEnd: /<\/[\uFF5C|]DSML[\uFF5C|][^<>\n]{0,200}>$/,
    mayBeUnclosed: true,
  },
  {
    // `<｜tool▁calls▁begin｜>` … `<｜tool▁calls▁end｜>`, and the per-call `<｜tool▁call▁begin｜>`.
    format: 'deepseek',
    label: 'DeepSeek tool-call tokens',
    open: /<[\uFF5C|]tool[\u2581_]calls?[\u2581_]begin[\uFF5C|]>/g,
    close: /<[\uFF5C|]tool[\u2581_]calls?[\u2581_]end[\uFF5C|]>/g,
    closeAtEnd: /<[\uFF5C|]tool[\u2581_]calls?[\u2581_]end[\uFF5C|]>$/,
    mayBeUnclosed: true,
  },
  {
    // `<tool_call>` … `</tool_call>`, which Qwen3-Coder fills with `<function=…>` rather than JSON.
    format: 'hermes',
    label: '<tool_call> tags',
    open: /<tool_call>/g,
    close: /<\/tool_call>/g,
    closeAtEnd: /<\/tool_call>$/,
    mayBeUnclosed: false,
    startsBlock: startsHermesBlock,
  },
];

/**
 * An end-of-turn token a route can leak after the block it passed on. It is not prose, so it does
 * not make the block "followed by more text".
 */
const END_TOKEN_AT_END =
  /<[\uFF5C|](?:end[\u2581_]of[\u2581_]sentence|im_end|endoftext|eot_id|end_of_text)[\uFF5C|]>$/;

/** A code fence's opening or closing line: three or more backticks or tildes, then the rest. */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/;

/**
 * The stretches of `text` inside a fenced code block, as `[from, to)` offsets. A fence that is
 * never closed runs to the end of the text, the way a Markdown renderer reads it.
 */
function fencedRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let open: { char: string; length: number; from: number } | undefined;
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length;
    const fence = FENCE_LINE.exec(line);
    if (open === undefined) {
      // A backtick fence's info string cannot hold a backtick: ```a``` is an inline span.
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        open = { char: fence[1][0], length: fence[1].length, from: offset };
      }
    } else if (
      fence &&
      fence[1][0] === open.char &&
      fence[1].length >= open.length &&
      fence[2].trim() === ''
    ) {
      ranges.push([open.from, lineEnd]);
      open = undefined;
    }
    offset = lineEnd + 1;
  }
  if (open !== undefined) ranges.push([open.from, text.length]);
  return ranges;
}

/** Whether only spaces and tabs stand between the start of `index`'s line and `index`. */
function startsLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, index));
}

/**
 * The tool-call markup `text` ends with, or null when it does not.
 *
 * The block has to start outside a code fence and run to the end of the text, ignoring trailing
 * whitespace and end-of-turn tokens: closed by one of its own closing tags, or, for the formats
 * whose markers cannot be prose, cut off after an opening tag that is followed by more markup
 * (or that stands alone on its line, with nothing after it).
 */
export function detectToolCallMarkup(text: string): ToolMarkup | null {
  let trimmed = text.trimEnd();
  // A bounded loop rather than one pattern with a repeated group: `(\s*token)+$` backtracks
  // quadratically on a long run of whitespace, and a model repeating the token forever is not a
  // reply worth reading further.
  for (let strip = 0; strip < 4; strip++) {
    const stripped = trimmed.replace(END_TOKEN_AT_END, '').trimEnd();
    if (stripped === trimmed) break;
    trimmed = stripped;
  }
  if (trimmed === '') return null;
  let fenced: Array<readonly [number, number]> | undefined;
  for (const spec of FORMATS) {
    const openers = [...trimmed.matchAll(spec.open)].filter(
      (opener) => spec.startsBlock?.(trimmed, opener.index, opener[0].length) ?? true,
    );
    if (openers.length === 0) continue;
    const ranges = (fenced ??= fencedRanges(trimmed));
    const live = openers.filter(
      (opener) => !ranges.some(([from, to]) => opener.index >= from && opener.index < to),
    );
    if (live.length === 0) continue;
    if (spec.closeAtEnd.test(trimmed)) {
      return { format: spec.format, label: spec.label, closed: true };
    }
    if (!spec.mayBeUnclosed) continue;
    // Cut off: the text's last tag is an opening one, so nothing closed the block. A closer
    // further up does not matter, since a block can be cut off after its first parameter closed.
    const lastOpen = openers[openers.length - 1].index;
    const lastClose = [...trimmed.matchAll(spec.close)].at(-1)?.index ?? -1;
    if (lastClose > lastOpen) continue;
    // What follows the opening tag has to be more markup: "...leaks <｜DSML｜ calls> as text." is a
    // sentence about the tag. A tag with nothing after it counts only on a line of its own, since
    // "- DeepSeek emits <｜DSML｜function_calls>" is a sentence too.
    const startsMarkup = live.some((opener) => {
      const afterTag = trimmed.slice(opener.index + opener[0].length);
      return afterTag === '' ? startsLine(trimmed, opener.index) : /^\s*</.test(afterTag);
    });
    if (startsMarkup) return { format: spec.format, label: spec.label, closed: false };
  }
  return null;
}
