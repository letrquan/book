import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/messages.js';
import { countWrittenTurns, isWorkStep } from './transcript-messages.js';

function user(id: string, kind?: Message['kind']): Message {
  return { id, role: 'user', content: id, timestamp: 0, kind } as Message;
}

function assistant(id: string, names: string[]): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 0,
    toolCalls: names.map((name, index) => ({ id: `${id}-${index}`, name, arguments: {} })),
  } as Message;
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

describe('isWorkStep', () => {
  it('is a step whenever the agent calls a tool that does the work', () => {
    expect(isWorkStep(assistant('a1', ['Bash']))).toBe(true);
    // Bookkeeping rides along with real work; the turn is still a step.
    expect(isWorkStep(assistant('a1', ['Read', 'TodoWrite']))).toBe(true);
  });

  it('is an answer when the only calls are bookkeeping', () => {
    // Task bookkeeping is classified by the tool catalog, so a task tool added
    // later is covered without a second list here.
    expect(isWorkStep(assistant('a1', ['TodoWrite']))).toBe(false);
    expect(isWorkStep(assistant('a1', ['TaskOutput']))).toBe(false);
  });

  it('is a step when the call is a subagent, which is a category of its own', () => {
    expect(isWorkStep(assistant('a1', ['Task']))).toBe(true);
  });

  it('is a step when the call opens plan mode, which is more work, not less', () => {
    // Entering plan mode only flips the mode; the agent keeps working, so the
    // sentence above it is narration.
    expect(isWorkStep(assistant('a1', ['EnterPlanMode']))).toBe(true);
  });

  it('is an answer when the turn hands itself back to you', () => {
    // A question or a plan approval is the end of the turn, not a step: the
    // sentence above it is the answer to what you asked.
    expect(isWorkStep(assistant('a1', ['AskUserQuestion']))).toBe(false);
    expect(isWorkStep(assistant('a1', ['ExitPlanMode']))).toBe(false);
  });

  it('is an answer when it called nothing', () => {
    expect(isWorkStep(assistant('a1', []))).toBe(false);
  });

  it('is never a step for a turn you wrote', () => {
    expect(isWorkStep(user('u1'))).toBe(false);
  });
});
