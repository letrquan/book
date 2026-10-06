import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { Message, Usage } from '../types/messages.js';
import { createSessionFixture } from '../test/session-fixture.js';
import { SessionStore } from './store.js';
import { createAgentRunContext } from '../types/runs.js';
import { hasExternalContext } from '../tools/memory-save.js';
import { SessionRuntime } from './runtime.js';
import type { ProviderResponseMetadata } from '../types/providers.js';

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
    carriedCount: 0,
    carriedClippedCount: 0,
    carriedDroppedCount: 0,
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

  it('persists a host-appended user message as host-written, and reloads it that way', async () => {
    const fixture = createSessionFixture();
    try {
      const sessionId = fixture.store.create({ cwd: fixture.root });
      const workState: Message = {
        id: 'work-state-1',
        role: 'user',
        content: '[work-state] Current plan, restated by the host.',
        includeInContext: true,
        kind: 'conversation',
        derivedContent: true,
        timestamp: 30,
      };
      // Shaped like a record an older Book wrote: no `derivedContent` at all.
      const legacy: Message = {
        id: 'legacy-1',
        role: 'user',
        content: 'appended before the flag was persisted',
        includeInContext: true,
        kind: 'conversation',
        timestamp: 31,
      };
      const session = new AgentSession({
        runLoop: async (_config, _registry, _prompt, _history, callbacks) => {
          callbacks.onUserMessageAppended?.(workState);
          callbacks.onUserMessageAppended?.(legacy);
          return [workState, legacy];
        },
      });

      await session.run({
        config: defaultConfig(),
        registry: {} as ToolRegistry,
        prompt: 'prompt',
        history: [],
        sessionId,
        timelineStore: fixture.store,
        callbacks: { onEvent: () => {}, onTurnStart: () => {} },
      });

      const reloaded = new SessionStore(fixture.root).load(sessionId).transcript;
      expect(reloaded.find((message) => message.id === 'work-state-1')?.derivedContent).toBe(true);
      const legacyReloaded = reloaded.find((message) => message.id === 'legacy-1');
      expect(legacyReloaded?.content).toBe('appended before the flag was persisted');
      expect(legacyReloaded?.derivedContent).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
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

  // A saved compaction cannot be taken back, so a cancel (Esc during the row's last moments,
  // or the exit) has nothing left to stop but the user's PostCompact hooks. They run to their
  // own timeouts instead of under the compaction's abort signal.
  it('runs PostCompact hooks outside the compaction abort signal', async () => {
    const postCompactCalls: Array<{ signal?: AbortSignal }> = [];
    const controller = new AbortController();
    const session = new AgentSession({
      compactRunner: async () => compactedResult(),
      postCompactHooksRunner: async (_config, options) => {
        postCompactCalls.push(options);
      },
    });

    await session.compact({
      config: defaultConfig(),
      history: [],
      sessionId: 'session-1',
      transcriptOrdinal: 0,
      options: { trigger: 'manual', signal: controller.signal },
      timelineStore: { append: () => {} },
    });

    expect(postCompactCalls).toHaveLength(1);
    expect(postCompactCalls[0]?.signal).toBeUndefined();
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

  it('reports compaction usage to the host so its session bill sees the spend (#370)', () => {
    // The summarizer and the judge are real model calls, and run accounting
    // already charges them to the root run. The host's own session bill did not
    // hear about them at all, so a `/cost` after a compaction named a figure
    // smaller than what the session had actually spent.
    const seen: unknown[] = [];
    const session = new AgentSession({
      compactRunner: async (_config, _history, options) => {
        options.onUsage?.(
          { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          {
            provider: 'anthropic',
            requestedModel: 'claude-sonnet-5',
            responseModel: 'claude-sonnet-5',
            responseId: 'compact-response',
          },
        );
        return compactedResult();
      },
    });

    return session
      .compact({
        config: defaultConfig(),
        history: [],
        sessionId: 'session-1',
        transcriptOrdinal: 0,
        options: { trigger: 'auto' },
        timelineStore: { append: () => {} },
        onUsage: (usage) => seen.push(usage),
      })
      .then(() => {
        expect(seen).toEqual([{ promptTokens: 20, completionTokens: 5, totalTokens: 25 }]);
      });
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

  it('flags root accounting estimated when compaction completes without usage', async () => {
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

    // The omission stays visible, but it no longer nulls the accumulated cost or
    // latches the run into a permanent budget refusal.
    expect(runtime.runAccounting.snapshotRoot(runContext.rootRunId)).toMatchObject({
      costUsd: 0,
      costStatus: 'estimated',
      budgetStatus: 'within',
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

  // #268 item 3: a second end for a session already ending returned at once, so a caller
  // that awaited it (a second exit, a /clear racing an exit) went on while SessionEnd ran.
  it('a second end for a session already ending waits for the SessionEnd in flight', async () => {
    let finishSessionEnd: () => void = () => {};
    const ends: string[] = [];
    const session = new AgentSession({
      sessionEndRunner: (_config, sessionId) => {
        ends.push(sessionId);
        return new Promise<void>((resolve) => {
          finishSessionEnd = resolve;
        });
      },
    });
    const config = defaultConfig();

    const first = session.endLifecycle(config, 'session-1', 'exit');
    let secondSettled = false;
    const second = session.endLifecycle(config, 'session-1', 'exit').then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);

    finishSessionEnd();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    expect(ends).toEqual(['session-1']);
  });

  // The first caller reports a failed SessionEnd; a caller that only waited for it must not
  // report the same failure a second time.
  it('a second end that waited on a failed SessionEnd does not rethrow its error', async () => {
    const session = new AgentSession({
      sessionEndRunner: async () => {
        throw new Error('hook blew up');
      },
    });
    const config = defaultConfig();

    const first = session.endLifecycle(config, 'session-1', 'exit');
    const second = session.endLifecycle(config, 'session-1', 'exit');

    await expect(first).rejects.toThrow('hook blew up');
    await expect(second).resolves.toBeUndefined();
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
      await expect(permission).resolves.toEqual({ result: 'deny', reason: 'dismissed' });
    } finally {
      persisted.cleanup();
      timeline.cleanup();
    }
  });

  it('carries the persisted plan through an in-TUI resume', async () => {
    // Both launch-time paths pass `plan: loaded.plan`; the in-TUI `/resume`
    // bootstrap silently did not. A user who wrote a 12-item plan, switched away
    // and came back resumed a half-finished multi-hour objective with an empty
    // task list — and, because `planUnrestored` also stayed false, with no notice
    // that anything had been dropped.
    const fixture = createSessionFixture('book-agent-session-resume-plan-');
    try {
      const currentSessionId = fixture.store.create({ cwd: '/proj' });
      const selectedSessionId = fixture.store.create({ cwd: '/proj', name: 'planned' });
      const config = { ...defaultConfig(), workspace: '/proj' };
      fixture.store.append(selectedSessionId, {
        type: 'user',
        eventId: 'user-1',
        timestamp: 1,
        data: { id: 'user-1', content: 'migrate the call sites', kind: 'conversation' },
      });
      fixture.store.append(selectedSessionId, {
        type: 'plan',
        eventId: 'plan-1',
        timestamp: 2,
        data: {
          version: 1,
          todos: [{ content: 'migrate the call sites', status: 'in_progress' }],
          tasks: [],
        },
      });

      const session = new AgentSession();
      await session.startLifecycle(config, currentSessionId, 'startup');
      const result = await session.resumeSession({
        config,
        currentSessionId,
        store: fixture.store,
        selector: 'planned',
      });

      expect(result.status).toBe('transitioned');
      expect(result.status === 'transitioned' && result.bootstrap.plan).toMatchObject({
        todos: [{ content: 'migrate the call sites', status: 'in_progress' }],
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('marks a session agent-driven when an agent-driven TUI resumes it with /resume', async () => {
    const fixture = createSessionFixture('book-agent-session-resume-driver-');
    try {
      const currentSessionId = fixture.store.create({ cwd: '/proj', driver: 'agent' });
      const typedId = fixture.store.create({ cwd: '/proj', name: 'typed', driver: 'human' });
      const config = { ...defaultConfig(), workspace: '/proj', sessionDriver: 'agent' as const };

      const session = new AgentSession();
      await session.startLifecycle(config, currentSessionId, 'startup');
      const result = await session.resumeSession({
        config,
        currentSessionId,
        store: fixture.store,
        selector: 'typed',
      });

      expect(result.status).toBe('transitioned');
      // The turns that follow are the delegator's, so extraction must stop reading it as the user's.
      expect(fixture.store.findById(typedId)?.driver).toBe('agent');
    } finally {
      fixture.cleanup();
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

  it('installs the resumed conversation as the runtime tool history', async () => {
    // The runtime is replaced wholesale on a resume, so a host that projects the
    // conversation without rebuilding one (`onTransition` omitted) used to leave
    // the session with no record of what it had read — and the next memory write
    // skipped quarantine even though this conversation had fetched the web.
    const fixture = createSessionFixture('book-agent-session-resume-tools-');
    try {
      const currentSessionId = fixture.store.create({ cwd: '/proj' });
      const selectedSessionId = fixture.store.create({ cwd: '/proj', name: 'web' });
      const config = { ...defaultConfig(), workspace: '/proj' };
      fixture.store.append(selectedSessionId, {
        type: 'assistant',
        eventId: 'assistant-web',
        timestamp: 1,
        data: {
          id: 'assistant-web',
          content: 'fetched',
          complete: true,
          kind: 'conversation',
          includeInContext: true,
          toolCalls: [{ id: 'call-web', name: 'WebFetch', arguments: { url: 'https://e.com' } }],
          toolResults: [
            { version: 2, toolCallId: 'call-web', status: 'success', content: 'page text' },
          ],
        },
      });

      const session = new AgentSession();
      await session.startLifecycle(config, currentSessionId, 'startup');
      const result = await session.resumeSession({
        config,
        currentSessionId,
        store: fixture.store,
        selector: 'web',
      });

      expect(result.status).toBe('transitioned');
      expect(session.getRuntime().usedToolNames.has('WebFetch')).toBe(true);
      expect(
        hasExternalContext({
          workspaceRoot: config.workspace,
          env: {},
          usedToolNames: session.getRuntime().usedToolNames,
        }),
      ).toBe(true);
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
      pendingElicitations: [],
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
      // The stale run's prompt was withdrawn, not declined by a person (#264).
      { result: 'deny', reason: 'dismissed' },
      'reject',
      { action: 'cancel', message: 'Session changed.' },
    ]);
    expect(session.interactions.getSnapshot()).toEqual({
      pendingPermission: null,
      pendingPlanApproval: null,
      pendingUserQuestions: [],
      pendingElicitations: [],
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
      interactions: { permission: true, planApproval: false, userQuestions: 0, elicitations: 0 },
    });
    expect(operation.signal?.aborted).toBe(true);
    await expect(permission).resolves.toEqual({ result: 'deny', reason: 'dismissed' });
    expect(operation.isCurrent()).toBe(true);
    expect(session.finishSend(operation)).toBe(true);
    expect(session.finishSend(operation)).toBe(false);
  });
});

describe('AgentSession usage records across runs sharing a root', () => {
  /**
   * One model call's worth of usage, as the provider reports it.
   */
  const turnUsage = (promptTokens: number, completionTokens: number) => ({
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  });
  const meta = {
    provider: 'openai-compatible',
    requestedModel: 'gpt-5',
    responseModel: 'gpt-5',
    responseId: 'response-1',
  } as unknown as ProviderResponseMetadata;

  it('persists each run under a shared root once, never the whole root total', async () => {
    // A managed agent's completion is handed to the model as a NEW run under the
    // root its spawning turn already used, in the same process. The spawn's spend
    // is already on disk, so writing the root's whole inclusive total again would
    // bill it twice on every delivered completion.
    const runtime = new SessionRuntime();
    const spendPerRun = [turnUsage(100, 10), turnUsage(20, 2)];
    let run = 0;
    // Mirrors `runAgentLoop`'s `recordTurnUsage`: charge the root, THEN report.
    const runLoop: AgentLoopRunner = async (
      _config,
      _registry,
      _prompt,
      _history,
      callbacks,
      _mode,
      options,
    ) => {
      const turn = spendPerRun[run++];
      if (options?.runContext) runtime.runAccounting.record(options.runContext, turn, meta);
      callbacks.onUsage?.(turn, meta);
      return [];
    };
    const session = new AgentSession({ runtime, runLoop });
    const records: SessionRecord[] = [];

    for (const runId of ['spawning-turn', 'completion-turn']) {
      await session.run({
        config: defaultConfig(),
        registry: {} as ToolRegistry,
        prompt: 'prompt',
        history: [],
        sessionId: 'session-1',
        runContext: createAgentRunContext({
          sessionId: 'session-1',
          runId,
          rootRunId: 'shared-root',
          source: 'tui',
          startedAt: 1,
        }),
        timelineStore: { append: (_id, record) => records.push(record) },
        callbacks: { onEvent: () => {}, onTurnStart: () => {} },
      });
    }

    const persisted = records
      .filter((record) => record.type === 'usage')
      .map((record) => (record.data as { usage: Usage }).usage);
    // The stored record keeps every spend field, so a read of the session sums to
    // the objective's real total rather than to one of its runs.
    expect(persisted).toEqual(
      spendPerRun.map((spend) => ({
        ...spend,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      })),
    );
  });

  it('leaves a skipped record for the next writer instead of marking it persisted', async () => {
    // A run that is no longer the current session, or that has nowhere to write,
    // appends nothing. Marking its spend persisted anyway would hand it to no
    // record at all: the tokens would be counted as written for every later run
    // under that root and never reach disk, so the next process restored a carry
    // short by exactly the abandoned turn.
    const runtime = new SessionRuntime();
    const spendPerRun = [turnUsage(100, 10), turnUsage(20, 2)];
    let run = 0;
    const runLoop: AgentLoopRunner = async (
      _config,
      _registry,
      _prompt,
      _history,
      callbacks,
      _mode,
      options,
    ) => {
      const turn = spendPerRun[run++];
      if (options?.runContext) runtime.runAccounting.record(options.runContext, turn, meta);
      callbacks.onUsage?.(turn, meta);
      return [];
    };
    const session = new AgentSession({ runtime, runLoop });
    const records: SessionRecord[] = [];
    const shared = { sessionId: 'session-1', rootRunId: 'shared-root', source: 'tui' as const };

    // The first run's turn is abandoned: the session moved on before it reported.
    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      sessionId: 'session-1',
      runContext: createAgentRunContext({ ...shared, runId: 'abandoned-turn', startedAt: 1 }),
      timelineStore: { append: (_id, record) => records.push(record) },
      isCurrent: () => false,
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });
    expect(records).toEqual([]);

    // The next run under the same root writes both turns: the skipped one is
    // still unpersisted spend.
    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      sessionId: 'session-1',
      runContext: createAgentRunContext({ ...shared, runId: 'later-turn', startedAt: 2 }),
      timelineStore: { append: (_id, record) => records.push(record) },
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    const persisted = records
      .filter((record) => record.type === 'usage')
      .map((record) => (record.data as { usage: Usage }).usage);
    expect(persisted).toEqual([
      {
        promptTokens: 120,
        completionTokens: 12,
        totalTokens: 132,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    ]);
  });

  it('persists root spend the run never reported when the caller passed no runContext', async () => {
    // `run()` mints a run context for a caller that passed none, and the loop
    // charges that root. Keying the record off the request's (absent) context
    // skipped the root's watermark and wrote only the reported turn, so a managed
    // agent's spend — routed to the root, never through `onUsage` — reached no
    // record and no later process restored it.
    const runtime = new SessionRuntime();
    const runLoop: AgentLoopRunner = async (
      _config,
      _registry,
      _prompt,
      _history,
      callbacks,
      _mode,
      options,
    ) => {
      const turn = turnUsage(40, 4);
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, turn, meta);
        // A managed agent's spend: in the root, never reported to `onUsage`.
        runtime.runAccounting.record(options.runContext, turnUsage(70, 7), {
          ...meta,
          responseId: 'response-agent',
        } as unknown as ProviderResponseMetadata);
      }
      callbacks.onUsage?.(turn, meta);
      return [];
    };
    const session = new AgentSession({ runtime, runLoop });
    const records: SessionRecord[] = [];

    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'prompt',
      history: [],
      sessionId: 'session-1',
      timelineStore: { append: (_id, record) => records.push(record) },
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    const persisted = records
      .filter((record) => record.type === 'usage')
      .map((record) => (record.data as { usage: Usage }).usage);
    expect(persisted).toEqual([
      {
        promptTokens: 110,
        completionTokens: 11,
        totalTokens: 121,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    ]);
  });
});

/**
 * Spend charged after a root's last response, and the three flushes that have to
 * catch it: the end of the run, the end of the session (`dispose`), and a
 * `reset` that replaces the runtime under it (#336).
 *
 * Each case asserts the same two things, because either half alone passes
 * happily while the bug is present: the record exists by the time the run
 * resolves (so the run-end flush ran, not just the dispose one), and a resumed
 * session's carry adds up to every charge the session made — nothing lost, and
 * nothing written twice.
 */
describe('AgentSession end-of-run and end-of-session usage flushes', () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
    workspaces.length = 0;
  });

  const usage = (promptTokens: number, completionTokens: number) => ({
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  });
  const meta = (responseId: string): ProviderResponseMetadata =>
    ({
      provider: 'openai-compatible',
      requestedModel: 'gpt-5',
      responseModel: 'gpt-5',
      responseId,
    }) as unknown as ProviderResponseMetadata;
  const registry = {} as ToolRegistry;
  const events = { onEvent: () => {}, onTurnStart: () => {} };
  const SESSION_ID = 'session-1';

  interface Captured {
    runtime: SessionRuntime;
    store: SessionStore;
    records: SessionRecord[];
    /** The `usage` records written so far, in order. */
    persisted: () => Usage[];
    /**
     * What a process resuming this session would restore: the sum of the
     * records, the way `cli/run.ts` reads it. Every scenario ends on this, so a
     * lost charge and a double-written one both fail the same assertion.
     */
    carried: () => Usage | undefined;
  }

  /** A real store, so a scenario can be resumed rather than only read back. */
  function capture(): Captured {
    const root = mkdtempSync(join(tmpdir(), 'book-usage-flush-'));
    workspaces.push(root);
    const runtime = new SessionRuntime();
    const store = new SessionStore(root);
    const sessionId = store.create({ cwd: root, id: SESSION_ID });
    const records: SessionRecord[] = [];
    return {
      runtime,
      store,
      records,
      persisted: () =>
        records
          .filter((record) => record.type === 'usage')
          .map((record) => (record.data as { usage: Usage }).usage),
      carried: () => store.load(sessionId).carriedUsage,
    };
  }

  /** Appends to the real store and to the ordered list, as one seam would. */
  function timeline(captured: Captured): Pick<SessionStore, 'append'> {
    return {
      append: (sessionId, record) => {
        captured.records.push(record);
        captured.store.append(sessionId, record);
        return captured.store;
      },
    };
  }

  const runRequest = (
    captured: Captured,
    runId: string,
    overrides: Partial<Parameters<AgentSession['run']>[0]> = {},
  ): Parameters<AgentSession['run']>[0] => ({
    config: defaultConfig(),
    registry,
    prompt: 'prompt',
    history: [],
    sessionId: 'session-1',
    runContext: createAgentRunContext({
      sessionId: 'session-1',
      runId,
      source: 'tui',
      startedAt: 1,
    }),
    timelineStore: timeline(captured),
    callbacks: events,
    ...overrides,
  });

  it('writes what a managed child spent after the last response when the run ends', async () => {
    const captured = capture();
    const { runtime } = captured;
    const child = usage(50, 5);
    // A loop that reports its turn and only then lets a background child answer,
    // which is charged to the root and reported to nobody.
    const runLoop: AgentLoopRunner = async (_c, _r, _p, _h, callbacks, _m, options) => {
      const turn = usage(100, 10);
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, turn, meta('response-root'));
      }
      callbacks.onUsage?.(turn, meta('response-root'));
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, child, meta('response-child'));
      }
      return [];
    };
    const withLoop = new AgentSession({ runtime, runLoop });

    await withLoop.run(runRequest(captured, 'turn-1'));

    // Before dispose: the run-end flush is what wrote this.
    expect(captured.persisted()).toEqual([
      { ...usage(100, 10), cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      { ...child, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    ]);
    // The dispose sweep finds the watermark already committed and adds nothing.
    withLoop.dispose();
    expect(captured.persisted()).toHaveLength(2);
    expect(captured.records.filter((record) => record.type === 'usage')).toHaveLength(2);
    // A resumed session restores exactly the turn and the child, once each.
    expect(captured.carried()).toMatchObject(usage(150, 15));
  });

  it('writes a turn handed over to a later root exactly once, never losing the part charged after it', async () => {
    // Root 1 runs, then hands its totals to root 2. Root 2's first `onUsage` writes
    // what root 1 left behind plus its own turn. A child of root 1 that answers
    // AFTER the hand-over is charged above what root 2 inherited, so it is root 1's
    // to write — and marking it written when root 2 committed (because the whole
    // of root 1's then-current total was taken as covered) loses it outright.
    const captured = capture();
    const { runtime } = captured;
    const afterHandover = usage(70, 7);
    const firstTurn = usage(100, 10);
    const secondTurn = usage(200, 20);
    // One session and one loop for both roots, as a multi-prompt host has it.
    const runLoop: AgentLoopRunner = async (_c, _r, _p, _h, callbacks, _m, options) => {
      const turn = options?.runContext?.runId === 'root-1-turn' ? firstTurn : secondTurn;
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, turn, meta('response-root'));
      }
      callbacks.onUsage?.(turn, meta('response-root'));
      return [];
    };
    const roots = {
      one: createAgentRunContext({
        sessionId: 'session-1',
        runId: 'root-1-turn',
        rootRunId: 'root-1',
        source: 'tui',
        startedAt: 1,
      }),
      two: createAgentRunContext({
        sessionId: 'session-1',
        runId: 'root-2-turn',
        rootRunId: 'root-2',
        source: 'tui',
        startedAt: 2,
      }),
    };
    const agentSession = new AgentSession({ runtime, runLoop });
    await agentSession.run(runRequest(captured, 'root-1-turn', { runContext: roots.one }));

    // The hand-over a multi-prompt host performs between the two turns.
    const beforeHandover = runtime.runAccounting.snapshotRoot('root-1').inclusiveUsage;
    runtime.runAccounting.seedRoot('root-2', {
      usage: beforeHandover,
      costUsd: null,
      persistedUsage: runtime.runAccounting.persistedUsage('root-1'),
      fromRootRunId: 'root-1',
    });
    // The child answers now: after the hand-over, before root 2 reports anything.
    runtime.runAccounting.record(roots.one, afterHandover, meta('response-late'));

    await agentSession.run(runRequest(captured, 'root-2-turn', { runContext: roots.two }));
    agentSession.dispose();

    // Root 1's own turn, then root 2's turn, then the child's 70+7 — written by
    // root 1, which inherited only up to the hand-over, and only once.
    expect(captured.persisted().map((entry) => entry.totalTokens)).toEqual([110, 220, 77]);
    // Every charge the session made, and nothing twice.
    expect(captured.carried()).toMatchObject(usage(370, 37));
  });

  it('writes a handed-over remainder once even when the successor never reports a turn', async () => {
    // A host-performed command: root 2 is started, inherits root 1's totals, and
    // never runs a turn, so no `onUsage` of its own ever fires. Whatever root 1
    // left unwritten is inside root 2's carry and so is root 2's to write; root 1
    // must not write the same tokens as well.
    const captured = capture();
    const { runtime } = captured;
    const remainder = usage(50, 5);
    const firstTurn = usage(100, 10);
    const rootOne = createAgentRunContext({
      sessionId: 'session-1',
      runId: 'root-1-turn',
      rootRunId: 'root-1',
      source: 'tui',
      startedAt: 1,
    });
    const runLoop: AgentLoopRunner = async (_c, _r, _p, _h, callbacks, _m, options) => {
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, firstTurn, meta('response-root'));
      }
      callbacks.onUsage?.(firstTurn, meta('response-root'));
      if (options?.runContext) {
        // Charged after the turn reported, so no record of root 1's own covers it.
        runtime.runAccounting.record(options.runContext, remainder, meta('response-child'));
      }
      return [];
    };
    const session1 = new AgentSession({ runtime, runLoop });
    await session1.run(runRequest(captured, 'root-1-turn', { runContext: rootOne }));

    const beforeHandover = runtime.runAccounting.snapshotRoot('root-1').inclusiveUsage;
    // The same seam a print-mode host uses for a root it starts itself: registered
    // on the one session, never run.
    session1.trackRunUsage('root-2', {
      sessionId: 'session-1',
      timelineStore: timeline(captured),
    });
    runtime.runAccounting.startRoot(
      createAgentRunContext({
        sessionId: 'session-1',
        runId: 'root-2',
        rootRunId: 'root-2',
        source: 'tui',
        startedAt: 2,
      }),
    );
    runtime.runAccounting.seedRoot('root-2', {
      usage: beforeHandover,
      costUsd: null,
      persistedUsage: runtime.runAccounting.persistedUsage('root-1'),
      fromRootRunId: 'root-1',
    });
    session1.dispose();

    // The turn, then the remainder — once, by whichever root wrote it.
    expect(captured.persisted().map((entry) => entry.totalTokens)).toEqual([110, 55]);
    // The successor's record carried root 1's remainder, so the resume restores
    // both turns and neither of them twice.
    expect(captured.carried()).toMatchObject(usage(150, 15));
  });

  it('persists a send-registered root whose child spends after the turn, on dispose', async () => {
    // The TUI path: `send()` registers its target with the operation lease, which
    // `dispose` has already released by the time it flushes. Consulting that lease
    // there skipped every target the TUI ever created, so a background agent that
    // answered after its turn was lost on quit.
    const captured = capture();
    const { runtime } = captured;
    const child = usage(50, 5);
    const turn = usage(100, 10);
    const runLoop: AgentLoopRunner = async (_c, _r, _p, _h, callbacks, _m, options) => {
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, turn, meta('response-root'));
      }
      callbacks.onUsage?.(turn, meta('response-root'));
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, child, meta('response-child'));
      }
      return [];
    };
    const agentSession = new AgentSession({ runtime, runLoop });
    const message = {
      id: 'user-1',
      role: 'user' as const,
      content: 'go',
      includeInContext: true,
      timestamp: 1,
    };
    const result = await agentSession.send({
      config: defaultConfig(),
      sessionId: 'session-1',
      registry,
      mode: 'default',
      history: [],
      timelineStore: timeline(captured),
      callbacks: events,
      createUserMessage: () => message,
      displayMessage: 'go',
      contextMessage: 'go',
      runContext: createAgentRunContext({
        sessionId: 'session-1',
        runId: 'turn-1',
        source: 'tui',
        startedAt: 1,
      }),
    });
    expect(result.status).toBe('completed');

    agentSession.dispose();

    expect(captured.persisted().map((entry) => entry.totalTokens)).toEqual([110, 55]);
    // What a TUI quit would leave on disk: the turn and the late child, once each.
    expect(captured.carried()).toMatchObject(usage(150, 15));
  });

  it('persists spend charged while a reset stops the old runtime', async () => {
    // `reset` replaces the runtime, which stops the managed children. A child
    // charged during that teardown belongs to the outgoing runtime, so the flush
    // has to happen after the children stop and before the runtime is gone.
    const captured = capture();
    const { runtime } = captured;
    const duringTeardown = usage(40, 4);
    const turn = usage(100, 10);
    const runLoop: AgentLoopRunner = async (_c, _r, _p, _h, callbacks, _m, options) => {
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, turn, meta('response-root'));
      }
      callbacks.onUsage?.(turn, meta('response-root'));
      return [];
    };
    const agentSession = new AgentSession({ runtime, runLoop });
    const rootRunId = 'turn-1';
    await agentSession.run(
      runRequest(captured, rootRunId, {
        runContext: createAgentRunContext({
          sessionId: 'session-1',
          runId: rootRunId,
          source: 'tui',
          startedAt: 1,
        }),
      }),
    );
    // A managed child that answers as the runtime tears down.
    const realDispose = SessionRuntime.prototype.dispose;
    const disposeSpy = vi.spyOn(SessionRuntime.prototype, 'dispose').mockImplementation(function (
      this: SessionRuntime,
      reason?: string,
    ) {
      runtime.runAccounting.record(
        createAgentRunContext({
          sessionId: 'session-1',
          runId: 'turn-1-child',
          rootRunId,
          parentRunId: rootRunId,
          source: 'tui',
          startedAt: 2,
        }),
        duringTeardown,
        meta('response-teardown'),
      );
      realDispose.call(this, reason);
    });

    agentSession.reset('test-reset');
    disposeSpy.mockRestore();

    expect(captured.persisted().map((entry) => entry.totalTokens)).toEqual([110, 44]);
    // The charge made while the old runtime was stopping is on disk, once.
    expect(captured.carried()).toMatchObject(usage(140, 14));
    // The outgoing runtime's targets are released with it: nothing can be charged
    // to a root whose runtime is gone, and holding its target would make every
    // later sweep walk a runtime that is no longer the session's.
    const targets = (agentSession as unknown as { usageTargets: Map<string, { runtime: unknown }> })
      .usageTargets;
    expect([...targets.values()].some((entry) => entry.runtime === runtime)).toBe(false);
    // The replacement is installed, and it is the session's runtime now.
    expect(agentSession.getRuntime()).not.toBe(runtime);
  });

  it('persists compaction spend, which no turn of its own will ever report', async () => {
    // A manual `/compact` is a model call charged to a root, and the root it
    // mints never runs a turn: nothing calls `onUsage` for it, so only the
    // end-of-session flush can write it — and only if the root is registered.
    const captured = capture();
    const { runtime } = captured;
    const judge = usage(20, 5);
    const runContext = createAgentRunContext({
      sessionId: SESSION_ID,
      runId: 'manual-compact',
      source: 'tui',
      startedAt: 1,
    });
    const session = new AgentSession({
      runtime,
      compactRunner: async (_config, _history, options) => {
        options.onUsage?.(
          judge,
          meta('response-compact') as Parameters<NonNullable<typeof options.onUsage>>[1],
        );
        return compactedResult();
      },
    });

    await session.compact({
      config: defaultConfig(),
      history: [],
      sessionId: SESSION_ID,
      transcriptOrdinal: 0,
      runContext,
      runtime,
      timelineStore: timeline(captured),
      options: { trigger: 'manual' },
    });
    session.dispose();

    expect(captured.persisted().map((entry) => entry.totalTokens)).toEqual([25]);
    expect(captured.carried()).toMatchObject(judge);
  });

  it('persists a compaction that ran before a cancelled send ever registered its root', async () => {
    // The host auto-compacts in `beforePrepare`, and a send cancelled between
    // there and `run()` returns without reaching the registration inside `run()`.
    // The compactor's spend is then charged to a root nothing will ever flush.
    const captured = capture();
    const { runtime } = captured;
    const judge = usage(20, 5);
    const session = new AgentSession({
      runtime,
      compactRunner: async (_config, _history, options) => {
        options.onUsage?.(
          judge,
          meta('response-compact') as Parameters<NonNullable<typeof options.onUsage>>[1],
        );
        return compactedResult();
      },
    });

    const outcome = await session.send({
      config: defaultConfig(),
      sessionId: SESSION_ID,
      registry,
      mode: 'default',
      history: [],
      timelineStore: timeline(captured),
      callbacks: events,
      createUserMessage: () => ({
        id: 'user-1',
        role: 'user' as const,
        content: 'go',
        includeInContext: true,
        timestamp: 1,
      }),
      displayMessage: 'go',
      contextMessage: 'go',
      beforePrepare: async (control) => {
        await session.compact({
          config: defaultConfig(),
          history: [],
          sessionId: SESSION_ID,
          transcriptOrdinal: 0,
          runContext: control.runContext,
          runtime,
          timelineStore: timeline(captured),
          options: { trigger: 'auto' },
        });
        throw new Error('cancelled before the turn started');
      },
    });
    expect(outcome.status).toBe('failed');

    session.dispose();
    expect(captured.persisted().map((entry) => entry.totalTokens)).toEqual([25]);
    expect(captured.carried()).toMatchObject(judge);
  });

  it('survives a store that throws: the run ends, the swap happens, the rest is written', async () => {
    // `store.append` is synchronous fs I/O. Called from the run's `finally` and
    // from the runtime swap, a throw replaced a completed run's outcome with a
    // filesystem error, aborted the sweep part-way, and left the session on a
    // disposed runtime.
    const captured = capture();
    const { runtime } = captured;
    const turn = usage(100, 10);
    const late = usage(50, 5);
    const runLoop: AgentLoopRunner = async (_c, _r, _p, _h, callbacks, _m, options) => {
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, turn, meta('response-root'));
      }
      callbacks.onUsage?.(turn, meta('response-root'));
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, late, meta('response-child'));
      }
      return [];
    };
    const session = new AgentSession({ runtime, runLoop });
    // One root's store fails; the other's still has to be written.
    const failing = new Set([SESSION_ID]);
    const realAppend = captured.store.append.bind(captured.store);
    const flakyStore = {
      append: (sessionId: string, record: SessionRecord) => {
        if (failing.has(sessionId)) throw new Error('EIO: disk on fire');
        return realAppend(sessionId, record);
      },
    };
    // Root A writes through the failing store, root B through the real one.
    const rootA = createAgentRunContext({
      sessionId: SESSION_ID,
      runId: 'root-a-turn',
      rootRunId: 'root-a',
      source: 'tui',
      startedAt: 1,
    });
    const rootB = createAgentRunContext({
      sessionId: 'session-b',
      runId: 'root-b-turn',
      rootRunId: 'root-b',
      source: 'tui',
      startedAt: 2,
    });
    session.trackRunUsage('root-a', { sessionId: SESSION_ID, timelineStore: flakyStore });
    runtime.runAccounting.startRoot(rootA);
    runtime.runAccounting.record(rootA, turn, meta('response-a'));
    session.trackRunUsage('root-b', { sessionId: 'session-b', timelineStore: timeline(captured) });
    runtime.runAccounting.startRoot(rootB);
    runtime.runAccounting.record(rootB, usage(30, 3), meta('response-b'));

    expect(() => session.reset('test-reset')).not.toThrow();
    // The failed write left its watermark alone, so the spend is still owed.
    expect(runtime.isDisposed).toBe(true);
    expect(session.getRuntime()).not.toBe(runtime);
    // Root B, whose store worked, was still flushed by the same sweep.
    expect(captured.persisted().map((entry) => entry.totalTokens)).toEqual([33]);
  });

  it('names every model the root spent on, so a pricey child is not under-priced', async () => {
    // The per-response writer holds the root's whole unpersisted delta and names
    // the reporting response's model. A cheap root whose pricier managed children
    // all finished before its last response therefore produced records naming only
    // the cheap one, and the flush writers — which would have named the pricey one —
    // found nothing left to write. `carriedModels` never saw it, so the restored
    // carry was priced at the cheap rate.
    const captured = capture();
    const { runtime } = captured;
    const turn = usage(100, 10);
    const child = usage(50, 5);
    const childMeta: ProviderResponseMetadata = {
      provider: 'anthropic',
      requestedModel: 'claude-opus-5',
      responseModel: 'claude-opus-5',
      responseId: 'response-child',
    } as unknown as ProviderResponseMetadata;
    const runLoop: AgentLoopRunner = async (_c, _r, _p, _h, callbacks, _m, options) => {
      // The child finishes first, on the dearer model.
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, child, childMeta);
      }
      if (options?.runContext) {
        runtime.runAccounting.record(options.runContext, turn, meta('response-root'));
      }
      callbacks.onUsage?.(turn, meta('response-root'));
      return [];
    };
    const session = new AgentSession({ runtime, runLoop });
    await session.run(
      runRequest(captured, 'turn-1', {
        timelineStore: timeline(captured),
      }),
    );
    session.dispose();

    const models = captured.store.load('session-1').carriedModels?.map((model) => model);
    expect(models).toContain('claude-opus-5');
    expect(models).toContain('gpt-5');
  });
});

describe('AgentSession deferred compaction', () => {
  const step = (id: string, role: Message['role'], content: string): Message => ({
    id,
    role,
    content,
    includeInContext: true,
    timestamp: 0,
  });
  const snapshot = [step('u1', 'user', 'first'), step('a1', 'assistant', 'done first')];
  const delta = [step('u2', 'user', 'second'), step('a2', 'assistant', 'done second')];

  it('prepares without committing, then judges, applies the steps taken meanwhile, and records once', async () => {
    const records: SessionRecord[] = [];
    const postCompactCalls: unknown[] = [];
    const judged: Array<{ deltaIds: string[] }> = [];
    const session = new AgentSession({
      compactRunner: async () => compactedResult(),
      judgeRunner: async (_config, _applied, judgedDelta) => {
        judged.push({ deltaIds: judgedDelta.map((message) => message.id) });
        return {
          verdict: 'accepted',
          missing: [],
          modelCalls: 1,
          deltaMessages: judgedDelta.length,
        };
      },
      postCompactHooksRunner: async (_config, options) => {
        postCompactCalls.push(options);
      },
    });

    const prepared = await session.prepareCompact({
      config: defaultConfig(),
      history: snapshot,
      sessionId: 'session-1',
      transcriptOrdinal: 2,
      options: { trigger: 'auto' },
      timelineStore: { append: (_id, record) => records.push(record) },
    });
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.prepared.snapshot.map((message) => message.id)).toEqual(['u1', 'a1']);
    // Nothing committed yet: no record, no hook.
    expect(records).toEqual([]);
    expect(postCompactCalls).toEqual([]);

    const outcome = await session.commitCompact({
      prepared: prepared.prepared,
      history: [...snapshot, ...delta],
      config: defaultConfig(),
      sessionId: 'session-1',
      transcriptOrdinal: 4,
      options: {},
      timelineStore: { append: (_id, record) => records.push(record) },
    });
    expect(outcome.result.status).toBe('compacted');
    if (outcome.result.status !== 'compacted') return;
    expect(judged).toEqual([{ deltaIds: ['u2', 'a2'] }]);
    // The record carries the replacement plus the steps taken meanwhile, the
    // boundary sits at the later ordinal, and the verdict rides along.
    expect(outcome.result.replacementHistory.map((message) => message.id)).toEqual([
      'checkpoint-1',
      'u2',
      'a2',
    ]);
    expect(outcome.result.judge).toMatchObject({ verdict: 'accepted', deltaMessages: 2 });
    // The reducer's one call plus the judge's.
    expect(outcome.result.modelCalls).toBe(2);
    expect(outcome.boundary).toMatchObject({
      transcriptOrdinal: 4,
      preContextCount: 4,
      postContextCount: 3,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'compact',
      data: {
        replacementHistory: outcome.result.replacementHistory,
        judge: { verdict: 'accepted' },
      },
    });
    expect(postCompactCalls).toHaveLength(1);
  });

  it('drops a checkpoint the judge rejects, writing nothing', async () => {
    const records: SessionRecord[] = [];
    const session = new AgentSession({
      compactRunner: async () => compactedResult(),
      judgeRunner: async () => ({
        verdict: 'rejected',
        missing: ['the batch size the second step used'],
        modelCalls: 1,
        deltaMessages: 2,
      }),
      postCompactHooksRunner: async () => {
        throw new Error('no hook on a rejected checkpoint');
      },
    });
    const prepared = await session.prepareCompact({
      config: defaultConfig(),
      history: snapshot,
      transcriptOrdinal: 2,
      options: { trigger: 'auto' },
    });
    if (prepared.status !== 'prepared') throw new Error(prepared.status);
    const outcome = await session.commitCompact({
      prepared: prepared.prepared,
      history: [...snapshot, ...delta],
      config: defaultConfig(),
      transcriptOrdinal: 4,
      options: {},
      timelineStore: { append: (_id, record) => records.push(record) },
    });
    expect(outcome.result).toMatchObject({
      status: 'skipped',
      reason: 'judge-rejected',
      judge: { verdict: 'rejected', missing: ['the batch size the second step used'] },
    });
    expect(outcome.result.status === 'skipped' && outcome.result.message).toContain('batch size');
    expect(records).toEqual([]);
  });

  it('writes nothing when the run was cancelled while the judge was out', async () => {
    const records: SessionRecord[] = [];
    const controller = new AbortController();
    const session = new AgentSession({
      compactRunner: async () => compactedResult(),
      judgeRunner: async () => {
        controller.abort();
        return {
          verdict: 'inconclusive',
          missing: [],
          modelCalls: 1,
          note: 'aborted',
          deltaMessages: 2,
        };
      },
      postCompactHooksRunner: async () => {
        throw new Error('no hook after a cancel');
      },
    });
    const prepared = await session.prepareCompact({
      config: defaultConfig(),
      history: snapshot,
      transcriptOrdinal: 2,
      options: { trigger: 'auto' },
    });
    if (prepared.status !== 'prepared') throw new Error(prepared.status);
    const outcome = await session.commitCompact({
      prepared: prepared.prepared,
      history: [...snapshot, ...delta],
      config: defaultConfig(),
      transcriptOrdinal: 4,
      options: { signal: controller.signal },
      timelineStore: { append: (_id, record) => records.push(record) },
    });
    expect(outcome.result).toMatchObject({ status: 'failed', reason: 'aborted' });
    expect(records).toEqual([]);
  });

  it('declines a checkpoint whose snapshot the history no longer extends', async () => {
    const session = new AgentSession({
      compactRunner: async () => compactedResult(),
      judgeRunner: async () => {
        throw new Error('nothing to judge');
      },
    });
    const prepared = await session.prepareCompact({
      config: defaultConfig(),
      history: snapshot,
      transcriptOrdinal: 2,
      options: { trigger: 'auto' },
    });
    if (prepared.status !== 'prepared') throw new Error(prepared.status);
    const outcome = await session.commitCompact({
      prepared: prepared.prepared,
      // The last turn was rewound and re-answered.
      history: [snapshot[0], step('a1b', 'assistant', 'done first, differently'), ...delta],
      config: defaultConfig(),
      transcriptOrdinal: 4,
      options: {},
    });
    expect(outcome.result).toMatchObject({ status: 'skipped', reason: 'not-applicable' });
  });
});

describe('AgentSession.recordUserMessage — one pass over what the user typed', () => {
  let workspaces: string[] = [];

  afterEach(() => {
    for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
    workspaces = [];
  });

  function workspaceWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'book-shell-order-'));
    workspaces.push(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  async function record(displayMessage: string, workspace: string): Promise<Message> {
    const userMessage: Message = {
      id: 'user-shell',
      role: 'user',
      content: displayMessage,
      includeInContext: true,
      timestamp: 10,
    };
    const result = await new AgentSession().recordUserMessage({
      config: defaultConfig({ workspace }),
      sessionId: 'session-1',
      displayMessage,
      userMessage,
      timelineStore: { append: () => {} },
    });
    userMessage.contextContent = result.contextMessage;
    return userMessage;
  }

  it('never runs a line of a mentioned file as a command', async () => {
    const workspace = workspaceWith({ 'notes.md': '# Notes\n!echo PWNED-FROM-FILE\n' });

    const message = await record('Explain @notes.md', workspace);

    expect(message.contextContent).toContain('!echo PWNED-FROM-FILE');
    expect(message.contextContent).not.toMatch(/^PWNED-FROM-FILE$/m);
  });

  it('never runs a line inside a fenced block', async () => {
    const workspace = workspaceWith({});
    const typed = 'Run this later:\n```\n!echo PWNED-FROM-FENCE\n```';

    expect((await record(typed, workspace)).contextContent).toBe(typed);
  });

  it('still runs a command line the user typed', async () => {
    const workspace = workspaceWith({});

    const message = await record('Output:\n!echo typed-by-user', workspace);

    expect(message.contextContent).toContain('typed-by-user');
    expect(message.contextContent).not.toContain('!echo');
  });

  it("never mention-expands a command's output", async () => {
    const workspace = workspaceWith({ 'secret.txt': 'TOP SECRET' });

    const message = await record('!echo see @secret.txt', workspace);

    expect(message.contextContent).toContain('see @secret.txt');
    expect(message.contextContent).not.toContain('TOP SECRET');
    expect(message.fileObservations).toEqual([]);
  });

  it('expands and observes the same mentions, whatever a command printed', async () => {
    // A command that prints an unclosed fence must not hide a later mention the user typed.
    const workspace = workspaceWith({ 'notes.md': 'NOTE BODY' });

    const message = await record('!echo ~~~\nNow update @notes.md', workspace);

    expect(message.contextContent).toContain('NOTE BODY');
    expect(message.fileObservations?.map((observation) => observation.path)).toEqual(['notes.md']);
  });
});
