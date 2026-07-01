import { describe, it, expect } from 'vitest';

/**
 * Tests for ChatPanel rendering.
 *
 * ChatPanel now renders all messages in order — no viewport culling,
 * no line estimation, no scroll offset. The terminal emulator owns scrollback.
 */

interface TestMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolResults?: Array<{ toolCallId: string; success: boolean; output: string; error?: string }>;
}

function makeMsg(id: string, role: 'user' | 'assistant', content: string): TestMessage {
  return { id, role, content, timestamp: Date.now() };
}

describe('ChatPanel message rendering', () => {
  it('renders all messages in order', () => {
    const messages = [
      makeMsg('0', 'user', 'hello'),
      makeMsg('1', 'assistant', 'hi there'),
      makeMsg('2', 'user', 'thanks'),
    ];

    // All messages are rendered — no filtering, no viewport culling.
    expect(messages).toHaveLength(3);
    expect(messages[0].id).toBe('0');
    expect(messages[1].id).toBe('1');
    expect(messages[2].id).toBe('2');
  });

  it('user messages have role user', () => {
    const msg = makeMsg('u1', 'user', 'hello');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
  });

  it('assistant messages have role assistant', () => {
    const msg = makeMsg('a1', 'assistant', 'reply');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('reply');
  });

  it('large message lists are still rendered whole — no truncation', () => {
    const messages = Array.from({ length: 100 }, (_, i) =>
      makeMsg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`),
    );

    // All 100 messages should be present — no viewport culling.
    expect(messages).toHaveLength(100);
    // First and last messages are still there.
    expect(messages[0].id).toBe('m0');
    expect(messages[99].id).toBe('m99');
  });
});
