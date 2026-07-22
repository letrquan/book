import type { AgentRuntimeEvent } from '../agents/types.js';
import { runAgentLoop } from '../agent/loop.js';
import { runCompact, runPostCompactHooks, type RunCompactOptions } from '../agent/compact.js';
import { runSessionEnd, runSessionStart } from './lifecycle.js';
import type { SessionLifecycleOptions } from './lifecycle.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type {
  CompactBoundary,
  CompactRecordData,
  CompactResult,
  RewindSnapshotCaptureResult,
  RewindSnapshotStoreInterface,
  RewindTarget,
  SessionRecord,
  SessionStoreInterface,
  TurnCheckpointRecordData,
} from '../types/sessions.js';
import type { Message, Usage } from '../types/messages.js';
import type { ToolCall, ToolResult, UserQuestionResponse } from '../types/tools.js';
import {
  collectAtMentionObservations,
  expandAtMentions,
  expandShellCommands,
} from '../input/input-expansion.js';
import { observationKey } from '../tools/file-provenance.js';
import { AgentInteractionController } from './agent-interactions.js';
import {
  AgentSessionOperations,
  type AgentSessionOperation,
  type CancelOperationResult,
} from './agent-session-operations.js';
import {
  createAgentSessionSnapshot,
  reduceAgentSessionSnapshot,
  type AgentEvent,
  type AgentSessionSnapshot,
} from './agent-events.js';
import { selectSession, type SessionBootstrap } from './resolve.js';
import { SessionRuntime, type SessionRuntimeOptions } from './runtime.js';

export type AgentLoopRunner = typeof runAgentLoop;
type AgentLoopOptions = NonNullable<Parameters<AgentLoopRunner>[6]>;

export interface AgentSessionRunCallbacks {
  onEvent: (event: AgentEvent) => void;
  onTurnStart: AgentLoopCallbacks['onTurnStart'];
  onDone?: AgentLoopCallbacks['onDone'];
  onUsage?: AgentLoopCallbacks['onUsage'];
  onModeChange?: AgentLoopCallbacks['onModeChange'];
  onCompact?: AgentLoopCallbacks['onCompact'];
  onAssistantMessageComplete?: AgentLoopCallbacks['onAssistantMessageComplete'];
  onTodos?: AgentLoopCallbacks['onTodos'];
  onRetry?: AgentLoopCallbacks['onRetry'];
  onStreamStall?: AgentLoopCallbacks['onStreamStall'];
  onStreamResume?: AgentLoopCallbacks['onStreamResume'];
  onPersistPermissionRule?: AgentLoopCallbacks['onPersistPermissionRule'];
  onHookEvent?: AgentLoopCallbacks['onHookEvent'];
  onPermissionRequired?: AgentLoopCallbacks['onPermissionRequired'];
  onPlanApprovalRequired?: AgentLoopCallbacks['onPlanApprovalRequired'];
  onUserQuestionRequired?: AgentLoopCallbacks['onUserQuestionRequired'];
  userQuestionStatus?: 'pending' | 'unavailable';
}

export interface AgentSessionRunRequest {
  config: AgentConfig;
  registry: ToolRegistry;
  prompt: string;
  history: Message[];
  mode?: PermissionMode;
  sessionId: string;
  timelineStore?: Pick<SessionStoreInterface, 'append'>;
  callbacks: AgentSessionRunCallbacks;
  options?: Omit<AgentLoopOptions, 'signal'>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export interface AgentSessionPrepareSendRequest {
  config: AgentConfig;
  sessionId: string;
  displayMessage: string;
  contextMessage?: string;
  userMessage: Message;
  snapshotStore?: Pick<RewindSnapshotStoreInterface, 'capture' | 'captureAsync'>;
  timelineStore?: Pick<SessionStoreInterface, 'append'>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  runtime?: SessionRuntime;
}

export interface AgentSessionRecordUserRequest {
  config: AgentConfig;
  sessionId: string;
  displayMessage: string;
  contextMessage?: string;
  userMessage: Message;
  timelineStore?: Pick<SessionStoreInterface, 'append'>;
  expandShellInput?: boolean;
  runtime?: SessionRuntime;
  signal?: AbortSignal;
}

export interface AgentSessionSendControl {
  signal?: AbortSignal;
  isCurrent: () => boolean;
}

export interface AgentSessionSendRequest {
  config: AgentConfig;
  registry?: ToolRegistry;
  displayMessage: string;
  contextMessage?: string;
  createUserMessage: () => Message;
  history: Message[] | (() => Message[]);
  mode?: PermissionMode;
  sessionId: string;
  snapshotStore?: Pick<RewindSnapshotStoreInterface, 'capture' | 'captureAsync'>;
  timelineStore?: Pick<SessionStoreInterface, 'append'>;
  registryStore?: SessionStoreInterface;
  callbacks: AgentSessionRunCallbacks;
  options?: Omit<
    AgentLoopOptions,
    'signal' | 'displayMessage' | 'userMessageId' | 'userMessageTimestamp' | 'userFileObservations'
  >;
  isCurrent?: () => boolean;
  runtime?: SessionRuntime;
  beforePrepare?: (control: AgentSessionSendControl) => void | Promise<void>;
  onPreparing?: (userMessage: Message, control: AgentSessionSendControl) => void;
  onPrepared?: (
    result: Extract<AgentSessionPrepareSendResult, { status: 'prepared' }>,
    control: AgentSessionSendControl,
  ) => void;
}

export type AgentSessionSendResult =
  | { status: 'rejected'; activeKind: AgentSessionOperation['kind'] | null }
  | { status: 'cancelled' }
  | { status: 'completed'; messages: Message[] }
  | { status: 'failed'; phase: 'before-prepare' | 'prepare' | 'run'; error: unknown };

export interface AgentSessionCompactRequest {
  config: AgentConfig;
  history: readonly Message[];
  sessionId?: string;
  transcriptOrdinal: number;
  options: Omit<RunCompactOptions, 'sessionId'>;
  timelineStore?: Pick<SessionStoreInterface, 'append'>;
  isCurrent?: () => boolean;
  onCommitted?: (
    result: Extract<CompactResult, { status: 'compacted' }>,
    boundary: CompactBoundary,
  ) => void;
}

export interface AgentSessionCompactOutcome {
  result: CompactResult;
  boundary?: CompactBoundary;
}

export type AgentSessionPrepareSendResult =
  | { status: 'prepared'; contextMessage: string; rewindTarget: RewindTarget }
  | { status: 'cancelled' };

export interface AgentSessionCancelResult {
  operation: CancelOperationResult;
  interactions: ReturnType<AgentInteractionController['cancelAll']>;
}

export interface AgentSessionDependencies {
  runLoop?: AgentLoopRunner;
  compactRunner?: typeof runCompact;
  postCompactHooksRunner?: typeof runPostCompactHooks;
  sessionStartRunner?: typeof runSessionStart;
  sessionEndRunner?: typeof runSessionEnd;
  runtime?: SessionRuntime;
  registryFactory?: (request: {
    config: AgentConfig;
    sessionId: string;
    registryStore?: SessionStoreInterface;
  }) => ToolRegistry;
}

export interface AgentSessionTransitionRequest {
  config: AgentConfig;
  currentSessionId: string;
  store?: SessionStoreInterface;
  timelineStore?: SessionStoreInterface;
  previousName?: string;
  onTransitionStart?: () => void;
  onTransition?: (bootstrap: SessionBootstrap) => void;
}

export interface AgentSessionResumeRequest extends AgentSessionTransitionRequest {
  selector: string;
}

export type AgentSessionTransitionResult =
  | { status: 'unchanged'; sessionId: string }
  | { status: 'transitioned'; bootstrap: SessionBootstrap };

type AgentSessionListener = (snapshot: AgentSessionSnapshot) => void;

/** Shared owner for agent-loop execution, interaction promises, and operation lifetime. */
export class AgentSession {
  readonly interactions = new AgentInteractionController();
  readonly operations = new AgentSessionOperations();
  private readonly runLoop: AgentLoopRunner;
  private readonly compactRunner: typeof runCompact;
  private readonly postCompactHooksRunner: typeof runPostCompactHooks;
  private readonly sessionStartRunner: typeof runSessionStart;
  private readonly sessionEndRunner: typeof runSessionEnd;
  private snapshot = createAgentSessionSnapshot();
  private readonly listeners = new Set<AgentSessionListener>();
  private runGeneration = 0;
  private lifecycleStartedSessionId?: string;
  private lifecycleEndedSessionId?: string;
  private runtime: SessionRuntime;
  private readonly registryFactory?: AgentSessionDependencies['registryFactory'];

  constructor(dependencies: AgentSessionDependencies = {}) {
    this.runLoop = dependencies.runLoop ?? runAgentLoop;
    this.compactRunner = dependencies.compactRunner ?? runCompact;
    this.postCompactHooksRunner = dependencies.postCompactHooksRunner ?? runPostCompactHooks;
    this.sessionStartRunner = dependencies.sessionStartRunner ?? runSessionStart;
    this.sessionEndRunner = dependencies.sessionEndRunner ?? runSessionEnd;
    this.runtime = dependencies.runtime ?? new SessionRuntime();
    this.registryFactory = dependencies.registryFactory;
  }

  startSend(): AgentSessionOperation | null {
    return this.operations.tryStart('send', true);
  }

  finishSend(operation: AgentSessionOperation): boolean {
    return operation.kind === 'send' && operation.release();
  }

  async send(request: AgentSessionSendRequest): Promise<AgentSessionSendResult> {
    const operation = this.startSend();
    if (!operation) {
      return { status: 'rejected', activeKind: this.operations.activeKind };
    }
    const control: AgentSessionSendControl = {
      signal: operation.signal,
      isCurrent: () => operation.isCurrent() && request.isCurrent?.() !== false,
    };
    const runtime = request.runtime ?? this.runtime;

    try {
      try {
        await request.beforePrepare?.(control);
      } catch (error) {
        return { status: 'failed', phase: 'before-prepare', error };
      }
      if (!control.isCurrent() || control.signal?.aborted) return { status: 'cancelled' };

      const userMessage = request.createUserMessage();
      request.onPreparing?.(userMessage, control);

      let prepared: Extract<AgentSessionPrepareSendResult, { status: 'prepared' }>;
      try {
        const result = await this.prepareSend({
          config: request.config,
          sessionId: request.sessionId,
          displayMessage: request.displayMessage,
          contextMessage: request.contextMessage,
          userMessage,
          snapshotStore: request.snapshotStore,
          timelineStore: request.timelineStore,
          signal: control.signal,
          isCurrent: control.isCurrent,
          runtime,
        });
        if (result.status === 'cancelled') return result;
        prepared = result;
        request.onPrepared?.(prepared, control);
      } catch (error) {
        return { status: 'failed', phase: 'prepare', error };
      }

      try {
        const history = typeof request.history === 'function' ? request.history() : request.history;
        const registry =
          request.registry ??
          this.registryFactory?.({
            config: request.config,
            sessionId: request.sessionId,
            registryStore: request.registryStore,
          });
        if (!registry) throw new Error('AgentSession send requires a tool registry.');
        const messages = await this.run({
          config: request.config,
          registry,
          prompt: prepared.contextMessage,
          history,
          mode: request.mode,
          sessionId: request.sessionId,
          timelineStore: request.timelineStore,
          callbacks: request.callbacks,
          options: {
            ...request.options,
            runtime,
            displayMessage: request.displayMessage,
            userMessageId: userMessage.id,
            userMessageTimestamp: userMessage.timestamp,
            userFileObservations: userMessage.fileObservations,
            userMessageKind: userMessage.kind,
            skipUserPromptHooks: userMessage.kind === 'agent-notification',
          },
          signal: control.signal,
          isCurrent: control.isCurrent,
        });
        return { status: 'completed', messages };
      } catch (error) {
        return { status: 'failed', phase: 'run', error };
      }
    } finally {
      this.finishSend(operation);
    }
  }

  getSnapshot(): AgentSessionSnapshot {
    return this.snapshot;
  }

  getRuntime(): SessionRuntime {
    return this.runtime;
  }

  replaceRuntime(options: SessionRuntimeOptions = {}, via = 'session_transition'): SessionRuntime {
    this.runtime.dispose(via);
    this.runtime = new SessionRuntime(options);
    return this.runtime;
  }

  subscribe(listener: AgentSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(via: string): AgentSessionCancelResult {
    return {
      operation: this.operations.cancel(),
      interactions: this.interactions.cancelAll(via),
    };
  }

  reset(via: string): void {
    this.interactions.cancelAll(via);
    this.operations.reset();
    this.runGeneration++;
    this.replaceRuntime({}, via);
    this.replaceSnapshot(createAgentSessionSnapshot());
  }

  dispose(via = 'session_disposed'): void {
    this.interactions.cancelAll(via);
    this.operations.reset();
    this.runGeneration++;
    this.runtime.dispose(via);
  }

  async startLifecycle(
    config: AgentConfig,
    sessionId: string,
    source: Parameters<typeof runSessionStart>[2],
    options?: SessionLifecycleOptions,
  ): Promise<void> {
    if (this.lifecycleStartedSessionId === sessionId) return;
    this.lifecycleStartedSessionId = sessionId;
    await this.sessionStartRunner(config, sessionId, source, options);
  }

  async endLifecycle(
    config: AgentConfig,
    sessionId: string,
    reason: Parameters<typeof runSessionEnd>[2],
    options?: SessionLifecycleOptions,
  ): Promise<void> {
    if (this.lifecycleEndedSessionId === sessionId) return;
    this.lifecycleEndedSessionId = sessionId;
    await this.sessionEndRunner(config, sessionId, reason, options);
  }

  async clearSession(
    request: AgentSessionTransitionRequest,
  ): Promise<AgentSessionTransitionResult> {
    request.onTransitionStart?.();
    this.operations.cancel();
    await this.endLifecycle(request.config, request.currentSessionId, 'clear');
    if (request.previousName && request.store) {
      request.store.patchMeta(request.currentSessionId, { name: request.previousName });
    }

    const sessionId = request.store
      ? request.store.create({ cwd: request.config.workspace })
      : (request.timelineStore?.create({ cwd: request.config.workspace }) ?? crypto.randomUUID());
    if (request.store && request.timelineStore && request.timelineStore !== request.store) {
      request.timelineStore.create({ id: sessionId, cwd: request.config.workspace });
    }

    const bootstrap = emptySessionBootstrap(
      sessionId,
      undefined,
      request.store !== undefined,
      'clear',
    );
    this.reset('session-clear');
    request.onTransition?.(bootstrap);
    await this.startLifecycle(request.config, sessionId, 'clear');
    return { status: 'transitioned', bootstrap };
  }

  async resumeSession(request: AgentSessionResumeRequest): Promise<AgentSessionTransitionResult> {
    if (!request.store) {
      throw new Error('Session persistence is disabled; /resume is unavailable.');
    }
    const selected = selectSession(request.store, request.selector, request.config.workspace);
    if (selected.id === request.currentSessionId) {
      return { status: 'unchanged', sessionId: selected.id };
    }

    const loaded = request.store.load(selected.id);
    request.onTransitionStart?.();
    this.operations.cancel();
    await this.endLifecycle(request.config, request.currentSessionId, 'resume');
    request.store.touch(selected.id);

    const bootstrap: SessionBootstrap = {
      sessionId: selected.id,
      sessionName: loaded.meta.name,
      history: loaded.contextHistory,
      transcript: loaded.transcript,
      contextHistory: loaded.contextHistory,
      compactBoundaries: loaded.compactBoundaries,
      rewindTargets: loaded.rewindTargets,
      activeEventIds: loaded.activeEventIds,
      source: 'resume',
      persisted: true,
      created: false,
    };
    this.reset('session-resume');
    request.onTransition?.(bootstrap);
    await this.startLifecycle(request.config, selected.id, 'resume');
    return { status: 'transitioned', bootstrap };
  }

  async prepareSend(
    request: AgentSessionPrepareSendRequest,
  ): Promise<AgentSessionPrepareSendResult> {
    const checkpointId = crypto.randomUUID();
    const checkpointTimestamp = Date.now();
    const capture = await captureSnapshot(request.snapshotStore);
    if (request.isCurrent?.() === false || request.signal?.aborted) {
      return { status: 'cancelled' };
    }

    const checkpoint = capture.ok
      ? {
          snapshotId: capture.manifest.id,
          gitHead: capture.manifest.gitHead,
          entryCount: capture.manifest.entries.length,
          logicalBytes: capture.manifest.logicalBytes,
        }
      : {
          gitHead: capture.gitHead,
          codeUnavailableReason: capture.reason,
        };
    const rewindTarget: RewindTarget = {
      id: checkpointId,
      userEventId: request.userMessage.id,
      prompt: request.displayMessage,
      timestamp: checkpointTimestamp,
      ...checkpoint,
      codeAvailable: capture.ok,
    };

    request.timelineStore?.append(request.sessionId, {
      type: 'turn_checkpoint',
      eventId: checkpointId,
      timestamp: checkpointTimestamp,
      data: {
        version: 1,
        checkpointId,
        userEventId: request.userMessage.id,
        prompt: request.displayMessage,
        checkpoint,
      } satisfies TurnCheckpointRecordData,
    } satisfies SessionRecord);

    // Expansion follows checkpoint capture so its side effects belong to this rewind boundary.
    const { contextMessage } = await this.recordUserMessage(request);

    return { status: 'prepared', contextMessage, rewindTarget };
  }

  async recordUserMessage(
    request: AgentSessionRecordUserRequest,
  ): Promise<{ contextMessage: string }> {
    const expandedMentions =
      request.contextMessage === undefined
        ? expandAtMentions(request.displayMessage, request.config.workspace)
        : request.contextMessage;
    const contextMessage =
      request.contextMessage !== undefined || request.expandShellInput === false
        ? expandedMentions
        : await expandShellCommands(expandedMentions, request.config.workspace, request.signal);
    request.userMessage.contextContent =
      contextMessage === request.displayMessage ? undefined : contextMessage;
    request.userMessage.fileObservations =
      request.contextMessage === undefined
        ? collectAtMentionObservations(
            request.displayMessage,
            request.config.workspace,
            request.userMessage.id,
          )
        : [];
    const observationLedger = (request.runtime ?? this.runtime).fileObservationLedger;
    for (const observation of request.userMessage.fileObservations) {
      observationLedger.set(observationKey(observation.workspaceId, observation.path), observation);
    }
    request.timelineStore?.append(request.sessionId, {
      type: 'user',
      eventId: request.userMessage.id,
      timestamp: request.userMessage.timestamp,
      data: {
        id: request.userMessage.id,
        content: request.displayMessage,
        contextContent: request.userMessage.contextContent,
        kind: request.userMessage.kind ?? 'conversation',
        agentNotifications: request.userMessage.agentNotifications,
        fileObservations: request.userMessage.fileObservations,
      },
    } satisfies SessionRecord);

    return { contextMessage };
  }

  async compact(request: AgentSessionCompactRequest): Promise<AgentSessionCompactOutcome> {
    const result = await this.compactRunner(request.config, request.history, {
      ...request.options,
      sessionId: request.sessionId,
    });
    if (result.status !== 'compacted') return { result };
    if (request.isCurrent?.() === false) return { result };

    const timestamp = Date.now();
    const boundary: CompactBoundary = {
      id: result.compactId,
      trigger: result.trigger,
      transcriptOrdinal: request.transcriptOrdinal,
      preContextCount: result.preMessageCount,
      postContextCount: result.replacementHistory.length,
      preContextTokens: result.preContextTokens,
      postContextTokens: result.postContextTokens,
      generation: result.generation,
      checkpointVersion: 2,
      timestamp,
    };
    const data: CompactRecordData = {
      version: 2,
      compactId: result.compactId,
      generation: result.generation,
      trigger: result.trigger,
      focus: request.options.focus,
      checkpoint: result.checkpoint,
      summary: result.summary,
      preContextTokens: result.preContextTokens,
      postContextTokens: result.postContextTokens,
      replacementHistory: result.replacementHistory,
      boundary,
      throughEventRef: result.throughEventRef,
      summarizedCount: result.summarizedCount,
      retainedCount: result.retainedCount,
      strategy: result.strategy,
      modelCalls: result.modelCalls,
      degraded: result.degraded,
      warning: result.warning,
    };
    if (request.timelineStore && request.sessionId) {
      request.timelineStore.append(request.sessionId, {
        type: 'compact',
        eventId: result.compactId,
        timestamp,
        data,
      } satisfies SessionRecord);
    }
    request.onCommitted?.(result, boundary);
    await this.postCompactHooksRunner(request.config, {
      trigger: result.trigger,
      sessionId: request.sessionId,
      focus: request.options.focus,
      onHookEvent: request.options.onHookEvent,
      signal: request.options.signal,
    });
    return { result, boundary };
  }

  async run(request: AgentSessionRunRequest): Promise<Message[]> {
    const { callbacks } = request;
    const runGeneration = ++this.runGeneration;
    let usage: Usage | null = null;
    let emittedError: string | undefined;
    this.replaceSnapshot(createAgentSessionSnapshot());
    const emit = (event: AgentEvent) => {
      if (runGeneration === this.runGeneration) this.emit(event, callbacks.onEvent);
      else callbacks.onEvent(event);
    };
    emit({ type: 'system', model: request.config.model, cwd: request.config.workspace });
    emit({ type: 'session', sessionId: request.sessionId });

    try {
      const messages = await this.runLoop(
        request.config,
        request.registry,
        request.prompt,
        request.history,
        {
          onText: (content: string) => emit({ type: 'text', content }),
          onToolCall: (toolCall: ToolCall) => emit({ type: 'tool_use', toolCall }),
          onToolResult: (toolResult: ToolResult) => emit({ type: 'tool_result', toolResult }),
          onError: (error: string) => {
            emittedError = error;
            emit({ type: 'error', error });
          },
          onTurnStart: callbacks.onTurnStart,
          onDone: callbacks.onDone ?? (() => {}),
          onPermissionRequired: (toolCall) => {
            if (request.isCurrent?.() === false) return Promise.resolve('deny');
            return callbacks.onPermissionRequired
              ? callbacks.onPermissionRequired(toolCall)
              : this.interactions.requestPermission(toolCall);
          },
          onPlanApprovalRequired: (plan) => {
            if (request.isCurrent?.() === false) return Promise.resolve('reject');
            return callbacks.onPlanApprovalRequired
              ? callbacks.onPlanApprovalRequired(plan)
              : this.interactions.requestPlanApproval(plan);
          },
          onUserQuestionRequired: async (question, context): Promise<UserQuestionResponse> => {
            if (request.isCurrent?.() === false) {
              return { action: 'cancel', message: 'Session changed.' };
            }
            emit({
              type: 'user_question',
              request: question,
              status: callbacks.userQuestionStatus ?? 'pending',
            });
            const response = callbacks.onUserQuestionRequired
              ? await callbacks.onUserQuestionRequired(question, context)
              : await this.interactions.requestUserQuestion(question);
            emit({ type: 'user_question_result', requestId: question.id, response });
            return response;
          },
          onUsage: (nextUsage) => {
            usage = nextUsage;
            callbacks.onUsage?.(nextUsage);
          },
          onModeChange: callbacks.onModeChange,
          onCompact: callbacks.onCompact,
          onAssistantMessageComplete: (message) => {
            if (request.isCurrent?.() === false) return;
            request.timelineStore?.append(request.sessionId, {
              type: 'assistant',
              eventId: message.id,
              timestamp: message.timestamp,
              data: {
                id: message.id,
                complete: true,
                content: message.content,
                kind: message.kind ?? 'conversation',
                toolCalls: message.toolCalls,
                toolResults: message.toolResults,
                fileObservations: message.fileObservations,
              },
            } satisfies SessionRecord);
            callbacks.onAssistantMessageComplete?.(message);
          },
          onTodos: callbacks.onTodos,
          onRetry: callbacks.onRetry,
          onStreamStall: callbacks.onStreamStall,
          onStreamResume: callbacks.onStreamResume,
          onPersistPermissionRule: callbacks.onPersistPermissionRule,
          onHookEvent: callbacks.onHookEvent,
          onAgentEvent: (event: AgentRuntimeEvent) => emit(event),
        },
        request.mode,
        {
          ...request.options,
          runtime: request.options?.runtime ?? this.runtime,
          signal: request.signal,
        },
      );
      emit({ type: 'result', messages, usage, sessionId: request.sessionId });
      return messages;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (emittedError !== message) emit({ type: 'error', error: message });
      throw error;
    } finally {
      emit({ type: 'done' });
    }
  }

  private emit(event: AgentEvent, hostListener: (event: AgentEvent) => void): void {
    this.snapshot = reduceAgentSessionSnapshot(this.snapshot, event);
    for (const listener of this.listeners) listener(this.snapshot);
    hostListener(event);
  }

  private replaceSnapshot(snapshot: AgentSessionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

async function captureSnapshot(
  snapshotStore?: Pick<RewindSnapshotStoreInterface, 'capture' | 'captureAsync'>,
): Promise<RewindSnapshotCaptureResult> {
  if (!snapshotStore) {
    return { ok: false, reason: 'Filesystem checkpoint storage is unavailable.' };
  }
  if (snapshotStore.captureAsync) return snapshotStore.captureAsync();
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(snapshotStore.capture());
      } catch (error) {
        reject(error);
      }
    }, 0);
  });
}

function emptySessionBootstrap(
  sessionId: string,
  sessionName: string | undefined,
  persisted: boolean,
  source: SessionBootstrap['source'],
): SessionBootstrap {
  return {
    sessionId,
    sessionName,
    history: [],
    transcript: [],
    contextHistory: [],
    compactBoundaries: [],
    rewindTargets: [],
    activeEventIds: [],
    source,
    persisted,
    created: true,
  };
}
