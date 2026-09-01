import type { AgentRuntimeEvent } from '../agents/types.js';
import { runAgentLoop } from '../agent/loop.js';
import { runCompact, runPostCompactHooks, type RunCompactOptions } from '../agent/compact.js';
import { resolveContextLimit } from '../models.js';
import { runSessionEnd, runSessionStart } from './lifecycle.js';
import type { SessionLifecycleOptions } from './lifecycle.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type {
  CompactBoundary,
  CompactRecordData,
  CompactResult,
  PlanRecordData,
  RewindSnapshotCaptureResult,
  RewindSnapshotStoreInterface,
  RewindTarget,
  SessionRecord,
  SessionStoreInterface,
  TurnCheckpointRecordData,
} from '../types/sessions.js';
import type { Message, Usage } from '../types/messages.js';
import { createAgentRunContext, type AgentRunContext, type AgentRunSource } from '../types/runs.js';
import {
  classifyAbortReason,
  classifyRuntimeError,
  createTerminalOutcome,
  type AgentTerminalOutcome,
} from '../types/terminal.js';
import type { ToolCall, ToolResult, UserQuestionResponse } from '../types/tools.js';
import {
  collectAtMentionObservations,
  expandAtMentions,
  expandShellCommands,
} from '../input/input-expansion.js';
import { observationKey, workspaceIdentity } from '../tools/file-provenance.js';
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
import { createRunAmbientSnapshot } from './run-ambient.js';
import { deriveSessionName } from './name.js';
import type { HarnessRunContext } from '../harness/contracts.js';
import type {
  FinalizeRunInput,
  HarnessObserver,
  HarnessCoordinator,
  HarnessObserverFlushResult,
  WorkflowProvenance,
} from '../harness/contracts.js';
import { builtinWorkflowRegistry, selectWorkflow } from '../harness/coordinator.js';
import { createHarnessCoordinator, wrapAgentLoopCallbacks } from '../harness/coordinator.js';
import { assertHarnessModeAvailable } from '../harness/coordinator.js';

export type AgentLoopRunner = typeof runAgentLoop;

/** Evidence preparation may not block the user path longer than this. */
const HARNESS_PREPARE_TIMEOUT_MS = 2_000;
type AgentLoopOptions = NonNullable<Parameters<AgentLoopRunner>[6]>;
type SessionTimelineStore = Pick<SessionStoreInterface, 'append'> &
  Partial<Pick<SessionStoreInterface, 'patchMeta' | 'readImageAttachment'>>;

export interface AgentSessionRunCallbacks {
  onEvent: (event: AgentEvent) => void;
  onTurnStart: AgentLoopCallbacks['onTurnStart'];
  onDone?: AgentLoopCallbacks['onDone'];
  onTerminal?: AgentLoopCallbacks['onTerminal'];
  onUsage?: AgentLoopCallbacks['onUsage'];
  getMode?: AgentLoopCallbacks['getMode'];
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
  onPlanHandoff?: AgentLoopCallbacks['onPlanHandoff'];
  onUserQuestionRequired?: AgentLoopCallbacks['onUserQuestionRequired'];
  userQuestionStatus?: 'pending' | 'unavailable';
  onHarnessFinalized?: (result: HarnessObserverFlushResult) => void;
}

export interface AgentSessionRunRequest {
  config: AgentConfig;
  registry: ToolRegistry;
  prompt: string;
  history: Message[];
  /** Authoritative display transcript used when Zero-Mem builds query-time context. */
  transcript?: readonly Message[];
  compactBoundaries?: readonly CompactBoundary[];
  mode?: PermissionMode;
  sessionId: string;
  timelineStore?: Pick<SessionStoreInterface, 'append'> &
    Partial<Pick<SessionStoreInterface, 'readImageAttachment'>>;
  callbacks: AgentSessionRunCallbacks;
  /** Frozen attribution for this request; created once when omitted. */
  runContext?: AgentRunContext;
  /** Optional frozen harness metadata; absent when harness mode is off. */
  harnessContext?: Readonly<HarnessRunContext>;
  /** Optional hard USD ceiling for this root run. */
  maxBudgetUsd?: number;
  source?: AgentRunSource;
  resumedFromRunId?: string;
  options?: Omit<AgentLoopOptions, 'signal'>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  /** Internal host override; enabled observers are otherwise prepared at this boundary. */
  harnessCoordinator?: HarnessCoordinator;
  harnessObserver?: HarnessObserver;
  /** Headless multi-turn hosts defer the root seal until linked child turns finish. */
  harnessFinalize?: boolean;
}

export interface AgentSessionPrepareSendRequest {
  config: AgentConfig;
  sessionId: string;
  displayMessage: string;
  contextMessage?: string;
  userMessage: Message;
  sessionName?: string;
  snapshotStore?: Pick<RewindSnapshotStoreInterface, 'capture' | 'captureAsync'>;
  timelineStore?: SessionTimelineStore;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  harnessCoordinator?: HarnessCoordinator;
  harnessObserver?: HarnessObserver;
  harnessFinalize?: boolean;
  runtime?: SessionRuntime;
  onUserMessagePersisted?: () => void;
}

export interface AgentSessionRecordUserRequest {
  config: AgentConfig;
  sessionId: string;
  displayMessage: string;
  contextMessage?: string;
  userMessage: Message;
  sessionName?: string;
  timelineStore?: SessionTimelineStore;
  expandShellInput?: boolean;
  runtime?: SessionRuntime;
  signal?: AbortSignal;
  onUserMessagePersisted?: () => void;
}

export interface AgentSessionSendControl {
  signal?: AbortSignal;
  isCurrent: () => boolean;
  runContext: AgentRunContext;
}

export interface AgentSessionSendRequest {
  config: AgentConfig;
  registry?: ToolRegistry;
  displayMessage: string;
  contextMessage?: string;
  createUserMessage: () => Message;
  history: Message[] | (() => Message[]);
  /** Authoritative display transcript used when Zero-Mem builds query-time context. */
  transcript?: readonly Message[] | (() => readonly Message[]);
  compactBoundaries?: readonly CompactBoundary[];
  mode?: PermissionMode;
  sessionId: string;
  sessionName?: string;
  snapshotStore?: Pick<RewindSnapshotStoreInterface, 'capture' | 'captureAsync'>;
  timelineStore?: SessionTimelineStore;
  registryStore?: SessionStoreInterface;
  callbacks: AgentSessionRunCallbacks;
  /** Frozen attribution for this request; created once when omitted. */
  runContext?: AgentRunContext;
  /** Optional frozen harness metadata; absent when harness mode is off. */
  harnessContext?: Readonly<HarnessRunContext>;
  /** Optional hard USD ceiling for this root run. */
  maxBudgetUsd?: number;
  source?: AgentRunSource;
  resumedFromRunId?: string;
  /** Managed-continuation linkage: the originating root and parent execution run. */
  rootRunId?: string;
  parentRunId?: string;
  harnessCoordinator?: HarnessCoordinator;
  harnessObserver?: HarnessObserver;
  harnessFinalize?: boolean;
  options?: Omit<
    AgentLoopOptions,
    | 'signal'
    | 'displayMessage'
    | 'userMessageId'
    | 'userMessageTimestamp'
    | 'userFileObservations'
    | 'userAttachments'
    | 'resolveAttachment'
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
  | { status: 'cancelled'; messages?: Message[]; outcome?: AgentTerminalOutcome }
  | { status: 'completed'; messages: Message[]; outcome: AgentTerminalOutcome }
  | {
      status: 'failed';
      phase: 'before-prepare' | 'run';
      error: unknown;
      messages?: Message[];
      outcome?: AgentTerminalOutcome;
    }
  | { status: 'failed'; phase: 'prepare'; error: unknown; userMessagePersisted: boolean };

export interface AgentSessionCompactRequest {
  config: AgentConfig;
  history: readonly Message[];
  /** Authoritative trace used to initialize Zero-Mem without replacing history. */
  sourceHistory?: readonly Message[];
  compactBoundaries?: readonly CompactBoundary[];
  sessionId?: string;
  transcriptOrdinal: number;
  options: Omit<RunCompactOptions, 'sessionId'>;
  runContext?: AgentRunContext;
  runtime?: SessionRuntime;
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
  | {
      status: 'prepared';
      contextMessage: string;
      rewindTarget: RewindTarget;
      sessionName: string;
    }
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
  harnessCoordinator?: HarnessCoordinator;
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
/**
 * Usage written since the last record, so a stream of deltas still sums correctly.
 *
 * Clamped at zero per field: a compaction or a re-priced retry can make an
 * inclusive total move backwards, and a negative delta would silently refund
 * spend the run actually made.
 */
function subtractUsage(total: Usage, already: Usage): Usage {
  const at = (left: number | undefined, right: number | undefined): number =>
    Math.max(0, (left ?? 0) - (right ?? 0));
  return {
    promptTokens: at(total.promptTokens, already.promptTokens),
    completionTokens: at(total.completionTokens, already.completionTokens),
    totalTokens: at(total.totalTokens, already.totalTokens),
    cacheReadInputTokens: at(total.cacheReadInputTokens, already.cacheReadInputTokens),
    cacheCreationInputTokens: at(total.cacheCreationInputTokens, already.cacheCreationInputTokens),
  };
}

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
  private readonly harnessCoordinator?: HarnessCoordinator;

  constructor(dependencies: AgentSessionDependencies = {}) {
    this.runLoop = dependencies.runLoop ?? runAgentLoop;
    this.compactRunner = dependencies.compactRunner ?? runCompact;
    this.postCompactHooksRunner = dependencies.postCompactHooksRunner ?? runPostCompactHooks;
    this.sessionStartRunner = dependencies.sessionStartRunner ?? runSessionStart;
    this.sessionEndRunner = dependencies.sessionEndRunner ?? runSessionEnd;
    this.runtime = dependencies.runtime ?? new SessionRuntime();
    this.registryFactory = dependencies.registryFactory;
    this.harnessCoordinator = dependencies.harnessCoordinator;
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
    const runtime = request.runtime ?? this.runtime;
    let userMessagePersisted = false;
    let runOutcome: AgentTerminalOutcome | undefined;

    try {
      const userMessage = request.createUserMessage();
      const runContext =
        request.runContext ??
        createAgentRunContext({
          sessionId: request.sessionId,
          runId: userMessage.id,
          rootRunId: request.rootRunId,
          parentRunId: request.parentRunId,
          source: request.source ?? 'internal',
          resumedFromRunId: request.resumedFromRunId,
        });
      runtime.runAccounting.startRoot(runContext, request.maxBudgetUsd);
      const control: AgentSessionSendControl = {
        signal: operation.signal,
        isCurrent: () => operation.isCurrent() && request.isCurrent?.() !== false,
        runContext,
      };

      try {
        await request.beforePrepare?.(control);
      } catch (error) {
        return { status: 'failed', phase: 'before-prepare', error };
      }
      if (!control.isCurrent() || control.signal?.aborted) return { status: 'cancelled' };

      request.onPreparing?.(userMessage, control);

      let prepared: Extract<AgentSessionPrepareSendResult, { status: 'prepared' }>;
      try {
        const result = await this.prepareSend({
          config: request.config,
          sessionId: request.sessionId,
          displayMessage: request.displayMessage,
          contextMessage: request.contextMessage,
          userMessage,
          sessionName: request.sessionName,
          snapshotStore: request.snapshotStore,
          timelineStore: request.timelineStore,
          signal: control.signal,
          isCurrent: control.isCurrent,
          runtime,
          onUserMessagePersisted: () => {
            userMessagePersisted = true;
          },
        });
        if (result.status === 'cancelled') return result;
        prepared = result;
        request.onPrepared?.(prepared, control);
      } catch (error) {
        return { status: 'failed', phase: 'prepare', error, userMessagePersisted };
      }

      try {
        const history = typeof request.history === 'function' ? request.history() : request.history;
        const transcript =
          typeof request.transcript === 'function' ? request.transcript() : request.transcript;
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
          transcript,
          compactBoundaries: request.compactBoundaries,
          mode: request.mode,
          sessionId: request.sessionId,
          timelineStore: request.timelineStore,
          callbacks: {
            ...request.callbacks,
            onTerminal: (outcome) => {
              runOutcome ??= outcome;
              request.callbacks.onTerminal?.(outcome);
            },
          },
          runContext,
          harnessContext: request.harnessContext,
          harnessCoordinator: request.harnessCoordinator,
          harnessObserver: request.harnessObserver,
          harnessFinalize: request.harnessFinalize,
          maxBudgetUsd: request.maxBudgetUsd,
          options: {
            ...request.options,
            runtime,
            displayMessage: request.displayMessage,
            userMessageId: userMessage.id,
            userMessageTimestamp: userMessage.timestamp,
            userFileObservations: userMessage.fileObservations,
            userAttachments: userMessage.attachments,
            userMessageKind: userMessage.kind,
            userMessageDerived: userMessage.derivedContent,
            resolveAttachment: request.timelineStore?.readImageAttachment
              ? (attachment) =>
                  request.timelineStore!.readImageAttachment!(request.sessionId, attachment)
              : undefined,
            skipUserPromptHooks: userMessage.kind === 'agent-notification',
          },
          signal: control.signal,
          isCurrent: control.isCurrent,
        });
        const outcome = runOutcome ?? this.snapshot.terminal;
        if (!outcome) {
          return {
            status: 'failed',
            phase: 'run',
            error: new Error('Agent run ended without a terminal outcome.'),
          };
        }
        if (outcome.status === 'completed') return { status: 'completed', messages, outcome };
        if (outcome.status === 'cancelled') return { status: 'cancelled', messages, outcome };
        return {
          status: 'failed',
          phase: 'run',
          error: new Error(outcome.message ?? `Agent run ${outcome.status}.`),
          messages,
          outcome,
        };
      } catch (error) {
        return {
          status: 'failed',
          phase: 'run',
          error,
          outcome: runOutcome ?? this.snapshot.terminal,
        };
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
      operation: this.operations.cancel({ bookTerminalReason: 'user_cancelled' }),
      interactions: this.interactions.cancelAll(via),
    };
  }

  reset(via: string): void {
    this.interactions.cancelAll(via);
    this.operations.reset({ bookTerminalReason: 'session_replaced' });
    this.runGeneration++;
    this.replaceRuntime({}, via);
    this.replaceSnapshot(createAgentSessionSnapshot());
  }

  dispose(via = 'session_disposed'): void {
    this.interactions.cancelAll(via);
    this.operations.reset({ bookTerminalReason: 'session_disposed' });
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
    this.operations.cancel({ bookTerminalReason: 'session_replaced' });
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
    this.operations.cancel({ bookTerminalReason: 'session_replaced' });
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
      // Both launch-time paths carry this; in-TUI `/resume` silently did not, so a
      // user who wrote a plan, switched away and came back resumed a half-finished
      // objective with an empty task list and no notice that it had been dropped.
      plan: loaded.plan,
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
      attachments: request.userMessage.attachments,
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
        attachments: request.userMessage.attachments,
        checkpoint,
      } satisfies TurnCheckpointRecordData,
    } satisfies SessionRecord);

    // Expansion follows checkpoint capture so its side effects belong to this rewind boundary.
    const { contextMessage, sessionName } = await this.recordUserMessage(request);

    return { status: 'prepared', contextMessage, rewindTarget, sessionName };
  }

  async recordUserMessage(
    request: AgentSessionRecordUserRequest,
  ): Promise<{ contextMessage: string; sessionName: string }> {
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
        // Persisted explicitly: this record is written field by field, so without
        // it a resumed session forgets that the turn was a resolved command body
        // and the carried ledger would start treating it as the user's own words.
        derivedContent: request.userMessage.derivedContent,
        kind: request.userMessage.kind ?? 'conversation',
        agentNotifications: request.userMessage.agentNotifications,
        attachments: request.userMessage.attachments,
        fileObservations: request.userMessage.fileObservations,
      },
    } satisfies SessionRecord);
    if (request.timelineStore) request.onUserMessagePersisted?.();

    const sessionName = request.sessionName?.trim() || deriveSessionName(request.displayMessage);
    if (!request.sessionName?.trim()) {
      request.timelineStore?.patchMeta?.(request.sessionId, { name: sessionName });
    }

    return { contextMessage, sessionName };
  }

  async compact(request: AgentSessionCompactRequest): Promise<AgentSessionCompactOutcome> {
    const runtime = request.runtime ?? this.runtime;
    // Zero-Mem replaces routine compaction, not the loop's last-resort recovery.
    // An `auto` attempt reaching here has already been through the loop's own
    // gate, which under Zero-Mem leaves exactly one caller: the context-overflow
    // path, where replacing history with a checkpoint is the only way the run
    // continues at all. Warming an index there returns `skipped` and the turn
    // fails with the same overflow it started with.
    if (request.config.experimentalZeroMem && request.options.trigger !== 'auto') {
      const warmed = await runtime.zeroMemRuntime.warm(
        request.sourceHistory ?? request.history,
        request.sessionId ?? 'session',
        request.compactBoundaries,
      );
      return {
        result: {
          status: 'skipped',
          reason: 'disabled',
          message: `Zero-Mem index ready for ${warmed.indexedMessages} trace message${warmed.indexedMessages === 1 ? '' : 's'}; history was not replaced.`,
        },
      };
    }
    if (request.runContext) runtime.runAccounting.startRoot(request.runContext);
    const result = await this.compactRunner(request.config, request.history, {
      ...request.options,
      sessionId: request.sessionId,
      beforeModelCall: request.runContext
        ? (model) => {
            const requestCheck = request.options.beforeModelCall?.(model);
            if (requestCheck && !requestCheck.allowed) return requestCheck;
            return runtime.runAccounting.checkBeforeModelCall(request.runContext!.rootRunId, model);
          }
        : request.options.beforeModelCall,
      onUsage: request.runContext
        ? (usage, metadata) => {
            runtime.runAccounting.record(request.runContext!, usage, metadata);
            request.options.onUsage?.(usage, metadata);
          }
        : request.options.onUsage,
      onUsageMissing: request.runContext
        ? (metadata) => {
            runtime.runAccounting.markUsageUnknown(
              request.runContext!,
              metadata,
              'compaction_usage',
            );
            request.options.onUsageMissing?.(metadata);
          }
        : request.options.onUsageMissing,
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
    // `run()` is a public shared lifecycle boundary; direct hosts may not have
    // passed through config loading, so reject unavailable modes before run ID,
    // accounting, ambient, or runtime setup.
    assertHarnessModeAvailable(request.config.settings.harness.mode);
    // Selection is part of that same pre-setup gate. An unknown or unavailable
    // workflow must fail the run rather than degrade to a silent baseline, and
    // it must fail before accounting and ambient state exist — a throw after
    // those are recorded would leave the host without a terminal event.
    const workflowSelection = selectWorkflow(builtinWorkflowRegistry(), {
      mode: request.config.settings.harness.mode,
      runOverride: request.config.harnessWorkflowOverride,
      settingsWorkflow: request.config.settings.harness.workflow,
    });
    const { callbacks } = request;
    const runGeneration = ++this.runGeneration;
    let usage: Usage | null = null;
    let emittedError: string | undefined;
    let terminalOutcome: AgentTerminalOutcome | undefined;
    let streamedAssistantText = '';
    const runContext =
      request.runContext ??
      createAgentRunContext({
        sessionId: request.sessionId,
        runId: request.options?.userMessageId,
        source: request.source,
        resumedFromRunId: request.resumedFromRunId,
      });
    const runtime = request.options?.runtime ?? this.runtime;
    let effectiveHistory = request.history;
    const usesZeroMem = request.config.experimentalZeroMem && !request.options?.isSubagent;
    const loopConfig = usesZeroMem
      ? { ...request.config, autoCompactEnabled: false }
      : request.config;
    runtime.runAccounting.startRoot(runContext, request.maxBudgetUsd);
    const effectiveConfig = request.options?.modelOverride
      ? { ...loopConfig, model: request.options.modelOverride }
      : loopConfig;
    const ambient = runtime.recordRunAmbientSnapshot(
      runContext.runId,
      createRunAmbientSnapshot(effectiveConfig, request.registry, {
        permissionMode: request.mode,
        commands: request.options?.commands,
        systemPromptAppend: request.options?.systemPromptAppend,
        hideAgents: request.options?.hideAgents,
        planMode: request.mode === 'plan',
        allowedTools: request.options?.allowedTools,
      }),
    );
    let harnessObserver = request.harnessObserver;
    let harnessContext = request.harnessContext;
    let harnessPreparationError: string | undefined;
    const harnessMode = request.config.settings.harness.mode;
    const workflowProvenance: WorkflowProvenance = {
      decision: workflowSelection.decision,
      registryVersion: workflowSelection.registryVersion,
      registryDigest: workflowSelection.registryDigest,
      overrideScope: workflowSelection.overrideScope,
      definitionDigest: workflowSelection.resolved?.definitionDigest,
      policyRenderVersion: workflowSelection.resolved?.policyRenderVersion,
      policySection: workflowSelection.resolved?.policySection,
      clamps: workflowSelection.resolved?.clamps.map((entry) => ({
        field: entry.field,
        reason: entry.reason,
      })),
      activeFieldCount: workflowSelection.resolved?.complexity.activeFieldCount,
      renderedChars: workflowSelection.resolved?.complexity.renderedChars,
      requestedExtraCalls: workflowSelection.resolved?.complexity.requestedExtraCalls,
    };
    if (!harnessObserver && harnessMode !== 'off') {
      try {
        const coordinator =
          request.harnessCoordinator ??
          this.harnessCoordinator ??
          createHarnessCoordinator(harnessMode, { workspace: request.config.workspace });
        const preparePromise = coordinator.prepareRun({
          mode: harnessMode,
          workspace: request.config.workspace,
          identity: {
            workspaceId: workspaceIdentity(request.config.workspace),
            rootRunId: runContext.rootRunId,
            runId: runContext.runId,
            parentRunId: runContext.parentRunId,
            resumedFromRunId: runContext.resumedFromRunId,
            sessionId: runContext.sessionId,
          },
          workflow: workflowProvenance,
          metadata: {
            mode: 'observe',
            model: ambient.model.requestedModel,
            provider: ambient.model.provider,
            runtimeFingerprint: ambient.fingerprint,
            environmentFingerprint: ambient.runtime.environmentFingerprint,
            toolSurfaceFingerprint: ambient.tools.fingerprint,
            contextCapabilitiesVersion: 'context-v1',
            settingsFingerprint: ambient.settings.fingerprint,
          },
        });
        // A hung evidence filesystem must degrade observation, not stall the run.
        const prepared = await Promise.race([
          preparePromise,
          new Promise<null>((resolvePrepare) => {
            const timer = setTimeout(() => resolvePrepare(null), HARNESS_PREPARE_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        if (prepared === null) {
          harnessPreparationError = 'observer_preparation_timeout';
          void preparePromise
            .then((late) => {
              if (late.status === 'prepared') void late.observer.close();
            })
            .catch(() => undefined);
        } else if (prepared.status === 'prepared') {
          harnessObserver = prepared.observer;
          harnessContext = prepared.context;
        }
      } catch (error) {
        // Observation is explicitly best-effort for the user task. The terminal
        // callback below reports the degraded evidence state.
        harnessPreparationError =
          error instanceof Error ? error.message.slice(0, 256) : 'observer-init-failed';
      }
      // A failed or timed-out preparation leaves no harness context, so the
      // selected workflow's guidance never reaches the prompt and the run
      // proceeds as baseline. That is the intended direction — a workflow whose
      // evidence stream does not exist must not silently change behavior — but
      // the reversion is reported rather than hidden.
      if (harnessPreparationError && workflowSelection.resolved?.policySection) {
        harnessPreparationError = `${harnessPreparationError}; workflow_policy_not_applied`;
      }
    }
    const finalizeOutcome = (outcome: AgentTerminalOutcome): AgentTerminalOutcome => {
      if (!terminalOutcome) {
        terminalOutcome = outcome;
        callbacks.onTerminal?.(outcome);
      }
      return terminalOutcome;
    };
    // The host notification is harness-only surface; a throwing host callback
    // must degrade observation reporting, never the user run's outcome.
    const notifyHarnessFinalized = (result: HarnessObserverFlushResult): void => {
      try {
        callbacks.onHarnessFinalized?.(result);
      } catch {
        /* contained */
      }
    };
    const finalizeHarness = async (outcome: AgentTerminalOutcome): Promise<void> => {
      const result: FinalizeRunInput = {
        status: outcome.status === 'timed_out' ? 'timed-out' : outcome.status,
        reasonCode: harnessPreparationError ? 'observer_initialization_failed' : outcome.reason,
      };
      if (!harnessObserver) {
        if (harnessMode !== 'off') {
          notifyHarnessFinalized({
            flushed: false,
            status: 'failed',
            droppedEventCount: 0,
            incomplete: true,
            failureReason: harnessPreparationError ?? 'observer-unavailable',
            storageErrors: harnessPreparationError ? [harnessPreparationError] : [],
          });
        }
        return;
      }
      try {
        const finalized =
          request.harnessFinalize === false
            ? await harnessObserver.flush()
            : harnessObserver.finalize
              ? await harnessObserver.finalize(result)
              : await harnessObserver.close();
        notifyHarnessFinalized({
          ...finalized,
          failureReason: harnessPreparationError ?? finalized.failureReason,
          incomplete: Boolean(harnessPreparationError) || finalized.incomplete,
        });
      } catch (error) {
        notifyHarnessFinalized({
          flushed: false,
          status: 'failed',
          droppedEventCount: 0,
          incomplete: true,
          failureReason:
            error instanceof Error ? error.message.slice(0, 256) : 'observer-finalize-failed',
        });
      }
    };
    this.replaceSnapshot(createAgentSessionSnapshot());
    const emit = (event: AgentEvent) => {
      if (runGeneration === this.runGeneration) this.emit(event, callbacks.onEvent);
      else callbacks.onEvent(event);
    };
    emit({ type: 'run_started', context: runContext, ambient });
    emit({ type: 'system', model: effectiveConfig.model, cwd: request.config.workspace });
    emit({ type: 'session', sessionId: request.sessionId });
    const unsubscribeShellEvents = runtime.shellManager.subscribe((event) => emit(event));

    try {
      if (usesZeroMem) {
        const contextLimit = resolveContextLimit(request.config);
        const prepared = await runtime.zeroMemRuntime.prepare({
          transcript: request.transcript ?? request.history,
          query: request.options?.displayMessage ?? request.prompt,
          sessionId: request.sessionId,
          compactBoundaries: request.compactBoundaries,
          currentMessageId: request.options?.userMessageId,
          timestamp: request.options?.userMessageTimestamp,
          maxContextTokens: Math.max(1, Math.min(32_000, Math.floor(contextLimit * 0.5))),
        });
        effectiveHistory = prepared.history;
      }
      /**
       * Append a whole-plan snapshot. Both todo and task writers call this, and
       * the loader takes the last `plan` record, so an interleaved write cannot
       * leave half a plan on disk. The signature check keeps a per-wave callback
       * from appending an identical record on every tool result.
       */
      /** Inclusive usage already written to the timeline for this run. */
      let persistedUsage: Usage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
      let lastPlanSignature = '';
      const persistPlan = (): void => {
        if (!request.timelineStore) return;
        const data: PlanRecordData = {
          version: 1,
          todos: runtime.todos.map((todo) => ({
            content: todo.content,
            status: todo.status,
            activeForm: todo.activeForm,
          })),
          tasks: runtime.tasks,
        };
        const signature = JSON.stringify(data);
        if (signature === lastPlanSignature) return;
        lastPlanSignature = signature;
        request.timelineStore.append(request.sessionId, {
          type: 'plan',
          timestamp: Date.now(),
          data,
        } satisfies SessionRecord);
      };

      const baseLoopCallbacks: AgentLoopCallbacks = {
        onText: (content: string) => {
          streamedAssistantText += content;
          emit({ type: 'text', content });
        },
        onReasoning: (content: string) => emit({ type: 'reasoning', content }),
        onAttemptDiscarded: () => {
          // Also unwind the partial-output tally: the abandoned text is not
          // output the run produced, and counting it would mislabel a later
          // cancellation as having delivered something.
          streamedAssistantText = '';
          emit({ type: 'attempt_discarded', reason: 'empty_response' });
        },
        onToolCall: (toolCall: ToolCall) => emit({ type: 'tool_use', toolCall }),
        onToolResult: (toolResult: ToolResult) => emit({ type: 'tool_result', toolResult }),
        onError: (error: string) => {
          emittedError = error;
          emit({ type: 'error', error });
        },
        onTurnStart: callbacks.onTurnStart,
        onDone: callbacks.onDone ?? (() => {}),
        onTerminal: (outcome) => {
          finalizeOutcome(outcome);
        },
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
        onUsage: (nextUsage, metadata) => {
          usage = nextUsage;
          // Persist the INCLUSIVE delta, not just this response.
          //
          // Managed agents route their usage to the in-memory `RunAccounting` only
          // (`manager.ts` accumulates onto the agent record) and Task subagents
          // discard it outright (`subagent.ts` passes `onUsage: () => {}`), so this
          // seam - the only writer of the `usage` record - persisted root spend
          // alone. A run that spent $5 at the root and $45 across a fan-out
          // restored a $5 carry and was authorised the whole fan-out again, which
          // is precisely the delegated money a budget is supposed to bound.
          //
          // `RunAccounting` already tracks every execution under this root in
          // process, so the honest number is its inclusive total minus whatever has
          // already been written. Cost is still not stored: it is re-derived from
          // tokens at bootstrap, deliberately at the most expensive model involved.
          const inclusive = request.runContext
            ? runtime.runAccounting.snapshotRoot(request.runContext.rootRunId).inclusiveUsage
            : null;
          const recordUsage = inclusive ? subtractUsage(inclusive, persistedUsage) : nextUsage;
          if (inclusive) persistedUsage = inclusive;
          if (recordUsage.totalTokens <= 0 && recordUsage.promptTokens <= 0) return;
          // `RunAccounting.roots` is rebuilt with the process, so without a durable
          // record forty restarts is forty independent budget caps. The 'usage'
          // SessionRecord type was already declared with no writers; this is it.
          // Cost is not stored — pricing can change between processes, so it is
          // re-derived from tokens at bootstrap.
          if (request.isCurrent?.() !== false) {
            request.timelineStore?.append(request.sessionId, {
              type: 'usage',
              timestamp: Date.now(),
              data: {
                version: 1,
                usage: recordUsage,
                requestedModel: metadata?.requestedModel,
                responseModel: metadata?.responseModel,
              },
            } satisfies SessionRecord);
          }
          callbacks.onUsage?.(nextUsage, metadata);
        },
        getMode: callbacks.getMode,
        onModeChange: callbacks.onModeChange,
        onPlanHandoff: callbacks.onPlanHandoff,
        // Kept under Zero-Mem: `loopConfig` already sets `autoCompactEnabled:
        // false`, which gates the loop's two routine compaction paths, and the
        // context-overflow path at the bottom of the turn is deliberately not
        // gated by it. Nulling the callback disabled that recovery too.
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
              reasoningContent: message.reasoningContent,
              providerMetadata: message.providerMetadata,
              kind: message.kind ?? 'conversation',
              toolCalls: message.toolCalls,
              toolResults: message.toolResults,
              fileObservations: message.fileObservations,
            },
          } satisfies SessionRecord);
          callbacks.onAssistantMessageComplete?.(message);
        },
        // The plan is persisted from here because this is the only seam that sees
        // every mutation with the session store in scope.
        onTodos: (todos) => {
          if (request.isCurrent?.() !== false) persistPlan();
          callbacks.onTodos?.(todos);
        },
        onTasks: () => {
          if (request.isCurrent?.() !== false) persistPlan();
        },
        /**
         * Persist a user message the loop authored rather than the host — a
         * continuation, a work-state refresh. Hosts write the user message before
         * `send`, so nothing else records these and a resumed session would show
         * assistant turns answering questions that were never asked.
         *
         * `UserPromptSubmit` hooks and memory capture are deliberately skipped:
         * this is the agent talking to itself, not a person submitting a prompt.
         */
        onUserMessageAppended: (message) => {
          if (request.isCurrent?.() === false) return;
          request.timelineStore?.append(request.sessionId, {
            type: 'user',
            eventId: message.id,
            timestamp: message.timestamp,
            data: {
              id: message.id,
              content: message.content,
              kind: message.kind ?? 'conversation',
              includeInContext: message.includeInContext ?? true,
            },
          } satisfies SessionRecord);
        },
        onRetry: callbacks.onRetry,
        onStreamStall: callbacks.onStreamStall,
        onStreamResume: callbacks.onStreamResume,
        onPersistPermissionRule: callbacks.onPersistPermissionRule,
        onHookEvent: callbacks.onHookEvent,
        onAgentEvent: (event: AgentRuntimeEvent) => emit(event),
      };
      const loopCallbacks = harnessObserver
        ? wrapAgentLoopCallbacks(baseLoopCallbacks, {
            observer: harnessObserver,
            runId: runContext.runId,
          })
        : baseLoopCallbacks;
      const messages = await this.runLoop(
        loopConfig,
        request.registry,
        request.prompt,
        effectiveHistory,
        loopCallbacks,
        request.mode,
        {
          ...request.options,
          runtime,
          runContext,
          harnessContext: harnessContext ?? request.options?.harnessContext,
          harnessObserver: harnessObserver
            ? { observer: harnessObserver, runId: runContext.runId }
            : undefined,
          resolveAttachment:
            request.options?.resolveAttachment ??
            (request.timelineStore?.readImageAttachment
              ? (attachment) =>
                  request.timelineStore!.readImageAttachment!(request.sessionId, attachment)
              : undefined),
          signal: request.signal,
        },
      );
      const partialOutput =
        streamedAssistantText.length > 0 ||
        messages.slice(effectiveHistory.length).some((message) => message.role === 'assistant');
      const outcome = finalizeOutcome(
        terminalOutcome ??
          (request.signal?.aborted
            ? classifyAbortReason(request.signal.reason, partialOutput)
            : emittedError
              ? createTerminalOutcome('failed', 'provider_error', {
                  partialOutput,
                  message: emittedError,
                })
              : createTerminalOutcome('completed', 'normal_completion', {
                  partialOutput: false,
                })),
      );
      emit({
        type: 'result',
        messages,
        usage,
        sessionId: request.sessionId,
        outcome,
        runContext,
      });
      emit({ type: 'terminal', outcome, runContext });
      await finalizeHarness(outcome);
      return messages;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (emittedError !== message) emit({ type: 'error', error: message });
      const partialOutput = streamedAssistantText.length > 0;
      const outcome = finalizeOutcome(
        terminalOutcome ??
          (request.signal?.aborted
            ? classifyAbortReason(request.signal.reason, partialOutput)
            : classifyRuntimeError(error, partialOutput)),
      );
      emit({ type: 'terminal', outcome, runContext });
      await finalizeHarness(outcome);
      throw error;
    } finally {
      unsubscribeShellEvents();
      emit({ type: 'done' });
      if (harnessObserver && !terminalOutcome) {
        await finalizeHarness(
          createTerminalOutcome('interrupted', 'missing_terminal', {
            partialOutput: streamedAssistantText.length > 0,
          }),
        );
      }
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
