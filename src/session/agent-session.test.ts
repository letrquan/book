import { describe, expect, it, vi } from 'vitest';
import type { AgentLoopRunner } from './agent-session.js';
import { AgentSession } from './agent-session.js';
import type { ToolRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import { toolSuccess } from '../tools/result.js';
import type { AgentEvent, AgentSessionSnapshot } from './agent-events.js';
import { createAgentSessionSnapshot, reduceAgentSessionSnapshot } from './agent-events.js';
import type {
  CompactResult,
  RewindSnapshotCaptureResult,
  SessionRecord,
  TurnCheckpointRecordData,
} from '../types/sessions.js';
import type { Message } from '../types/messages.js';
import { createSessionFixture } from '../test/session-fixture.js';
import { createAgentRunContext } from '../types/runs.js';
import { SessionRuntime } from './runtime.js';

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
  it('owns and replaces session runtime resources during reset', () => {
    const session = new AgentSession();
    const first = session.getRuntime();
    const controller = first.trackAbortController(new AbortController());

    session.reset('test-reset');

    expect(controller.signal.aborted).toBe(true);
    expect(first.isDisposed).toBe(true);
    expect(session.getRuntime()).not.toBe(first);
    expect(session.getRuntime().isDisposed).toBe(false);
  });

  it('owns send ordering and returns the completed messages', async () => {
    const order: string[] = [];
    const message: Message = {
      id: 'assistant-send',
      role: 'assistant',
      content: 'done',
      includeInContext: true,
      timestamp: 20,
    };
    const session = new AgentSession({
      runLoop: async (_config, _registry, prompt, history, callbacks) => {
        order.push(`run:${prompt}:${history.length}`);
        callbacks.onAssistantMessageComplete?.(message);
        return [message];
      },
    });

    const result = await session.send({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      displayMessage: 'hello',
      createUserMessage: () => {
        order.push('create-user-message');
        return {
          id: 'user-send',
          role: 'user',
          content: 'hello',
          includeInContext: true,
          timestamp: 10,
        };
      },
      history: [],
      sessionId: 'session-1',
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
      beforePrepare: (control) => {
        order.push('before-prepare');
        expect(control.runContext.runId).toBe('user-send');
      },
      onPreparing: () => {
        order.push('preparing');
      },
      onPrepared: () => {
        order.push('prepared');
      },
    });

    expect(result).toEqual({
      status: 'completed',
      messages: [message],
      outcome: { status: 'completed', reason: 'normal_completion', partialOutput: false },
    });
    expect(order).toEqual([
      'create-user-message',
      'before-prepare',
      'preparing',
      'prepared',
      'run:hello:0',
    ]);
    expect(session.operations.activeKind).toBeNull();
  });

  it('rejects overlapping sends without creating a second transaction', async () => {
    let releaseRun!: () => void;
    const run = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const session = new AgentSession({
      runLoop: async () => {
        await run;
        return [];
      },
    });
    const request = (displayMessage: string): Parameters<AgentSession['send']>[0] => ({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      displayMessage,
      createUserMessage: () => ({
        id: `user-${displayMessage}`,
        role: 'user',
        content: displayMessage,
        includeInContext: true,
        timestamp: 10,
      }),
      history: [],
      sessionId: 'session-1',
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    const first = session.send(request('first'));
    await Promise.resolve();
    const second = await session.send(request('second'));
    expect(second).toEqual({ status: 'rejected', activeKind: 'send' });

    releaseRun();
    await expect(first).resolves.toEqual({
      status: 'completed',
      messages: [],
      outcome: { status: 'completed', reason: 'normal_completion', partialOutput: false },
    });
    expect(session.operations.activeKind).toBeNull();
  });

  it('returns the cancellation outcome when an active send is cancelled', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const session = new AgentSession({
      runLoop: async (_config, _registry, _prompt, _history, _callbacks, _mode, options) => {
        markStarted();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return [];
      },
    });

    const pending = session.send({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      displayMessage: 'hello',
      createUserMessage: () => ({
        id: 'user-cancelled',
        role: 'user',
        content: 'hello',
        includeInContext: true,
        timestamp: 10,
      }),
      history: [],
      sessionId: 'session-1',
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });
    await started;
    session.cancel('test');

    await expect(pending).resolves.toEqual({
      status: 'cancelled',
      messages: [],
      outcome: { status: 'cancelled', reason: 'user_cancelled', partialOutput: false },
    });
  });

  it('returns partial history when a send terminates with a provider failure', async () => {
    const messages: Message[] = [
      {
        id: 'user-failed',
        role: 'user',
        content: 'hello',
        includeInContext: true,
        timestamp: 10,
      },
      {
        id: 'assistant-partial',
        role: 'assistant',
        content: 'partial',
        includeInContext: true,
        timestamp: 11,
      },
    ];
    const session = new AgentSession({
      runLoop: async (_config, _registry, _prompt, _history, callbacks) => {
        callbacks.onTerminal?.({
          status: 'failed',
          reason: 'provider_error',
          message: 'provider failed',
          partialOutput: true,
        });
        return messages;
      },
    });

    const result = await session.send({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      displayMessage: 'hello',
      createUserMessage: () => messages[0]!,
      history: [],
      sessionId: 'session-1',
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(result).toMatchObject({
      status: 'failed',
      phase: 'run',
      messages,
      outcome: { status: 'failed', reason: 'provider_error', partialOutput: true },
    });
  });

  it('returns a stale send outcome even after session replacement clears the snapshot', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const session = new AgentSession({
      runLoop: async (_config, _registry, _prompt, _history, _callbacks, _mode, options) => {
        markStarted();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return [];
      },
    });

    const pending = session.send({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      displayMessage: 'hello',
      createUserMessage: () => ({
        id: 'user-replaced',
        role: 'user',
        content: 'hello',
        includeInContext: true,
        timestamp: 10,
      }),
      history: [],
      sessionId: 'session-1',
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });
    await started;
    session.reset('test');

    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      phase: 'run',
      outcome: { status: 'interrupted', reason: 'session_replaced', partialOutput: false },
    });
    expect(session.getSnapshot()).toEqual(createAgentSessionSnapshot());
  });

  it('releases the send lease when preparation fails', async () => {
    const error = new Error('capture failed');
    const session = new AgentSession();
    const result = await session.send({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      displayMessage: 'hello',
      createUserMessage: () => ({
        id: 'user-failure',
        role: 'user',
        content: 'hello',
        includeInContext: true,
        timestamp: 10,
      }),
      history: [],
      sessionId: 'session-1',
      snapshotStore: {
        capture: () => {
          throw error;
        },
      },
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(result).toMatchObject({
      status: 'failed',
      phase: 'prepare',
      error,
      userMessagePersisted: false,
    });
    expect(session.operations.activeKind).toBeNull();
  });

  it('marks preparation failures after the user timeline event as persisted', async () => {
    const error = new Error('metadata update failed');
    const session = new AgentSession();
    const records: SessionRecord[] = [];
    const result = await session.send({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      displayMessage: 'hello',
      createUserMessage: () => ({
        id: 'user-persisted-failure',
        role: 'user',
        content: 'hello',
        includeInContext: true,
        timestamp: 10,
      }),
      history: [],
      sessionId: 'session-1',
      timelineStore: {
        append: (_id, record) => records.push(record),
        patchMeta: () => {
          throw error;
        },
      },
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(records.map((record) => record.type)).toEqual(['turn_checkpoint', 'user']);
    expect(result).toMatchObject({
      status: 'failed',
      phase: 'prepare',
      error,
      userMessagePersisted: true,
    });
    expect(session.operations.activeKind).toBeNull();
  });

  it('returns run failures and releases the send lease', async () => {
    const error = new Error('run failed');
    const session = new AgentSession({
      runLoop: async () => {
        throw error;
      },
    });
    const result = await session.send({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      displayMessage: 'hello',
      createUserMessage: () => ({
        id: 'user-run-failure',
        role: 'user',
        content: 'hello',
        includeInContext: true,
        timestamp: 10,
      }),
      history: [],
      sessionId: 'session-1',
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(result).toMatchObject({ status: 'failed', phase: 'run', error });
    expect(session.operations.activeKind).toBeNull();
  });

  it('prepares checkpoint and user timeline records outside the host layer', async () => {
    const session = new AgentSession();
    const records: SessionRecord[] = [];
    const metaPatches: Array<[string, { name?: string }]> = [];
    const config = defaultConfig();
    const attachment = {
      id: 'image-1',
      sha256: '1'.repeat(64),
      storageKey: `${'1'.repeat(64)}.png`,
      mediaType: 'image/png' as const,
      byteSize: 3,
    };
    const userMessage: Message = {
      id: 'user-1',
      role: 'user',
      content: 'hello',
      attachments: [attachment],
      includeInContext: true,
      timestamp: 10,
    };

    const result = await session.prepareSend({
      config,
      sessionId: 'session-1',
      displayMessage: 'hello',
      userMessage,
      timelineStore: {
        append: (_id, record) => records.push(record),
        patchMeta: (id, patch) => metaPatches.push([id, patch]),
      },
    });

    expect(result).toMatchObject({
      status: 'prepared',
      contextMessage: 'hello',
      sessionName: 'Hello',
      rewindTarget: {
        userEventId: 'user-1',
        prompt: 'hello',
        attachments: [attachment],
        codeAvailable: false,
        codeUnavailableReason: 'Filesystem checkpoint storage is unavailable.',
      },
    });
    expect(records.map((record) => record.type)).toEqual(['turn_checkpoint', 'user']);
    expect((records[0].data as TurnCheckpointRecordData).attachments).toEqual([attachment]);
    expect((records[1].data as { attachments?: Message['attachments'] }).attachments).toEqual([
      attachment,
    ]);
    expect(metaPatches).toEqual([['session-1', { name: 'Hello' }]]);
    expect(userMessage.contextContent).toBeUndefined();
    expect(userMessage.fileObservations).toEqual([]);
  });

  it('preserves an explicit session name when recording the first prompt', async () => {
    const patchMeta = vi.fn();
    const result = await new AgentSession().recordUserMessage({
      config: defaultConfig(),
      sessionId: 'session-1',
      sessionName: 'Release work',
      displayMessage: 'fix the release workflow',
      userMessage: {
        id: 'user-named',
        role: 'user',
        content: 'fix the release workflow',
        includeInContext: true,
        timestamp: 10,
      },
      timelineStore: { append: () => {}, patchMeta },
      expandShellInput: false,
    });

    expect(result.sessionName).toBe('Release work');
    expect(patchMeta).not.toHaveBeenCalled();
  });

  it('records checkpoint-free host input without enabling shell expansion', async () => {
    const records: SessionRecord[] = [];
    const userMessage: Message = {
      id: 'user-headless',
      role: 'user',
      content: '!echo should-not-run',
      includeInContext: true,
      timestamp: 10,
    };

    const result = await new AgentSession().recordUserMessage({
      config: defaultConfig(),
      sessionId: 'session-1',
      displayMessage: userMessage.content,
      userMessage,
      timelineStore: { append: (_id, record) => records.push(record) },
      expandShellInput: false,
    });

    expect(result.contextMessage).toBe('!echo should-not-run');
    expect(userMessage.contextContent).toBeUndefined();
    expect(records.map((record) => record.type)).toEqual(['user']);
  });

  it('persists synthetic agent notifications with separate provider context', async () => {
    const records: SessionRecord[] = [];
    const userMessage: Message = {
      id: 'notification-1',
      role: 'user',
      content: 'Atlas completed: Found three gaps',
      contextContent: '<subagent_notification>{"agent_id":"atlas"}</subagent_notification>',
      includeInContext: true,
      kind: 'agent-notification',
      agentNotifications: [
        {
          agentId: 'atlas',
          displayName: 'Atlas',
          status: 'completed',
          summary: 'Found three gaps',
          evidenceIds: [],
        },
      ],
      timestamp: 10,
    };

    const result = await new AgentSession().recordUserMessage({
      config: defaultConfig(),
      sessionId: 'session-1',
      displayMessage: userMessage.content,
      contextMessage: userMessage.contextContent,
      userMessage,
      timelineStore: { append: (_id, record) => records.push(record) },
    });

    expect(result.contextMessage).toBe(userMessage.contextContent);
    expect(userMessage.fileObservations).toEqual([]);
    expect(records[0]).toMatchObject({
      type: 'user',
      data: {
        kind: 'agent-notification',
        contextContent: userMessage.contextContent,
        agentNotifications: userMessage.agentNotifications,
      },
    });
  });

  it('routes synthetic completion context through the send pipeline without user hooks', async () => {
    let prompt = '';
    let options: Parameters<AgentLoopRunner>[6];
    const session = new AgentSession({
      runLoop: async (_config, _registry, nextPrompt, history, _callbacks, _mode, nextOptions) => {
        prompt = nextPrompt;
        options = nextOptions;
        return history;
      },
    });
    const contextMessage = '<subagent_notification>{"agent_id":"atlas"}</subagent_notification>';

    const result = await session.send({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      displayMessage: 'Atlas completed',
      contextMessage,
      createUserMessage: () => ({
        id: 'notification-send',
        role: 'user',
        content: 'Atlas completed',
        contextContent: contextMessage,
        includeInContext: true,
        kind: 'agent-notification',
        timestamp: 10,
      }),
      history: [],
      sessionId: 'session-1',
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(result.status).toBe('completed');
    expect(prompt).toBe(contextMessage);
    expect(options).toMatchObject({
      displayMessage: 'Atlas completed',
      userMessageKind: 'agent-notification',
      skipUserPromptHooks: true,
    });
  });

  it('persists finalized assistant messages outside host layers', async () => {
    const records: SessionRecord[] = [];
    const message: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'done',
      includeInContext: true,
      timestamp: 20,
      toolCalls: [{ id: 'call-1', name: 'Read', arguments: { file_path: 'README.md' } }],
      toolResults: [toolSuccess('contents', { toolCallId: 'call-1' })],
    };
    const session = new AgentSession({
      runLoop: async (_config, _registry, _prompt, _history, callbacks) => {
        callbacks.onAssistantMessageComplete?.(message);
        return [message];
      },
    });

    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      sessionId: 'session-1',
      timelineStore: { append: (_id, record) => records.push(record) },
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(records).toEqual([
      expect.objectContaining({
        type: 'assistant',
        eventId: 'assistant-1',
        data: expect.objectContaining({
          id: 'assistant-1',
          complete: true,
          content: 'done',
          kind: 'conversation',
          toolCalls: message.toolCalls,
          toolResults: message.toolResults,
        }),
      }),
    ]);
  });

  it('does not persist finalized assistant messages after the host becomes stale', async () => {
    const records: SessionRecord[] = [];
    const session = new AgentSession({
      runLoop: async (_config, _registry, _prompt, _history, callbacks) => {
        callbacks.onAssistantMessageComplete?.({
          id: 'assistant-stale',
          role: 'assistant',
          content: 'late',
          includeInContext: true,
          timestamp: 20,
        });
        return [];
      },
    });

    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      sessionId: 'session-1',
      timelineStore: { append: (_id, record) => records.push(record) },
      isCurrent: () => false,
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(records).toEqual([]);
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

  it('attributes compaction usage to the active root run', async () => {
    const runtime = new SessionRuntime();
    const runContext = createAgentRunContext({
      sessionId: 'session-1',
      runId: 'root-run',
      source: 'headless',
      startedAt: 1,
    });
    const session = new AgentSession({
      runtime,
      compactRunner: async (_config, _history, options) => {
        options.onUsage?.(
          { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          {
            provider: 'openai-compatible',
            requestedModel: 'gpt-5',
            responseModel: 'gpt-5',
            responseId: 'compact-response',
          },
        );
        return compactedResult();
      },
    });

    await session.compact({
      config: defaultConfig({ model: 'gpt-5' }),
      history: [],
      sessionId: 'session-1',
      transcriptOrdinal: 0,
      runContext,
      runtime,
      options: { trigger: 'auto' },
    });

    expect(runtime.runAccounting.snapshotRoot(runContext.rootRunId)).toMatchObject({
      directUsage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      inclusiveUsage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      modelIdentities: [{ responseId: 'compact-response', status: 'verified' }],
      completeness: 'complete',
      missingSources: [],
    });
  });

  it('marks root accounting unknown when compaction completes without usage', async () => {
    const runtime = new SessionRuntime();
    const runContext = createAgentRunContext({
      sessionId: 'session-1',
      runId: 'root-run',
      source: 'headless',
      startedAt: 1,
    });
    runtime.runAccounting.startRoot(runContext, 1);
    const session = new AgentSession({
      runtime,
      compactRunner: async (_config, _history, options) => {
        options.onUsageMissing?.({
          provider: 'openai-compatible',
          requestedModel: 'gpt-5',
          responseModel: 'gpt-5',
          responseId: 'compact-response-without-usage',
        });
        return compactedResult();
      },
    });

    await session.compact({
      config: defaultConfig({ model: 'gpt-5' }),
      history: [],
      sessionId: 'session-1',
      transcriptOrdinal: 0,
      runContext,
      runtime,
      options: { trigger: 'auto' },
    });

    expect(runtime.runAccounting.snapshotRoot(runContext.rootRunId)).toMatchObject({
      costUsd: null,
      costStatus: 'unknown',
      budgetStatus: 'unknown',
      modelIdentities: [{ responseId: 'compact-response-without-usage', status: 'verified' }],
      missingSources: ['compaction_usage'],
    });
  });

  it('settles session lifecycle hooks exactly once per session transition', async () => {
    const starts: Array<[string, string]> = [];
    const ends: Array<[string, string]> = [];
    const hookEvents: string[] = [];
    const session = new AgentSession({
      sessionStartRunner: async (_config, sessionId, source, options) => {
        starts.push([sessionId, source]);
        options?.onHookEvent?.('SessionStart', { sessionId });
      },
      sessionEndRunner: async (_config, sessionId, reason, options) => {
        ends.push([sessionId, reason]);
        options?.onHookEvent?.('SessionEnd', { sessionId });
      },
    });
    const config = defaultConfig();
    const lifecycleOptions = {
      onHookEvent: (event: string) => hookEvents.push(event),
    };

    await Promise.all([
      session.startLifecycle(config, 'session-1', 'startup', lifecycleOptions),
      session.startLifecycle(config, 'session-1', 'startup', lifecycleOptions),
    ]);
    await Promise.all([
      session.endLifecycle(config, 'session-1', 'clear', lifecycleOptions),
      session.endLifecycle(config, 'session-1', 'exit', lifecycleOptions),
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
    expect(hookEvents).toEqual(['SessionStart', 'SessionEnd']);
  });

  it('owns clear transitions across lifecycle, persistence, cancellation, and projection', async () => {
    const persisted = createSessionFixture('book-agent-session-clear-');
    const timeline = createSessionFixture('book-agent-session-timeline-');
    try {
      const currentSessionId = persisted.store.create({ cwd: '/proj' });
      timeline.store.create({ id: currentSessionId, cwd: '/proj' });
      const config = { ...defaultConfig(), workspace: '/proj' };
      const order: string[] = [];
      const session = new AgentSession({
        sessionStartRunner: async (_config, sessionId, source) => {
          order.push(`start:${sessionId}:${source}`);
        },
        sessionEndRunner: async (_config, sessionId, reason) => {
          order.push(`end:${sessionId}:${reason}`);
        },
      });
      await session.startLifecycle(config, currentSessionId, 'startup');
      order.length = 0;
      const send = session.startSend()!;
      const permission = session.interactions.requestPermission({
        id: 'call-1',
        name: 'Bash',
        arguments: {},
      });

      const result = await session.clearSession({
        config,
        currentSessionId,
        store: persisted.store,
        timelineStore: timeline.store,
        previousName: 'previous work',
        onTransitionStart: () => order.push('transition:start'),
        onTransition: (bootstrap) => order.push(`project:${bootstrap.sessionId}`),
      });

      expect(result.status).toBe('transitioned');
      if (result.status !== 'transitioned') throw new Error('Expected a session transition.');
      expect(result.bootstrap).toMatchObject({
        source: 'clear',
        persisted: true,
        created: true,
        history: [],
        transcript: [],
      });
      expect(persisted.store.load(currentSessionId).meta.name).toBe('previous work');
      expect(persisted.store.load(result.bootstrap.sessionId).transcript).toEqual([]);
      expect(timeline.store.load(result.bootstrap.sessionId).transcript).toEqual([]);
      expect(order).toEqual([
        'transition:start',
        `end:${currentSessionId}:clear`,
        `project:${result.bootstrap.sessionId}`,
        `start:${result.bootstrap.sessionId}:clear`,
      ]);
      expect(send.signal?.aborted).toBe(true);
      expect(send.isCurrent()).toBe(false);
      await expect(permission).resolves.toBe('deny');
    } finally {
      persisted.cleanup();
      timeline.cleanup();
    }
  });

  it('owns resume selection and returns the persisted session projection', async () => {
    const fixture = createSessionFixture('book-agent-session-resume-');
    try {
      const currentSessionId = fixture.store.create({ cwd: '/proj' });
      const selectedSessionId = fixture.store.create({ cwd: '/proj', name: 'feature' });
      const config = { ...defaultConfig(), workspace: '/proj' };
      fixture.store.append(selectedSessionId, {
        type: 'user',
        eventId: 'user-1',
        timestamp: 1,
        data: { id: 'user-1', content: 'remember me', kind: 'conversation' },
      });
      const order: string[] = [];
      const session = new AgentSession({
        sessionStartRunner: async (_config, sessionId, source) => {
          order.push(`start:${sessionId}:${source}`);
        },
        sessionEndRunner: async (_config, sessionId, reason) => {
          order.push(`end:${sessionId}:${reason}`);
        },
      });
      await session.startLifecycle(config, currentSessionId, 'startup');
      order.length = 0;

      const result = await session.resumeSession({
        config,
        currentSessionId,
        store: fixture.store,
        selector: 'feature',
        onTransitionStart: () => order.push('transition:start'),
        onTransition: (bootstrap) => order.push(`project:${bootstrap.sessionId}`),
      });

      expect(result).toMatchObject({
        status: 'transitioned',
        bootstrap: {
          sessionId: selectedSessionId,
          sessionName: 'feature',
          source: 'resume',
          persisted: true,
          created: false,
          transcript: [{ role: 'user', content: 'remember me' }],
          contextHistory: [{ role: 'user', content: 'remember me' }],
        },
      });
      expect(order).toEqual([
        'transition:start',
        `end:${currentSessionId}:resume`,
        `project:${selectedSessionId}`,
        `start:${selectedSessionId}:resume`,
      ]);
      expect(
        fixture.store
          .readRecords(selectedSessionId)
          .some((record) => (record.data as { kind?: string }).kind === 'session_touch'),
      ).toBe(true);

      order.length = 0;
      await expect(
        session.resumeSession({
          config,
          currentSessionId: selectedSessionId,
          store: fixture.store,
          selector: 'feature',
          onTransitionStart: () => order.push('transition:start'),
        }),
      ).resolves.toEqual({ status: 'unchanged', sessionId: selectedSessionId });
      expect(order).toEqual([]);
    } finally {
      fixture.cleanup();
    }
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
      'run_started',
      'system',
      'session',
      'text',
      'tool_use',
      'tool_result',
      'user_question',
      'user_question_result',
      'result',
      'terminal',
      'done',
    ]);
    expect(snapshot).toMatchObject({
      status: 'completed',
      sessionId: 'session-1',
      ambient: {
        schemaVersion: 2,
        settings: { agentsMode: 'adaptive' },
      },
      assistantText: 'hello',
      toolCalls: [toolCall],
      toolResults: [toolResult],
      messages,
      usage: { totalTokens: 5 },
      terminal: { status: 'completed', reason: 'normal_completion', partialOutput: false },
    });
    expect(session.getSnapshot()).toEqual(snapshot);
    const started = events.find((event) => event.type === 'run_started');
    const terminal = events.find((event) => event.type === 'terminal');
    expect(started?.context).toMatchObject({
      sessionId: 'session-1',
      source: 'internal',
    });
    expect(started?.ambient.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(terminal?.runContext).toEqual(started?.context);
  });

  it('snapshots the effective model override and resolved permission mode', async () => {
    const session = new AgentSession({
      runLoop: async () => [],
    });
    const events: AgentEvent[] = [];

    await session.run({
      config: defaultConfig({ model: 'gpt-5', provider: 'auto' }),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      mode: 'plan',
      sessionId: 'session-override',
      callbacks: { onEvent: (event) => events.push(event), onTurnStart: () => {} },
      options: { modelOverride: 'claude-sonnet-5' },
    });

    const started = events.find((event) => event.type === 'run_started');
    const system = events.find((event) => event.type === 'system');
    expect(started?.ambient).toMatchObject({
      model: { provider: 'anthropic', requestedModel: 'claude-sonnet-5' },
      policies: { permissionMode: 'plan' },
    });
    expect(system).toMatchObject({ model: 'claude-sonnet-5' });
  });

  it('delegates non-interactive host decisions while retaining question events', async () => {
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
    const events: AgentEvent[] = [];

    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      sessionId: 'session-1',
      callbacks: {
        onEvent: (event) => events.push(event),
        onTurnStart: () => {},
        onPermissionRequired: async () => 'deny',
        onPlanApprovalRequired: async () => 'approve',
        onUserQuestionRequired: async () => ({
          action: 'decline',
          message: 'Headless input is unavailable.',
        }),
        userQuestionStatus: 'unavailable',
      },
    });

    expect(decisions).toEqual([
      'deny',
      'approve',
      { action: 'decline', message: 'Headless input is unavailable.' },
    ]);
    expect(events).toContainEqual({
      type: 'user_question',
      request: { id: 'question-1', source: { kind: 'root' }, questions: [] },
      status: 'unavailable',
    });
    expect(events).toContainEqual({
      type: 'user_question_result',
      requestId: 'question-1',
      response: { action: 'decline', message: 'Headless input is unavailable.' },
    });
    expect(session.interactions.getSnapshot()).toEqual({
      pendingPermission: null,
      pendingPlanApproval: null,
      pendingUserQuestions: [],
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
    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'system',
      'session',
      'error',
      'terminal',
      'done',
    ]);
    expect(session.getSnapshot()).toMatchObject({
      status: 'failed',
      sessionId: 'session-1',
      error: 'provider failed',
      terminal: {
        status: 'failed',
        reason: 'runtime_error',
        message: 'provider failed',
        partialOutput: false,
      },
    });
  });

  it('preserves caller cancellation as a distinct terminal outcome', async () => {
    const controller = new AbortController();
    const session = new AgentSession({
      runLoop: async (_config, _registry, _prompt, _history, callbacks) => {
        callbacks.onText('partial');
        controller.abort({ bookTerminalReason: 'user_cancelled' });
        return [];
      },
    });

    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      sessionId: 'session-1',
      signal: controller.signal,
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(session.getSnapshot()).toMatchObject({
      status: 'cancelled',
      assistantText: 'partial',
      terminal: {
        status: 'cancelled',
        reason: 'user_cancelled',
        partialOutput: true,
      },
    });
  });

  it('preserves timeout as distinct from cancellation and failure', async () => {
    const controller = new AbortController();
    const session = new AgentSession({
      runLoop: async () => {
        controller.abort(new DOMException('Provider timed out.', 'TimeoutError'));
        return [];
      },
    });

    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      sessionId: 'session-1',
      signal: controller.signal,
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(session.getSnapshot()).toMatchObject({
      status: 'timed_out',
      terminal: {
        status: 'timed_out',
        reason: 'provider_timeout',
        message: 'Provider timed out.',
        partialOutput: false,
      },
    });
  });

  it('keeps partial provider output attached to the failed terminal outcome', async () => {
    const message: Message = {
      id: 'assistant-partial',
      role: 'assistant',
      content: 'partial',
      includeInContext: true,
      timestamp: 1,
    };
    const session = new AgentSession({
      runLoop: async (_config, _registry, _prompt, _history, callbacks) => {
        callbacks.onText('partial');
        callbacks.onError('provider failed');
        callbacks.onTerminal?.({
          status: 'failed',
          reason: 'provider_error',
          message: 'provider failed',
          partialOutput: true,
          providerCode: 'server_error',
        });
        return [message];
      },
    });

    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      sessionId: 'session-1',
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    expect(session.getSnapshot()).toMatchObject({
      status: 'failed',
      assistantText: 'partial',
      messages: [message],
      terminal: {
        status: 'failed',
        reason: 'provider_error',
        partialOutput: true,
        providerCode: 'server_error',
      },
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
          callbacks.onTerminal?.({
            status: 'interrupted',
            reason: 'session_replaced',
            partialOutput: true,
          });
          return firstMessages;
        }
        callbacks.onTerminal?.({
          status: 'completed',
          reason: 'normal_completion',
          partialOutput: false,
        });
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
      terminal: { status: 'completed', reason: 'normal_completion', partialOutput: false },
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
