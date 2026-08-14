import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message, Usage, LocalCommandDisplay } from '../../types/messages.js';
import type {
  NestedToolInvocation,
  ToolDefinition,
  ToolResult,
  PermissionResult,
  PlanApprovalResult,
  UserQuestionResponse,
} from '../../types/tools.js';
import type { PermissionMode, RetryPhase } from '../../types/runtime.js';
import { createAgentRunContext, type AgentRunContext } from '../../types/runs.js';
import type { CommandContext } from '../../types/commands.js';
import type {
  SessionMeta,
  SessionRecord,
  SessionStoreInterface,
  CompactResult,
  CompactTrigger,
  CompactBoundary,
  RewindAction,
  RewindRecordData,
  RewindSnapshotStoreInterface,
  RewindTarget,
} from '../../types/sessions.js';
import { resolveContextLimit, shouldCompact, usagePressureTokens } from '../../agent/compact.js';
import { applyModelDefaults, resolveModelProviderConfig } from '../../config.js';
import type { Todo } from '../../tools/todo.js';
import type { AgentConfig } from '../../types/runtime.js';
import { makeMessage, removeTrailingEmptyAssistantPlaceholder } from './streaming-state.js';
import { createDebugLoggerWithCounter, createUiDebugLogger } from '../../debug-log.js';
import { loadMemoryContext } from '../../memory-store.js';
import {
  readSettingsGlobal,
  removeProviderGlobal,
  persistSettingLocal,
  persistAgentProfileModel,
  persistSettingGlobal,
  persistSettingsGlobal,
  persistPermissionRuleLocal,
  persistSkillActivationLocal,
  persistSkillExecutionLocal,
  persistSkillsEnabledLocal,
  clearLocalSettings,
} from '../persist.js';
import {
  DEFAULT_SETTINGS,
  providerConfigSchema,
  type CompactStrategy,
  type ResolvedSettings,
  type SkillActivation,
  type SkillExecution,
} from '../../settings.js';
import { resolveSettings } from '../../settings-loader.js';
import { providerConfigFromDraft, type ProviderSaveRequest } from '../model-options.js';
import type { ProviderRemovalResult } from '../components/ModelPicker.js';
import { updateEffortLevel } from '../../commands/effort.js';
import { observationKey } from '../../tools/file-provenance.js';
import type { SessionBootstrap } from '../../session/resolve.js';
import { normalizeWorkspace } from '../../session/store.js';
import {
  AgentSession,
  type AgentSessionSendControl,
  type AgentSessionSendResult,
} from '../../session/agent-session.js';
import { SessionRuntime } from '../../session/runtime.js';
import { createInteractiveAgentSession } from '../../session/interactive-session.js';
import type { AgentCompletionNotification } from '../../agents/types.js';
import { buildAgentCompletionMessage } from '../../agents/completion-notification.js';
import type { BackgroundShellRecord } from '../../types/runtime.js';
import { resolvePermissionMode } from '../../permission-mode.js';

const log = createDebugLoggerWithCounter('tui:agent');
const uiLog = createUiDebugLogger('tui:agent');
import { createMessageAccumulator } from './message-accumulator.js';
import type { MessageAccumulator } from './message-accumulator.js';

export function didSendMessageComplete(result: AgentSessionSendResult): boolean {
  return result.status === 'completed';
}

export function shouldDiscardOptimisticMessages(result: AgentSessionSendResult): boolean {
  if (result.status === 'cancelled') return !result.messages;
  return result.status === 'failed' && result.phase !== 'run';
}

export interface UseAgentSessionOptions extends SessionBootstrap {
  permissionMode?: PermissionMode;
  store?: SessionStoreInterface;
  timelineStore?: SessionStoreInterface;
  snapshotStore?: RewindSnapshotStoreInterface;
  /** Live extra tools (e.g. MCP) merged into each per-send registry. */
  additionalTools?: () => ToolDefinition[];
}

function providerIdFromSelection(selection: string): string | undefined {
  const slash = selection.indexOf('/');
  return slash > 0 ? selection.slice(0, slash) : undefined;
}

// BYOK providers are persisted to the user-global ~/.book/settings.json so they
// are shared across every project. Only providers present in that file were
// added by the user and are therefore removable; providers inherited from a
// project layer or --settings override are not.
function readOwnedProviders(): {
  ids: Set<string>;
  modelCounts: Map<string, number>;
} {
  const global = readSettingsGlobal();
  const provider = global.provider;
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
    return { ids: new Set(), modelCounts: new Map() };
  }
  const registry = provider as Record<string, unknown>;
  const ids = new Set(Object.keys(registry));
  const modelCounts = new Map<string, number>();
  for (const providerId of ids) {
    const entry = registry[providerId];
    const models =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).models
        : undefined;
    modelCounts.set(
      providerId,
      typeof models === 'object' && models !== null && !Array.isArray(models)
        ? Object.keys(models).length
        : 0,
    );
  }
  return { ids, modelCounts };
}

export function resolveConfigAfterProviderRemoval(
  current: AgentConfig,
  settings: ResolvedSettings,
  providerId: string,
): {
  config: AgentConfig;
  activeModel: string;
  switched: boolean;
  inheritedProviderRevealed: boolean;
} {
  const currentSelection = current.modelSelection ?? current.model;
  const configuredDefault = settings.model;
  const defaultIsStale =
    configuredDefault !== undefined &&
    providerIdFromSelection(configuredDefault) === providerId &&
    !settings.provider[providerId];
  const effectiveDefault = !configuredDefault || defaultIsStale ? 'gpt-4o' : configuredDefault;
  const activeProviderRemoved = providerIdFromSelection(currentSelection) === providerId;
  const nextSelection = activeProviderRemoved ? effectiveDefault : currentSelection;
  const next = applyModelDefaults(
    resolveModelProviderConfig({ ...current, settings }, nextSelection),
  );
  const activeModel = next.modelSelection ?? next.model;

  return {
    config: next,
    activeModel,
    switched: activeProviderRemoved && activeModel !== currentSelection,
    inheritedProviderRevealed: Boolean(settings.provider[providerId]),
  };
}

/** UI-only compact status — never appended to provider history. */
export type CompactUiState = {
  phase: 'working' | 'diff' | 'done' | 'error' | 'skipped';
  trigger: CompactTrigger;
  preMessages?: number;
  preContextTokens?: number;
  message?: string;
  degraded?: boolean;
  warning?: string;
  strategy?: Extract<CompactResult, { status: 'compacted' }>['strategy'];
  modelCalls?: number;
};

function buildObservationLedger(messages: Message[]) {
  const ledger = new Map<string, NonNullable<Message['fileObservations']>[number]>();
  for (const message of messages) {
    for (const observation of message.fileObservations ?? []) {
      const key = observationKey(observation.workspaceId, observation.path);
      const current = ledger.get(key);
      if (!current || current.timestamp <= observation.timestamp) ledger.set(key, observation);
    }
  }
  return ledger;
}

function withoutRuntimeState(config: AgentConfig): AgentConfig {
  return { ...config };
}

interface SendMessageOptions {
  contextMessage?: string;
  kind?: Message['kind'];
  agentNotifications?: Message['agentNotifications'];
  attachments?: Message['attachments'];
  /** Managed-continuation linkage back to the originating root and parent run. */
  rootRunId?: string;
  parentRunId?: string;
}

/** Short transcript line shown for a fresh-context handoff (the full plan is the context). */
const HANDOFF_DISPLAY_MESSAGE = 'Implementing the approved plan with a fresh context.';

/** Frames the approved plan as authoritative task intent for the reseeded implementation turn. */
function buildHandoffPrompt(plan: string): string {
  return [
    'You are implementing a plan that was just approved in a planning session.',
    'This is a handoff to a fresh context: the plan below is your complete and',
    'authoritative source of task intent. Implement it step by step. If a step is',
    'ambiguous, make the reasonable choice and keep going.',
    '',
    '<approved-plan>',
    plan,
    '</approved-plan>',
  ].join('\n');
}

export function useAgent(config: AgentConfig, session: UseAgentSessionOptions) {
  const initialTranscript = session.transcript ?? session.history;
  const initialContext = session.contextHistory ?? session.history;
  const [messages, setMessages] = useState<Message[]>(initialTranscript);
  const [compactBoundaries, setCompactBoundaries] = useState<CompactBoundary[]>(
    session.compactBoundaries ?? [],
  );
  const [rewindTargets, setRewindTargets] = useState<RewindTarget[]>(session.rewindTargets ?? []);
  const [isThinking, setIsThinking] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isRewinding, setIsRewinding] = useState(false);
  const [compactUi, setCompactUi] = useState<CompactUiState | null>(null);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [mode, setMode] = useState<PermissionMode>(() =>
    resolvePermissionMode(config.settings, session.permissionMode),
  );
  const [agentTodos, setAgentTodos] = useState<Todo[]>([]);
  // Set when the user approves a plan with "fresh context"; a post-send effect
  // starts a new conversation seeded with the approved plan.
  const [pendingHandoff, setPendingHandoff] = useState<{
    plan: string;
    mode: PermissionMode;
    generation: number;
  } | null>(null);
  // Guards single execution of the handoff reseed. State (not a ref) so releasing it
  // re-runs the effect to pick up a handoff raised during a prior reseed.
  const [handoffInFlight, setHandoffInFlight] = useState(false);
  // R1: liveConfig is the mutable config the agent loop reads. `config` (the
  // prop) is the startup snapshot; setModel/setEffort/persistPermissionRule
  // mutate liveConfig so subsequent runAgentLoop calls pick up the change.
  // Without this, /model would silently no-op (send closes over `config`).
  const [liveConfig, setLiveConfig] = useState<AgentConfig>(() => withoutRuntimeState(config));
  const [ownedProviders, setOwnedProviders] = useState(() => readOwnedProviders());
  const [agentSession] = useState(() =>
    createInteractiveAgentSession({
      runtime: new SessionRuntime({
        fileObservationLedger: buildObservationLedger(initialTranscript),
      }),
      additionalTools: session.additionalTools,
    }),
  );
  const { interactions, operations } = agentSession;
  const [interactionSnapshot, setInteractionSnapshot] = useState(() => interactions.getSnapshot());
  const { pendingPermission, pendingPlanApproval, pendingUserQuestions } = interactionSnapshot;
  const [turnDurationMs, setTurnDurationMs] = useState<number>(0);
  const [sessionId, setSessionId] = useState(session.sessionId);
  const [sessionName, setSessionName] = useState(session.sessionName);

  // Retry state for the spinner label.
  const [retryPhase, setRetryPhase] = useState<RetryPhase>('none');
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [retryMax, setRetryMax] = useState(0);
  const [retryCountdownMs, setRetryCountdownMs] = useState(0);

  // Mutable id of the assistant message currently being streamed into.
  // Callbacks read this ref (not state) so multi-turn updates always target
  // the latest in-progress message without stale-closure issues.
  const streamingIdRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>(initialTranscript);
  const contextHistoryRef = useRef<Message[]>(initialContext);
  const sessionIdRef = useRef(session.sessionId);
  const sessionNameRef = useRef(session.sessionName);
  const resumedFromRunIdRef = useRef<string | undefined>(undefined);
  const sessionGenerationRef = useRef(0);
  const modeRef = useRef(mode);
  const liveConfigRef = useRef(liveConfig);
  const ownedProvidersRef = useRef(ownedProviders);
  const turnStartRef = useRef(Date.now());
  // Countdown timer ref for retry countdown.
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Message accumulator for batched streaming updates.
  const accumulatorRef = useRef<MessageAccumulator | null>(null);
  const hostUsageRef = useRef<Usage | null>(null);
  const lastHostCompactAttemptRef = useRef<string | null>(null);
  // Plan-handoff request captured from the loop's onPlanHandoff callback, consumed
  // once the plan-approving send settles.
  const pendingHandoffRef = useRef<{ plan: string; mode: PermissionMode } | null>(null);
  const timelineStore = session.timelineStore ?? session.store;

  useEffect(() => interactions.subscribe(setInteractionSnapshot), [interactions]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    liveConfigRef.current = liveConfig;
  }, [liveConfig]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    ownedProvidersRef.current = ownedProviders;
  }, [ownedProviders]);

  const settlePermission = useCallback(
    (result: PermissionResult, via: string) => {
      return interactions.settlePermission(result, via);
    },
    [interactions],
  );

  const settlePlanApproval = useCallback(
    (result: PlanApprovalResult, via: string) => {
      return interactions.settlePlanApproval(result, via);
    },
    [interactions],
  );

  const settleUserQuestion = useCallback(
    (result: UserQuestionResponse, via: string, requestId?: string) =>
      interactions.settleUserQuestion(result, via, requestId),
    [interactions],
  );

  useEffect(() => {
    agentSession
      .startLifecycle(liveConfigRef.current, session.sessionId, session.source)
      .catch((err) => {
        log.warn('SessionStart hook failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [agentSession, session.sessionId, session.source]);

  useEffect(() => {
    return () => {
      agentSession
        .endLifecycle(liveConfigRef.current, sessionIdRef.current, 'exit')
        .catch((err) => {
          log.warn('SessionEnd hook failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    };
  }, [agentSession]);

  // Clean up timers / pending prompts / in-flight work on unmount.
  useEffect(() => {
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      accumulatorRef.current?.stop();
      accumulatorRef.current = null;
      // Abort work and deny/reject prompts so no session promise survives unmount.
      agentSession.dispose('unmount');
    };
  }, [agentSession]);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  useEffect(
    () =>
      agentSession.subscribe((snapshot) => {
        if (
          snapshot.status !== 'completed' &&
          snapshot.status !== 'failed' &&
          snapshot.status !== 'cancelled' &&
          snapshot.status !== 'timed_out' &&
          snapshot.status !== 'interrupted'
        )
          return;
        if (snapshot.sessionId !== sessionIdRef.current) return;
        setIsThinking(false);
        clearCountdown();
        setRetryPhase('none');
        setRetryCountdownMs(0);
        if (
          (snapshot.status === 'failed' ||
            snapshot.status === 'timed_out' ||
            snapshot.status === 'interrupted') &&
          snapshot.error
        ) {
          setError(snapshot.error);
        }
      }),
    [agentSession, clearCountdown],
  );

  const finalizeStreamingMessages = useCallback(() => {
    setMessages((prev) => {
      const next = removeTrailingEmptyAssistantPlaceholder(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  const prepareConversationProjection = useCallback(() => {
    sessionGenerationRef.current++;
    accumulatorRef.current?.discard();
    accumulatorRef.current = null;
    clearCountdown();
  }, [clearCountdown]);

  const projectConversationState = useCallback(
    (
      nextId: string,
      nextName: string | undefined,
      transcript: Message[],
      contextHistory: Message[] = transcript,
      boundaries: CompactBoundary[] = [],
      targets: RewindTarget[] = [],
    ) => {
      sessionIdRef.current = nextId;
      sessionNameRef.current = nextName;
      messagesRef.current = transcript;
      contextHistoryRef.current = contextHistory;
      streamingIdRef.current = null;
      setSessionId(nextId);
      setSessionName(nextName);
      setMessages(transcript);
      setCompactBoundaries(boundaries);
      setRewindTargets(targets);
      setIsThinking(false);
      setStreamingMessageId(null);
      setError(null);
      setCurrentTurn(0);
      setUsage(null);
      hostUsageRef.current = null;
      lastHostCompactAttemptRef.current = null;
      setAgentTodos([]);
      setTurnDurationMs(0);
      setRetryPhase('none');
      setRetryAttempt(0);
      setRetryMax(0);
      setRetryCountdownMs(0);
      agentSession.replaceRuntime(
        { fileObservationLedger: buildObservationLedger(transcript) },
        'session_transition',
      );
      setLiveConfig((current) => ({
        ...current,
        memoryContext: current.settings.memory.enabled
          ? loadMemoryContext(current.workspace)
          : undefined,
      }));
    },
    [agentSession],
  );

  const resetConversationState = useCallback(
    (
      nextId: string,
      nextName: string | undefined,
      transcript: Message[],
      contextHistory: Message[] = transcript,
      boundaries: CompactBoundary[] = [],
      targets: RewindTarget[] = [],
      opts: { preserveOperation?: boolean } = {},
    ) => {
      prepareConversationProjection();
      if (opts.preserveOperation) interactions.cancelAll('session-reset');
      else agentSession.reset('session-reset');
      projectConversationState(nextId, nextName, transcript, contextHistory, boundaries, targets);
    },
    [agentSession, interactions, prepareConversationProjection, projectConversationState],
  );

  const endCurrentSession = useCallback(
    (reason: 'clear' | 'resume' | 'exit' | 'completion') =>
      agentSession.endLifecycle(liveConfigRef.current, sessionIdRef.current, reason),
    [agentSession],
  );

  const startNewConversation = useCallback(
    async (previousName?: string) => {
      await agentSession.clearSession({
        config: liveConfigRef.current,
        currentSessionId: sessionIdRef.current,
        store: session.store,
        timelineStore,
        previousName,
        onTransitionStart: prepareConversationProjection,
        onTransition: (bootstrap) => {
          resumedFromRunIdRef.current = undefined;
          projectConversationState(
            bootstrap.sessionId,
            bootstrap.sessionName,
            bootstrap.transcript ?? bootstrap.history,
            bootstrap.contextHistory ?? bootstrap.history,
            bootstrap.compactBoundaries,
            bootstrap.rewindTargets,
          );
        },
      });
    },
    [
      agentSession,
      prepareConversationProjection,
      projectConversationState,
      session.store,
      timelineStore,
    ],
  );

  const resumeConversation = useCallback(
    async (selector: string) => {
      await agentSession.resumeSession({
        config: liveConfigRef.current,
        currentSessionId: sessionIdRef.current,
        store: session.store,
        timelineStore,
        selector,
        onTransitionStart: prepareConversationProjection,
        onTransition: (bootstrap) => {
          resumedFromRunIdRef.current = [...(bootstrap.transcript ?? bootstrap.history)]
            .reverse()
            .find((message) => message.role === 'user')?.id;
          projectConversationState(
            bootstrap.sessionId,
            bootstrap.sessionName,
            bootstrap.transcript ?? bootstrap.history,
            bootstrap.contextHistory ?? bootstrap.history,
            bootstrap.compactBoundaries,
            bootstrap.rewindTargets,
          );
        },
      });
    },
    [
      agentSession,
      prepareConversationProjection,
      projectConversationState,
      session.store,
      timelineStore,
    ],
  );

  const listSessions = useCallback((): SessionMeta[] => {
    if (!session.store) return [];
    const cwd = normalizeWorkspace(liveConfig.workspace);
    return session.store.list().filter((meta) => meta.cwd === cwd);
  }, [liveConfig.workspace, session.store]);

  const projectCompactResult = useCallback(
    (result: Extract<CompactResult, { status: 'compacted' }>, boundary: CompactBoundary) => {
      contextHistoryRef.current = result.replacementHistory;
      setCompactBoundaries((current) => [...current, boundary]);
      setUsage(null);
      hostUsageRef.current = null;
    },
    [],
  );

  const sendMessage = useCallback(
    async (
      userMessage: string,
      commandContext?: CommandContext,
      messageOptions?: SendMessageOptions,
    ): Promise<AgentSessionSendResult> => {
      setCompactUi(null);

      const generation = sessionGenerationRef.current;
      const activeSessionId = sessionIdRef.current;
      let operationIsCurrent = () => false;
      const stillCurrent = () =>
        sessionGenerationRef.current === generation && operationIsCurrent();
      let activeAccumulator: MessageAccumulator | null = null;
      let activeUserMessage: Message | undefined;
      let placeholder: Message | undefined;
      let activeRunContext: AgentRunContext | undefined;

      log.info('send message', {
        len: userMessage.length,
        mode: modeRef.current,
        hasCommandContext: !!commandContext,
        sessionId: activeSessionId,
      });
      uiLog.event('send:start', {
        len: userMessage.length,
        mode: modeRef.current,
        hasCommandContext: !!commandContext,
      });

      const beforePrepare = async (control: AgentSessionSendControl) => {
        operationIsCurrent = control.isCurrent;
        activeRunContext = control.runContext;
        // Cross-turn auto-compact before appending the new user message.
        const contextLimit = resolveContextLimit(liveConfig);
        const hostCompactAttemptKey = `${usagePressureTokens(hostUsageRef.current)}:${contextHistoryRef.current.length}`;
        if (
          liveConfig.compactStrategy === 'summary' &&
          liveConfig.autoCompactEnabled !== false &&
          contextLimit != null &&
          shouldCompact(hostUsageRef.current, contextLimit) &&
          lastHostCompactAttemptRef.current !== hostCompactAttemptKey
        ) {
          lastHostCompactAttemptRef.current = hostCompactAttemptKey;
          try {
            setIsCompacting(true);
            setCompactUi({
              phase: 'working',
              trigger: 'auto',
              preMessages: contextHistoryRef.current.length,
              preContextTokens: usagePressureTokens(hostUsageRef.current),
            });
            const autoOutcome = await agentSession.compact({
              config: liveConfig,
              history: contextHistoryRef.current,
              sourceHistory: messagesRef.current,
              compactBoundaries,
              sessionId: activeSessionId,
              transcriptOrdinal: messagesRef.current.length,
              runContext: control.runContext,
              runtime: agentSession.getRuntime(),
              timelineStore,
              isCurrent: stillCurrent,
              onCommitted: projectCompactResult,
              options: {
                trigger: 'auto',
                preContextTokens: usagePressureTokens(hostUsageRef.current),
                upcomingUserIntent: messageOptions?.contextMessage ?? userMessage,
              },
            });
            const autoResult = autoOutcome.result;
            if (stillCurrent() && autoResult.status === 'compacted' && autoOutcome.boundary) {
              setCompactUi({
                phase: 'diff',
                trigger: 'auto',
                preMessages: autoResult.preMessageCount,
                preContextTokens: autoResult.preContextTokens,
                message: autoResult.degraded
                  ? 'Conversation compacted with reduced fidelity'
                  : 'Conversation compacted',
                degraded: autoResult.degraded,
                warning: autoResult.warning,
                strategy: autoResult.strategy,
                modelCalls: autoResult.modelCalls,
              });
            } else if (stillCurrent()) {
              setCompactUi(null);
            }
          } catch (err) {
            log.warn('pre-turn auto-compact failed', {
              error: err instanceof Error ? err.message : String(err),
            });
            if (stillCurrent()) setCompactUi(null);
          } finally {
            if (stillCurrent()) setIsCompacting(false);
          }
        }
      };

      const createUserMessage = () => {
        const message = makeMessage('user', userMessage, messageOptions?.contextMessage, true);
        message.kind = messageOptions?.kind ?? 'conversation';
        message.agentNotifications = messageOptions?.agentNotifications;
        message.attachments = messageOptions?.attachments;
        activeUserMessage = message;
        return message;
      };

      const projectPreparingSend = (userMsg: Message, control: AgentSessionSendControl) => {
        operationIsCurrent = control.isCurrent;
        // Render the user's message immediately and stream into a fresh placeholder.
        placeholder = makeMessage('assistant', '', undefined, true);
        streamingIdRef.current = placeholder.id;
        setStreamingMessageId(placeholder.id);
        setIsThinking(true);
        setError(null);
        setCurrentTurn(0);
        setUsage(null);
        setRetryPhase('none');
        setRetryAttempt(0);
        setRetryMax(0);
        setRetryCountdownMs(0);
        setMessages((prev) => {
          const next = [...prev, userMsg, placeholder!];
          messagesRef.current = next;
          return next;
        });
      };

      const removeOptimisticMessages = () => {
        if (!activeUserMessage || !placeholder) return;
        setMessages((prev) => {
          const next = prev.filter(
            (message) => message.id !== activeUserMessage?.id && message.id !== placeholder?.id,
          );
          messagesRef.current = next;
          return next;
        });
      };

      const projectPreparedSend = (
        prepared: Extract<Awaited<ReturnType<AgentSession['prepareSend']>>, { status: 'prepared' }>,
      ) => {
        if (prepared.sessionName !== sessionNameRef.current) {
          sessionNameRef.current = prepared.sessionName;
          setSessionName(prepared.sessionName);
        }
        setRewindTargets((current) => [prepared.rewindTarget, ...current]);
        // Ink layout plus markdown parsing commonly takes longer than a 60fps
        // frame on a real transcript. A 32ms cadence keeps streaming responsive
        // without making the terminal renderer compete with every token delta.
        activeAccumulator = createMessageAccumulator(placeholder!.id, setMessages, messagesRef, 32);
        accumulatorRef.current = activeAccumulator;
        activeAccumulator.start();
        uiLog.event('accumulator:started', { flushIntervalMs: 32 });
      };

      const sendResult = await agentSession.send({
        config: liveConfig,
        displayMessage: userMessage,
        contextMessage: messageOptions?.contextMessage,
        createUserMessage,
        history: () => contextHistoryRef.current,
        transcript: () => messagesRef.current,
        compactBoundaries,
        mode: modeRef.current,
        sessionId: activeSessionId,
        source: 'tui',
        resumedFromRunId:
          messageOptions?.kind === 'agent-notification' ? undefined : resumedFromRunIdRef.current,
        rootRunId:
          messageOptions?.kind === 'agent-notification' ? messageOptions?.rootRunId : undefined,
        parentRunId:
          messageOptions?.kind === 'agent-notification' ? messageOptions?.parentRunId : undefined,
        sessionName: sessionNameRef.current,
        snapshotStore: session.snapshotStore,
        timelineStore,
        registryStore: timelineStore,
        isCurrent: () => sessionGenerationRef.current === generation,
        runtime: agentSession.getRuntime(),
        beforePrepare,
        onPreparing: projectPreparingSend,
        onPrepared: projectPreparedSend,
        callbacks: {
          onEvent: (event) => {
            if (!stillCurrent()) return;
            switch (event.type) {
              case 'text':
                activeAccumulator?.addText(event.content);
                break;
              case 'reasoning':
                activeAccumulator?.addReasoning(event.content);
                break;
              case 'tool_use':
                activeAccumulator?.addToolCall(event.toolCall);
                break;
              case 'tool_result':
                activeAccumulator?.addToolResult(event.toolResult);
                break;
              case 'error':
                log.warn('agent error', { error: event.error });
                break;
            }
          },
          onTodos: (todos) => {
            if (stillCurrent()) setAgentTodos(todos as Todo[]);
          },
          onTurnStart: (turn) => {
            if (!stillCurrent()) return;
            log.debug('TUI turn start', { turn });
            setCurrentTurn(turn);
            turnStartRef.current = Date.now();
            if (turn > 1) {
              activeAccumulator?.stop();
              uiLog.event('accumulator:stopped', { reason: 'new-turn', turn });
              const next = makeMessage('assistant', '', undefined, true);
              streamingIdRef.current = next.id;
              setStreamingMessageId(next.id);
              setMessages((prev) => {
                const updated = [...prev, next];
                messagesRef.current = updated;
                return updated;
              });
              activeAccumulator = createMessageAccumulator(next.id, setMessages, messagesRef, 32);
              accumulatorRef.current = activeAccumulator;
              activeAccumulator.start();
              uiLog.event('accumulator:started', { flushIntervalMs: 32, turn });
            }
          },
          onDone: () => {
            if (!stillCurrent()) return;
            log.info('agent done', { durationMs: Date.now() - turnStartRef.current });
            uiLog.event('send:done', { durationMs: Date.now() - turnStartRef.current });
            setTurnDurationMs(Date.now() - turnStartRef.current);
          },
          onUsage: (u: Usage) => {
            if (!stillCurrent()) return;
            hostUsageRef.current = u;
            lastHostCompactAttemptRef.current = null;
            setUsage(u);
          },
          getMode: () => modeRef.current,
          onModeChange: (newMode: PermissionMode) => {
            if (!stillCurrent()) return;
            modeRef.current = newMode;
            setMode(newMode);
          },
          onPlanHandoff: (handoff) => {
            if (!stillCurrent()) return;
            // Consumed after this send settles (see the pending-handoff effect).
            pendingHandoffRef.current = handoff;
          },
          onCompact: async (history, usage) => {
            if (!stillCurrent()) {
              return { status: 'skipped', reason: 'disabled', message: 'Session changed.' };
            }
            const outcome = await agentSession.compact({
              config: liveConfigRef.current,
              history,
              sourceHistory: messagesRef.current,
              compactBoundaries,
              sessionId: activeSessionId,
              transcriptOrdinal: messagesRef.current.length,
              runContext: activeRunContext,
              runtime: agentSession.getRuntime(),
              timelineStore,
              isCurrent: stillCurrent,
              onCommitted: projectCompactResult,
              options: {
                trigger: 'auto',
                preContextTokens: usage ? usagePressureTokens(usage) : undefined,
              },
            });
            const result = outcome.result;
            if (!stillCurrent()) return result;
            if (result.status === 'compacted' && outcome.boundary) {
              setCompactUi({
                phase: 'diff',
                trigger: 'auto',
                preMessages: result.preMessageCount,
                preContextTokens: result.preContextTokens,
                message: result.degraded
                  ? 'Conversation compacted with reduced fidelity'
                  : 'Conversation compacted',
                degraded: result.degraded,
                warning: result.warning,
                strategy: result.strategy,
                modelCalls: result.modelCalls,
              });
            }
            return result;
          },
          onRetry: (phase, attempt, max, delayMs) => {
            if (!stillCurrent()) return;
            setRetryPhase(phase);
            setRetryAttempt(attempt);
            setRetryMax(max);
            setRetryCountdownMs(delayMs);

            // Start countdown timer.
            clearCountdown();
            countdownRef.current = setInterval(() => {
              setRetryCountdownMs((prev) => {
                const next = prev - 1000;
                if (next <= 0) {
                  clearCountdown();
                  return 0;
                }
                return next;
              });
            }, 1000);
          },
          onStreamStall: (countdownMs) => {
            if (!stillCurrent()) return;
            setRetryPhase('stalled');
            setRetryCountdownMs(countdownMs);
            clearCountdown();
            countdownRef.current = setInterval(() => {
              setRetryCountdownMs((prev) => {
                const next = prev - 1000;
                if (next <= 0) {
                  clearCountdown();
                  return 0;
                }
                return next;
              });
            }, 1000);
          },
          onStreamResume: () => {
            if (!stillCurrent()) return;
            setRetryPhase('none');
            clearCountdown();
          },
          onPersistPermissionRule: (rule: string) => {
            persistPermissionRule(rule);
          },
        },
        options: {
          nestedToolObserver: {
            onToolCall: (invocation: NestedToolInvocation) => {
              if (stillCurrent()) activeAccumulator?.addNestedToolCall(invocation);
            },
            onToolResult: (traceId: string, result: ToolResult) => {
              if (stillCurrent()) activeAccumulator?.addNestedToolResult(traceId, result);
            },
          },
          manageSessionHooks: false,
          assistantMessageId: () => streamingIdRef.current ?? undefined,
          allowedTools: commandContext?.allowedTools,
          modelOverride: commandContext?.modelOverride,
          commands: commandContext ? [commandContext.command] : undefined,
          parentSessionId: activeSessionId,
        },
      });
      if (messageOptions?.kind !== 'agent-notification' && sendResult.status !== 'rejected') {
        resumedFromRunIdRef.current = undefined;
      }

      const hostStillCurrent = sessionGenerationRef.current === generation;
      if (sendResult.status === 'rejected') {
        uiLog.event('send:rejected', {
          reason: sendResult.activeKind === 'compact' ? 'compacting' : 'already-in-flight',
          len: userMessage.length,
        });
        return sendResult;
      }
      if (hostStillCurrent && 'messages' in sendResult && sendResult.messages) {
        // Nested tool traces remain display-only; the returned history is provider context.
        contextHistoryRef.current = sendResult.messages;
      }
      // A fresh-context plan approval sets this late in the loop. Always drop it on any
      // terminal outcome of this send so it can't leak into a later turn; reseed only
      // when this send completed as the current generation.
      if (pendingHandoffRef.current) {
        const handoff = pendingHandoffRef.current;
        pendingHandoffRef.current = null;
        if (hostStillCurrent && sendResult.status === 'completed') {
          setPendingHandoff({ ...handoff, generation });
        }
      }
      if (hostStillCurrent && shouldDiscardOptimisticMessages(sendResult)) {
        if (sendResult.status === 'failed') {
          setError(
            sendResult.error instanceof Error ? sendResult.error.message : String(sendResult.error),
          );
        }
        setIsThinking(false);
        removeOptimisticMessages();
      }
      if (hostStillCurrent && placeholder) {
        accumulatorRef.current?.stop();
        uiLog.event('accumulator:stopped', { reason: 'done' });
        if (accumulatorRef.current === activeAccumulator) accumulatorRef.current = null;
        finalizeStreamingMessages();
        streamingIdRef.current = null;
        setStreamingMessageId(null);
      }
      uiLog.event('send:finally', { durationMs: Date.now() - turnStartRef.current });
      return sendResult;
    },
    [
      liveConfig,
      clearCountdown,
      compactBoundaries,
      finalizeStreamingMessages,
      timelineStore,
      projectCompactResult,
      session.snapshotStore,
      agentSession,
    ],
  );

  const send = useCallback(
    async (
      userMessage: string,
      commandContext?: CommandContext,
      attachments?: Message['attachments'],
    ) => {
      return sendMessage(userMessage, commandContext, { attachments });
    },
    [sendMessage],
  );

  // Fresh-context plan handoff: once the plan-approving turn settles, start a new
  // conversation and reseed it with only the approved plan (like Codex/Claude Code).
  useEffect(() => {
    if (!pendingHandoff || handoffInFlight) return;
    // Abandon if the session moved on (clear/resume/rewind) before we could reseed.
    if (sessionGenerationRef.current !== pendingHandoff.generation) {
      setPendingHandoff(null);
      return;
    }
    const handoff = pendingHandoff;
    setHandoffInFlight(true);
    const { plan, mode: handoffMode } = handoff;
    void (async () => {
      try {
        log.info('plan handoff: starting fresh conversation');
        await startNewConversation();
        modeRef.current = handoffMode;
        setMode(handoffMode);
        await sendMessage(HANDOFF_DISPLAY_MESSAGE, undefined, {
          contextMessage: buildHandoffPrompt(plan),
          kind: 'conversation',
        });
      } catch (err) {
        log.warn('plan handoff failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Surface the loss: the approved plan was not implemented.
        setError('Failed to start fresh-context implementation; the approved plan was not run.');
      } finally {
        // Clear only this request, so a handoff raised during the reseed above survives
        // and is picked up when handoffInFlight is released.
        setPendingHandoff((current) => (current === handoff ? null : current));
        setHandoffInFlight(false);
      }
    })();
  }, [pendingHandoff, handoffInFlight, startNewConversation, sendMessage]);

  const sendAgentCompletions = useCallback(
    async (notifications: AgentCompletionNotification[]): Promise<boolean> => {
      if (notifications.length === 0) return false;
      const recordedDeliveryIds = new Set(
        messagesRef.current.flatMap((message) =>
          (message.agentNotifications ?? [])
            .map((notification) => notification.deliveryId)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      const fresh = notifications.filter(
        (notification) => !recordedDeliveryIds.has(notification.deliveryId),
      );
      if (fresh.length === 0) return true;
      const built = fresh.map(buildAgentCompletionMessage);
      // Parent linkage is only truthful when every batched completion shares one root.
      const sharedRootRunId =
        fresh[0]?.rootRunId &&
        fresh.every((notification) => notification.rootRunId === fresh[0]?.rootRunId)
          ? fresh[0]?.rootRunId
          : undefined;
      const result = await sendMessage(
        built.map((item) => item.displayMessage).join('\n'),
        undefined,
        {
          contextMessage: built.map((item) => item.contextMessage).join('\n'),
          kind: 'agent-notification',
          agentNotifications: built.map((item) => item.display),
          rootRunId: sharedRootRunId,
          parentRunId: sharedRootRunId ? fresh[0]?.runId : undefined,
        },
      );
      return didSendMessageComplete(result);
    },
    [sendMessage],
  );

  const sendBackgroundShellCompletion = useCallback(
    async (shell: BackgroundShellRecord): Promise<boolean> => {
      const tail = agentSession.getRuntime().shellManager.readTail(shell.id, 4_000) ?? '';
      const exit = shell.exitCode !== undefined ? ` exit=${shell.exitCode ?? 'none'}` : '';
      const display = `Background shell ${shell.title || shell.id} ${shell.status}${exit}.`;
      const context = [
        '<background-shell-completion>',
        `id: ${shell.id}`,
        `title: ${shell.title || shell.command}`,
        `status: ${shell.status}${exit}`,
        `elapsed_ms: ${(shell.finishedAt ?? Date.now()) - shell.startedAt}`,
        tail ? 'output_tail:' : undefined,
        tail || undefined,
        '</background-shell-completion>',
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n');
      const result = await sendMessage(display, undefined, {
        contextMessage: context,
        kind: 'agent-notification',
      });
      return didSendMessageComplete(result);
    },
    [agentSession, sendMessage],
  );

  const resolvePermission = useCallback(
    (result: PermissionResult) => {
      settlePermission(result, 'resolve');
    },
    [settlePermission],
  );

  const cancelPermission = useCallback(() => {
    settlePermission('deny', 'cancel-permission');
  }, [settlePermission]);

  const resolvePlanApproval = useCallback(
    (result: PlanApprovalResult) => {
      settlePlanApproval(result, 'resolve');
    },
    [settlePlanApproval],
  );

  const resolveUserQuestion = useCallback(
    (result: UserQuestionResponse) => {
      settleUserQuestion(result, 'resolve');
    },
    [settleUserQuestion],
  );

  // Abort the in-flight agent stream (Esc while thinking) or compact request.
  // The active lease stays held until its finally block; only its signal is aborted.
  const cancel = useCallback(() => {
    const activeKind = operations.activeKind;
    const hadAccumulator = accumulatorRef.current !== null;
    const cancelled = agentSession.cancel('cancel');
    uiLog.event('cancel', {
      activeKind,
      aborted: cancelled.operation.aborted,
      hadAccumulator,
      inFlight: activeKind === 'send',
    });
    // The active lease stays held until its finally block finishes unwinding.
    clearCountdown();
    setRetryPhase('none');
  }, [agentSession, clearCountdown, operations]);

  // Manually compact the conversation (summarize older turns).
  const compact = useCallback(
    async (focus?: string) => {
      const operation = operations.tryStart('compact', true);
      if (!operation) {
        setCompactUi({
          phase: 'skipped',
          trigger: 'manual',
          message: 'Cannot compact while a turn is in progress.',
        });
        return;
      }
      const generation = sessionGenerationRef.current;
      const activeSessionId = sessionIdRef.current;
      const stillCurrent = () =>
        sessionGenerationRef.current === generation && operation.isCurrent();
      const preMessages = contextHistoryRef.current.length;
      const preContextTokens = usagePressureTokens(hostUsageRef.current);

      setIsCompacting(true);
      setCompactUi({
        phase: 'working',
        trigger: 'manual',
        preMessages,
        preContextTokens,
      });

      try {
        const runContext = createAgentRunContext({
          sessionId: activeSessionId,
          source: 'tui',
        });
        const outcome = await agentSession.compact({
          config: liveConfigRef.current,
          history: contextHistoryRef.current,
          sourceHistory: messagesRef.current,
          compactBoundaries,
          sessionId: activeSessionId,
          transcriptOrdinal: messagesRef.current.length,
          runContext,
          runtime: agentSession.getRuntime(),
          timelineStore,
          isCurrent: stillCurrent,
          onCommitted: projectCompactResult,
          options: {
            trigger: 'manual',
            focus,
            preContextTokens,
            signal: operation.signal,
          },
        });
        const result = outcome.result;

        if (!stillCurrent()) return;

        if (result.status === 'skipped') {
          setCompactUi({
            phase: 'skipped',
            trigger: 'manual',
            preMessages,
            message: result.message ?? 'Not enough messages to compact.',
          });
          return;
        }
        if (result.status === 'failed') {
          setCompactUi({
            phase: 'error',
            trigger: 'manual',
            preMessages,
            message: result.error,
          });
          return;
        }

        if (!outcome.boundary) return;
        if (!stillCurrent()) return;
        setCompactUi({
          phase: 'diff',
          trigger: 'manual',
          preMessages: result.preMessageCount,
          preContextTokens: result.preContextTokens,
          message: result.degraded
            ? 'Conversation compacted with reduced fidelity'
            : 'Conversation compacted',
          degraded: result.degraded,
          warning: result.warning,
          strategy: result.strategy,
          modelCalls: result.modelCalls,
        });
      } catch (e) {
        if (stillCurrent()) {
          setCompactUi({
            phase: 'error',
            trigger: 'manual',
            preMessages,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      } finally {
        if (stillCurrent()) setIsCompacting(false);
        operation.release();
      }
    },
    [agentSession, compactBoundaries, operations, projectCompactResult, timelineStore],
  );

  const getRewindTargets = useCallback((): RewindTarget[] => {
    const currentGitHead = session.snapshotStore?.getCurrentGitHead();
    return rewindTargets.map((target) => {
      if (target.codeUnavailableReason) return { ...target, codeAvailable: false };
      const manifest = target.snapshotId
        ? session.snapshotStore?.getManifest(target.snapshotId)
        : undefined;
      const availability = !session.snapshotStore
        ? { available: false, reason: 'Filesystem checkpoint storage is unavailable.' }
        : !manifest
          ? session.snapshotStore.getAvailability(target.snapshotId, target.gitHead)
          : currentGitHead !== target.gitHead
            ? {
                available: false,
                reason: 'Git HEAD changed since this prompt; rewind never moves HEAD or the index.',
              }
            : { available: true };
      return {
        ...target,
        codeAvailable: availability.available,
        codeUnavailableReason: availability.available ? undefined : availability.reason,
      };
    });
  }, [rewindTargets, session.snapshotStore]);

  const rewind = useCallback(
    async (
      targetId: string,
      action: RewindAction,
    ): Promise<
      | { ok: true; restoredPrompt?: string; restoredAttachments?: Message['attachments'] }
      | { ok: false; error: string }
    > => {
      const operation = operations.tryStart('rewind');
      if (!operation) {
        return { ok: false, error: 'Rewind is unavailable while another operation is active.' };
      }
      if (!timelineStore) {
        operation.release();
        return { ok: false, error: 'Rewind timeline storage is unavailable.' };
      }
      const target = getRewindTargets().find((candidate) => candidate.id === targetId);
      if (!target) {
        operation.release();
        return { ok: false, error: 'The selected rewind target is no longer active.' };
      }
      if ((action === 'code' || action === 'both') && !target.codeAvailable) {
        operation.release();
        return {
          ok: false,
          error: target.codeUnavailableReason ?? 'Code rewind is unavailable for this prompt.',
        };
      }

      setIsRewinding(true);
      const activeSessionId = sessionIdRef.current;
      let safetySnapshotId: string | undefined;
      try {
        if (action === 'code' || action === 'both') {
          const restored = session.snapshotStore?.restore(target.snapshotId!);
          if (!restored)
            return { ok: false, error: 'Filesystem checkpoint storage is unavailable.' };
          if (!restored.ok) {
            return {
              ok: false,
              error: restored.rollbackError
                ? `${restored.error} Rollback also failed: ${restored.rollbackError}`
                : restored.error,
            };
          }
          safetySnapshotId = restored.safetySnapshotId;
        }

        timelineStore.append(activeSessionId, {
          type: 'rewind',
          eventId: crypto.randomUUID(),
          timestamp: Date.now(),
          data: {
            version: 1,
            action,
            targetId: target.id,
            targetUserEventId: target.userEventId,
          } satisfies RewindRecordData,
        } satisfies SessionRecord);

        if (action === 'conversation' || action === 'both') {
          const loaded = timelineStore.load(activeSessionId);
          resetConversationState(
            activeSessionId,
            sessionName,
            loaded.transcript,
            loaded.contextHistory,
            loaded.compactBoundaries,
            loaded.rewindTargets,
            { preserveOperation: true },
          );
        }
        if (safetySnapshotId) session.snapshotStore?.discardManifest(safetySnapshotId);
        return {
          ok: true,
          ...(action === 'code'
            ? {}
            : {
                restoredPrompt: target.prompt,
                ...(target.attachments?.length ? { restoredAttachments: target.attachments } : {}),
              }),
        };
      } catch (rewindError) {
        let rollbackMessage = '';
        if (safetySnapshotId) {
          const rollback = session.snapshotStore?.rollback(safetySnapshotId);
          if (rollback && !rollback.ok) rollbackMessage = ` Rollback failed: ${rollback.error}`;
        }
        return {
          ok: false,
          error: `${rewindError instanceof Error ? rewindError.message : String(rewindError)}${rollbackMessage}`,
        };
      } finally {
        operation.release();
        setIsRewinding(false);
      }
    },
    [
      getRewindTargets,
      operations,
      resetConversationState,
      session.snapshotStore,
      sessionName,
      timelineStore,
    ],
  );

  const clear = useCallback(() => {
    // Abort + stop accumulator BEFORE wiping message state so no late flush
    // can resurrect content into a cleared conversation.
    accumulatorRef.current?.stop();
    accumulatorRef.current = null;
    agentSession.cancel('clear');
    messagesRef.current = [];
    contextHistoryRef.current = [];
    setMessages([]);
    setCompactBoundaries([]);
    setRewindTargets([]);
    setError(null);
    setCurrentTurn(0);
    setUsage(null);
    hostUsageRef.current = null;
    lastHostCompactAttemptRef.current = null;
    setAgentTodos([]);
    streamingIdRef.current = null;
    setStreamingMessageId(null);
    // The send lease is released by send()'s finally after abort.
    if (!operations.isRunning('send')) setIsThinking(false);
    clearCountdown();
    setRetryPhase('none');
    setRetryCountdownMs(0);
  }, [agentSession, clearCountdown, operations]);

  const cycleMode = useCallback(() => {
    const modes: PermissionMode[] = [
      'default',
      'auto',
      'plan',
      'accept-edits',
      'dontAsk',
      'bypassPermissions',
    ].filter(
      (candidate) =>
        candidate !== 'bypassPermissions' ||
        liveConfigRef.current.settings.disableBypassPermissionsMode !== true,
    ) as PermissionMode[];
    const idx = modes.indexOf(modeRef.current);
    const nextMode = modes[(idx + 1) % modes.length];
    modeRef.current = nextMode;
    setMode(nextMode);
  }, []);

  // Surface a local-only assistant message WITHOUT an agent round-trip.
  // Precedent: compact() mutates messages directly via setMessages. Unlike
  // send(), this never invokes runAgentLoop — used by /diff /config /cost
  // /init-pre /memory-noop to show output instantly.
  const addLocalMessage = useCallback(
    (text: string, localCommand?: LocalCommandDisplay) => {
      const sendInFlight = operations.isRunning('send');
      if (sendInFlight || isThinking) {
        uiLog.event('local-message:blocked', {
          reason: sendInFlight ? 'in-flight' : 'is-thinking',
          preview: text.slice(0, 40),
        });
        return; // don't clobber a streaming turn
      }
      uiLog.event('local-message:added', {
        preview: text.slice(0, 40),
        presentation: localCommand?.kind ?? 'text',
      });
      const msg = {
        ...makeMessage('assistant', text, undefined, false),
        kind: 'local' as const,
        localCommand,
      };
      if (timelineStore) {
        timelineStore.append(sessionIdRef.current, {
          type: 'local',
          eventId: msg.id,
          timestamp: msg.timestamp,
          data: { id: msg.id, content: msg.content, kind: 'local', includeInContext: false },
        });
      }
      setMessages((prev) => {
        const next = [...prev, msg];
        messagesRef.current = next;
        return next;
      });
    },
    [isThinking, operations, timelineStore],
  );

  // Switch the active model for the rest of the session, optionally persisting
  // it to the user-global settings layer (~/.book/settings.json) so the choice
  // follows the user across projects. BOOK_MODEL can still override settings on
  // the next startup; app.tsx surfaces that warning.
  const setModel = useCallback(
    (name: string, options: { persist?: boolean } = {}) => {
      let next: AgentConfig;
      try {
        next = applyModelDefaults(resolveModelProviderConfig(liveConfigRef.current, name));
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (options.persist !== false) {
        const result = persistSettingGlobal('model', name);
        if (!result.ok) return result;
        // Drop any stale per-project model override so this folder uses the
        // global default we just wrote (local wins over global otherwise).
        clearLocalSettings(config.workspace, ['model']);
      }
      setLiveConfig(next);
      return { ok: true };
    },
    [config.workspace],
  );

  const upsertProviderAndSelect = useCallback(
    (request: ProviderSaveRequest) => {
      const providerId = request.providerId;
      let savedProvider;
      try {
        const existing = liveConfigRef.current.settings.provider[providerId];
        savedProvider = providerConfigSchema.parse(
          providerConfigFromDraft(request, existing, request.replaceModels),
        );
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      const selection = `${providerId}/${request.activeModelId}`;
      const activate = request.activate !== false;
      const result = persistSettingsGlobal({
        [`provider.${providerId}`]: savedProvider,
        ...(activate ? { model: selection } : {}),
      });
      if (!result.ok) return result;
      // Drop any stale per-project entries for this provider (and the active
      // model when we just set it) so this folder inherits the global value
      // instead of a local override shadowing it.
      clearLocalSettings(config.workspace, [
        `provider.${providerId}`,
        ...(activate ? ['model'] : []),
      ]);

      setLiveConfig((current) => {
        const withProvider: AgentConfig = {
          ...current,
          settings: {
            ...current.settings,
            ...(activate ? { model: selection } : {}),
            provider: {
              ...current.settings.provider,
              [providerId]: savedProvider,
            },
          },
        };
        return activate
          ? applyModelDefaults(resolveModelProviderConfig(withProvider, selection))
          : withProvider;
      });
      const nextOwnedProviders = {
        ids: new Set(ownedProvidersRef.current.ids).add(providerId),
        modelCounts: new Map(ownedProvidersRef.current.modelCounts).set(
          providerId,
          Object.keys(savedProvider.models).length,
        ),
      };
      ownedProvidersRef.current = nextOwnedProviders;
      setOwnedProviders(nextOwnedProviders);
      return { ok: true };
    },
    [config.workspace],
  );

  const removeProvider = useCallback(
    (providerId: string): ProviderRemovalResult => {
      if (!ownedProvidersRef.current.ids.has(providerId)) {
        return { ok: false, error: 'Only BYOK providers you added can be removed.' };
      }

      const persisted = removeProviderGlobal(providerId);
      if (!persisted.ok) return { ok: false, error: persisted.error };

      let resolvedSettings: ResolvedSettings;
      let resolvedRuntime: ReturnType<typeof resolveConfigAfterProviderRemoval>;
      try {
        resolvedSettings = config.settingsContext?.noSettings
          ? structuredClone(DEFAULT_SETTINGS)
          : resolveSettings(config.workspace, config.settingsContext?.overridePath);
        resolvedRuntime = resolveConfigAfterProviderRemoval(
          liveConfigRef.current,
          resolvedSettings,
          providerId,
        );
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      liveConfigRef.current = resolvedRuntime.config;
      setLiveConfig(resolvedRuntime.config);
      const nextOwnedProviderIds = new Set(ownedProvidersRef.current.ids);
      const nextOwnedProviderModelCounts = new Map(ownedProvidersRef.current.modelCounts);
      nextOwnedProviderIds.delete(providerId);
      nextOwnedProviderModelCounts.delete(providerId);
      const nextOwnedProviders = {
        ids: nextOwnedProviderIds,
        modelCounts: nextOwnedProviderModelCounts,
      };
      ownedProvidersRef.current = nextOwnedProviders;
      setOwnedProviders(nextOwnedProviders);

      return {
        ok: true,
        providerId,
        removedModelCount: persisted.removedModelCount,
        activeModel: resolvedRuntime.activeModel,
        switched: resolvedRuntime.switched,
        inheritedProviderRevealed: resolvedRuntime.inheritedProviderRevealed,
      };
    },
    [config.settingsContext?.noSettings, config.settingsContext?.overridePath, config.workspace],
  );

  const setEffort = useCallback(
    (level: NonNullable<AgentConfig['effort']>) =>
      updateEffortLevel(
        liveConfigRef.current,
        level,
        (selected) => persistSettingLocal(config.workspace, 'effort', selected),
        (selected) =>
          setLiveConfig((current) => ({
            ...current,
            effort: selected,
            effortExplicit: true,
          })),
      ),
    [config.workspace],
  );

  const setAgentProfileModel = useCallback(
    (profile: string, model?: string) => {
      const persisted = persistAgentProfileModel(config.workspace, profile, model);
      if (!persisted.ok) return persisted;

      setLiveConfig((current) => {
        const profiles = { ...current.settings.agents.profiles };
        const existing = { ...(profiles[profile] ?? {}) };
        existing.model = model ?? 'inherit';
        if (Object.keys(existing).length > 0) profiles[profile] = existing;
        else delete profiles[profile];
        return {
          ...current,
          settings: {
            ...current.settings,
            agents: { ...current.settings.agents, profiles },
          },
        };
      });
      return { ok: true };
    },
    [config.workspace],
  );

  const setCompactModel = useCallback(
    (model: string) => {
      const result = persistSettingLocal(config.workspace, 'compactModel', model);
      if (!result.ok) return result;
      setLiveConfig((current) => ({
        ...current,
        compactModel: model,
        settings: { ...current.settings, compactModel: model },
      }));
      return { ok: true };
    },
    [config.workspace],
  );

  const setCompactStrategy = useCallback(
    (strategy: CompactStrategy) => {
      const result = persistSettingLocal(config.workspace, 'compactStrategy', strategy);
      if (!result.ok) return result;
      setLiveConfig((current) => ({
        ...current,
        compactStrategy: strategy,
        settings: { ...current.settings, compactStrategy: strategy },
      }));
      if (strategy === 'summary') {
        contextHistoryRef.current = messagesRef.current.filter(
          (message) => message.includeInContext && message.kind !== 'local',
        );
        hostUsageRef.current = null;
        setUsage(null);
      }
      return { ok: true };
    },
    [config.workspace],
  );

  const setSkillActivation = useCallback(
    (skillName: string, activation: SkillActivation) => {
      const persisted = persistSkillActivationLocal(config.workspace, skillName, activation);
      if (!persisted.ok) return persisted;

      setLiveConfig((current) => ({
        ...current,
        settings: {
          ...current.settings,
          skills: {
            ...current.settings.skills,
            overrides: {
              ...current.settings.skills.overrides,
              [skillName]: activation,
            },
          },
        },
      }));
      return { ok: true };
    },
    [config.workspace],
  );

  const setSkillExecution = useCallback(
    (skillName: string, execution: SkillExecution) => {
      const persisted = persistSkillExecutionLocal(config.workspace, skillName, execution);
      if (!persisted.ok) return persisted;

      setLiveConfig((current) => ({
        ...current,
        settings: {
          ...current.settings,
          skills: {
            ...current.settings.skills,
            execution: {
              ...current.settings.skills.execution,
              [skillName]: execution,
            },
          },
        },
      }));
      return { ok: true };
    },
    [config.workspace],
  );

  const setSkillsEnabled = useCallback(
    (enabled: boolean) => {
      const persisted = persistSkillsEnabledLocal(config.workspace, enabled);
      if (!persisted.ok) return persisted;
      setLiveConfig((current) => ({
        ...current,
        settings: {
          ...current.settings,
          skills: { ...current.settings.skills, enabled },
        },
      }));
      return { ok: true };
    },
    [config.workspace],
  );

  const setMemoryAutoSave = useCallback(
    (enabled: boolean) => {
      setLiveConfig((c) => ({
        ...c,
        settings: {
          ...c.settings,
          memory: { ...c.settings.memory, autoSave: enabled },
        },
      }));
      persistSettingLocal(config.workspace, 'memory.autoSave', enabled);
    },
    [config.workspace],
  );

  const setShowThinking = useCallback(
    (enabled: boolean) => {
      const result = persistSettingLocal(config.workspace, 'ui.showThinking', enabled);
      if (!result.ok) return result;
      setLiveConfig((current) => ({
        ...current,
        settings: {
          ...current.settings,
          ui: { ...current.settings.ui, showThinking: enabled },
        },
      }));
      return { ok: true };
    },
    [config.workspace],
  );

  const setStartupAnimation = useCallback(
    (enabled: boolean) => {
      const result = persistSettingLocal(config.workspace, 'ui.startupAnimation', enabled);
      if (!result.ok) return result;
      setLiveConfig((current) => ({
        ...current,
        settings: {
          ...current.settings,
          ui: { ...current.settings.ui, startupAnimation: enabled },
        },
      }));
      return { ok: true };
    },
    [config.workspace],
  );

  // Add an allow rule from the "Always allow" approval flow (CC-aligned) and
  // surface it live in settings so the next call is auto-allowed.
  const persistPermissionRule = useCallback(
    (rule: string) => {
      setLiveConfig((c) => {
        const allow = c.settings.permissions.allow.includes(rule)
          ? c.settings.permissions.allow
          : [...c.settings.permissions.allow, rule];
        return {
          ...c,
          settings: {
            ...c.settings,
            permissions: { ...c.settings.permissions, allow },
          },
        };
      });
      persistPermissionRuleLocal(config.workspace, 'allow', rule);
    },
    [config.workspace],
  );

  const setDefaultPermissionMode = useCallback(
    (nextMode: PermissionMode) => {
      const storedMode = nextMode === 'accept-edits' ? 'acceptEdits' : nextMode;
      const result = persistSettingGlobal('defaultMode', storedMode);
      if (!result.ok) return result;
      clearLocalSettings(config.workspace, ['defaultMode']);
      setLiveConfig((current) => ({
        ...current,
        settings: { ...current.settings, defaultMode: storedMode },
      }));
      return { ok: true };
    },
    [config.workspace],
  );

  return {
    messages,
    compactBoundaries,
    contextHistory: contextHistoryRef.current,
    isThinking,
    isCompacting,
    isRewinding,
    compactUi,
    setCompactUi,
    streamingMessageId,
    error,
    currentTurn,
    tokenCount: usage?.totalTokens ?? 0,
    usage,
    mode,
    pendingPermission,
    pendingPlanApproval,
    pendingUserQuestion: pendingUserQuestions[0] ?? null,
    pendingUserQuestionCount: pendingUserQuestions.length,
    agentTodos,
    turnDurationMs,
    retryPhase,
    retryAttempt,
    retryMax,
    retryCountdownMs,
    liveConfig,
    runtime: agentSession.getRuntime(),
    removableProviderIds: ownedProviders.ids,
    removableProviderModelCounts: ownedProviders.modelCounts,
    sessionId,
    sessionName,
    send,
    sendAgentCompletions,
    sendBackgroundShellCompletion,
    clear,
    startNewConversation,
    resumeConversation,
    listSessions,
    endCurrentSession,
    resolvePermission,
    cancelPermission,
    resolvePlanApproval,
    resolveUserQuestion,
    cancel,
    compact,
    rewind,
    getRewindTargets,
    cycleMode,
    addLocalMessage,
    setModel,
    upsertProviderAndSelect,
    removeProvider,
    setEffort,
    setAgentProfileModel,
    setCompactModel,
    setCompactStrategy,
    setSkillActivation,
    setSkillExecution,
    setSkillsEnabled,
    setMemoryAutoSave,
    setShowThinking,
    setStartupAnimation,

    /** Reload the memory snapshot after approve/discard so the next agent turn picks up changes. */
    refreshMemoryContext: () => {
      setLiveConfig((c) => ({
        ...c,
        memoryContext: loadMemoryContext(config.workspace),
      }));
    },

    persistPermissionRule,
    setDefaultPermissionMode,
  };
}
