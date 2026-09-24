/**
 * Reasoning tags a provider may wrap model thinking in, and the helpers that
 * separate that thinking from a message's actual answer.
 *
 * Not every provider delivers reasoning out of band. OpenAI-compatible routers
 * in particular often inline it into `content` as `<think>…</think>` instead of
 * the `reasoning_content` field the client reads, which leaves a turn whose only
 * output was an empty reasoning block looking like a turn that answered.
 *
 * Two callers need the same view of that text — the agent loop, to judge whether
 * a turn produced anything at all, and the TUI, to render a collapsed thought —
 * so the split lives here. `tui/` is a leaf of the import graph, so the loop
 * cannot reach into the renderer for it.
 */

interface ThinkBlockPart {
  kind: 'think';
  text: string;
}

interface MarkdownPart {
  kind: 'markdown';
  text: string;
}

export type MessagePart = ThinkBlockPart | MarkdownPart;

/**
 * Tags a provider may wrap reasoning in.
 *
 * An unlisted tag is not merely unstyled: `marked` sees raw markup and renders
 * the block as fenced HTML, so the transcript grew a code block labelled `html`
 * containing the model's private reasoning.
 */
const REASONING_TAG_PATTERN =
  /<(think|thinking|reasoning|reasoning_context)>([\s\S]*?)(?:<\/\1>|$)/gi;

/**
 * The same tags, but only where the provider actually closed them.
 *
 * The renderer treats an unclosed tag as reasoning running to the end of the
 * message, which is right mid-stream and keeps private thinking out of the
 * answer. Judging emptiness that way is not safe: a finished answer that merely
 * opens with an unfenced `<thinking>` — a common prompt-template convention, and
 * something this repository's own docs discuss — would strip to nothing, be
 * judged an empty turn, and fail a run that had in fact answered. A block the
 * provider never closed is left as answer text here, so the worst case is a
 * missed retry rather than a discarded reply.
 */
const CLOSED_REASONING_TAG_PATTERN =
  /<(think|thinking|reasoning|reasoning_context)>([\s\S]*?)<\/\1>/gi;

/** Opening or closing line of a fenced code block. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/gm;

/**
 * Byte ranges covered by fenced code blocks.
 *
 * An answer that quotes a prompt template is ordinary content here, and this
 * repository's own docs contain reasoning tags. Without this, such a fence had
 * its contents torn out and rendered as a collapsed thought, so the code block
 * in the answer silently lost its body.
 */
function fencedRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  FENCE_LINE.lastIndex = 0;
  let openedAt: number | null = null;
  let marker = '';
  let match: RegExpExecArray | null;
  while ((match = FENCE_LINE.exec(content)) !== null) {
    if (openedAt === null) {
      openedAt = match.index;
      marker = match[1][0];
    } else if (match[1][0] === marker) {
      ranges.push([openedAt, FENCE_LINE.lastIndex]);
      openedAt = null;
    }
  }
  // An unclosed fence runs to the end of the message, which is the common case
  // mid-stream.
  if (openedAt !== null) ranges.push([openedAt, content.length]);
  return ranges;
}

/**
 * A split, plus whether its last block is one the provider opened and never
 * closed. Such a block always runs to the end of the content, so there is at
 * most one and it is always the final part.
 */
interface Split {
  parts: MessagePart[];
  unterminated: boolean;
}

function splitWith(content: string, pattern: RegExp): Split {
  const parts: MessagePart[] = [];
  const fenced = fencedRanges(content);
  pattern.lastIndex = 0;
  let lastIndex = 0;
  let unterminated = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const index = match.index;
    if (fenced.some(([start, end]) => index >= start && index < end)) continue;
    const before = content.slice(lastIndex, index);
    if (before) parts.push({ kind: 'markdown', text: before });
    parts.push({ kind: 'think', text: match[2].trim() });
    unterminated = !match[0].toLowerCase().endsWith(`</${match[1].toLowerCase()}>`);
    lastIndex = pattern.lastIndex;
  }

  const after = content.slice(lastIndex);
  if (after) parts.push({ kind: 'markdown', text: after });
  return parts.length > 0
    ? { parts, unterminated }
    : { parts: [{ kind: 'markdown', text: content }], unterminated: false };
}

/**
 * Split a message into its answer segments and its reasoning blocks, in order,
 * treating an unclosed tag as reasoning running to the end of the message.
 *
 * That reading is right while the message streams — it is what keeps a thought
 * out of the answer as it arrives — but on a settled message it is a trap. A
 * provider that opened a reasoning tag and never closed it files the whole
 * finished answer as one thought, and the transcript collapses a turn that
 * answered in full down to a single `thought` line, which is indistinguishable
 * from an agent that quit mid-task. It happens: an OpenAI-compatible router
 * replays prior reasoning into history inside these very tags, and a model that
 * sees the convention starts emitting it — inconsistently closed.
 *
 * So pass `concluded` when the message is complete *and* called no tools — when
 * it is everything the turn will ever say. An unterminated block is then read
 * back as answer text, the same conservative reading the agent loop already
 * uses to decide the turn produced something (see
 * `CLOSED_REASONING_TAG_PATTERN`), so renderer and loop agree about what the
 * message is. The worst case becomes reasoning shown inline rather than an
 * answer that vanished.
 *
 * Both halves of that condition matter. A turn that called a tool has not
 * finished speaking and was never at risk — `answeredNothing` in the loop
 * already exempts it — so promoting its narration would only publish reasoning
 * the reader chose to keep collapsed, including when they turned thinking
 * display off entirely.
 */
export function splitReasoningParts(
  content: string,
  options?: { concluded?: boolean },
): MessagePart[] {
  const { parts, unterminated } = splitWith(content, REASONING_TAG_PATTERN);
  if (!options?.concluded || !unterminated) return parts;
  // Promoted whether or not some answer survives beside it. A block the
  // provider never closed is not a delimited thought, and a one-line preamble
  // ahead of a swallowed report is not an answer the reader can use.
  //
  // Only the trailing block is promoted. An earlier block the provider did
  // close is reasoning it meant to delimit, and stays one.
  const last = parts.length - 1;
  return parts.map((part, index) =>
    index === last && part.kind === 'think' ? { kind: 'markdown', text: part.text } : part,
  );
}

/**
 * Whether a settled message is nothing but reasoning the provider never closed.
 *
 * `stripReasoningTags` keeps an unclosed block as answer text on purpose, so a
 * finished answer that merely opens with an unfenced `<thinking>` is never
 * judged empty. The cost of that reading is a turn that is leaked
 * chain-of-thought from its first byte to its last — ending mid-sentence on a
 * tool call the model serialized as prose — passing as an answer. This is the
 * discriminator between the two: the block starts the content, is never
 * closed, and no answer text stands beside it. A closed block ahead of it is
 * reasoning the provider delimited and does not change the reading; text
 * before the opening tag does, because then there is an answer to protect.
 */
export function isUnclosedReasoningOnly(content: string): boolean {
  if (!content.includes('<')) return false;
  const { parts, unterminated } = splitWith(content, REASONING_TAG_PATTERN);
  return (
    unterminated && parts.every((part) => part.kind === 'think' || part.text.trim().length === 0)
  );
}

/**
 * The message with completed reasoning blocks removed.
 *
 * Used to decide whether a turn actually answered, so it is deliberately the
 * conservative reading — see `CLOSED_REASONING_TAG_PATTERN`. Callers that need
 * to *show* the reasoning want `splitReasoningParts` instead; this keeps no
 * record of what it dropped.
 */
export function stripReasoningTags(content: string): string {
  // The overwhelming majority of turns carry no markup at all; skip the scan.
  if (!content.includes('<')) return content;
  return splitWith(content, CLOSED_REASONING_TAG_PATTERN)
    .parts.filter((part): part is MarkdownPart => part.kind === 'markdown')
    .map((part) => part.text)
    .join('');
}

/**
 * A reasoning tag that opens the reply: after any blank lines, and indented
 * less than the four spaces that would make it an indented code block.
 */
const LEADING_REASONING_TAG =
  /^(?:[ \t]*\r?\n)*[ ]{0,3}<(think|thinking|reasoning|reasoning_context)>/i;

/**
 * Byte ranges covered by inline code spans outside fenced code.
 *
 * As in CommonMark, a run of backticks opens a span that the next run of the
 * same length closes, and a run with no partner is literal text. A tag written
 * in one — `<think>` in prose that explains the convention — is being quoted,
 * not used.
 */
function inlineCodeRanges(
  content: string,
  fenced: Array<[number, number]>,
): Array<[number, number]> {
  const runs: Array<{ start: number; length: number }> = [];
  const backticks = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = backticks.exec(content)) !== null) {
    const start = match.index;
    if (!fenced.some(([from, to]) => start >= from && start < to)) {
      runs.push({ start, length: match[0].length });
    }
  }
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < runs.length; i++) {
    let j = i + 1;
    while (j < runs.length && runs[j].length !== runs[i].length) j++;
    if (j === runs.length) continue;
    ranges.push([runs[i].start, runs[j].start + runs[j].length]);
    i = j;
  }
  return ranges;
}

/**
 * Where the block whose opening `tag` ends at `from` is closed: the end of its
 * text and the offset just past its closing tag, or null if it never closes.
 * Tags of the same name nest, so an inner block does not end the outer one,
 * and a tag that touches quoted code is text rather than markup.
 */
function findBlockClose(
  content: string,
  tag: string,
  from: number,
  quoted: Array<[number, number]>,
): { textEnd: number; after: number } | null {
  const tags = new RegExp(`<(/?)${tag}>`, 'gi');
  tags.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(content)) !== null) {
    const start = match.index;
    const end = tags.lastIndex;
    if (quoted.some(([lo, hi]) => start < hi && end > lo)) continue;
    depth += match[1] ? -1 : 1;
    if (depth === 0) return { textEnd: start, after: end };
  }
  return null;
}

/**
 * Split the closed reasoning blocks a settled reply opens with out of it, so
 * they are stored and re-sent as reasoning rather than as answer text.
 *
 * Book renders earlier assistant turns to OpenAI-compatible providers as
 * `<reasoning_context>…</reasoning_context>` followed by the answer, and some
 * routers inline thinking the same way, so models start every reply with that
 * block themselves. Left in `content`, it is what print mode prints and what a
 * `--resume` shows as the answer.
 *
 * What moves here leaves the answer for good — print mode, json `messages`, a
 * managed agent's result and every later request see only what is left — so
 * this is the narrow reading. Only blocks at the very start of the reply move,
 * one after another; a tag later in the answer is content, because answers
 * quote these tags (a review finding about them, a prompt template, prose in
 * backticks). A tag inside inline or fenced code is never markup, blocks of the
 * same name nest, and a block that never closes is kept as answer text for the
 * same reason `stripReasoningTags` keeps it.
 *
 * `found` says whether any block moved, even an empty one: the
 * `<think></think>` a model emits with thinking off has no reasoning to keep
 * but still has to leave the answer.
 */
export function separateInlineReasoning(content: string): {
  content: string;
  reasoning: string;
  found: boolean;
} {
  const unchanged = { content, reasoning: '', found: false };
  if (!content.includes('<')) return unchanged;
  const fenced = fencedRanges(content);
  const quoted = [...fenced, ...inlineCodeRanges(content, fenced)];
  const blocks: string[] = [];
  let rest = 0;
  for (;;) {
    const open = LEADING_REASONING_TAG.exec(content.slice(rest));
    if (!open) break;
    const close = findBlockClose(content, open[1], rest + open[0].length, quoted);
    if (!close) break;
    blocks.push(content.slice(rest + open[0].length, close.textEnd).trim());
    rest = close.after;
  }
  if (blocks.length === 0) return unchanged;
  return {
    content: content
      .slice(rest)
      .replace(/^[ \t]+(?=\S)/, '')
      .replace(/^(?:[ \t]*\r?\n)+/, ''),
    reasoning: blocks.filter(Boolean).join('\n\n'),
    found: true,
  };
}
