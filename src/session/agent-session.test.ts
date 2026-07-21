import { describe, expect, it } from 'vitest';
import type { AgentLoopRunner } from './agent-session.js';
import { AgentSession } from './agent-session.js';
import type { ToolRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import { toolSuccess } from '../tools/result.js';
import type { AgentEvent, AgentSessionSnapshot } from './agent-events.js';
import { createAgentSessionSnapshot, reduceAgentSessionSnapshot } from './agent-events.js';
import type { Message, RewindSnapshotCaptureResult, SessionRecord } from '../types.js';

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
    expect(events).toEqual([{ type: 'error', error: 'provider failed' }, { type: 'done' }]);
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
    operation.release();
  });
});
