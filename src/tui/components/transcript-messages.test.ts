import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/messages.js';
import { countWrittenTurns } from './transcript-messages.js';

function user(id: string, kind?: Message['kind']): Message {
  return { id, role: 'user', content: id, timestamp: 0, kind } as Message;
}

describe('countWrittenTurns', () => {
  it('counts the turns you wrote and nothing the host sent on your behalf', () => {
    // One typed prompt and four notifications used to read as page v.
    const messages: Message[] = [
      user('typed'),
      { id: 'reply', role: 'assistant', content: 'ok', timestamp: 0 } as Message,
      user('subagent-1', 'agent-notification'),
      user('subagent-2', 'agent-notification'),
      user('shell-done', 'agent-notification'),
      user('checkpoint', 'checkpoint'),
      user('carried', 'carried'),
      user('second', 'conversation'),
    ];
    expect(countWrittenTurns(messages)).toBe(2);
  });

  it('is zero for an empty transcript', () => {
    expect(countWrittenTurns([])).toBe(0);
  });
});
