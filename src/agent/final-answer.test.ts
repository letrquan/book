import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import { finalAnswerText } from './final-answer.js';

function user(content: string): Message {
  return { id: `user-${content}`, role: 'user', content, includeInContext: true, timestamp: 1 };
}

function assistant(content: string, extra: Partial<Message> = {}): Message {
  return {
    id: `assistant-${content}`,
    role: 'assistant',
    content,
    includeInContext: true,
    timestamp: 2,
    ...extra,
  };
}

const readCall = { id: 'call-1', name: 'Read', arguments: { file_path: 'a.txt' } };
const narration = assistant('Let me check the tests.', { toolCalls: [readCall] });

describe('finalAnswerText (#248)', () => {
  it.each<[string, Message[], string]>([
    [
      'an answer after a tool turn',
      [user('go'), narration, assistant('The answer.')],
      'The answer.',
    ],
    [
      'a failed final turn that was only reasoning',
      [user('go'), narration, assistant('', { reasoningContent: 'plan' })],
      '',
    ],
    ['a tool-call turn with nothing recorded after it', [user('go'), narration], ''],
    [
      'a user message nothing answered',
      [user('go'), assistant('Earlier answer.'), user('again')],
      '',
    ],
    [
      "a failed turn's partial text with no tool calls",
      [user('go'), assistant('Here is the refactored loop')],
      'Here is the refactored loop',
    ],
    ['an empty history', [], ''],
  ])('%s', (_shape, history, expected) => {
    expect(finalAnswerText(history)).toBe(expected);
  });
});
