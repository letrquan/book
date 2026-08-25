import { describe, it, expect } from 'vitest';
import { splitReasoningParts, stripReasoningTags } from './reasoning-tags.js';

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
});
