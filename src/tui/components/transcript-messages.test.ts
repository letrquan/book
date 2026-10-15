import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/messages.js';
import {
  countWrittenTurns,
  handsBack,
  isWorkStep,
  messagesFollowedByWork,
} from './transcript-messages.js';

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

/** An assistant turn with one file-writing call and its result, whose files are `mutations`. */
function writing(
  name: string,
  mutations: Array<{ memory?: true }>,
  status: 'success' | 'error' = 'success',
): Message {
  const fileMutations = mutations.map((mutation) => ({
    kind: 'update' as const,
    filePath: 'x.md',
    addedLines: 1,
    removedLines: 0,
    ...mutation,
  }));
  return {
    ...assistant('w1', [name]),
    toolResults: [
      {
        version: 2,
        toolCallId: 'w1-0',
        status,
        content: '',
        artifacts: { fileMutation: fileMutations[0], fileMutations },
      },
    ],
  } as Message;
}

describe('a memory write', () => {
  it('hands back, like the memory tool did, and is not a step', () => {
    for (const name of ['Write', 'Edit', 'MultiEdit', 'ApplyPatch']) {
      const message = writing(name, [{ memory: true }]);
      expect(handsBack(message), name).toBe(true);
      expect(isWorkStep(message), name).toBe(false);
    }
  });

  it('is an ordinary step when the file is not a memory file, the write failed, or it has not finished', () => {
    expect(handsBack(writing('Write', [{}]))).toBe(false);
    expect(isWorkStep(writing('Write', [{}]))).toBe(true);
    expect(handsBack(writing('Write', [{ memory: true }], 'error'))).toBe(false);
    expect(handsBack(assistant('a1', ['Write']))).toBe(false);
    expect(isWorkStep(assistant('a1', ['Write']))).toBe(true);
  });

  it('stays a step when a patch changes a memory file and a workspace file together', () => {
    expect(handsBack(writing('ApplyPatch', [{ memory: true }, {}]))).toBe(false);
    expect(isWorkStep(writing('ApplyPatch', [{ memory: true }, {}]))).toBe(true);
  });
});

describe('handsBack', () => {
  it('is true for a question and a plan for approval', () => {
    expect(handsBack(assistant('a1', ['AskUserQuestion']))).toBe(true);
    expect(handsBack(assistant('a1', ['ExitPlanMode']))).toBe(true);
    // The retired memory tool is an ordinary call now.
    expect(handsBack(assistant('a1', ['MemorySave']))).toBe(false);
  });

  it('is false for plan bookkeeping and for work', () => {
    expect(handsBack(assistant('a1', ['TodoWrite']))).toBe(false);
    expect(handsBack(assistant('a1', ['Bash']))).toBe(false);
    expect(handsBack(assistant('a1', []))).toBe(false);
  });
});

describe('messagesFollowedByWork', () => {
  it('marks a message that only updated the plan when a step follows it', () => {
    // The screenshot: `I'll clone, install, and launch…` + TodoWrite, then a
    // Bash step. The first sentence is narration, not the answer.
    const followed = messagesFollowedByWork([
      user('u1'),
      assistant('plan', ['TodoWrite']),
      assistant('step', ['Bash']),
    ]);
    expect([...followed]).toEqual(['plan']);
  });

  it('looks past more bookkeeping to the step behind it', () => {
    const followed = messagesFollowedByWork([
      user('u1'),
      assistant('plan', ['TodoWrite']),
      assistant('plan-again', ['TodoWrite']),
      assistant('step', ['Bash']),
    ]);
    expect(followed.has('plan')).toBe(true);
    expect(followed.has('plan-again')).toBe(true);
  });

  it('leaves the answer that ends by updating the plan alone', () => {
    // Nothing but more prose and bookkeeping follows, so it is the answer.
    const followed = messagesFollowedByWork([
      user('u1'),
      assistant('step', ['Bash']),
      assistant('answer', ['TodoWrite']),
      assistant('sign-off', []),
    ]);
    expect(followed.has('answer')).toBe(false);
    expect(followed.has('sign-off')).toBe(false);
    expect(followed.has('step')).toBe(false);
  });

  it('stops at the end of the turn', () => {
    const followed = messagesFollowedByWork([
      user('u1'),
      assistant('answer', ['TodoWrite']),
      user('u2'),
      assistant('next-turn', ['Bash']),
    ]);
    expect(followed.has('answer')).toBe(false);
  });

  it('ends the turn at a notification the transcript does not draw', () => {
    // A background shell finished after the answer and the agent went to work
    // on it: the earlier answer is still the answer to what you asked.
    const followed = messagesFollowedByWork([
      user('u1'),
      assistant('answer', []),
      user('shell-done', 'agent-notification'),
      assistant('follow-up', ['Bash']),
    ]);
    expect(followed.has('answer')).toBe(false);
  });

  it('marks prose that a step follows even when it called nothing', () => {
    const followed = messagesFollowedByWork([
      user('u1'),
      assistant('aside', []),
      assistant('step', ['Bash']),
    ]);
    expect(followed.has('aside')).toBe(true);
  });

  it("keeps Book's own notes in full ink when work follows them", () => {
    // A notice the host wrote mid-run is not the model's narration.
    const notice = { ...assistant('notice', []), kind: 'local' } as Message;
    const refused = { ...assistant('refused', []), hostNotice: true } as Message;
    const followed = messagesFollowedByWork([
      user('u1'),
      notice,
      refused,
      assistant('step', ['Bash']),
    ]);
    expect(followed.has('notice')).toBe(false);
    expect(followed.has('refused')).toBe(false);
  });

  it('reads no further back than the oldest entry on screen', () => {
    const followed = messagesFollowedByWork(
      [
        user('u1'),
        assistant('off-screen', ['TodoWrite']),
        assistant('on-screen', ['TodoWrite']),
        assistant('step', ['Bash']),
      ],
      'on-screen',
    );
    expect([...followed]).toEqual(['on-screen']);
  });
});
