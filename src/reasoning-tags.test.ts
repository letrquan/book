import { describe, it, expect } from 'vitest';
import {
  isUnclosedReasoningOnly,
  separateInlineReasoning,
  splitReasoningParts,
  stripReasoningTags,
} from './reasoning-tags.js';

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

describe('isUnclosedReasoningOnly', () => {
  it('recognises a turn that is leaked reasoning from first byte to last', () => {
    // The shape observed in print mode: one opening tag, no closing tag, and a
    // tool call the model serialized as prose, ending mid-sentence. It passed
    // the conservative emptiness reading and the run reported success.
    const content = `<reasoning_context>
Let's check \`npm run lint\` to be sure.call:default_api:Bash{command:npm run lint}`;
    expect(isUnclosedReasoningOnly(content)).toBe(true);
    expect(isUnclosedReasoningOnly(`\n  ${content}`)).toBe(true);
  });

  it('lets a closed block ahead of the unclosed one stand', () => {
    expect(isUnclosedReasoningOnly('<think>a</think><thinking>b')).toBe(true);
  });

  it('is false whenever there is an answer to protect', () => {
    expect(isUnclosedReasoningOnly('just an answer')).toBe(false);
    expect(isUnclosedReasoningOnly('Done. <thinking>trailing notes')).toBe(false);
    expect(isUnclosedReasoningOnly('<think>planning</think>the answer')).toBe(false);
  });

  it('is false for a block the provider closed, which the strip reading already handles', () => {
    expect(isUnclosedReasoningOnly('<think>weighing options</think>')).toBe(false);
  });

  it('leaves a fenced example alone', () => {
    const content = ['```', '<thinking>quoted', '```'].join('\n');
    expect(isUnclosedReasoningOnly(content)).toBe(false);
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

describe('separateInlineReasoning', () => {
  it('separates a closed reasoning_context block from the answer', () => {
    expect(
      separateInlineReasoning(
        '<reasoning_context>\n**Planning**\n</reasoning_context>\nThe answer.',
      ),
    ).toEqual({ content: 'The answer.', reasoning: '**Planning**', found: true });
  });

  it('joins two closed blocks with a blank line', () => {
    const input = '<think>Block 1</think>\n<think>Block 2</think>\nAnswer';
    expect(separateInlineReasoning(input)).toEqual({
      content: 'Answer',
      reasoning: 'Block 1\n\nBlock 2',
      found: true,
    });
  });

  it('returns an unclosed thinking block unchanged with empty reasoning', () => {
    const unclosed = '<thinking>unclosed thought';
    const result = separateInlineReasoning(unclosed);
    expect(result.content).toBe(unclosed);
    expect(result.reasoning).toBe('');
  });

  it('leaves a block inside a fenced code block in content', () => {
    const fenced = ['```', '<thinking>quoted</thinking>', '```'].join('\n');
    const result = separateInlineReasoning(fenced);
    expect(result.content).toBe(fenced);
    expect(result.reasoning).toBe('');
  });

  it('returns plain text with no < by identity', () => {
    const plain = 'just an ordinary answer';
    const result = separateInlineReasoning(plain);
    expect(result.content).toBe(plain);
    expect(result.reasoning).toBe('');
  });

  // Each of the next five lost answer text at 4c87d18: the split is permanent,
  // so a tag the answer merely quotes must never be read as markup.
  it('keeps a reasoning block quoted in inline code in the answer', () => {
    const input = 'Wrap it like `<thinking>plan</thinking>` in your prompt';
    const result = separateInlineReasoning(input);
    expect(result.content).toBe(input);
    expect(result.reasoning).toBe('');
    expect(result.found).toBe(false);
  });

  it('keeps an opening and a closing tag quoted in separate code spans', () => {
    const input = 'The element `<reasoning>` is closed by `</reasoning>`.';
    const result = separateInlineReasoning(input);
    expect(result.content).toBe(input);
    expect(result.reasoning).toBe('');
    expect(result.found).toBe(false);
  });

  it('keeps a tag quoted in prose ahead of a fenced example intact', () => {
    const input = [
      'Use the `<think>` tag like this:',
      '',
      '```',
      '<think>plan</think>',
      '```',
      'Done.',
    ].join('\n');
    const result = separateInlineReasoning(input);
    expect(result.content).toBe(input);
    expect(result.reasoning).toBe('');
    expect(result.found).toBe(false);
  });

  it('ends a nested same-name block at its first closing tag, losing no answer text', () => {
    const result = separateInlineReasoning('<think>A <think>B</think> C</think>\nAnswer');
    expect(result.content).toBe('C</think>\nAnswer');
    expect(result.reasoning).toBe('A <think>B');
    expect(result.found).toBe(true);
  });

  it('leaves a JSON report whose findings mention both tags byte-identical', () => {
    const report = JSON.stringify({
      findings: [
        { title: 'Opening tag', body: 'The parser keeps <think> open.' },
        { title: 'Middle', body: 'Unrelated finding.' },
        { title: 'Closing tag', body: 'A stray </think> survives.' },
      ],
    });
    const bare = separateInlineReasoning(report);
    expect(bare.content).toBe(report);
    expect(bare.reasoning).toBe('');
    expect(bare.found).toBe(false);

    const prefixed = separateInlineReasoning(`<think>plan the review</think>\n${report}`);
    expect(prefixed.content).toBe(report);
    expect(prefixed.reasoning).toBe('plan the review');
    expect(prefixed.found).toBe(true);
  });

  it('leaves the reply as written when its first closing tag is quoted', () => {
    const input = '<think>never write `</think>` early</think>\nAnswer';
    const result = separateInlineReasoning(input);
    expect(result.content).toBe(input);
    expect(result.found).toBe(false);
  });

  it('leaves a block in the middle of an answer where it is', () => {
    const input = 'Answer part 1 <think>more</think> part 2';
    const result = separateInlineReasoning(input);
    expect(result.content).toBe(input);
    expect(result.reasoning).toBe('');
    expect(result.found).toBe(false);
  });

  it('reports an empty block as found so its tags still leave the answer', () => {
    const result = separateInlineReasoning('<think>\n\n</think>\n\nAnswer');
    expect(result.content).toBe('Answer');
    expect(result.reasoning).toBe('');
    expect(result.found).toBe(true);
  });

  // Each of the next tests lost, or failed to split, answer text at 8243818.
  it('ends a block at its first closing tag when the reasoning mentions a bare opening tag', () => {
    const result = separateInlineReasoning(
      '<think>User says not to emit <think> tags.</think>The answer. The closing tag </think> ends it. Tail.',
    );
    expect(result.content).toBe('The answer. The closing tag </think> ends it. Tail.');
    expect(result.reasoning).toBe('User says not to emit <think> tags.');
    expect(result.found).toBe(true);
  });

  it('splits a block whose reasoning has an unpaired backtick', () => {
    const result = separateInlineReasoning(
      '<think>I will use a `x flag</think>Answer with `code` here.',
    );
    expect(result.content).toBe('Answer with `code` here.');
    expect(result.reasoning).toBe('I will use a `x flag');
    expect(result.found).toBe(true);
  });

  it('never lets an unpaired backtick in the reasoning pair with a tag the answer quotes', () => {
    const result = separateInlineReasoning(
      '<think>reasoning with lone `tick</think>The answer. Use `</think>` to close. More answer.',
    );
    expect(result.content).toBe('The answer. Use `</think>` to close. More answer.');
    expect(result.reasoning).toBe('reasoning with lone `tick');
  });

  it('leaves the reply as written when its first closing tag is in a double-backtick span', () => {
    const input = '<think>quote ``</think>`` here</think>\nAnswer';
    const result = separateInlineReasoning(input);
    expect(result.content).toBe(input);
    expect(result.found).toBe(false);
  });

  it('leaves the reply as written when its first closing tag is inside a fence', () => {
    const input = '<think>plan:\n```\n</think>\n```\ndone</think>\nAnswer';
    const result = separateInlineReasoning(input);
    expect(result.content).toBe(input);
    expect(result.found).toBe(false);
  });

  it('closes after a fence that ends right before the closing tag', () => {
    const result = separateInlineReasoning('<think>plan:\n```\ncode\n```\n</think>\nAnswer');
    expect(result.content).toBe('Answer');
    expect(result.reasoning).toBe('plan:\n```\ncode\n```');
  });

  it('keeps a block whose reasoning never closes its fence as answer text', () => {
    const input = '<think>plan:\n```ts\nconst x = 1;\n</think>\nAnswer';
    const result = separateInlineReasoning(input);
    expect(result.content).toBe(input);
    expect(result.found).toBe(false);
  });

  // The next three lost answer text at e3628ce: a skipped first tag let a later one, judged
  // partly by answer text, end the block.
  it('keeps a reply whose reasoning fence is still open at the closing tag', () => {
    const input =
      '<think>Steps:\n1. ```bash\n   npm test\n   ```\n</think>\nUse this template:\n```\n<think>{{reasoning}}</think>\n{{answer}}\n```\nThat is all.';
    const result = separateInlineReasoning(input);
    expect(result.content).toBe(input);
    expect(result.found).toBe(false);
  });

  it('keeps a reply whose closing tag sits between backticks from the reasoning and the answer', () => {
    const input =
      '<think>The fix belongs in `parseArgs`</think>`parseArgs` now rejects the flag. Models close their reasoning with </think> and the router forwards it.';
    const result = separateInlineReasoning(input);
    expect(result.content).toBe(input);
    expect(result.found).toBe(false);
  });

  it('stops at a later leading block whose closing tag looks quoted', () => {
    const result = separateInlineReasoning(
      '<think>a</think>\n<reasoning>run `x`</reasoning>`x` prints </reasoning> and more',
    );
    expect(result.reasoning).toBe('a');
    expect(result.content).toBe('<reasoning>run `x`</reasoning>`x` prints </reasoning> and more');
  });

  it('stores an answer that splitting again leaves unchanged', () => {
    const result = separateInlineReasoning('<think>x</think>\t<think>y</think>\nAnswer');
    expect(result.content).toBe('Answer');
    expect(result.reasoning).toBe('x\n\ny');
    expect(separateInlineReasoning(result.content).found).toBe(false);
  });
});
