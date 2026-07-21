import type { AgentRuntimeEvent } from '../agents/types.js';
import { runAgentLoop } from '../agent/loop.js';
import { runCompact, runPostCompactHooks, type RunCompactOptions } from '../agent/compact.js';
import { runSessionEnd, runSessionStart } from './lifecycle.js';
import type { ToolRegistry } from '../tools/registry.js';
import type {
  AgentConfig,
  AgentLoopCallbacks,
  CompactBoundary,
  CompactRecordData,
  CompactResult,
  Message,
  PermissionMode,
  RewindSnapshotCaptureResult,
  RewindSnapshotStoreInterface,
  RewindTarget,
  SessionRecord,
  SessionStoreInterface,
  ToolCall,
  ToolResult,
  TurnCheckpointRecordData,
  Usage,
  UserQuestionResponse,
} from '../types.js';
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
}

export interface AgentSessionRunRequest {
  config: AgentConfig;
  registry: ToolRegistry;
  prompt: string;
  history: Message[];
  mode?: PermissionMode;
  sessionId: string;
  callbacks: AgentSessionRunCallbacks;
  options?: Omit<AgentLoopOptions, 'signal'>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export interface AgentSessionPrepareSendRequest {
  config: AgentConfig;
  sessionId: string;
  displayMessage: string;
  userMessage: Message;
  snapshotStore?: Pick<RewindSnapshotStoreInterface, 'capture' | 'captureAsync'>;
  timelineStore?: Pick<SessionStoreInterface, 'append'>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export interface AgentSessionCompactRequest {
  config: AgentConfig;
  history: readonly Message[];
  sessionId: string;
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
}

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

  constructor(dependencies: AgentSessionDependencies = {}) {
    this.runLoop = dependencies.runLoop ?? runAgentLoop;
    this.compactRunner = dependencies.compactRunner ?? runCompact;
    this.postCompactHooksRunner = dependencies.postCompactHooksRunner ?? runPostCompactHooks;
    this.sessionStartRunner = dependencies.sessionStartRunner ?? runSessionStart;
    this.sessionEndRunner = dependencies.sessionEndRunner ?? runSessionEnd;
  }

  startSend(): AgentSessionOperation | null {
    return this.operations.tryStart('send', true);
  }

  finishSend(operation: AgentSessionOperation): boolean {
    return operation.kind === 'send' && operation.release();
  }

  getSnapshot(): AgentSessionSnapshot {
    return this.snapshot;
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
    this.replaceSnapshot(createAgentSessionSnapshot());
  }

  async startLifecycle(
    config: AgentConfig,
    sessionId: string,
    source: Parameters<typeof runSessionStart>[2],
  ): Promise<void> {
    if (this.lifecycleStartedSessionId === sessionId) return;
    this.lifecycleStartedSessionId = sessionId;
    await this.sessionStartRunner(config, sessionId, source);
  }

  async endLifecycle(
    config: AgentConfig,
    sessionId: string,
    reason: Parameters<typeof runSessionEnd>[2],
  ): Promise<void> {
    if (this.lifecycleEndedSessionId === sessionId) return;
    this.lifecycleEndedSessionId = sessionId;
    await this.sessionEndRunner(config, sessionId, reason);
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
    const contextMessage = expandShellCommands(
      expandAtMentions(request.displayMessage, request.config.workspace),
      request.config.workspace,
    );
    request.userMessage.contextContent =
      contextMessage === request.displayMessage ? undefined : contextMessage;
    request.userMessage.fileObservations = collectAtMentionObservations(
      request.displayMessage,
      request.config.workspace,
      request.userMessage.id,
    );
    request.config.fileObservationLedger ??= new Map();
    for (const observation of request.userMessage.fileObservations) {
      request.config.fileObservationLedger.set(
        observationKey(observation.workspaceId, observation.path),
        observation,
      );
    }
    request.timelineStore?.append(request.sessionId, {
      type: 'user',
      eventId: request.userMessage.id,
      timestamp: request.userMessage.timestamp,
      data: {
        id: request.userMessage.id,
        content: request.displayMessage,
        contextContent: request.userMessage.contextContent,
        kind: 'conversation',
        fileObservations: request.userMessage.fileObservations,
      },
    } satisfies SessionRecord);

    return { status: 'prepared', contextMessage, rewindTarget };
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
    request.timelineStore?.append(request.sessionId, {
      type: 'compact',
      eventId: result.compactId,
      timestamp,
      data,
    } satisfies SessionRecord);
    request.onCommitted?.(result, boundary);
    await this.postCompactHooksRunner(request.config, {
      trigger: result.trigger,
      sessionId: request.sessionId,
      focus: request.options.focus,
      onHookEvent: request.options.onHookEvent,
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
          onPermissionRequired: (toolCall) =>
            request.isCurrent?.() === false
              ? Promise.resolve('deny')
              : this.interactions.requestPermission(toolCall),
          onPlanApprovalRequired: (plan) =>
            request.isCurrent?.() === false
              ? Promise.resolve('reject')
              : this.interactions.requestPlanApproval(plan),
          onUserQuestionRequired: async (question): Promise<UserQuestionResponse> => {
            if (request.isCurrent?.() === false) {
              return { action: 'cancel', message: 'Session changed.' };
            }
            emit({ type: 'user_question', request: question, status: 'pending' });
            const response = await this.interactions.requestUserQuestion(question);
            emit({ type: 'user_question_result', requestId: question.id, response });
            return response;
          },
          onUsage: (nextUsage) => {
            usage = nextUsage;
            callbacks.onUsage?.(nextUsage);
          },
          onModeChange: callbacks.onModeChange,
          onCompact: callbacks.onCompact,
          onAssistantMessageComplete: callbacks.onAssistantMessageComplete,
          onTodos: callbacks.onTodos,
          onRetry: callbacks.onRetry,
          onStreamStall: callbacks.onStreamStall,
          onStreamResume: callbacks.onStreamResume,
          onPersistPermissionRule: callbacks.onPersistPermissionRule,
          onHookEvent: callbacks.onHookEvent,
          onAgentEvent: (event: AgentRuntimeEvent) => emit(event),
        },
        request.mode,
        { ...request.options, signal: request.signal },
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
