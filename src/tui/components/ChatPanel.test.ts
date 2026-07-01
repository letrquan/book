import { describe, it, expect, beforeEach } from 'vitest';
import {
  estimateMessageLines,
  getVisibleMessages,
  getVisibleViewport,
  clearLineCache,
} from './ChatPanel.js';

beforeEach(() => {
  clearLineCache();
});

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
  autoScroll = true,
): TestMessage[] {
  return getVisibleMessages(messages, {
    scrollOffset,
    maxHeight,
    terminalWidth: termWidth,
    streamingMessageId,
    autoScroll,
  });
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

  it('streaming tail stays included when auto-scroll is active', () => {
    const msgs = Array.from(
      { length: 30 },
      (_, i) => makeMsg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`),
    );
    const result = computeVisibleMessages(msgs, 60, MAX_HEIGHT, TERM_WIDTH, 'm29', true);
    expect(result.some((m) => m.id === 'm29')).toBe(true);
  });

  it('streaming tail is not forced into view when auto-scroll is paused', () => {
    const msgs = Array.from(
      { length: 30 },
      (_, i) => makeMsg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`),
    );
    const result = computeVisibleMessages(msgs, 60, MAX_HEIGHT, TERM_WIDTH, 'm29', false);
    expect(result.some((m) => m.id === 'm29')).toBe(false);
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

  it('one-line scroll changes viewport offset before message boundaries change', () => {
    const msgs = Array.from(
      { length: 10 },
      (_, i) => makeMsg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`),
    );

    const first = getVisibleViewport(msgs, {
      scrollOffset: 1,
      maxHeight: MAX_HEIGHT,
      terminalWidth: TERM_WIDTH,
    });
    const second = getVisibleViewport(msgs, {
      scrollOffset: 2,
      maxHeight: MAX_HEIGHT,
      terminalWidth: TERM_WIDTH,
    });

    expect(second.messages.map((m) => m.id)).toEqual(first.messages.map((m) => m.id));
    expect(second.topOffset).toBe(first.topOffset - 1);
  });
});
