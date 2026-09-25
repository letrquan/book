import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import { finalAnswerText } from './final-answer.js';

function user(content: string): Message {
  return { id: `user-${content}`, role: 'user', content, includeInContext: true, timestamp: 1 };
}

/** A user-role message the host wrote itself, as the loop appends one mid-run. */
function host(content: string): Message {
  return { ...user(content), derivedContent: true };
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
const continuation = host('[continuation] You stopped without completing the plan.');
const workState = host('[work-state] Current plan, restated by the host.');
const outputCapResume = host(
  '[continuation] Your previous message was cut off at the output limit. Continue from exactly where you stopped.',
);

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
    [
      'an answer the host followed with a continuation prompt',
      [user('go'), assistant('FINAL-ANSWER'), continuation],
      'FINAL-ANSWER',
    ],
    [
      'an answer followed by a continuation and a work-state refresh',
      [user('go'), assistant('FINAL-ANSWER'), continuation, workState],
      'FINAL-ANSWER',
    ],
    [
      'output-cap partial text followed by the host resume prompt',
      [user('go'), assistant('PART-ONE'), outputCapResume],
      'PART-ONE',
    ],
    [
      'an answer, a continuation, then a turn that was only reasoning',
      [
        user('go'),
        assistant('FINAL-ANSWER'),
        continuation,
        assistant('', { reasoningContent: 'plan' }),
      ],
      'FINAL-ANSWER',
    ],
    [
      'an answer, a continuation, then a turn that called tools',
      [user('go'), assistant('FINAL-ANSWER'), continuation, narration],
      '',
    ],
    ['whitespace-only text after a tool turn', [user('go'), narration, assistant('\n')], ''],
  ])('%s', (_shape, history, expected) => {
    expect(finalAnswerText(history)).toBe(expected);
  });
});
