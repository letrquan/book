import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  Message,
  NestedToolInvocation,
  ToolResult,
  PermissionResult,
  PermissionMode,
  PlanApprovalResult,
  Usage,
  RetryPhase,
  CommandContext,
  SessionMeta,
  SessionRecord,
  SessionStoreInterface,
  CompactResult,
  CompactTrigger,
  LocalCommandDisplay,
  CompactBoundary,
  RewindAction,
  RewindRecordData,
  RewindSnapshotStoreInterface,
  RewindTarget,
  UserQuestionResponse,
} from '../../types.js';
import { resolveContextLimit, shouldCompact, usagePressureTokens } from '../../agent/compact.js';
import { applyModelDefaults, resolveModelProviderConfig } from '../../config.js';
import { createDefaultRegistry } from '../../tools/registry.js';
import type { Todo } from '../../tools/todo.js';
import type { AgentConfig } from '../../types.js';
import { makeMessage, removeTrailingEmptyAssistantPlaceholder } from './streaming-state.js';
import { createDebugLoggerWithCounter, createUiDebugLogger } from '../../debug-log.js';
import { loadMemoryContext } from '../../memory-store.js';
import {
  readSettingsLocal,
  removeProviderLocal,
  persistSettingLocal,
  persistSettingsLocal,
  persistPermissionRuleLocal,
} from '../persist.js';
import { DEFAULT_SETTINGS, providerConfigSchema, type ResolvedSettings } from '../../settings.js';
import { resolveSettings } from '../../settings-loader.js';
import { providerConfigFromDraft, type ProviderSaveRequest } from '../model-options.js';
import type { ProviderRemovalResult } from '../components/ModelPicker.js';
import { updateEffortLevel } from '../../commands/effort.js';
import { observationKey } from '../../tools/file-provenance.js';
import { selectSession, type SessionBootstrap } from '../../session/resolve.js';
import { normalizeWorkspace } from '../../session/store.js';
import { runSessionEnd, runSessionStart } from '../../session/lifecycle.js';
import { AgentSession } from '../../session/agent-session.js';

const log = createDebugLoggerWithCounter('tui:agent');
const uiLog = createUiDebugLogger('tui:agent');
import { createMessageAccumulator } from './message-accumulator.js';
import type { MessageAccumulator } from './message-accumulator.js';

export interface UseAgentSessionOptions extends SessionBootstrap {
  store?: SessionStoreInterface;
  timelineStore?: SessionStoreInterface;
  snapshotStore?: RewindSnapshotStoreInterface;
}

function providerIdFromSelection(selection: string): string | undefined {
  const slash = selection.indexOf('/');
  return slash > 0 ? selection.slice(0, slash) : undefined;
}

function readLocalProviderOwnership(workspace: string): {
  ids: Set<string>;
  modelCounts: Map<string, number>;
} {
  const local = readSettingsLocal(workspace);
  const provider = local.provider;
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
  const [mode, setMode] = useState<PermissionMode>('default');
  const [agentTodos, setAgentTodos] = useState<Todo[]>([]);
  // R1: liveConfig is the mutable config the agent loop reads. `config` (the
  // prop) is the startup snapshot; setModel/setEffort/persistPermissionRule
  // mutate liveConfig so subsequent runAgentLoop calls pick up the change.
  // Without this, /model would silently no-op (send closes over `config`).
  const [liveConfig, setLiveConfig] = useState<AgentConfig>(() => ({
    ...config,
    fileObservationLedger: buildObservationLedger(initialTranscript),
  }));
  const [localProviderOwnership, setLocalProviderOwnership] = useState(() =>
    readLocalProviderOwnership(config.workspace),
  );
  const [agentSession] = useState(() => new AgentSession());
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
  const sessionGenerationRef = useRef(0);
  const lifecycleStartedRef = useRef(false);
  const lifecycleEndedRef = useRef(false);
  const liveConfigRef = useRef(liveConfig);
  const localProviderOwnershipRef = useRef(localProviderOwnership);
  const turnStartRef = useRef(Date.now());
  // Countdown timer ref for retry countdown.
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Message accumulator for batched streaming updates.
  const accumulatorRef = useRef<MessageAccumulator | null>(null);
  const hostUsageRef = useRef<Usage | null>(null);
  const lastHostCompactAttemptRef = useRef<string | null>(null);
  const timelineStore = session.timelineStore ?? session.store;

  useEffect(() => interactions.subscribe(setInteractionSnapshot), [interactions]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    liveConfigRef.current = liveConfig;
  }, [liveConfig]);

  useEffect(() => {
    localProviderOwnershipRef.current = localProviderOwnership;
  }, [localProviderOwnership]);

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
    if (lifecycleStartedRef.current) return;
    lifecycleStartedRef.current = true;
    runSessionStart(liveConfigRef.current, session.sessionId, session.source).catch((err) => {
      log.warn('SessionStart hook failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, [session.sessionId, session.source]);

  useEffect(() => {
    return () => {
      if (lifecycleEndedRef.current) return;
      lifecycleEndedRef.current = true;
      runSessionEnd(liveConfigRef.current, sessionIdRef.current, 'exit').catch((err) => {
        log.warn('SessionEnd hook failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
  }, []);

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
      agentSession.cancel('unmount');
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
        if (snapshot.status !== 'completed' && snapshot.status !== 'failed') return;
        if (snapshot.sessionId !== sessionIdRef.current) return;
        setIsThinking(false);
        clearCountdown();
        setRetryPhase('none');
        setRetryCountdownMs(0);
        if (snapshot.status === 'failed' && snapshot.error) setError(snapshot.error);
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
      sessionGenerationRef.current++;
      accumulatorRef.current?.discard();
      accumulatorRef.current = null;
      if (opts.preserveOperation) interactions.cancelAll('session-reset');
      else agentSession.reset('session-reset');
      clearCountdown();

      sessionIdRef.current = nextId;
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
      setLiveConfig((current) => ({
        ...current,
        tasks: [],
        toolDiscoveryState: undefined,
        fileObservationLedger: buildObservationLedger(transcript),
        memoryContext: current.settings.memory.enabled
          ? loadMemoryContext(current.workspace)
          : undefined,
      }));
    },
    [agentSession, clearCountdown, interactions],
  );

  const endCurrentSession = useCallback(
    async (reason: 'clear' | 'resume' | 'exit' | 'completion') => {
      if (lifecycleEndedRef.current) return;
      lifecycleEndedRef.current = true;
      await runSessionEnd(liveConfigRef.current, sessionIdRef.current, reason);
    },
    [],
  );

  const startNewConversation = useCallback(
    async (previousName?: string) => {
      const oldId = sessionIdRef.current;
      sessionGenerationRef.current++;
      accumulatorRef.current?.discard();
      operations.cancel();
      await endCurrentSession('clear');
      if (previousName && session.store) session.store.patchMeta(oldId, { name: previousName });

      const nextId = session.store
        ? session.store.create({ cwd: liveConfig.workspace })
        : timelineStore
          ? timelineStore.create({ cwd: liveConfig.workspace })
          : crypto.randomUUID();
      if (session.store && timelineStore && timelineStore !== session.store) {
        timelineStore.create({ id: nextId, cwd: liveConfig.workspace });
      }
      lifecycleEndedRef.current = false;
      resetConversationState(nextId, undefined, []);
      await runSessionStart(liveConfigRef.current, nextId, 'clear');
    },
    [
      endCurrentSession,
      liveConfig.workspace,
      operations,
      resetConversationState,
      session.store,
      timelineStore,
    ],
  );

  const resumeConversation = useCallback(
    async (selector: string) => {
      if (!session.store)
        throw new Error('Session persistence is disabled; /resume is unavailable.');
      const selected = selectSession(session.store, selector, liveConfig.workspace);
      if (selected.id === sessionIdRef.current) return;

      const loaded = session.store.load(selected.id);
      sessionGenerationRef.current++;
      accumulatorRef.current?.discard();
      operations.cancel();
      await endCurrentSession('resume');
      session.store.touch(selected.id);
      lifecycleEndedRef.current = false;
      resetConversationState(
        selected.id,
        loaded.meta.name,
        loaded.transcript,
        loaded.contextHistory,
        loaded.compactBoundaries,
        loaded.rewindTargets,
      );
      await runSessionStart(liveConfigRef.current, selected.id, 'resume');
    },
    [endCurrentSession, liveConfig.workspace, operations, resetConversationState, session.store],
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

  const send = useCallback(
    async (userMessage: string, commandContext?: CommandContext) => {
      const operation = agentSession.startSend();
      if (!operation) {
        uiLog.event('send:rejected', {
          reason: operations.activeKind === 'compact' ? 'compacting' : 'already-in-flight',
          len: userMessage.length,
        });
        return;
      }
      setCompactUi(null);

      const generation = sessionGenerationRef.current;
      const activeSessionId = sessionIdRef.current;
      const stillCurrent = () =>
        sessionGenerationRef.current === generation && operation.isCurrent();
      let activeAccumulator: MessageAccumulator | null = null;

      log.info('send message', {
        len: userMessage.length,
        mode,
        hasCommandContext: !!commandContext,
        sessionId: activeSessionId,
      });
      uiLog.event('send:start', {
        len: userMessage.length,
        mode,
        hasCommandContext: !!commandContext,
      });

      // Cross-turn auto-compact before appending the new user message.
      const contextLimit = resolveContextLimit(liveConfig);
      const hostCompactAttemptKey = `${usagePressureTokens(hostUsageRef.current)}:${contextHistoryRef.current.length}`;
      if (
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
            sessionId: activeSessionId,
            transcriptOrdinal: messagesRef.current.length,
            timelineStore,
            isCurrent: stillCurrent,
            onCommitted: projectCompactResult,
            options: {
              trigger: 'auto',
              preContextTokens: usagePressureTokens(hostUsageRef.current),
              upcomingUserIntent: userMessage,
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

      // --- Optimistic, Claude-Code-style update ---
      // Render the user's message IMMEDIATELY, and seed a fresh, empty
      // assistant message that we will stream into. Prior messages are never
      // touched, so they stay visible (scrolled above) while the reply streams.
      const history = contextHistoryRef.current;
      const userMsg = makeMessage('user', userMessage, undefined, true);
      userMsg.kind = 'conversation';
      const placeholder = makeMessage('assistant', '', undefined, true);
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
        const next = [...prev, userMsg, placeholder];
        messagesRef.current = next;
        return next;
      });
      const removeOptimisticMessages = () => {
        setMessages((prev) => {
          const next = prev.filter(
            (message) => message.id !== userMsg.id && message.id !== placeholder.id,
          );
          messagesRef.current = next;
          return next;
        });
      };

      let contextMessage: string;
      try {
        const prepared = await agentSession.prepareSend({
          config: liveConfig,
          sessionId: activeSessionId,
          displayMessage: userMessage,
          userMessage: userMsg,
          snapshotStore: session.snapshotStore,
          timelineStore,
          signal: operation.signal,
          isCurrent: stillCurrent,
        });
        if (prepared.status === 'cancelled') {
          if (stillCurrent()) {
            setIsThinking(false);
            streamingIdRef.current = null;
            setStreamingMessageId(null);
            removeOptimisticMessages();
          }
          agentSession.finishSend(operation);
          return;
        }
        contextMessage = prepared.contextMessage;
        setRewindTargets((current) => [prepared.rewindTarget, ...current]);
      } catch (preflightError) {
        if (stillCurrent()) {
          setError(
            preflightError instanceof Error ? preflightError.message : String(preflightError),
          );
          setIsThinking(false);
          streamingIdRef.current = null;
          setStreamingMessageId(null);
          removeOptimisticMessages();
        }
        agentSession.finishSend(operation);
        return;
      }

      // Create and start the batched message accumulator.
      // All streaming callbacks push to this queue; it flushes at ~60fps.
      activeAccumulator = createMessageAccumulator(placeholder.id, setMessages, messagesRef, 16);
      accumulatorRef.current = activeAccumulator;
      activeAccumulator.start();
      uiLog.event('accumulator:started', { flushIntervalMs: 16 });

      const registry = createDefaultRegistry({
        agents: liveConfig.settings.agents.mode !== 'off',
        ...(timelineStore
          ? {
              sessionHistory: {
                store: timelineStore,
                sessionId: () => sessionIdRef.current,
              },
            }
          : {}),
      });
      try {
        // `history` (pre-user state) is passed as context; the loop pushes its
        // own copy of the user message for API context. We ignore the loop's
        // returned history — the hook's state is authoritative and updated live.
        const updatedHistory = await agentSession.run({
          config: liveConfig,
          registry,
          prompt: contextMessage,
          history,
          mode,
          sessionId: activeSessionId,
          signal: operation.signal,
          isCurrent: stillCurrent,
          callbacks: {
            onEvent: (event) => {
              if (!stillCurrent()) return;
              switch (event.type) {
                case 'text':
                  activeAccumulator?.addText(event.content);
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
            onModeChange: (newMode: PermissionMode) => {
              if (stillCurrent()) setMode(newMode);
            },
            onCompact: async (history, usage) => {
              if (!stillCurrent()) {
                return { status: 'skipped', reason: 'disabled', message: 'Session changed.' };
              }
              // Flush display accumulator so it cannot overwrite a replacement.
              activeAccumulator?.stop();
              const outcome = await agentSession.compact({
                config: liveConfigRef.current,
                history,
                sessionId: activeSessionId,
                transcriptOrdinal: messagesRef.current.length,
                timelineStore,
                isCurrent: stillCurrent,
                onCommitted: projectCompactResult,
                options: {
                  trigger: 'auto',
                  preContextTokens: usagePressureTokens(usage),
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
            onAssistantMessageComplete: (message) => {
              if (!stillCurrent() || !timelineStore) return;
              timelineStore.append(activeSessionId, {
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
            displayMessage: userMessage,
            userMessageId: userMsg.id,
            userMessageTimestamp: userMsg.timestamp,
            userFileObservations: userMsg.fileObservations,
            assistantMessageId: () => streamingIdRef.current ?? undefined,
            allowedTools: commandContext?.allowedTools,
            modelOverride: commandContext?.modelOverride,
            commands: commandContext ? [commandContext.command] : undefined,
            parentSessionId: activeSessionId,
          },
        });
        if (stillCurrent()) {
          // Flush the UI accumulator, but keep its authoritative display state:
          // nested tool traces are display-only and are not present in the loop's
          // returned API history. Assistant turns are persisted via
          // onAssistantMessageComplete (not final-history length slicing).
          activeAccumulator?.stop();
          contextHistoryRef.current = updatedHistory;
        }
      } catch {
        // AgentSession publishes the terminal failure through its snapshot.
      } finally {
        if (stillCurrent()) {
          activeAccumulator?.stop();
          uiLog.event('accumulator:stopped', { reason: 'done' });
          if (accumulatorRef.current === activeAccumulator) accumulatorRef.current = null;
          // Drop a trailing totally-empty assistant placeholder (e.g. cancelled
          // before any tokens/tools). Never strip partial or tool-bearing turns.
          finalizeStreamingMessages();
          streamingIdRef.current = null;
          setStreamingMessageId(null);
        }
        agentSession.finishSend(operation);
        uiLog.event('send:finally', { durationMs: Date.now() - turnStartRef.current });
      }
    },
    [
      liveConfig,
      mode,
      clearCountdown,
      finalizeStreamingMessages,
      timelineStore,
      projectCompactResult,
      session.snapshotStore,
      agentSession,
      operations,
    ],
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
        const outcome = await agentSession.compact({
          config: liveConfigRef.current,
          history: contextHistoryRef.current,
          sessionId: activeSessionId,
          transcriptOrdinal: messagesRef.current.length,
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
    [agentSession, operations, projectCompactResult, timelineStore],
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
    ): Promise<{ ok: true; restoredPrompt?: string } | { ok: false; error: string }> => {
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
          ...(action === 'code' ? {} : { restoredPrompt: target.prompt }),
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
    ];
    setMode((prev) => {
      const idx = modes.indexOf(prev);
      return modes[(idx + 1) % modes.length];
    });
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
  // it to the local settings layer. BOOK_MODEL can still override settings on
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
        const result = persistSettingLocal(config.workspace, 'model', name);
        if (!result.ok) return result;
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
      const result = persistSettingsLocal(config.workspace, {
        [`provider.${providerId}`]: savedProvider,
        ...(activate ? { model: selection } : {}),
      });
      if (!result.ok) return result;

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
      const nextLocalProviderOwnership = {
        ids: new Set(localProviderOwnershipRef.current.ids).add(providerId),
        modelCounts: new Map(localProviderOwnershipRef.current.modelCounts).set(
          providerId,
          Object.keys(savedProvider.models).length,
        ),
      };
      localProviderOwnershipRef.current = nextLocalProviderOwnership;
      setLocalProviderOwnership(nextLocalProviderOwnership);
      return { ok: true };
    },
    [config.workspace],
  );

  const removeProvider = useCallback(
    (providerId: string): ProviderRemovalResult => {
      if (!localProviderOwnershipRef.current.ids.has(providerId)) {
        return { ok: false, error: 'Only workspace-local BYOK providers can be removed.' };
      }

      const persisted = removeProviderLocal(config.workspace, providerId);
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
      const nextLocalProviderIds = new Set(localProviderOwnershipRef.current.ids);
      const nextLocalProviderModelCounts = new Map(localProviderOwnershipRef.current.modelCounts);
      nextLocalProviderIds.delete(providerId);
      nextLocalProviderModelCounts.delete(providerId);
      const nextLocalProviderOwnership = {
        ids: nextLocalProviderIds,
        modelCounts: nextLocalProviderModelCounts,
      };
      localProviderOwnershipRef.current = nextLocalProviderOwnership;
      setLocalProviderOwnership(nextLocalProviderOwnership);

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
    localProviderIds: localProviderOwnership.ids,
    localProviderModelCounts: localProviderOwnership.modelCounts,
    sessionId,
    sessionName,
    send,
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
    setMemoryAutoSave,

    /** Reload the memory snapshot after approve/discard so the next agent turn picks up changes. */
    refreshMemoryContext: () => {
      setLiveConfig((c) => ({
        ...c,
        memoryContext: loadMemoryContext(config.workspace),
      }));
    },

    persistPermissionRule,
  };
}
