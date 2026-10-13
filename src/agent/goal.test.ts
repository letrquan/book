import { describe, expect, it } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createRegistry } from '../tools/registry.js';
import { planModeTools } from '../tools/plan-mode.js';
import { defaultConfig } from '../test/fixtures.js';
import { SessionRuntime } from '../session/runtime.js';
import type { AgentLoopCallbacks, ProviderMessage } from '../types/providers.js';
import type { Provider } from '../provider/index.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';
import type { Message } from '../types/messages.js';
import type { GoalStatusEvent } from '../types/goal.js';
import {
  GOAL_DEFAULT_BLOCK_CAP,
  GOAL_EVALUATOR_SYSTEM,
  buildGoalCheckPrompt,
  createGoal,
  evaluateGoal,
  formatGoalReport,
  formatGoalStatus,
  goalFeedbackMessage,
  goalKickoffPrompt,
  isGoalClearWord,
  parseGoalVerdict,
  restoreGoal,
} from './goal.js';

function message(role: 'user' | 'assistant', content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    includeInContext: true,
    kind: 'conversation',
    timestamp: 0,
  };
}

function isGoalCheck(messages: ProviderMessage[]): boolean {
  return messages[0]?.role === 'system' && messages[0].content === GOAL_EVALUATOR_SYSTEM;
}

/**
 * A provider that answers the main loop with `mainReplies` (the last repeats) and
 * the goal evaluator with `verdicts` in order. A verdict given as a function runs
 * while its check is in flight, the way a `/goal` typed during a check would.
 */
function scripted(mainReplies: string[], verdicts: Array<string | (() => string)>) {
  const checks: ProviderMessage[][] = [];
  let mainTurn = 0;
  const provider = {
    id: 'scripted',
    stream: async function* (_config: unknown, messages: ProviderMessage[]) {
      if (isGoalCheck(messages)) {
        checks.push(messages);
        const next = verdicts.shift();
        if (next === undefined) throw new Error('no verdict left');
        const verdict = typeof next === 'function' ? next() : next;
        yield { type: 'text', content: verdict };
        yield { type: 'done', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
        return;
      }
      const reply = mainReplies[Math.min(mainTurn, mainReplies.length - 1)];
      mainTurn++;
      yield { type: 'text', content: reply };
      yield { type: 'done' };
    },
  } as unknown as Provider;
  return { provider, checks, mainTurns: () => mainTurn };
}

async function runWithGoal(provider: Provider, runtime: SessionRuntime, maxTurns = 0) {
  const config = defaultConfig();
  config.maxTurns = maxTurns;
  const appended: Message[] = [];
  const statuses: GoalStatusEvent[] = [];
  let outcome: AgentTerminalOutcome | undefined;
  const callbacks = {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
    onUserMessageAppended: (value: Message) => appended.push(value),
    onGoalStatus: (event: GoalStatusEvent) => statuses.push(event),
  } as unknown as AgentLoopCallbacks;
  const history = await runAgentLoop(
    config,
    createRegistry(),
    goalKickoffPrompt(runtime.activeGoal?.condition ?? ''),
    [],
    callbacks,
    'auto',
    { provider, isNewSession: false, runtime },
  );
  return { history, appended, statuses, outcome };
}

describe('goal verdict parsing', () => {
  it('reads met, unmet and impossible answers', () => {
    expect(parseGoalVerdict('{"ok": true, "reason": "tests pass"}')).toEqual({
      kind: 'met',
      reason: 'tests pass',
    });
    expect(parseGoalVerdict('```json\n{"ok": false, "reason": "2 failing"}\n```')).toEqual({
      kind: 'unmet',
      reason: '2 failing',
    });
    expect(parseGoalVerdict('{"ok": false, "impossible": true, "reason": "no network"}')).toEqual({
      kind: 'impossible',
      reason: 'no network',
    });
  });

  it('accepts string booleans and fills a missing reason', () => {
    expect(parseGoalVerdict('{"ok": "false"}')).toEqual({
      kind: 'unmet',
      reason: 'insufficient evidence in transcript',
    });
  });

  it('refuses an answer without a legible ok', () => {
    expect(parseGoalVerdict('Looks done to me.')).toBeUndefined();
    expect(parseGoalVerdict('{"reason": "maybe"}')).toBeUndefined();
  });
});

describe('goal text', () => {
  it('recognises every clear word, case-insensitively', () => {
    for (const word of ['clear', 'STOP', 'off', 'reset', 'none', 'Cancel']) {
      expect(isGoalClearWord(word)).toBe(true);
    }
    expect(isGoalClearWord('all tests pass')).toBe(false);
  });

  it('quotes a long condition back to the agent truncated', () => {
    const feedback = goalFeedbackMessage('x'.repeat(600), 'not yet');
    expect(feedback.startsWith('Stop hook feedback:\n[')).toBe(true);
    expect(feedback).toContain('…]: not yet');
    expect(feedback.length).toBeLessThan(560);
  });

  it('reports the goal for /goal with no argument', () => {
    expect(formatGoalReport(undefined)).toBe('No goal set. Usage: `/goal <condition>`');
    const goal = createGoal('tests pass');
    expect(formatGoalReport(goal)).toBe('Goal active: tests pass (not yet evaluated)');
    expect(formatGoalReport({ ...goal, iterations: 2, lastReason: 'one failing' })).toBe(
      'Goal active: tests pass (2 turns)\nLast check: one failing',
    );
  });

  it('formats an achieved goal with its cost', () => {
    expect(
      formatGoalStatus({
        state: 'met',
        condition: 'c',
        reason: 'r',
        iterations: 3,
        durationMs: 125_000,
        tokens: 12_345,
      }),
    ).toBe('● Goal achieved (2m · 3 turns · 12.3k tokens)');
  });

  it('picks the token unit after rounding', () => {
    const met = {
      state: 'met',
      condition: 'c',
      reason: 'r',
      iterations: 1,
      durationMs: 0,
    } as const;
    expect(formatGoalStatus({ ...met, tokens: 999_949 })).toContain('999.9k tokens');
    expect(formatGoalStatus({ ...met, tokens: 999_960 })).toContain('· 1M tokens');
    expect(formatGoalStatus({ ...met, tokens: 999.6 })).toContain('· 1k tokens');
  });

  it('says when the turn limit paused the goal', () => {
    expect(
      formatGoalStatus({ state: 'paused', condition: 'c', cause: 'max_turns', detail: 'not yet' }),
    ).toBe('Goal paused · the turn limit was reached · send a message to continue');
  });

  it('marks a dropped prefix in the evaluator prompt', () => {
    const history = Array.from({ length: 40 }, (_, index) =>
      message(index % 2 ? 'assistant' : 'user', `turn ${index} ${'word '.repeat(200)}`),
    );
    const prompt = buildGoalCheckPrompt(history, 'tests pass', 2_000, '/repo');
    expect(prompt).toContain('[Earlier conversation truncated');
    expect(prompt).toContain('Condition: tests pass');
    expect(prompt).toContain('"hook_event_name":"Stop"');
    expect(prompt).toContain('turn 39');
    expect(prompt).not.toContain('turn 0 ');
  });

  it('restores only a goal that is still set', () => {
    expect(restoreGoal(undefined)).toBeUndefined();
    expect(restoreGoal({ version: 1, goal: null })).toBeUndefined();
    const restored = restoreGoal({ version: 1, goal: createGoal('tests pass', 1_000) });
    expect(restored).toMatchObject({ condition: 'tests pass', origin: 'restored', setAt: 1_000 });
  });
});

describe('evaluateGoal', () => {
  it('sends the transcript and the condition to the evaluator', async () => {
    const { provider, checks } = scripted([], ['{"ok": true, "reason": "said so"}']);
    const verdict = await evaluateGoal(
      defaultConfig(),
      [message('user', 'make it green'), message('assistant', 'All 12 tests pass.')],
      'all tests pass',
      { provider },
    );
    expect(verdict).toEqual({ kind: 'met', reason: 'said so' });
    const user = checks[0][1].content as string;
    expect(user).toContain('All 12 tests pass.');
    expect(user).toContain('Condition: all tests pass');
  });

  it('fails open on an unreadable answer', async () => {
    const { provider } = scripted([], ['I cannot tell.']);
    const verdict = await evaluateGoal(defaultConfig(), [message('user', 'x')], 'c', { provider });
    expect(verdict.kind).toBe('error');
  });

  it('fails open when the evaluator does not answer in time', async () => {
    const provider = {
      id: 'slow',
      stream: async function* (
        _config: unknown,
        _messages: unknown,
        _tools: unknown,
        options?: { signal?: AbortSignal },
      ) {
        await new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
        yield { type: 'done' };
      },
    } as unknown as Provider;
    const verdict = await evaluateGoal(defaultConfig(), [message('user', 'x')], 'c', {
      provider,
      timeoutMs: 20,
    });
    expect(verdict).toEqual({ kind: 'error', detail: 'timed out' });
  });
});

describe('goal in the loop', () => {
  it('keeps the run going until the evaluator finds the condition met', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('the answer is 42');
    const { provider, checks, mainTurns } = scripted(
      ['Working on it.', 'The answer is 42.'],
      [
        '{"ok": false, "reason": "no answer given yet"}',
        '{"ok": true, "reason": "\\"The answer is 42.\\""}',
      ],
    );

    const { appended, statuses, outcome } = await runWithGoal(provider, runtime);

    expect(mainTurns()).toBe(2);
    expect(checks).toHaveLength(2);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      role: 'user',
      derivedContent: true,
      kind: 'conversation',
      content: 'Stop hook feedback:\n[the answer is 42]: no answer given yet',
    });
    expect(statuses.map((status) => status.state)).toEqual(['unmet', 'met']);
    // Two checks at 5 output tokens each; the scripted main turns report no usage.
    expect(statuses[1]).toMatchObject({ iterations: 2, tokens: 10 });
    expect(runtime.activeGoal).toBeUndefined();
    expect(outcome?.status).toBe('completed');
  });

  it('clears a goal the evaluator judges impossible', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('reach the moon');
    const { provider } = scripted(
      ['I cannot do that.'],
      ['{"ok": false, "impossible": true, "reason": "no rocket"}'],
    );
    const { statuses, outcome } = await runWithGoal(provider, runtime);
    expect(statuses).toMatchObject([{ state: 'failed', reason: 'no rocket' }]);
    expect(runtime.activeGoal).toBeUndefined();
    expect(outcome).toMatchObject({ status: 'failed', reason: 'goal_unmet' });
  });

  it('pauses past the block cap and keeps the goal for the next message', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('never');
    const verdicts = Array.from(
      { length: GOAL_DEFAULT_BLOCK_CAP + 1 },
      () => '{"ok": false, "reason": "not yet"}',
    );
    const { provider, checks, mainTurns } = scripted(['Still going.'], verdicts);

    const { statuses, appended, outcome } = await runWithGoal(provider, runtime);

    // As in Claude Code: eight rounds of feedback, then the ninth unmet check ends the run.
    expect(checks).toHaveLength(GOAL_DEFAULT_BLOCK_CAP + 1);
    expect(mainTurns()).toBe(GOAL_DEFAULT_BLOCK_CAP + 1);
    expect(appended).toHaveLength(GOAL_DEFAULT_BLOCK_CAP);
    expect(statuses.at(-1)).toMatchObject({
      state: 'paused',
      cause: 'block_cap',
      detail: 'not yet',
    });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'goal_unmet' });
    expect(runtime.activeGoal).toMatchObject({
      condition: 'never',
      iterations: GOAL_DEFAULT_BLOCK_CAP + 1,
      lastReason: 'not yet',
    });
  });

  it('ends the turn and keeps the goal when the check fails', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('c');
    const { provider } = scripted(['Done.'], ['not json']);
    const { statuses, appended, outcome } = await runWithGoal(provider, runtime);
    expect(appended).toHaveLength(0);
    expect(statuses).toMatchObject([{ state: 'paused', cause: 'check_failed' }]);
    expect(runtime.activeGoal?.condition).toBe('c');
    // Failing open lets the run end, but nothing confirmed the goal: not a success.
    expect(outcome).toMatchObject({ status: 'failed', reason: 'goal_unverified' });
    expect(outcome?.message).toBeUndefined();
  });

  it('checks the goal on the last allowed turn, and a met goal still clears', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('c');
    const { provider, checks } = scripted(['Done.'], ['{"ok": true, "reason": "done"}']);
    const { statuses, outcome } = await runWithGoal(provider, runtime, 1);
    expect(checks).toHaveLength(1);
    expect(statuses).toMatchObject([{ state: 'met', iterations: 1 }]);
    expect(runtime.activeGoal).toBeUndefined();
    expect(outcome?.status).toBe('completed');
  });

  it('ends at the turn limit when the goal is still unmet on the last allowed turn', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('c');
    const { provider, checks, mainTurns } = scripted(['Done.'], ['{"ok": false, "reason": "no"}']);
    const { statuses, appended, outcome } = await runWithGoal(provider, runtime, 1);
    expect(checks).toHaveLength(1);
    expect(mainTurns()).toBe(1);
    // No turn is left to answer it, so no feedback is sent.
    expect(appended).toHaveLength(0);
    expect(statuses).toMatchObject([{ state: 'paused', cause: 'max_turns', detail: 'no' }]);
    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'max_turns',
      message: 'Reached max turns (1).',
    });
    expect(runtime.activeGoal).toMatchObject({ condition: 'c', iterations: 1, lastReason: 'no' });
  });

  it('checks a goal set while the previous one was being checked', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('A');
    const { provider, checks, mainTurns } = scripted(
      ['Done.'],
      [
        () => {
          runtime.activeGoal = createGoal('B');
          return '{"ok": false, "reason": "A is not done"}';
        },
        '{"ok": true, "reason": "B holds"}',
      ],
    );
    const { statuses, appended, outcome } = await runWithGoal(provider, runtime);
    expect(checks).toHaveLength(2);
    expect(checks[1][1].content as string).toContain('Condition: B');
    // A's verdict is discarded: it sent no feedback and reported nothing.
    expect(appended).toHaveLength(0);
    expect(statuses).toMatchObject([{ state: 'met', condition: 'B' }]);
    expect(mainTurns()).toBe(1);
    expect(runtime.activeGoal).toBeUndefined();
    expect(outcome?.status).toBe('completed');
  });

  it('gives a goal set mid-run its own count of unmet checks', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('A');
    const unmetA = Array.from(
      { length: GOAL_DEFAULT_BLOCK_CAP },
      () => '{"ok": false, "reason": "A not yet"}',
    );
    const { provider, checks } = scripted(
      ['Working.'],
      [
        ...unmetA,
        // The check that would have tripped A's cap: B replaces A while it runs.
        () => {
          runtime.activeGoal = createGoal('B');
          return '{"ok": false, "reason": "A not yet"}';
        },
        '{"ok": false, "reason": "B not yet"}',
        '{"ok": true, "reason": "B holds"}',
      ],
    );
    const { statuses, appended, outcome } = await runWithGoal(provider, runtime);
    expect(checks).toHaveLength(GOAL_DEFAULT_BLOCK_CAP + 3);
    // B's first unmet check is its first, so the agent is sent back rather than stopped.
    expect(appended.at(-1)?.content).toBe('Stop hook feedback:\n[B]: B not yet');
    expect(statuses.at(-1)).toMatchObject({ state: 'met', condition: 'B' });
    expect(outcome?.status).toBe('completed');
  });

  it('does not override a continuation brake', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('c');
    const { provider, checks } = scripted(['Done.'], []);
    const config = defaultConfig();
    config.maxTurns = 0;
    // A spent continuation budget is the operator's ceiling, not the model's choice to stop.
    config.settings.continuation = {
      ...config.settings.continuation,
      enabled: true,
      maxConsecutive: 0,
    };
    await runAgentLoop(
      config,
      createRegistry(),
      'go',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
      } as unknown as AgentLoopCallbacks,
      'auto',
      { provider, isNewSession: false, runtime },
    );
    expect(checks).toHaveLength(0);
  });

  it('does not override a plan handoff', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('c');
    const checks: unknown[] = [];
    const provider = {
      id: 'scripted',
      stream: async function* (_config: unknown, messages: ProviderMessage[]) {
        if (isGoalCheck(messages)) {
          checks.push(messages);
          yield { type: 'text', content: '{"ok": false, "reason": "not yet"}' };
          yield { type: 'done' };
          return;
        }
        yield {
          type: 'tool_call',
          toolCall: { id: 'exit-1', name: 'ExitPlanMode', arguments: { plan: '1. Do it.' } },
        };
        yield { type: 'done' };
      },
    } as unknown as Provider;
    const registry = createRegistry();
    registry.registerAll(planModeTools);
    const handoffs: unknown[] = [];
    await runAgentLoop(
      defaultConfig(),
      registry,
      'plan it',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
        onPlanApprovalRequired: async () => 'approve-fresh',
        onPlanHandoff: (handoff: unknown) => handoffs.push(handoff),
      } as unknown as AgentLoopCallbacks,
      'plan',
      { provider, isNewSession: false, runtime },
    );
    expect(handoffs).toHaveLength(1);
    expect(checks).toHaveLength(0);
  });

  it('never checks a goal from a subagent loop', async () => {
    const runtime = new SessionRuntime();
    runtime.activeGoal = createGoal('c');
    const { provider, checks } = scripted(['Done.'], []);
    const config = defaultConfig();
    await runAgentLoop(
      config,
      createRegistry(),
      'child task',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
      } as unknown as AgentLoopCallbacks,
      'auto',
      { provider, isNewSession: false, runtime, isSubagent: true },
    );
    expect(checks).toHaveLength(0);
  });
});
