/**
 * Extraction of the shell substitutions a slash-command body performs.
 *
 * Two callers must never disagree about this list: the approval fingerprint
 * (`command-approvals.ts`) and the executor (`resolve.ts`). Deriving both from
 * one scan is what makes "the shell that ran is the shell that was approved"
 * true by construction rather than by review.
 *
 * Extraction runs against the raw body, before variable substitution, because
 * that is when the resolver executes: the `command` string here is byte-for-byte
 * what reaches the shell, so `$ARGUMENTS` cannot smuggle anything into an
 * approved command.
 *
 * The single scan also closes a second-order hole. Substituting fenced blocks
 * first and then scanning the *result* for inline backticks — as this resolver
 * used to — re-reads command output as source, so a block that printed
 * ``!`cmd` `` would have it executed. Spans are taken from the original body
 * once and output is never rescanned.
 */

export type ShellInjectionKind = 'block' | 'command';

export interface ShellInjection {
  /** ```` ```! ```` fenced block, or an inline ``!`cmd` `` span. */
  kind: ShellInjectionKind;
  /** Exactly the string handed to the shell. */
  command: string;
  /** Half-open span of the placeholder within the body. */
  start: number;
  end: number;
}

/**
 * Fenced blocks are matched against the raw body, independently of everything
 * else in it. Folding both forms into one alternation looked equivalent and was
 * not: an earlier plain ``` fence or a stray backtick leaves odd backtick
 * parity, and the inline alternative then swallows the first backtick of a
 * later ```! opener — turning a block into an inline command with a span that
 * leaves stray backticks in the prompt.
 */
const BLOCK_PATTERN = /```!\s*\n([\s\S]*?)```/g;
const INLINE_PATTERN = /!?`([^`]+)`/g;

export function extractShellInjections(body: string): ShellInjection[] {
  const injections: ShellInjection[] = [];
  // Same UTF-16 code units the regex indexes, so blanking a span preserves
  // every later offset exactly.
  const outsideBlocks = body.split('');

  for (const match of body.matchAll(BLOCK_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    injections.push({ kind: 'block', command: match[1].trim(), start, end });
    // Blank the span before the inline scan: a block contributes no backticks
    // to pair with, and — unlike substituting its output first — nothing a
    // command prints can be read back as source.
    for (let index = start; index < end; index++) outsideBlocks[index] = ' ';
  }

  for (const match of outsideBlocks.join('').matchAll(INLINE_PATTERN)) {
    const inline = match[1];
    // A plain `code` span is Markdown prose, not an instruction to run anything.
    if (!match[0].startsWith('!`') && !inline.startsWith('!')) continue;
    const start = match.index ?? 0;
    injections.push({
      kind: 'command',
      command: (inline.startsWith('!') ? inline.slice(1) : inline).trim(),
      start,
      end: start + match[0].length,
    });
  }

  // Document order: it is both the execution order and what the approval
  // fingerprint digests.
  return injections.sort((left, right) => left.start - right.start);
}

/**
 * Replace each extracted span with its output.
 *
 * `outputs` is positional against `injections`, which must have come from
 * `extractShellInjections(body)` — the spans index into that exact body.
 */
export function applyShellInjections(
  body: string,
  injections: readonly ShellInjection[],
  outputs: readonly string[],
): string {
  let result = '';
  let cursor = 0;
  for (const [index, injection] of injections.entries()) {
    result += body.slice(cursor, injection.start);
    result += outputs[index] ?? '';
    cursor = injection.end;
  }
  return result + body.slice(cursor);
}
