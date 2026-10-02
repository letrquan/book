import type { AgentRuntimeEvent } from '../agents/types.js';
import { runAgentLoop } from '../agent/loop.js';
import {
  applyCompactResult,
  judgeCompaction,
  judgedResult,
  resolveCompactBudgets,
  runCompact,
  runPostCompactHooks,
  type RunCompactOptions,
} from '../agent/compact.js';

import { runSessionEnd, runSessionStart } from './lifecycle.js';
import type { SessionLifecycleOptions } from './lifecycle.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { AgentLoopCallbacks, ProviderResponseMetadata } from '../types/providers.js';
import type {
  CompactBoundary,
  CompactRecordData,
  CompactResult,
  PlanRecordData,
  PreparedCompaction,
  RewindSnapshotCaptureResult,
  RewindSnapshotStoreInterface,
  RewindTarget,
  SessionRecord,
  SessionStoreInterface,
  TurnCheckpointRecordData,
  UsageRecordData,
} from '../types/sessions.js';
import type { Message, Usage } from '../types/messages.js';
import { createAgentRunContext, type AgentRunContext, type AgentRunSource } from '../types/runs.js';
import {
  classifyAbortReason,
  classifyRuntimeError,
  createTerminalOutcome,
  type AgentTerminalOutcome,
} from '../types/terminal.js';
import type {
  PermissionDecision,
  ToolCall,
  ToolResult,
  UserQuestionResponse,
} from '../types/tools.js';
import { collectAtMentionObservations, expandUserInput } from '../input/input-expansion.js';
import { observationKey } from '../tools/file-provenance.js';
import { createDebugLogger } from '../debug-log.js';
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
import { isSpendlessUsage } from './run-accounting.js';
import { SessionRuntime, type SessionRuntimeOptions } from './runtime.js';
import { createRunAmbientSnapshot } from './run-ambient.js';
import { deriveSessionName } from './name.js';

export type AgentLoopRunner = typeof runAgentLoop;

const log = createDebugLogger('session:usage');

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
  beforeToolExecution?: AgentLoopCallbacks['beforeToolExecution'];
  onCompact?: AgentLoopCallbacks['onCompact'];
  prepareCompact?: AgentLoopCallbacks['prepareCompact'];
  commitCompact?: AgentLoopCallbacks['commitCompact'];
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
}

export interface AgentSessionRunRequest {
  config: AgentConfig;
  registry: ToolRegistry;
  prompt: string;
  history: Message[];
  compactBoundaries?: readonly CompactBoundary[];
  mode?: PermissionMode;
  sessionId: string;
  timelineStore?: Pick<SessionStoreInterface, 'append'> &
    Partial<Pick<SessionStoreInterface, 'readImageAttachment'>>;
  callbacks: AgentSessionRunCallbacks;
  /** Frozen attribution for this request; created once when omitted. */
  runContext?: AgentRunContext;
  /** Optional hard USD ceiling for this root run. */
  maxBudgetUsd?: number;
  source?: AgentRunSource;
  resumedFromRunId?: string;
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
  sessionName?: string;
  snapshotStore?: Pick<RewindSnapshotStoreInterface, 'capture' | 'captureAsync'>;
  timelineStore?: SessionTimelineStore;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
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
  /** Optional hard USD ceiling for this root run. */
  maxBudgetUsd?: number;
  source?: AgentRunSource;
  resumedFromRunId?: string;
  /** Managed-continuation linkage: the originating root and parent execution run. */
  rootRunId?: string;
  parentRunId?: string;
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
  compactBoundaries?: readonly CompactBoundary[];
  sessionId?: string;
  transcriptOrdinal: number;
  options: Omit<RunCompactOptions, 'sessionId'>;
  runContext?: AgentRunContext;
  runtime?: SessionRuntime;
  timelineStore?: Pick<SessionStoreInterface, 'append'>;
  isCurrent?: () => boolean;
  /**
   * Provider usage from the compaction's own model calls (the summarizer and, in
   * the deferred flow, the judge).
   *
   * Run accounting already charges these to the root run, but a host that keeps
   * its own session bill never heard about them, so `/cost` named a figure below
   * what the session had spent (#370).
   */
  onUsage?: (usage: Usage) => void;
  onCommitted?: (
    result: Extract<CompactResult, { status: 'compacted' }>,
    boundary: CompactBoundary,
  ) => void;
}

export interface AgentSessionCompactOutcome {
  result: CompactResult;
  boundary?: CompactBoundary;
}

/** `prepareCompact`'s answer: a compaction awaiting its commit, or the reason there is none. */
export type AgentSessionPrepareCompactOutcome =
  | { status: 'prepared'; prepared: PreparedCompaction }
  | { status: 'skipped' | 'failed'; result: CompactResult };

export interface AgentSessionCommitCompactRequest {
  prepared: PreparedCompaction;
  /** The history as it stands now; must extend the snapshot by message ids. */
  history: readonly Message[];
  config: AgentConfig;
  sessionId?: string;
  transcriptOrdinal: number;
  options: Omit<RunCompactOptions, 'sessionId' | 'trigger'>;
  runContext?: AgentRunContext;
  runtime?: SessionRuntime;
  timelineStore?: Pick<SessionStoreInterface, 'append'>;
  isCurrent?: () => boolean;
  onUsage?: AgentSessionCompactRequest['onUsage'];
  onCommitted?: AgentSessionCompactRequest['onCommitted'];
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
  /** The deferred checkpoint's judge; a test double stands in for the model call. */
  judgeRunner?: typeof judgeCompaction;
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

/** Where a root's `usage` records go, and whether that place can still be written. */
export interface AgentSessionUsageTarget {
  sessionId: string;
  /** Absent for a run with nowhere to write; its spend is left for a later writer. */
  timelineStore?: Pick<SessionStoreInterface, 'append'>;
  /** False once the session has moved on, which is what stops a stale run writing. */
  isCurrent?: () => boolean;
}

/**
 * Shared owner for agent-loop execution, interaction promises, and operation lifetime.
 */
export class AgentSession {
  readonly interactions = new AgentInteractionController();
  readonly operations = new AgentSessionOperations();
  private readonly runLoop: AgentLoopRunner;
  private readonly compactRunner: typeof runCompact;
  private readonly judgeRunner: typeof judgeCompaction;
  private readonly postCompactHooksRunner: typeof runPostCompactHooks;
  private readonly sessionStartRunner: typeof runSessionStart;
  private readonly sessionEndRunner: typeof runSessionEnd;
  private snapshot = createAgentSessionSnapshot();
  private readonly listeners = new Set<AgentSessionListener>();
  private runGeneration = 0;
  private lifecycleStartedSessionId?: string;
  private lifecycleStart?: Promise<void>;
  private lifecycleEndedSessionId?: string;
  private lifecycleEnd?: Promise<void>;
  private runtime: SessionRuntime;
  private readonly registryFactory?: AgentSessionDependencies['registryFactory'];
  /**
   * Every root this session has run, and where its spend is written (#336).
   *
   * `onUsage` persists what a run's own responses report, which leaves two
   * shapes of spend with nowhere to go: whatever a managed child spent after the
   * root's last response, and a root whose model was never called at all — a
   * `/review` the host performed. Neither reaches a store on the way out, so the
   * process ends holding tokens no later process restores, and `--max-budget-usd`
   * re-authorises them. Registered by `run()` and by hosts that create a root
   * themselves (`trackRunUsage`), and drained by `dispose`.
   */
  private readonly usageTargets = new Map<
    string,
    { target: AgentSessionUsageTarget; runtime: SessionRuntime }
  >();

  constructor(dependencies: AgentSessionDependencies = {}) {
    this.runLoop = dependencies.runLoop ?? runAgentLoop;
    this.compactRunner = dependencies.compactRunner ?? runCompact;
    this.judgeRunner = dependencies.judgeRunner ?? judgeCompaction;
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

  /**
   * Stop the outgoing runtime, write what it spent, and install its replacement.
   *
   * The one place a runtime goes away, so it is where its spend is written: the
   * children are stopped first, so a managed agent charged during the teardown is
   * in the figures the flush reads, and its targets are released with it rather
   * than walked by every later sweep. A `/resume` or `/rewind` that reached the
   * replacement without this left the outgoing runtime's unpersisted spend behind
   * with it, and the resumed session restored a carry short of what it had cost.
   */
  replaceRuntime(options: SessionRuntimeOptions = {}, via = 'session_transition'): SessionRuntime {
    const outgoing = this.runtime;
    outgoing.dispose(via);
    this.releaseRunUsage(outgoing);
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
    // Children first, then the store: a managed agent is charged as it is
    // stopped, and its spend is in the figures the flush writes. A child still
    // unwinding on another turn — the abort is not the loop's return — is past a
    // synchronous dispose, which is the one thing it cannot wait for.
    this.runtime.dispose(via);
    this.releaseRunUsage(this.runtime);
  }

  /**
   * Record that `rootRunId`'s spend belongs in `target`, so the flush at the end
   * of the session can persist what no response of that root reported.
   *
   * `run()` registers every root it runs. A host that starts a root itself and
   * never sends a turn — a print-mode `/review`, whose reviewer agents spend
   * under a root the root model is never asked for — registers it here, or its
   * spend leaves the process with it. Re-registering a root replaces the target,
   * so a run under an existing root keeps writing to where that root writes.
   */
  trackRunUsage(rootRunId: string, target: AgentSessionUsageTarget): void {
    this.usageTargets.set(rootRunId, { target, runtime: this.runtime });
  }

  /**
   * Register a compaction's root the way `run` registers a turn's.
   *
   * A compactor's model calls are charged to a run context, and no turn of that
   * root may ever run — a manual `/compact` mints a root of its own, and a send
   * cancelled between the host's auto-compact in `beforePrepare` and `run()`
   * never reaches `run`'s own registration. Without this, that spend is charged
   * to a root no flush knows about, and leaves the process unwritten.
   */
  private registerUsageTarget(
    request: Pick<
      AgentSessionCompactRequest | AgentSessionCommitCompactRequest,
      'runContext' | 'timelineStore' | 'sessionId'
    >,
    runtime: SessionRuntime,
  ): void {
    if (!request.runContext || !request.timelineStore || !request.sessionId) return;
    this.usageTargets.set(request.runContext.rootRunId, {
      target: { sessionId: request.sessionId, timelineStore: request.timelineStore },
      runtime,
    });
  }

  /**
   * Write what a root has spent and no `usage` record covers, as one record
   * named after the response the host is being told about.
   *
   * The `onUsage` writer, and the reason it is one function rather than a
   * closure: every host reaches it the same way, so the watermark it moves and
   * the ones `flushRunUsage` moves are the same figure, written once. Cost is
   * not stored — pricing changes between processes, so it is re-derived from the
   * tokens at bootstrap, deliberately at the most expensive model involved.
   *
   * The watermark moves only where a record really lands. A turn that reaches no
   * store — a session that moved on, a run with nowhere to write — leaves its
   * spend unpersisted instead, for the next writer under this root to record;
   * counted as written, no record would ever hold it and no restart would
   * restore it.
   */
  private persistReportedUsage(
    rootRunId: string,
    reported: Usage,
    metadata: ProviderResponseMetadata | undefined,
  ): void {
    const entry = this.usageTargets.get(rootRunId);
    if (!entry) return;
    const { target, runtime } = entry;
    const recordUsage = runtime.runAccounting.peekUnpersistedUsage(rootRunId) ?? reported;
    if (isSpendlessUsage(recordUsage)) return;
    const store = target.isCurrent?.() === false ? undefined : target.timelineStore;
    if (!store) return;
    // `RunAccounting.roots` is rebuilt with the process, so without a durable
    // record forty restarts is forty independent budget caps. The 'usage'
    // SessionRecord type was already declared with no writers; this is it.
    store.append(target.sessionId, {
      type: 'usage',
      timestamp: Date.now(),
      data: {
        version: 1,
        usage: recordUsage,
        // The response that triggered this write, which is not the same thing as
        // the models the delta covers: a dearer child may have finished before it.
        requestedModel: metadata?.requestedModel,
        responseModel: metadata?.responseModel,
        models: runtime.runAccounting.modelsFor(rootRunId),
      },
    } satisfies SessionRecord);
    runtime.runAccounting.commitPersistedUsage(rootRunId);
  }

  /**
   * Write what a root has spent and no `usage` record covers, if it can be
   * written at all.
   *
   * One record for the whole delta, so what this writes and what it then commits
   * are the same figure by construction. It is named after the dearest model the
   * root has spent on rather than after any one of them: `carriedCostUsd`
   * (`headless.ts`) prices a restored carry at the most expensive model in
   * `carriedModels` regardless of which record said what, and the records do not
   * attribute tokens to models, so one name is all the restored pool can be said
   * to have cost.
   *
   * `requireCurrent` is the end of a run, where the target's own currency still
   * decides whether it is the session to write to. The end-of-session sweep does
   * not pass it: by then every operation lease has been released, so consulting
   * one would skip every target the TUI ever registered — which is where a
   * background agent's late spend goes.
   *
   * A store that throws is contained here. This runs from a run's `finally` and
   * from the runtime swap, so an escaping filesystem error would replace a
   * completed run's outcome, abort the sweep part-way, and leave the session
   * installed on a disposed runtime. Nothing was written, so the watermark stays
   * where it was and the spend remains owed to the next writer that can.
   */
  private flushRunUsage(rootRunId: string, requireCurrent: boolean): void {
    const entry = this.usageTargets.get(rootRunId);
    if (!entry) return;
    const { target, runtime } = entry;
    const recordUsage = runtime.runAccounting.peekUnpersistedUsage(rootRunId);
    if (!recordUsage || isSpendlessUsage(recordUsage)) return;
    const store =
      requireCurrent && target.isCurrent?.() === false ? undefined : target.timelineStore;
    if (!store) return;
    // `RunAccounting.roots` is rebuilt with the process, so without a durable
    // record forty restarts is forty independent budget caps. Cost is not stored
    // — pricing changes between processes, so it is re-derived from the tokens
    // at bootstrap, deliberately at the most expensive model involved.
    try {
      store.append(target.sessionId, {
        type: 'usage',
        timestamp: Date.now(),
        data: {
          version: 1,
          usage: recordUsage,
          requestedModel: runtime.runAccounting.dearestModel(rootRunId),
          models: runtime.runAccounting.modelsFor(rootRunId),
        } satisfies UsageRecordData,
      });
      runtime.runAccounting.commitPersistedUsage(rootRunId);
    } catch (error) {
      log.warn('usage record could not be appended; spend left unpersisted', {
        rootRunId,
        sessionId: target.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Write what the roots of a runtime that is going away spent, and drop their
   * targets: nothing can be charged to a root whose runtime is gone, so keeping
   * its target would only make every later sweep walk it.
   *
   * Whatever lease a target carries is ignored — a `send()` lease has been
   * released by the time any of these runs, so consulting one would skip every
   * target the TUI ever made.
   */
  private releaseRunUsage(runtime: SessionRuntime): void {
    for (const [rootRunId, entry] of [...this.usageTargets.entries()]) {
      if (entry.runtime !== runtime) continue;
      this.flushRunUsage(rootRunId, false);
      this.usageTargets.delete(rootRunId);
    }
  }

  async startLifecycle(
    config: AgentConfig,
    sessionId: string,
    source: Parameters<typeof runSessionStart>[2],
    options?: SessionLifecycleOptions,
  ): Promise<void> {
    if (this.lifecycleStartedSessionId === sessionId) {
      await this.lifecycleStart?.catch(() => undefined);
      return;
    }
    this.lifecycleStartedSessionId = sessionId;
    this.lifecycleStart = this.sessionStartRunner(config, sessionId, source, options);
    await this.lifecycleStart;
  }

  // A second call for a session that is already ending waits for the SessionEnd in flight
  // instead of returning at once, which let a second exit or a `/clear` racing an exit move on
  // while the hooks were still running. The first caller reports a failed SessionEnd; a caller that
  // only waited for it does not report the same failure a second time.
  async endLifecycle(
    config: AgentConfig,
    sessionId: string,
    reason: Parameters<typeof runSessionEnd>[2],
    options?: SessionLifecycleOptions,
  ): Promise<void> {
    if (this.lifecycleEndedSessionId === sessionId) {
      await this.lifecycleEnd?.catch(() => undefined);
      return;
    }
    this.lifecycleEndedSessionId = sessionId;
    this.lifecycleEnd = this.sessionEndRunner(config, sessionId, reason, options);
    await this.lifecycleEnd;
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
    // The resumed conversation's tool history lives on the runtime, so install
    // it here rather than relying on `onTransition` to rebuild one: a host that
    // projects the conversation without one would otherwise lose the record the
    // next memory write reads to decide whether the session saw external content.
    this.reset('session-resume');
    this.replaceRuntime({ history: bootstrap.transcript ?? bootstrap.history }, 'session-resume');
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
    // One pass over what the user typed: a `!cmd` line runs, an `@path` mention
    // is inlined, and neither is found in the other's output. A mentioned file's
    // lines must never run as commands, and a command's output must never be read
    // as the user's own mentions (#261 review).
    const expandShellInput =
      request.contextMessage === undefined && request.expandShellInput !== false;
    const contextMessage =
      request.contextMessage !== undefined
        ? request.contextMessage
        : await expandUserInput(request.displayMessage, request.config.workspace, {
            expandShell: expandShellInput,
            signal: request.signal,
          });
    request.userMessage.contextContent =
      contextMessage === request.displayMessage ? undefined : contextMessage;
    request.userMessage.fileObservations =
      request.contextMessage === undefined
        ? collectAtMentionObservations(
            request.displayMessage,
            request.config.workspace,
            request.userMessage.id,
            expandShellInput,
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
    if (request.runContext) runtime.runAccounting.startRoot(request.runContext);
    this.registerUsageTarget(request, runtime);
    const result = await this.compactRunner(request.config, request.history, {
      ...this.accountedOptions(request.options, request.runContext, runtime, request.onUsage),
      sessionId: request.sessionId,
    });
    if (result.status !== 'compacted') return { result };
    if (request.isCurrent?.() === false) return { result };
    return this.commitCompactResult(result, request);
  }

  /**
   * Deferred compaction (`plans/async-compaction-plan.md`): the reducer half of
   * `compact`, on a snapshot, without the record, the boundary or the
   * PostCompact hooks. PreCompact hooks still run -- they are the refusal
   * point, and the suspect-input scan they see is the snapshot's.
   */
  async prepareCompact(
    request: AgentSessionCompactRequest,
  ): Promise<AgentSessionPrepareCompactOutcome> {
    const runtime = request.runtime ?? this.runtime;
    if (request.runContext) runtime.runAccounting.startRoot(request.runContext);
    this.registerUsageTarget(request, runtime);
    const result = await this.compactRunner(request.config, request.history, {
      ...this.accountedOptions(request.options, request.runContext, runtime, request.onUsage),
      sessionId: request.sessionId,
    });
    if (result.status !== 'compacted') return { status: result.status, result };
    return {
      status: 'prepared',
      prepared: {
        snapshot: [...request.history],
        result,
        trigger: request.options.trigger,
        preContextTokens: request.options.preContextTokens,
      },
    };
  }

  /**
   * The other half: apply a prepared compaction to the history as it stands,
   * ask the judge whether the checkpoint holds what the steps taken meanwhile
   * relied on, and only then write the record and run the hooks. A rejected
   * or inapplicable checkpoint is dropped, and the caller falls back to a
   * synchronous compaction.
   */
  async commitCompact(
    request: AgentSessionCommitCompactRequest,
  ): Promise<AgentSessionCompactOutcome> {
    const runtime = request.runtime ?? this.runtime;
    const { prepared } = request;
    const applied = applyCompactResult(prepared.result, prepared.snapshot, request.history, {
      toolResultMaxTokens: resolveCompactBudgets(request.config).retainedToolResultMaxTokens,
    });
    if (!applied) {
      return {
        result: {
          status: 'skipped',
          reason: 'not-applicable',
          message: 'The history no longer extends the snapshot the reducer read.',
        },
      };
    }
    const snapshotIds = new Set(prepared.snapshot.map((message) => message.id));
    const delta = request.history.filter((message) => !snapshotIds.has(message.id));
    // The judge spends too, charged to the same root as the reducer it reviews.
    if (request.runContext) runtime.runAccounting.startRoot(request.runContext);
    this.registerUsageTarget(request, runtime);
    const accounted = this.accountedOptions(
      { ...request.options, trigger: prepared.trigger },
      request.runContext,
      runtime,
      request.onUsage,
    );
    const judge = await this.judgeRunner(request.config, applied, delta, {
      signal: accounted.signal,
      provider: accounted.provider,
      beforeModelCall: accounted.beforeModelCall,
      onUsage: accounted.onUsage,
      onUsageMissing: accounted.onUsageMissing,
    });
    // A cancellation that lands during the judge call is a stop, not an
    // inconclusive verdict: the synchronous path writes nothing under the
    // same abort, and a checkpoint stamped as judged that nobody judged must
    // not be what a resume starts from.
    if (accounted.signal?.aborted || judge.note === 'aborted') {
      return { result: { status: 'failed', reason: 'aborted', error: 'Compaction aborted.' } };
    }
    const result = judgedResult(applied, judge);
    if (result.status !== 'compacted') return { result };
    if (request.isCurrent?.() === false) return { result };
    return this.commitCompactResult(result, {
      config: request.config,
      history: request.history,
      sessionId: request.sessionId,
      transcriptOrdinal: request.transcriptOrdinal,
      options: { ...request.options, trigger: prepared.trigger },
      runContext: request.runContext,
      runtime,
      timelineStore: request.timelineStore,
      isCurrent: request.isCurrent,
      onCommitted: request.onCommitted,
    });
  }

  /**
   * The compactor's model calls charged to the run, the way `compact` has always charged
   * them, and reported to the host's own session bill when it keeps one (#370).
   */
  private accountedOptions(
    options: AgentSessionCompactRequest['options'],
    runContext: AgentRunContext | undefined,
    runtime: SessionRuntime,
    onUsage?: AgentSessionCompactRequest['onUsage'],
  ): AgentSessionCompactRequest['options'] {
    return {
      ...options,
      beforeModelCall: runContext
        ? (model) => {
            const requestCheck = options.beforeModelCall?.(model);
            if (requestCheck && !requestCheck.allowed) return requestCheck;
            return runtime.runAccounting.checkBeforeModelCall(runContext.rootRunId, model);
          }
        : options.beforeModelCall,
      // Left exactly as it was when there is nothing to chain: a compaction with
      // no run context and no host callback hands the runner its own options back.
      onUsage:
        runContext || onUsage
          ? (usage, metadata) => {
              if (runContext) runtime.runAccounting.record(runContext, usage, metadata);
              options.onUsage?.(usage, metadata);
              onUsage?.(usage);
            }
          : options.onUsage,
      onUsageMissing: runContext
        ? (metadata) => {
            runtime.runAccounting.markUsageUnknown(runContext, metadata, 'compaction_usage');
            options.onUsageMissing?.(metadata);
          }
        : options.onUsageMissing,
    };
  }

  /** The record, the boundary, `onCommitted` and the PostCompact hooks for a compacted result. */
  private async commitCompactResult(
    result: Extract<CompactResult, { status: 'compacted' }>,
    request: AgentSessionCompactRequest,
  ): Promise<AgentSessionCompactOutcome> {
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
      carriedCount: result.carriedCount,
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
      carriedCount: result.carriedCount,
      strategy: result.strategy,
      modelCalls: result.modelCalls,
      degraded: result.degraded,
      warning: result.warning,
      ...(result.judge ? { judge: result.judge } : {}),
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
    // No signal: a saved compaction cannot be taken back, so a cancel here (Esc in the row's last
    // moments, an exit, a cancelled turn around an auto-compaction) would stop nothing but the
    // user's hooks. They run to their own timeouts.
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
    const effectiveHistory = request.history;
    runtime.runAccounting.startRoot(runContext, request.maxBudgetUsd);
    const effectiveConfig = request.options?.modelOverride
      ? {
          ...request.config,
          model: request.options.modelOverride,
          modelSelection: request.options.modelOverride,
        }
      : request.config;
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
    // The root's spend has a durable home for as long as this session lives, so
    // the flush at the end of the session can write what no response of this run
    // reported (#336).
    this.usageTargets.set(runContext.rootRunId, {
      target: {
        sessionId: request.sessionId,
        timelineStore: request.timelineStore,
        isCurrent: request.isCurrent,
      },
      runtime,
    });
    const finalizeOutcome = (outcome: AgentTerminalOutcome): AgentTerminalOutcome => {
      if (!terminalOutcome) {
        terminalOutcome = outcome;
        callbacks.onTerminal?.(outcome);
      }
      return terminalOutcome;
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
      /**
       * Append a whole-plan snapshot. Both todo and task writers call this, and
       * the loader takes the last `plan` record, so an interleaved write cannot
       * leave half a plan on disk. The signature check keeps a per-wave callback
       * from appending an identical record on every tool result.
       */
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
        onNotice: (message: string) => emit({ type: 'notice', message }),
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
          if (request.isCurrent?.() === false) {
            return Promise.resolve<PermissionDecision>({ result: 'deny', reason: 'dismissed' });
          }
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
          // process, so the honest number is the part of its inclusive total that
          // no `usage` record covers yet — the root owns that watermark, seeded
          // from the carry the session resumed with, so neither a restart nor a
          // second run under the same root writes a token twice. Read the run
          // context this run resolved, not the request's: a caller that passed none
          // is still charged to the root minted above, and keying off the request
          // skipped the watermark and wrote only the reported turn. The figure is
          // written whole, under the model of the response reporting it, because
          // this response is the one the host is being told about; a writer with no
          // response to name a model from splits the same delta per model
          // (`flushRunUsage`).
          this.persistReportedUsage(runContext.rootRunId, nextUsage, metadata);
          callbacks.onUsage?.(nextUsage, metadata);
        },
        getMode: callbacks.getMode,
        onModeChange: callbacks.onModeChange,
        // The root run's only: a managed child and a Task subagent run the loop
        // with their own callbacks, and neither announces calls to a stream the
        // host is reading for them.
        beforeToolExecution: callbacks.beforeToolExecution,
        onPlanHandoff: callbacks.onPlanHandoff,
        // Passed through as is: the loop gates every compaction site on
        // `autoCompactEnabled`, the context-overflow recovery included.
        onCompact: callbacks.onCompact,
        prepareCompact: callbacks.prepareCompact,
        commitCompact: callbacks.commitCompact,
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
              // Without this a resumed session reads a host notice as the model's
              // own reply: `finalAnswerText` and the answer walk both key on it.
              hostNotice: message.hostNotice,
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
              // A host-appended prompt stays host-written across a reload: the ledger,
              // Carried Turns and memory extraction all key on it.
              derivedContent: message.derivedContent,
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
      let messages: Message[];
      try {
        messages = await this.runLoop(
          request.config,
          request.registry,
          request.prompt,
          effectiveHistory,
          baseLoopCallbacks,
          request.mode,
          {
            ...request.options,
            runtime,
            runContext,
            resolveAttachment:
              request.options?.resolveAttachment ??
              (request.timelineStore?.readImageAttachment
                ? (attachment) =>
                    request.timelineStore!.readImageAttachment!(request.sessionId, attachment)
                : undefined),
            signal: request.signal,
          },
        );
      } finally {
        // The root run has ended, whether it returned or threw (#336). Whatever it
        // spent without a response to report it — a compaction judge's last call, a
        // managed child that answered as the run finished — is written now rather
        // than left to the end of the session: a host that runs another root
        // afterwards hands that root the whole carry, and only the writer that
        // reads the watermark knows which part of it is already on disk. Spend
        // charged after this point is the dispose flush's, which is why the two
        // write the same figure rather than one of them.
        this.flushRunUsage(runContext.rootRunId, true);
      }
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
      throw error;
    } finally {
      unsubscribeShellEvents();
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
