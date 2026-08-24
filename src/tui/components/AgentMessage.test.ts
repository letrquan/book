import { describe, it, expect } from 'vitest';
import {
  countReasoningLines,
  countReasoningRows,
  getRetryLabel,
  managedAgentTracesEqualForMessage,
  splitThinkBlocks,
  trimPartialClosingFences,
} from './AgentMessage.js';
import type { ManagedAgentTrace } from '../managed-agent-transcript.js';
import type { Message } from '../../types/messages.js';

/**
 * Tests for AgentMessage retry rendering logic.
 *
 * The component renders retry state in two modes:
 * 1. No content yet (spinner-only phase): retry label shown as a standalone spinner line.
 * 2. Content exists (streaming resumed after retry): retry label shown on its own
 *    line ABOVE the content, not inline with it. This prevents the new response
 *    from printing inline with the retry message.
 */

describe('getRetryLabel', () => {
  it('returns undefined for "none" phase', () => {
    expect(getRetryLabel('none', 0, 0, 0)).toBeUndefined();
  });

  it('transport retry with countdown and attempt', () => {
    const label = getRetryLabel('transport', 3, 10, 4500);
    expect(label).toContain('Retrying in');
    expect(label).toContain('5s'); // 4500ms → ceil = 5s
    expect(label).toContain('attempt 3/10');
  });

  it('transport retry with no max attempts', () => {
    const label = getRetryLabel('transport', 7, 0, 2000);
    expect(label).toContain('attempt 7');
    expect(label).not.toContain('/');
  });

  it('transport retry at 0ms countdown shows 0s', () => {
    const label = getRetryLabel('transport', 1, 5, 0);
    expect(label).toContain('0s');
  });

  it('stalled retry with network message', () => {
    const label = getRetryLabel('stalled', 1, 5, 8000);
    expect(label).toContain('Waiting for API response');
    expect(label).toContain('check your network');
    expect(label).toContain('8s');
  });

  it('watchdog retry', () => {
    const label = getRetryLabel('watchdog', 47, 0, 0);
    expect(label).toContain('Retrying (watchdog)');
    expect(label).toContain('attempt 47');
  });
});

describe('AgentMessage retry layout contract', () => {
  /**
   * These tests encode the layout contract without rendering:
   * - When content exists AND retryPhase is not 'none', the retry label
   *   should be rendered ABOVE the content in a separate Box.
   * - When no content exists, retry label is shown inline in the spinner line.
   *
   * The component implements this by checking `isRetrying && spinnerLabel`
   * BEFORE the content <Box>, and rendering a separate marginBottom Box
   * for the retry label.
   */

  it('retry label is non-empty when retrying with content present', () => {
    // Simulate: content="previous response", retryPhase="transport", attempt=2
    const label = getRetryLabel('transport', 2, 5, 3000);
    expect(label).toBeTruthy();
    // The label should NOT be undefined — the component uses this to decide
    // whether to render the retry line above content.
    expect(typeof label).toBe('string');
    expect(label!.length).toBeGreaterThan(0);
  });

  it('retry label is undefined when not retrying — no extra line rendered', () => {
    // When retryPhase is 'none', getRetryLabel returns undefined.
    // The component's `isRetrying` check (retryPhase !== 'none') is false,
    // so neither the standalone retry spinner nor the inline retry label
    // above content is rendered.
    const label = getRetryLabel('none', 0, 0, 0);
    expect(label).toBeUndefined();
  });

  it('stream resume (phase "none") clears retry label — content renders alone', () => {
    // After onStreamResume, retryPhase is set to 'none'.
    // getRetryLabel returns undefined. The content renders with just a
    // streaming spinner, no retry label above or inline.
    const label = getRetryLabel('none', 3, 10, 0);
    expect(label).toBeUndefined();
  });

  it('transport retry with large attempt count renders correctly', () => {
    const label = getRetryLabel('transport', 99, 100, 1000);
    expect(label).toContain('attempt 99/100');
  });
});

describe('trimPartialClosingFences', () => {
  it('strips partial closing fence (``)', () => {
    expect(trimPartialClosingFences('```rust\nfn main() {}\n``')).toBe('```rust\nfn main() {}\n');
  });

  it('strips partial closing fence (single backtick)', () => {
    expect(trimPartialClosingFences('```ts\nconst x = 1;\n`')).toBe('```ts\nconst x = 1;\n');
  });

  it('leaves complete fence unchanged', () => {
    const input = 'text\n```\ncode\n```';
    expect(trimPartialClosingFences(input)).toBe(input);
  });

  it('leaves plain text unchanged', () => {
    const input = 'plain text';
    expect(trimPartialClosingFences(input)).toBe(input);
  });

  it('leaves empty last line unchanged (no partial fence)', () => {
    const input = '```js\ncode\n';
    expect(trimPartialClosingFences(input)).toBe(input);
  });

  it('leaves text unchanged when no opening fence exists', () => {
    const input = 'just some `backticks` here';
    expect(trimPartialClosingFences(input)).toBe(input);
  });

  it('leaves complete closing fence unchanged even as last line', () => {
    // A complete ``` on the last line could be a real closing fence
    // or a soon-to-be-closing fence — we can't distinguish. Keep it.
    const input = '```rust\ncode\n```';
    expect(trimPartialClosingFences(input)).toBe(input);
  });

  it('handles nested fence by matching nearest opening', () => {
    // Inner block already closed, outer block still open with partial
    const input = '```md\nouter start\n```js\ninner code\n```\nouter end\n``';
    expect(trimPartialClosingFences(input)).toBe(
      '```md\nouter start\n```js\ninner code\n```\nouter end\n',
    );
  });
});

describe('reasoning presentation', () => {
  it('counts only visible reasoning lines', () => {
    expect(countReasoningLines('first\n\n  second  \n')).toBe(2);
  });
});

describe('managed-agent render invalidation', () => {
  const message: Message = {
    id: 'assistant-1',
    role: 'assistant',
    content: 'delegated',
    includeInContext: true,
    timestamp: 1,
    toolCalls: [{ id: 'spawn-1', name: 'AgentSpawn', arguments: {} }],
  };

  function trace(agentId: string): ManagedAgentTrace {
    return {
      agentId,
      parentToolCallId: 'spawn-1',
      profile: 'explorer',
      purpose: 'Inspect the repository',
      status: 'running',
      startedAt: 1,
      toolUses: [],
    };
  }

  it('ignores trace-map changes for messages without the changed spawn', () => {
    const before = new Map([['other-spawn', trace('agent-2')]]);
    const after = new Map([
      ['other-spawn', trace('agent-2')],
      ['unrelated', trace('agent-3')],
    ]);

    expect(managedAgentTracesEqualForMessage(message, before, after)).toBe(true);
  });

  it('rerenders when the message-owned managed trace changes', () => {
    const before = new Map([['spawn-1', trace('agent-1')]]);
    const after = new Map([['spawn-1', { ...trace('agent-1'), status: 'completed' as const }]]);

    expect(managedAgentTracesEqualForMessage(message, before, after)).toBe(false);
  });
});

describe('splitThinkBlocks reasoning tags', () => {
  it('captures the body of every reasoning tag a provider may emit', () => {
    for (const tag of ['think', 'thinking', 'reasoning', 'reasoning_context']) {
      const parts = splitThinkBlocks(`before<${tag}>hidden</${tag}>after`);
      expect(parts).toEqual([
        { kind: 'markdown', text: 'before' },
        { kind: 'think', text: 'hidden' },
        { kind: 'markdown', text: 'after' },
      ]);
    }
  });

  it('keeps an unclosed reasoning tag out of the answer while it streams', () => {
    // Unhandled, marked sees raw markup and renders the model's private
    // reasoning as a fenced `html` block in the transcript.
    const parts = splitThinkBlocks('answer<reasoning_context>still thinking');
    expect(parts).toEqual([
      { kind: 'markdown', text: 'answer' },
      { kind: 'think', text: 'still thinking' },
    ]);
  });

  it('does not restart matching mid-transcript when reused', () => {
    // The pattern is a module-level /g regex; a stale lastIndex would drop the
    // first block of the next message.
    const input = '<think>a</think>tail';
    expect(splitThinkBlocks(input)).toEqual(splitThinkBlocks(input));
  });

  it('leaves an unrelated tag alone', () => {
    expect(splitThinkBlocks('see <div>x</div> here')).toEqual([
      { kind: 'markdown', text: 'see <div>x</div> here' },
    ]);
  });
});

describe('countReasoningRows', () => {
  it('counts rendered rows, not source lines', () => {
    // The collapsed row advertises what expanding costs. Counting source lines
    // put `2 lines` above four wrapped rows, which reads as a broken count.
    const long = 'x'.repeat(100);
    expect(countReasoningRows(long, 25)).toBe(4);
    expect(countReasoningRows(long, undefined)).toBe(1);
  });

  it('ignores blank lines and sums across paragraphs', () => {
    expect(countReasoningRows('one\n\n\ntwo', 80)).toBe(2);
  });

  it('counts a short line as one row', () => {
    expect(countReasoningRows('short', 80)).toBe(1);
  });

  it('stays sane at a nonsense width', () => {
    expect(countReasoningRows('x'.repeat(40), 0)).toBe(1);
    expect(countReasoningRows('x'.repeat(40), -10)).toBe(1);
  });
});

describe('splitThinkBlocks and code fences', () => {
  it('leaves a reasoning tag inside a fenced block alone', () => {
    // An answer quoting a prompt template is ordinary content; tearing the tag
    // out gutted the code block it lived in.
    const content = ['Use this template:', '', '```ts', '<thinking>plan</thinking>', '```'].join(
      '\n',
    );
    expect(splitThinkBlocks(content)).toEqual([{ kind: 'markdown', text: content }]);
  });

  it('still splits a tag outside the fence', () => {
    const content = ['<think>real</think>answer', '```', '<thinking>quoted</thinking>', '```'].join(
      '\n',
    );
    const parts = splitThinkBlocks(content);
    expect(parts[0]).toEqual({ kind: 'think', text: 'real' });
    expect(parts[1].kind).toBe('markdown');
    expect(parts[1].text).toContain('<thinking>quoted</thinking>');
  });

  it('treats an unclosed fence as running to the end of the message', () => {
    const content = ['answer', '```', '<thinking>mid-stream</thinking>'].join('\n');
    expect(splitThinkBlocks(content)).toEqual([{ kind: 'markdown', text: content }]);
  });

  it('handles tilde fences too', () => {
    const content = ['~~~', '<reasoning>x</reasoning>', '~~~'].join('\n');
    expect(splitThinkBlocks(content)).toEqual([{ kind: 'markdown', text: content }]);
  });
});
