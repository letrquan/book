import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  Message,
  NestedToolInvocation,
  ToolCall,
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
} from '../../types.js';
import { runAgentLoop } from '../../agent/loop.js';
import { applyModelDefaults, resolveModelProviderConfig } from '../../config.js';
import { createDefaultRegistry } from '../../tools/registry.js';
import type { Todo } from '../../tools/todo.js';
import type { AgentConfig } from '../../types.js';
import { makeMessage } from './streaming-state.js';
import { createDebugLoggerWithCounter, createUiDebugLogger } from '../../debug-log.js';
import { loadMemoryContext } from '../../memory-store.js';
import { persistSettingLocal, persistPermissionRuleLocal } from '../persist.js';
import { expandAtMentions, expandShellCommands } from '../input-expansion.js';
import { selectSession, type SessionBootstrap } from '../../session/resolve.js';
import { normalizeWorkspace } from '../../session/store.js';
import { runSessionEnd, runSessionStart } from '../../session/lifecycle.js';

const log = createDebugLoggerWithCounter('tui:agent');
const uiLog = createUiDebugLogger('tui:agent');
import { createMessageAccumulator } from './message-accumulator.js';
import type { MessageAccumulator } from './message-accumulator.js';

export interface UseAgentSessionOptions extends SessionBootstrap {
  store?: SessionStoreInterface;
}

export function useAgent(config: AgentConfig, session: UseAgentSessionOptions) {
  const [messages, setMessages] = useState<Message[]>(session.history);
  const [isThinking, setIsThinking] = useState(false);
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
  const [liveConfig, setLiveConfig] = useState<AgentConfig>(config);
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    resolve: (value: PermissionResult) => void;
  } | null>(null);
  const [pendingPlanApproval, setPendingPlanApproval] = useState<{
    plan: string;
    resolve: (value: PlanApprovalResult) => void;
  } | null>(null);
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
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<Message[]>(session.history);
  const sessionIdRef = useRef(session.sessionId);
  const sessionGenerationRef = useRef(0);
  const lifecycleStartedRef = useRef(false);
  const lifecycleEndedRef = useRef(false);
  const liveConfigRef = useRef(liveConfig);
  const pendingPermissionRef = useRef(pendingPermission);
  const pendingPlanApprovalRef = useRef(pendingPlanApproval);
  const turnStartRef = useRef(Date.now());
  // Countdown timer ref for retry countdown.
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Message accumulator for batched streaming updates.
  const accumulatorRef = useRef<MessageAccumulator | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    liveConfigRef.current = liveConfig;
  }, [liveConfig]);

  useEffect(() => {
    pendingPermissionRef.current = pendingPermission;
  }, [pendingPermission]);

  useEffect(() => {
    pendingPlanApprovalRef.current = pendingPlanApproval;
  }, [pendingPlanApproval]);

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

  // Clean up countdown timer on unmount.
  useEffect(() => {
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    };
  }, []);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  const resetConversationState = useCallback(
    (nextId: string, nextName: string | undefined, history: Message[]) => {
      sessionGenerationRef.current++;
      pendingPermissionRef.current?.resolve('deny');
      pendingPlanApprovalRef.current?.resolve('reject');
      pendingPermissionRef.current = null;
      pendingPlanApprovalRef.current = null;
      accumulatorRef.current?.discard();
      accumulatorRef.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      clearCountdown();

      sessionIdRef.current = nextId;
      messagesRef.current = history;
      streamingIdRef.current = null;
      setSessionId(nextId);
      setSessionName(nextName);
      setMessages(history);
      setIsThinking(false);
      setStreamingMessageId(null);
      setError(null);
      setCurrentTurn(0);
      setUsage(null);
      setAgentTodos([]);
      setPendingPermission(null);
      setPendingPlanApproval(null);
      setTurnDurationMs(0);
      setRetryPhase('none');
      setRetryAttempt(0);
      setRetryMax(0);
      setRetryCountdownMs(0);
      setLiveConfig((current) => ({
        ...current,
        tasks: [],
        memoryContext: current.settings.memory.enabled
          ? loadMemoryContext(current.workspace)
          : undefined,
      }));
    },
    [clearCountdown],
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
      abortRef.current?.abort();
      await endCurrentSession('clear');
      if (previousName && session.store) session.store.patchMeta(oldId, { name: previousName });

      const nextId = session.store
        ? session.store.create({ cwd: liveConfig.workspace })
        : crypto.randomUUID();
      lifecycleEndedRef.current = false;
      resetConversationState(nextId, undefined, []);
      await runSessionStart(liveConfigRef.current, nextId, 'clear');
    },
    [endCurrentSession, liveConfig, resetConversationState, session.store],
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
      abortRef.current?.abort();
      await endCurrentSession('resume');
      session.store.touch(selected.id);
      lifecycleEndedRef.current = false;
      resetConversationState(selected.id, loaded.meta.name, loaded.history);
      await runSessionStart(liveConfigRef.current, selected.id, 'resume');
    },
    [endCurrentSession, liveConfig, resetConversationState, session.store],
  );

  const listSessions = useCallback((): SessionMeta[] => {
    if (!session.store) return [];
    const cwd = normalizeWorkspace(liveConfig.workspace);
    return session.store.list().filter((meta) => meta.cwd === cwd);
  }, [liveConfig.workspace, session.store]);

  const send = useCallback(
    async (userMessage: string, commandContext?: CommandContext) => {
      if (isThinking) {
        uiLog.event('send:rejected', { reason: 'already-thinking', len: userMessage.length });
        return;
      }

      const generation = sessionGenerationRef.current;
      const activeSessionId = sessionIdRef.current;
      const stillCurrent = () => sessionGenerationRef.current === generation;

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

      const contextMessage = expandShellCommands(
        expandAtMentions(userMessage, liveConfig.workspace),
        liveConfig.workspace,
      );

      // --- Optimistic, Claude-Code-style update ---
      // Render the user's message IMMEDIATELY, and seed a fresh, empty
      // assistant message that we will stream into. Prior messages are never
      // touched, so they stay visible (scrolled above) while the reply streams.
      const history = messagesRef.current;
      const userMsg = makeMessage(
        'user',
        userMessage,
        contextMessage === userMessage ? undefined : contextMessage,
      );
      if (session.store) {
        session.store.append(activeSessionId, {
          type: 'user',
          timestamp: userMsg.timestamp,
          data: { content: userMessage, contextContent: userMsg.contextContent },
        } satisfies SessionRecord);
      }
      const placeholder = makeMessage('assistant', '');
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

      // Create and start the batched message accumulator.
      // All streaming callbacks push to this queue; it flushes at ~60fps.
      accumulatorRef.current = createMessageAccumulator(
        placeholder.id,
        setMessages,
        messagesRef,
        16,
      );
      accumulatorRef.current.start();
      uiLog.event('accumulator:started', { flushIntervalMs: 16 });

      const registry = createDefaultRegistry();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // `history` (pre-user state) is passed as context; the loop pushes its
        // own copy of the user message for API context. We ignore the loop's
        // returned history — the hook's state is authoritative and updated live.
        const updatedHistory = await runAgentLoop(
          liveConfig,
          registry,
          contextMessage,
          history,
          {
            onText: (text) => {
              if (stillCurrent()) accumulatorRef.current?.addText(text);
            },
            onToolCall: (call: ToolCall) => {
              if (stillCurrent()) accumulatorRef.current?.addToolCall(call);
            },
            onToolResult: (result: ToolResult) => {
              if (stillCurrent()) accumulatorRef.current?.addToolResult(result);
            },
            onTodos: (todos) => {
              if (stillCurrent()) setAgentTodos(todos as Todo[]);
            },
            onError: (err) => {
              if (!stillCurrent()) return;
              log.warn('agent error', { error: err });
              setError(err);
            },
            onTurnStart: (turn) => {
              if (!stillCurrent()) return;
              log.debug('TUI turn start', { turn });
              setCurrentTurn(turn);
              turnStartRef.current = Date.now();
              if (turn > 1) {
                accumulatorRef.current?.stop();
                uiLog.event('accumulator:stopped', { reason: 'new-turn', turn });
                const next = makeMessage('assistant', '');
                streamingIdRef.current = next.id;
                setStreamingMessageId(next.id);
                setMessages((prev) => {
                  const updated = [...prev, next];
                  messagesRef.current = updated;
                  return updated;
                });
                accumulatorRef.current = createMessageAccumulator(
                  next.id,
                  setMessages,
                  messagesRef,
                  32,
                );
                accumulatorRef.current.start();
                uiLog.event('accumulator:started', { flushIntervalMs: 32, turn });
              }
            },
            onDone: () => {
              if (!stillCurrent()) return;
              log.info('agent done', { durationMs: Date.now() - turnStartRef.current });
              uiLog.event('send:done', { durationMs: Date.now() - turnStartRef.current });
              setTurnDurationMs(Date.now() - turnStartRef.current);
              setIsThinking(false);
              clearCountdown();
            },
            onPermissionRequired: (toolCall: ToolCall): Promise<PermissionResult> => {
              if (!stillCurrent()) return Promise.resolve('deny');
              return new Promise((resolve) => {
                uiLog.event('permission:pending', {
                  tool: toolCall.name,
                  id: toolCall.id,
                });
                const pending = { toolCall, resolve };
                pendingPermissionRef.current = pending;
                setPendingPermission(pending);
              });
            },
            onUsage: (u: Usage) => {
              if (stillCurrent()) setUsage(u);
            },
            onModeChange: (newMode: PermissionMode) => {
              if (stillCurrent()) setMode(newMode);
            },
            onPlanApprovalRequired: (plan: string): Promise<PlanApprovalResult> => {
              if (!stillCurrent()) return Promise.resolve('reject');
              return new Promise((resolve) => {
                uiLog.event('plan-approval:pending', { len: plan.length });
                const pending = { plan, resolve };
                pendingPlanApprovalRef.current = pending;
                setPendingPlanApproval(pending);
              });
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
          mode,
          {
            signal: controller.signal,
            nestedToolObserver: {
              onToolCall: (invocation: NestedToolInvocation) => {
                if (stillCurrent()) accumulatorRef.current?.addNestedToolCall(invocation);
              },
              onToolResult: (traceId: string, result: ToolResult) => {
                if (stillCurrent()) accumulatorRef.current?.addNestedToolResult(traceId, result);
              },
            },
            manageSessionHooks: false,
            displayMessage: userMessage,
            allowedTools: commandContext?.allowedTools,
            modelOverride: commandContext?.modelOverride,
            commands: commandContext ? [commandContext.command] : undefined,
          },
        );
        if (stillCurrent()) {
          accumulatorRef.current?.stop();
          messagesRef.current = updatedHistory;
          setMessages(updatedHistory);

          if (session.store) {
            for (const assistant of updatedHistory.slice(history.length)) {
              if (assistant.role !== 'assistant') continue;
              session.store.append(activeSessionId, {
                type: 'assistant',
                timestamp: assistant.timestamp,
                data: {
                  complete: true,
                  content: assistant.content,
                  toolCalls: assistant.toolCalls,
                  toolResults: assistant.toolResults,
                },
              } satisfies SessionRecord);
            }
          }
        }
      } catch (e) {
        if (stillCurrent()) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (stillCurrent()) {
          accumulatorRef.current?.stop();
          uiLog.event('accumulator:stopped', { reason: 'done' });
          accumulatorRef.current = null;
          setIsThinking(false);
          streamingIdRef.current = null;
          setStreamingMessageId(null);
          abortRef.current = null;
          clearCountdown();
          setRetryPhase('none');
          setRetryCountdownMs(0);
        }
      }
    },
    [liveConfig, isThinking, mode, clearCountdown, session.store],
  );

  const resolvePermission = useCallback(
    (result: PermissionResult) => {
      if (pendingPermission) {
        uiLog.event('permission:resolved', {
          tool: pendingPermission.toolCall.name,
          result,
        });
        pendingPermission.resolve(result);
        setPendingPermission(null);
      } else {
        uiLog.event('permission:resolved:noop', { reason: 'no-pending', result });
      }
    },
    [pendingPermission],
  );

  const cancelPermission = useCallback(() => {
    if (pendingPermission) {
      uiLog.event('permission:cancelled', { tool: pendingPermission.toolCall.name });
      pendingPermission.resolve('deny');
      setPendingPermission(null);
    } else {
      uiLog.event('permission:cancelled:noop', { reason: 'no-pending' });
    }
  }, [pendingPermission]);

  const resolvePlanApproval = useCallback(
    (result: PlanApprovalResult) => {
      if (pendingPlanApproval) {
        uiLog.event('plan-approval:resolved', { result });
        pendingPlanApproval.resolve(result);
        setPendingPlanApproval(null);
      } else {
        uiLog.event('plan-approval:resolved:noop', { reason: 'no-pending', result });
      }
    },
    [pendingPlanApproval],
  );

  // Abort the in-flight agent stream (Esc while thinking).
  const cancel = useCallback(() => {
    const hadAbort = abortRef.current !== null;
    const hadAccumulator = accumulatorRef.current !== null;
    uiLog.event('cancel', { hadAbort, hadAccumulator });
    abortRef.current?.abort();
    clearCountdown();
    setRetryPhase('none');
  }, [clearCountdown]);

  // Manually compact the conversation (summarize older turns).
  const compact = useCallback(async () => {
    if (messages.length <= 4) return;
    const { compactHistory, buildCompactPrompt } = await import('../../agent/compact.js');
    const { kept, summarized } = compactHistory(messages, 4);
    if (summarized.length === 0) return;
    // Summarize via a one-shot provider call.
    const { chatCompletionStream } = await import('../../provider/index.js');
    let summary = '';
    try {
      const stream = chatCompletionStream(
        liveConfig,
        [
          {
            role: 'system',
            content: 'You are a conversation summarizer. Produce a concise prose summary.',
          },
          { role: 'user', content: buildCompactPrompt(summarized) },
        ],
        [],
      );
      for await (const ev of stream) {
        if (ev.type === 'text' && ev.content) summary += ev.content;
      }
    } catch {
      return; // non-fatal
    }
    const summaryMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: `[Compacted summary of earlier conversation]\n${summary}`,
      timestamp: Date.now(),
    };
    const compactedMessages = [summaryMsg, ...kept];
    messagesRef.current = compactedMessages;
    setMessages(compactedMessages);
  }, [liveConfig, messages]);

  const clear = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
    setError(null);
    setCurrentTurn(0);
    setUsage(null);
    setAgentTodos([]);
    setPendingPermission(null);
    setPendingPlanApproval(null);
    streamingIdRef.current = null;
    setStreamingMessageId(null);
    clearCountdown();
    setRetryPhase('none');
  }, [clearCountdown]);

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
    (text: string) => {
      if (isThinking) {
        uiLog.event('local-message:blocked', { reason: 'is-thinking', preview: text.slice(0, 40) });
        return; // don't clobber a streaming turn
      }
      uiLog.event('local-message:added', { preview: text.slice(0, 40) });
      const msg = makeMessage('assistant', text);
      setMessages((prev) => {
        const next = [...prev, msg];
        messagesRef.current = next;
        return next;
      });
    },
    [isThinking],
  );

  // Switch the active model for the rest of the session and persist it to the
  // local settings layer. (BOOK_MODEL env, if set, overrides settings on the
  // next startup — app.tsx surfaces that warning, not here.)
  const setModel = useCallback(
    (name: string) => {
      setLiveConfig((c) => applyModelDefaults(resolveModelProviderConfig(c, name)));
      persistSettingLocal(config.workspace, 'model', name);
    },
    [config.workspace],
  );

  const setEffort = useCallback(
    (level: AgentConfig['effort']) => {
      setLiveConfig((c) => ({ ...c, effort: level, effortExplicit: true }));
      persistSettingLocal(config.workspace, 'effort', level);
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
    isThinking,
    streamingMessageId,
    error,
    currentTurn,
    tokenCount: usage?.totalTokens ?? 0,
    usage,
    mode,
    pendingPermission,
    pendingPlanApproval,
    agentTodos,
    turnDurationMs,
    retryPhase,
    retryAttempt,
    retryMax,
    retryCountdownMs,
    liveConfig,
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
    cancel,
    compact,
    cycleMode,
    addLocalMessage,
    setModel,
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
