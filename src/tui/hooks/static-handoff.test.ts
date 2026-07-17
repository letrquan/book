import { describe, expect, it } from 'vitest';
import type { Message } from '../../types.js';
import {
  isBlankAssistantContent,
  mergeAssistantMessages,
} from '../components/transcript-messages.js';

const message = (id: string, role: Message['role'], content: string): Message => ({
  id,
  role,
  content,
  includeInContext: true,
  timestamp: 1,
});

describe('transcript display messages', () => {
  it('treats whitespace-only assistant content as blank', () => {
    expect(isBlankAssistantContent(' \n\t')).toBe(true);
    expect(isBlankAssistantContent('text')).toBe(false);
  });

  it('merges completed tool-only assistant messages in order', () => {
    const messages: Message[] = [
      message('a1', 'assistant', 'working'),
      {
        ...message('a2', 'assistant', ''),
        toolCalls: [{ id: 'call-1', name: 'Read', arguments: {} }],
      },
      {
        ...message('a3', 'assistant', ' '),
        toolCalls: [{ id: 'call-2', name: 'Grep', arguments: {} }],
      },
    ];

    const merged = mergeAssistantMessages(messages);
    expect(merged).toHaveLength(1);
    expect(merged[0].toolCalls?.map((call) => call.id)).toEqual(['call-1', 'call-2']);
    expect(messages[0].toolCalls).toBeUndefined();
  });

  it('keeps the active streaming message separate', () => {
    const messages: Message[] = [
      message('a1', 'assistant', 'working'),
      {
        ...message('a2', 'assistant', ''),
        toolCalls: [{ id: 'call-1', name: 'Read', arguments: {} }],
      },
    ];

    expect(mergeAssistantMessages(messages, 'a2')).toEqual(messages);
  });

  it('does not merge across user turns or visible assistant content', () => {
    const messages = [
      message('a1', 'assistant', 'first'),
      message('u1', 'user', 'next'),
      message('a2', 'assistant', 'second'),
    ];
    expect(mergeAssistantMessages(messages)).toEqual(messages);
  });
});
