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

function splitWith(content: string, pattern: RegExp): MessagePart[] {
  const parts: MessagePart[] = [];
  const fenced = fencedRanges(content);
  pattern.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const index = match.index;
    if (fenced.some(([start, end]) => index >= start && index < end)) continue;
    const before = content.slice(lastIndex, index);
    if (before) parts.push({ kind: 'markdown', text: before });
    parts.push({ kind: 'think', text: match[2].trim() });
    lastIndex = pattern.lastIndex;
  }

  const after = content.slice(lastIndex);
  if (after) parts.push({ kind: 'markdown', text: after });
  return parts.length > 0 ? parts : [{ kind: 'markdown', text: content }];
}

/**
 * Split a message into its answer segments and its reasoning blocks, in order,
 * treating an unclosed tag as reasoning running to the end of the message.
 */
export function splitReasoningParts(content: string): MessagePart[] {
  return splitWith(content, REASONING_TAG_PATTERN);
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
    .filter((part): part is MarkdownPart => part.kind === 'markdown')
    .map((part) => part.text)
    .join('');
}
