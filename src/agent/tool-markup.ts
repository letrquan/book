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
   * Whether a block cut off before its closing tag still counts. Only for markers that prose has
   * no reason to contain: a lone `<tool_call>` can be a sentence about the tag.
   */
  readonly mayBeUnclosed: boolean;
}

const FORMATS: readonly FormatSpec[] = [
  {
    // `<｜DSML｜ calls>`, `<｜DSML｜function_calls>`, `<｜DSML｜ invoke name="Grep">`, … The whole
    // family rather than one tag name: the tag set differs between DeepSeek releases.
    format: 'dsml',
    label: 'DeepSeek DSML',
    open: /<[｜|]DSML[｜|][^<>\n]*>/g,
    close: /<\/[｜|]DSML[｜|][^<>\n]*>/g,
    closeAtEnd: /<\/[｜|]DSML[｜|][^<>\n]*>$/,
    mayBeUnclosed: true,
  },
  {
    // `<｜tool▁calls▁begin｜>` … `<｜tool▁calls▁end｜>`, and the per-call `<｜tool▁call▁begin｜>`.
    format: 'deepseek',
    label: 'DeepSeek tool-call tokens',
    open: /<[｜|]tool[▁_]calls?[▁_]begin[｜|]>/g,
    close: /<[｜|]tool[▁_]calls?[▁_]end[｜|]>/g,
    closeAtEnd: /<[｜|]tool[▁_]calls?[▁_]end[｜|]>$/,
    mayBeUnclosed: true,
  },
  {
    // `<tool_call>` … `</tool_call>`, which Qwen3-Coder fills with `<function=…>` rather than
    // JSON. The opening tag has to start a line: after other text, or indented, it is the tag in
    // a sentence or in a code sample.
    format: 'hermes',
    label: '<tool_call> tags',
    open: /^<tool_call>/gm,
    close: /<\/tool_call>/g,
    closeAtEnd: /<\/tool_call>$/,
    mayBeUnclosed: false,
  },
];

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

/**
 * The tool-call markup `text` ends with, or null when it does not.
 *
 * The block has to start outside a code fence and run to the end of the text, ignoring trailing
 * whitespace: closed by one of its own closing tags, or, for the formats whose markers cannot be
 * prose, cut off after an opening tag that is followed by nothing but more markup.
 */
export function detectToolCallMarkup(text: string): ToolMarkup | null {
  const trimmed = text.trimEnd();
  if (trimmed === '') return null;
  let fenced: Array<readonly [number, number]> | undefined;
  for (const spec of FORMATS) {
    const openers = [...trimmed.matchAll(spec.open)];
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
    // Cut off: the text's last tag is an opening one, so nothing closed the block; and what
    // follows the opening tag is more markup, since "...leaks <｜DSML｜ calls> as text." is a
    // sentence about the tag. A closer further up does not matter: a block can be cut off
    // after its first parameter closed.
    const lastOpen = openers[openers.length - 1].index;
    const lastClose = [...trimmed.matchAll(spec.close)].at(-1)?.index ?? -1;
    if (lastClose > lastOpen) continue;
    const startsMarkup = live.some((opener) =>
      /^\s*(?:<|$)/.test(trimmed.slice(opener.index + opener[0].length)),
    );
    if (startsMarkup) return { format: spec.format, label: spec.label, closed: false };
  }
  return null;
}
