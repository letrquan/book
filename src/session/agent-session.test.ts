import { describe, expect, it } from 'vitest';
import type { AgentLoopRunner } from './agent-session.js';
import { AgentSession } from './agent-session.js';
import type { ToolRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import { toolSuccess } from '../tools/result.js';
import type { AgentEvent, AgentSessionSnapshot } from './agent-events.js';
import { createAgentSessionSnapshot, reduceAgentSessionSnapshot } from './agent-events.js';
import type {
  CompactResult,
  Message,
  RewindSnapshotCaptureResult,
  SessionRecord,
} from '../types.js';

function compactedResult(): Extract<CompactResult, { status: 'compacted' }> {
  const replacementHistory: Message[] = [
    {
      id: 'checkpoint-1',
      role: 'assistant',
      content: 'summary',
      kind: 'checkpoint',
      includeInContext: true,
      timestamp: 20,
    },
  ];
  return {
    status: 'compacted',
    trigger: 'manual',
    replacementHistory,
    summary: 'summary',
    compactId: 'compact-1',
    generation: 1,
    checkpoint: {
      version: 2,
      generation: 1,
      state: { summary: 'summary', status: 'active' },
      constraints: [],
      files: [],
      episodes: [],
      openThreads: [],
      statistics: {
        summarizedMessages: 2,
        retainedMessages: 0,
        preTokens: 100,
        postTokens: 10,
      },
    },
    checkpointVersion: 2,
    summarizedCount: 2,
    retainedCount: 0,
    postContextTokens: 10,
    preContextTokens: 100,
    preMessageCount: 2,
    strategy: 'single-pass',
    modelCalls: 1,
  };
}

describe('AgentSession', () => {
  it('prepares checkpoint and user timeline records outside the host layer', async () => {
    const session = new AgentSession();
    const records: SessionRecord[] = [];
    const config = defaultConfig();
    const userMessage: Message = {
      id: 'user-1',
      role: 'user',
      content: 'hello',
      includeInContext: true,
      timestamp: 10,
    };

    const result = await session.prepareSend({
      config,
      sessionId: 'session-1',
      displayMessage: 'hello',
      userMessage,
      timelineStore: { append: (_id, record) => records.push(record) },
    });

    expect(result).toMatchObject({
      status: 'prepared',
      contextMessage: 'hello',
      rewindTarget: {
        userEventId: 'user-1',
        prompt: 'hello',
        codeAvailable: false,
        codeUnavailableReason: 'Filesystem checkpoint storage is unavailable.',
      },
    });
    expect(records.map((record) => record.type)).toEqual(['turn_checkpoint', 'user']);
    expect(userMessage.contextContent).toBeUndefined();
    expect(userMessage.fileObservations).toEqual([]);
  });

  it('does not persist preflight records after cancellation', async () => {
    let finishCapture!: (result: RewindSnapshotCaptureResult) => void;
    const capture = new Promise<RewindSnapshotCaptureResult>((resolve) => {
      finishCapture = resolve;
    });
    const controller = new AbortController();
    const records: SessionRecord[] = [];
    const pending = new AgentSession().prepareSend({
      config: defaultConfig(),
      sessionId: 'session-1',
      displayMessage: 'hello',
      userMessage: {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        includeInContext: true,
        timestamp: 10,
      },
      snapshotStore: {
        capture: () => ({ ok: false, reason: 'unused' }),
        captureAsync: () => capture,
      },
      timelineStore: { append: (_id, record) => records.push(record) },
      signal: controller.signal,
    });

    controller.abort();
    finishCapture({ ok: false, reason: 'capture unavailable' });

    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(records).toEqual([]);
  });

  it('owns compaction boundary persistence and post-compact hooks', async () => {
    const result = compactedResult();
    const records: SessionRecord[] = [];
    const postCompactCalls: unknown[] = [];
    const compactOptions: unknown[] = [];
    const commitOrder: string[] = [];
    const session = new AgentSession({
      compactRunner: async (_config, _history, options) => {
        compactOptions.push(options);
        return result;
      },
      postCompactHooksRunner: async (_config, options) => {
        commitOrder.push('post-hook');
        postCompactCalls.push(options);
      },
    });

    const outcome = await session.compact({
      config: defaultConfig(),
      history: [],
      sessionId: 'session-1',
      transcriptOrdinal: 7,
      options: { trigger: 'manual', focus: 'keep deployment details' },
      timelineStore: {
        append: (_id, record) => {
          commitOrder.push('persist');
          records.push(record);
        },
      },
      onCommitted: () => commitOrder.push('project'),
    });

    expect(outcome).toMatchObject({
      result,
      boundary: {
        id: 'compact-1',
        trigger: 'manual',
        transcriptOrdinal: 7,
        preContextCount: 2,
        postContextCount: 1,
        preContextTokens: 100,
        postContextTokens: 10,
        generation: 1,
        checkpointVersion: 2,
      },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'compact',
      eventId: 'compact-1',
      data: {
        version: 2,
        compactId: 'compact-1',
        focus: 'keep deployment details',
        replacementHistory: result.replacementHistory,
        boundary: outcome.boundary,
      },
    });
    expect(postCompactCalls).toEqual([
      {
        trigger: 'manual',
        sessionId: 'session-1',
        focus: 'keep deployment details',
        onHookEvent: undefined,
      },
    ]);
    expect(compactOptions).toEqual([
      { trigger: 'manual', focus: 'keep deployment details', sessionId: 'session-1' },
    ]);
    expect(commitOrder).toEqual(['persist', 'project', 'post-hook']);
  });

  it('does not commit compaction after the host becomes stale', async () => {
    const records: SessionRecord[] = [];
    let postCompactCalled = false;
    const session = new AgentSession({
      compactRunner: async () => compactedResult(),
      postCompactHooksRunner: async () => {
        postCompactCalled = true;
      },
    });

    const outcome = await session.compact({
      config: defaultConfig(),
      history: [],
      sessionId: 'session-1',
      transcriptOrdinal: 0,
      options: { trigger: 'auto' },
      timelineStore: { append: (_id, record) => records.push(record) },
      isCurrent: () => false,
    });

    expect(outcome.result.status).toBe('compacted');
    expect(outcome).not.toHaveProperty('boundary');
    expect(records).toEqual([]);
    expect(postCompactCalled).toBe(false);
  });

  it('settles session lifecycle hooks exactly once per session transition', async () => {
    const starts: Array<[string, string]> = [];
    const ends: Array<[string, string]> = [];
    const session = new AgentSession({
      sessionStartRunner: async (_config, sessionId, source) => {
        starts.push([sessionId, source]);
      },
      sessionEndRunner: async (_config, sessionId, reason) => {
        ends.push([sessionId, reason]);
      },
    });
    const config = defaultConfig();

    await Promise.all([
      session.startLifecycle(config, 'session-1', 'startup'),
      session.startLifecycle(config, 'session-1', 'startup'),
    ]);
    await Promise.all([
      session.endLifecycle(config, 'session-1', 'clear'),
      session.endLifecycle(config, 'session-1', 'exit'),
    ]);
    await session.startLifecycle(config, 'session-2', 'clear');
    await session.endLifecycle(config, 'session-2', 'completion');

    expect(starts).toEqual([
      ['session-1', 'startup'],
      ['session-2', 'clear'],
    ]);
    expect(ends).toEqual([
      ['session-1', 'clear'],
      ['session-2', 'completion'],
    ]);
  });

  it('owns interaction settlement and emits one reducible run sequence', async () => {
    const toolCall = { id: 'call-1', name: 'Read', arguments: { file_path: 'README.md' } };
    const toolResult = toolSuccess('contents', { toolCallId: toolCall.id });
    const question = {
      id: 'question-1',
      source: { kind: 'root' as const },
      questions: [
        {
          question: 'Continue?',
          header: 'Choice',
          options: [{ label: 'Yes', description: 'Continue' }],
          multiSelect: false,
        },
      ],
    };
    const messages: Message[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'done',
        includeInContext: true,
        timestamp: 1,
      },
    ];
    const runLoop: AgentLoopRunner = async (_config, _registry, _prompt, _history, callbacks) => {
      callbacks.onText('hello');
      callbacks.onToolCall(toolCall);
      callbacks.onToolResult(toolResult);
      callbacks.onUsage?.({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
      const responsePromise = callbacks.onUserQuestionRequired?.(question, {});
      expect(responsePromise).toBeDefined();
      expect(session.interactions.getSnapshot().pendingUserQuestions).toHaveLength(1);
      session.interactions.settleUserQuestion(
        { action: 'answer', answers: { 'Continue?': 'Yes' } },
        'test',
        question.id,
      );
      await responsePromise;
      callbacks.onDone();
      return messages;
    };
    const session = new AgentSession({ runLoop });
    const events: AgentEvent[] = [];

    await expect(
      session.run({
        config: defaultConfig(),
        registry: {} as ToolRegistry,
        prompt: 'prompt',
        history: [],
        sessionId: 'session-1',
        callbacks: { onEvent: (event) => events.push(event), onTurnStart: () => {} },
      }),
    ).resolves.toEqual(messages);

    const snapshot = events.reduce<AgentSessionSnapshot>(
      reduceAgentSessionSnapshot,
      createAgentSessionSnapshot(),
    );
    expect(events.map((event) => event.type)).toEqual([
      'system',
      'session',
      'text',
      'tool_use',
      'tool_result',
      'user_question',
      'user_question_result',
      'result',
      'done',
    ]);
    expect(snapshot).toMatchObject({
      status: 'completed',
      sessionId: 'session-1',
      assistantText: 'hello',
      toolCalls: [toolCall],
      toolResults: [toolResult],
      messages,
      usage: { totalTokens: 5 },
    });
    expect(session.getSnapshot()).toEqual(snapshot);
  });

  it('emits one terminal error and done when the loop throws', async () => {
    const session = new AgentSession({
      runLoop: async () => {
        throw new Error('provider failed');
      },
    });
    const events: AgentEvent[] = [];

    await expect(
      session.run({
        config: defaultConfig(),
        registry: {} as ToolRegistry,
        prompt: 'prompt',
        history: [],
        sessionId: 'session-1',
        callbacks: { onEvent: (event) => events.push(event), onTurnStart: () => {} },
      }),
    ).rejects.toThrow('provider failed');
    expect(events.map((event) => event.type)).toEqual(['system', 'session', 'error', 'done']);
    expect(session.getSnapshot()).toMatchObject({
      status: 'failed',
      sessionId: 'session-1',
      error: 'provider failed',
    });
  });

  it('does not let a stale overlapping run replace the current snapshot', async () => {
    let finishFirstRun!: () => void;
    const firstRunBlocked = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    const firstMessages: Message[] = [
      {
        id: 'assistant-first',
        role: 'assistant',
        content: 'first result',
        includeInContext: true,
        timestamp: 1,
      },
    ];
    const secondMessages: Message[] = [
      {
        id: 'assistant-second',
        role: 'assistant',
        content: 'second result',
        includeInContext: true,
        timestamp: 2,
      },
    ];
    const session = new AgentSession({
      runLoop: async (_config, _registry, prompt, _history, callbacks) => {
        callbacks.onText(`${prompt} started`);
        if (prompt === 'first') {
          await firstRunBlocked;
          callbacks.onText(' too late');
          return firstMessages;
        }
        return secondMessages;
      },
    });

    const firstRun = session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'first',
      history: [],
      sessionId: 'session-first',
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });
    await expect(
      session.run({
        config: defaultConfig(),
        registry: {} as ToolRegistry,
        prompt: 'second',
        history: [],
        sessionId: 'session-second',
        callbacks: { onEvent: () => {}, onTurnStart: () => {} },
      }),
    ).resolves.toEqual(secondMessages);
    const currentSnapshot = session.getSnapshot();

    finishFirstRun();
    await expect(firstRun).resolves.toEqual(firstMessages);

    expect(currentSnapshot).toMatchObject({
      status: 'completed',
      sessionId: 'session-second',
      assistantText: 'second started',
      messages: secondMessages,
    });
    expect(session.getSnapshot()).toBe(currentSnapshot);
  });

  it('does not enqueue interactions for a stale host run', async () => {
    const decisions: unknown[] = [];
    const session = new AgentSession({
      runLoop: async (_config, _registry, _prompt, _history, callbacks) => {
        decisions.push(
          await callbacks.onPermissionRequired({ id: 'call-1', name: 'Bash', arguments: {} }),
        );
        decisions.push(await callbacks.onPlanApprovalRequired?.('plan'));
        decisions.push(
          await callbacks.onUserQuestionRequired?.(
            { id: 'question-1', source: { kind: 'root' }, questions: [] },
            {},
          ),
        );
        return [];
      },
    });

    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      sessionId: 'session-1',
      isCurrent: () => false,
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(decisions).toEqual([
      'deny',
      'reject',
      { action: 'cancel', message: 'Session changed.' },
    ]);
    expect(session.interactions.getSnapshot()).toEqual({
      pendingPermission: null,
      pendingPlanApproval: null,
      pendingUserQuestions: [],
    });
  });

  it('cancels operation and interaction ownership together', async () => {
    const session = new AgentSession();
    const operation = session.startSend()!;
    const permission = session.interactions.requestPermission({
      id: 'call-1',
      name: 'Bash',
      arguments: { command: 'pwd' },
    });

    expect(session.cancel('test')).toEqual({
      operation: { kind: 'send', aborted: true },
      interactions: { permission: true, planApproval: false, userQuestions: 0 },
    });
    expect(operation.signal?.aborted).toBe(true);
    await expect(permission).resolves.toBe('deny');
    expect(operation.isCurrent()).toBe(true);
    expect(session.finishSend(operation)).toBe(true);
    expect(session.finishSend(operation)).toBe(false);
  });
});
