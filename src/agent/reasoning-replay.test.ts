import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import {
  reasoningReplayKeeps,
  TURN_REASONING_REPLAY_STRIDE,
  TURN_REASONING_REPLAY_WINDOW,
} from './reasoning-replay.js';
import { assistantMsg, toolCall, toolResult, userMsg } from '../test/fixtures.js';

/** One assistant step of a turn, identified by its step number (`a3` is step 3). */
function step(number: number, reasoningContent: string): Message {
  return {
    ...assistantMsg(
      '',
      [toolCall(`c${number}`, 'Read', { filePath: `f${number}.ts` })],
      [toolResult(`c${number}`, `contents of f${number}`)],
    ),
    id: `a${number}`,
    reasoningContent,
  };
}

/** One user turn with `count` in-context assistant steps, each with its own reasoning. */
function singleTurn(count: number): Message[] {
  return [
    userMsg('do the whole task'),
    ...Array.from({ length: count }, (_, i) => step(i, `t${i}`)),
  ];
}

/** The step numbers whose reasoning the predicate keeps, read back off the messages' ids. */
function keptSteps(history: Message[], replayAllReasoning?: boolean): number[] {
  const keeps = reasoningReplayKeeps(history, { replayAllReasoning });
  return history
    .filter((message, index) => message.role === 'assistant' && keeps(index))
    .map((message) => Number(message.id.slice(1)));
}

describe('reasoningReplayKeeps', () => {
  it('keeps between the window and the window plus a stride of the newest steps', () => {
    expect(TURN_REASONING_REPLAY_WINDOW).toBe(2);
    expect(TURN_REASONING_REPLAY_STRIDE).toBe(4);

    // The cut starts at step 0 and only moves in strides of 4, so a turn carries
    // between 2 and 5 steps' reasoning at any moment: the step being continued
    // plus room to grow to a full stride (#378).
    const expected: Record<number, number[]> = {
      1: [0],
      2: [0, 1],
      3: [0, 1, 2],
      4: [0, 1, 2, 3],
      5: [0, 1, 2, 3, 4],
      6: [4, 5],
      7: [4, 5, 6],
      8: [4, 5, 6, 7],
      9: [4, 5, 6, 7, 8],
      10: [8, 9],
      11: [8, 9, 10],
      12: [8, 9, 10, 11],
    };

    for (let steps = 1; steps <= 12; steps += 1) {
      expect(keptSteps(singleTurn(steps))).toEqual(expected[steps]);
    }
  });

  it('keeps every step of every turn when replayAllReasoning is set', () => {
    const history: Message[] = [
      userMsg('first'),
      step(0, 'earlier thought'),
      { ...userMsg('second'), id: 'u2' },
      ...Array.from({ length: 6 }, (_, i) => step(i + 1, `t${i + 1}`)),
    ];

    expect(keptSteps(history)).toEqual([5, 6]);
    expect(keptSteps(history, true)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('drops every step of a turn a later user message closed', () => {
    const history: Message[] = [
      ...singleTurn(6),
      { ...userMsg('next task'), id: 'u2' },
      step(6, 'newer thought'),
    ];

    expect(keptSteps(history)).toEqual([6]);
  });

  it('numbers only the steps this request serializes', () => {
    // A display-only step is not one the model can be continuing, so it does not
    // consume a step of the window; a host-written user message
    // (`derivedContent`) does not open a turn.
    const history = singleTurn(6);
    history.splice(1, 0, { ...step(6, 'hidden thought'), id: 'hidden', includeInContext: false });
    history.splice(2, 0, {
      ...userMsg('[continuation] Continue from exactly where you stopped.'),
      id: 'u-cont',
      derivedContent: true,
    });

    expect(keptSteps(history)).toEqual([4, 5]);
  });
});
