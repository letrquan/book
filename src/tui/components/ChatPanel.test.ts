import { describe, it, expect } from 'vitest';
import { estimateMessageLines } from './ChatPanel.js';

/**
 * Tests for ChatPanel scroll logic.
 *
 * ChatPanel now uses a line-based virtual viewport: only messages whose
 * estimated line positions fall within the visible range (scrollOffset
 * to scrollOffset + maxHeight) are rendered. This prevents Ink from
 * pushing old content off-screen.
 */

interface TestMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolResults?: Array<{ toolCallId: string; success: boolean; output: string; error?: string }>;
}

/**
 * Simulate the viewport calculation from ChatPanel.
 * Walks oldest→newest. Viewport covers [totalLines - scrollOffset - height*2, totalLines - scrollOffset + height].
 */
function computeVisibleMessages(
  messages: TestMessage[],
  scrollOffset: number,
  maxHeight: number,
  termWidth: number,
  streamingMessageId: string | null,
): TestMessage[] {
  if (messages.length === 0) return [];

  const height = Math.max(5, maxHeight);

  // Compute total estimated lines
  let totalLines = 0;
  for (const msg of messages) {
    totalLines += estimateMessageLines(msg, termWidth);
  }

  const viewportTop = Math.max(0, totalLines - scrollOffset - height * 2);
  const viewportBottom = totalLines - scrollOffset + height;

  const included: TestMessage[] = [];
  let lineCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgLines = estimateMessageLines(msg, termWidth);
    const msgTop = lineCount;
    lineCount += msgLines;

    if (lineCount <= viewportTop) continue;
    if (msgTop > viewportBottom) break;

    included.push(msg);
  }

  // During streaming, always include the last few messages
  if (streamingMessageId) {
    const tailMessages = messages.slice(-Math.min(10, messages.length));
    for (const tm of tailMessages) {
      if (!included.includes(tm)) {
        included.push(tm);
      }
    }
  }

  return included;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeMsg(
  id: string,
  role: 'user' | 'assistant',
  content: string,
): TestMessage {
  return { id, role, content, timestamp: Date.now() };
}

// Short messages: ~4 lines each (1 gap + 2 label + 1 content)
// Content length 20 at termWidth=80 = ceil(20/80) = 1 line
// Total: 1 gap + 2 label + 1 content = 4

describe('estimateMessageLines', () => {
  it('user message: 1 gap + 2 label + wrapped content', () => {
    // content 80 chars, width 80 => 1 line. 1+2+1 = 4
    const msg = makeMsg('a', 'user', 'x'.repeat(80));
    expect(estimateMessageLines(msg, 80)).toBe(4);
  });

  it('user message: wrapped content adds lines', () => {
    // content 200 chars, width 80 => ceil(200/80)=3 lines. 1+2+3 = 6
    const msg = makeMsg('a', 'user', 'x'.repeat(200));
    expect(estimateMessageLines(msg, 80)).toBe(6);
  });

  it('assistant message: text only', () => {
    // content 160 chars, width 80 => ceil(160/80)=2. 1+2+2 = 5
    const msg = makeMsg('a', 'assistant', 'x'.repeat(160));
    expect(estimateMessageLines(msg, 80)).toBe(5);
  });

  it('assistant message: no text', () => {
    const msg = makeMsg('a', 'assistant', '');
    expect(estimateMessageLines(msg, 80)).toBe(3); // 1 gap + 2 label, no text
  });

  it('assistant message with tool calls', () => {
    const msg: TestMessage = {
      id: 'a',
      role: 'assistant',
      content: 'x'.repeat(80),
      timestamp: Date.now(),
      toolCalls: [
        { id: 't1', name: 'Read', arguments: {} },
        { id: 't2', name: 'Write', arguments: {} },
      ],
    };
    // 1 gap + 2 label + 1 text + 2*2 tool calls = 8
    expect(estimateMessageLines(msg, 80)).toBe(8);
  });

  it('assistant message with tool results', () => {
    const msg: TestMessage = {
      id: 'a',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolResults: [
        { toolCallId: 't1', success: true, output: 'ok' },
      ],
    };
    // 1 gap + 2 label + 0 text + 1 result = 4
    expect(estimateMessageLines(msg, 80)).toBe(4);
  });

  it('narrow terminal increases line count', () => {
    // 80 chars on a 20-col terminal => ceil(80/20)=4 lines
    const msg = makeMsg('a', 'user', 'x'.repeat(80));
    expect(estimateMessageLines(msg, 20)).toBeGreaterThan(estimateMessageLines(msg, 80));
  });

  it('minimum terminal width is 20', () => {
    // Even with width=1, clamp to 20
    const msg = makeMsg('a', 'user', 'x'.repeat(100));
    // ceil(100/20)=5. 1+2+5 = 8
    expect(estimateMessageLines(msg, 1)).toBe(8);
  });
});

describe('ChatPanel virtual viewport', () => {
  const MAX_HEIGHT = 20;
  const TERM_WIDTH = 80;

  it('empty messages returns empty', () => {
    const result = computeVisibleMessages([], 0, MAX_HEIGHT, TERM_WIDTH, null);
    expect(result).toEqual([]);
  });

  it('few messages: all fit within viewport', () => {
    // 3 short messages = ~12 lines, fits in 20-line viewport
    const msgs = [
      makeMsg('0', 'user', 'hi'),
      makeMsg('1', 'assistant', 'hello'),
      makeMsg('2', 'user', 'thanks'),
    ];
    const result = computeVisibleMessages(msgs, 0, MAX_HEIGHT, TERM_WIDTH, null);
    expect(result).toEqual(msgs);
  });

  it('many messages at scrollOffset=0: only last N fit', () => {
    // Each message ~4 lines. 20-line viewport fits ~5 messages.
    // 50 messages total = ~200 lines. At offset=0, only last ~5 visible.
    const msgs = Array.from(
      { length: 50 },
      (_, i) => makeMsg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`),
    );
    const result = computeVisibleMessages(msgs, 0, MAX_HEIGHT, TERM_WIDTH, null);
    expect(result.length).toBeLessThan(50);
    expect(result.length).toBeGreaterThanOrEqual(3);
    // Last message should be the newest one
    expect(result[result.length - 1].id).toBe('m49');
  });

  it('scrollOffset > 0 shows older messages', () => {
    // 30 messages = ~120 lines. Viewport 20 lines.
    // offset=40 means skip first 40 lines (10 messages) from tail.
    const msgs = Array.from(
      { length: 30 },
      (_, i) => makeMsg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`),
    );
    const result = computeVisibleMessages(msgs, 40, MAX_HEIGHT, TERM_WIDTH, null);
    // Should show messages from further back, not the newest
    expect(result.length).toBeLessThan(30);
    // The tail message m29 is ~4 lines, cumulative from bottom: 4. At offset=40,
    // m29 and several more are above the viewport.
    expect(result[result.length - 1].id).not.toBe('m29');
  });

  it('streaming message always included even if above viewport', () => {
    // 30 messages. At offset=60, the newest messages are above viewport.
    // But the streaming message (m29) should still be included.
    const msgs = Array.from(
      { length: 30 },
      (_, i) => makeMsg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`),
    );
    const result = computeVisibleMessages(msgs, 60, MAX_HEIGHT, TERM_WIDTH, 'm29');
    expect(result.some((m) => m.id === 'm29')).toBe(true);
  });

  it('scrollOffset=0 with messages that exactly fill viewport', () => {
    // 5 messages * 4 lines each = 20 lines, exactly the viewport
    const msgs = Array.from(
      { length: 5 },
      (_, i) => makeMsg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', 'short'),
    );
    const result = computeVisibleMessages(msgs, 0, MAX_HEIGHT, TERM_WIDTH, null);
    expect(result.length).toBe(5);
  });
});
