import { describe, it, expect } from 'vitest';
import { splitReasoningParts, stripReasoningTags } from './reasoning-tags.js';

/** The opening tag `stripReasoningTags` leaves behind but the renderer strips. */
const REASONING_TAG_OPENER = /<(think|thinking|reasoning|reasoning_context)>/gi;

describe('stripReasoningTags', () => {
  it('leaves ordinary content untouched', () => {
    expect(stripReasoningTags('just an answer')).toBe('just an answer');
  });

  it('drops every reasoning tag a provider may emit', () => {
    for (const tag of ['think', 'thinking', 'reasoning', 'reasoning_context']) {
      expect(stripReasoningTags(`before<${tag}>hidden</${tag}>after`)).toBe('beforeafter');
    }
  });

  it('reports an empty reasoning block as no answer at all', () => {
    // The exact shape an OpenAI-compatible router emits when the model produced
    // only thinking. Left unstripped it reads as a finished 15-character answer
    // and ends the run.
    expect(stripReasoningTags('<think></think>').trim()).toBe('');
  });

  it('reports a filled reasoning block with no answer as no answer', () => {
    expect(stripReasoningTags('<think>weighing options</think>').trim()).toBe('');
  });

  it('keeps an answer that follows a reasoning block', () => {
    expect(stripReasoningTags('<think>planning</think>the answer').trim()).toBe('the answer');
  });

  it('keeps an unclosed tag as answer text', () => {
    // Deliberately more conservative than the renderer. Judging emptiness by the
    // lenient reading would strip a finished answer that merely opens with an
    // unfenced `<thinking>` down to nothing, and the loop would then fail a run
    // that had answered. A missed retry is the cheaper mistake.
    expect(stripReasoningTags('<thinking>is a common template convention').trim()).not.toBe('');
    expect(stripReasoningTags('answer<think>still going').trim()).toBe('answer<think>still going');
  });

  it('leaves a fenced example alone', () => {
    // This repository's own docs quote reasoning tags; stripping them from a
    // fence would silently empty the code block in a real answer.
    const content = ['see:', '```', '<thinking>quoted</thinking>', '```'].join('\n');
    expect(stripReasoningTags(content)).toBe(content);
  });

  it('leaves an unrelated tag alone', () => {
    expect(stripReasoningTags('see <div>x</div> here')).toBe('see <div>x</div> here');
  });

  it('is stable across repeated calls', () => {
    // The pattern is a module-level /g regex; a stale lastIndex would drop the
    // first block of the next message.
    const input = '<think>a</think>tail';
    expect(stripReasoningTags(input)).toBe(stripReasoningTags(input));
  });
});

describe('splitReasoningParts', () => {
  it('keeps the reasoning body for callers that render it', () => {
    expect(splitReasoningParts('before<think>hidden</think>after')).toEqual([
      { kind: 'markdown', text: 'before' },
      { kind: 'think', text: 'hidden' },
      { kind: 'markdown', text: 'after' },
    ]);
  });

  it('hides an unclosed block while the message is still streaming', () => {
    // Mid-stream this is the whole point: the thought stays out of the answer
    // until the provider closes it, so nothing private flashes into view.
    expect(splitReasoningParts('<reasoning_context>weighing the options')).toEqual([
      { kind: 'think', text: 'weighing the options' },
    ]);
  });

  it('reads a concluded unclosed block that holds the entire answer as answer text', () => {
    // The shape that made a finished turn look abandoned: a router replays prior
    // reasoning inside these tags, the model copies the convention, opens one and
    // never closes it, and the renderer files the completed report as a thought
    // it then collapses to a single line.
    const content = `<reasoning_context>
ranking the candidates

## Recommendation`;

    expect(splitReasoningParts(content, { concluded: true })).toEqual([
      {
        kind: 'markdown',
        text: `ranking the candidates

## Recommendation`,
      },
    ]);
  });

  it('drops the dangling tag rather than leaking it into the markdown', () => {
    // `marked` renders raw markup as a fenced `html` block, which would bury the
    // recovered answer just as thoroughly as the collapsed thought did.
    const parts = splitReasoningParts('<thinking>the answer', { concluded: true });

    expect(parts.map((part) => part.text).join('')).not.toContain('<thinking>');
  });

  it('leaves a concluded closed block collapsed even when it is the whole message', () => {
    // A turn that only thought really did produce no answer. Promoting this would
    // publish reasoning the provider explicitly delimited as private.
    expect(splitReasoningParts('<think>weighing options</think>', { concluded: true })).toEqual([
      { kind: 'think', text: 'weighing options' },
    ]);
  });

  it('recovers a report stranded behind a one-line preamble', () => {
    // The router-replay shape in full: a closed block the model echoed, a line of
    // narration, then the real report behind a tag it never closed. Bailing out
    // because the preamble is non-blank would leave the report collapsed and the
    // turn still reading as abandoned.
    const content = `<reasoning_context>echoed prior reasoning</reasoning_context>
Now let me continue.
<reasoning_context>weighing them, then the report`;

    expect(splitReasoningParts(content, { concluded: true })).toEqual([
      { kind: 'think', text: 'echoed prior reasoning' },
      {
        kind: 'markdown',
        text: `
Now let me continue.
`,
      },
      { kind: 'markdown', text: 'weighing them, then the report' },
    ]);
  });

  it('promotes only the unterminated block, not a closed one before it', () => {
    expect(
      splitReasoningParts('<think>private</think><thinking>the answer', { concluded: true }),
    ).toEqual([
      { kind: 'think', text: 'private' },
      { kind: 'markdown', text: 'the answer' },
    ]);
  });

  it('shows exactly the text the loop counts as this turn answering', () => {
    // The renderer hiding text that `stripReasoningTags` counts as an answer is
    // the disagreement that lost a completed turn, so pin the contents, not just
    // whether something rendered. The two readings differ only in the dangling
    // tag itself, which the renderer must drop — `marked` would turn it into a
    // fenced `html` block and bury the answer a second time.
    for (const content of [
      '<reasoning_context>only an unclosed report',
      '<think>closed</think>',
      'plain answer',
      'answer<think>trailing',
      '<think>closed</think>preamble<thinking>the report',
    ]) {
      const rendered = splitReasoningParts(content, { concluded: true })
        .filter((part) => part.kind === 'markdown')
        .map((part) => part.text)
        .join('');
      const counted = stripReasoningTags(content).replace(REASONING_TAG_OPENER, '');

      expect(rendered).toBe(counted);
    }
  });
});
