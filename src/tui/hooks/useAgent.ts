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

const log = createDebugLoggerWithCounter('tui:agent');
const uiLog = createUiDebugLogger('tui:agent');
import { createMessageAccumulator } from './message-accumulator.js';
import type { MessageAccumulator } from './message-accumulator.js';

export function useAgent(config: AgentConfig) {
  const [messages, setMessages] = useState<Message[]>([]);
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
  const messagesRef = useRef<Message[]>([]);
  const turnStartRef = useRef(Date.now());
  // Countdown timer ref for retry countdown.
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Message accumulator for batched streaming updates.
  const accumulatorRef = useRef<MessageAccumulator | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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

  const send = useCallback(
    async (userMessage: string, commandContext?: CommandContext) => {
      if (isThinking) {
        uiLog.event('send:rejected', { reason: 'already-thinking', len: userMessage.length });
        return;
      }

      log.info('send message', {
        len: userMessage.length,
        mode,
        hasCommandContext: !!commandContext,
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
        await runAgentLoop(
          liveConfig,
          registry,
          contextMessage,
          history,
          {
            onText: (text) => {
              accumulatorRef.current?.addText(text);
            },
            onToolCall: (call: ToolCall) => {
              accumulatorRef.current?.addToolCall(call);
            },
            onToolResult: (result: ToolResult) => {
              accumulatorRef.current?.addToolResult(result);
            },
            onTodos: (todos) => {
              setAgentTodos(todos as Todo[]);
            },
            onError: (err) => {
              log.warn('agent error', { error: err });
              setError(err);
            },
            onTurnStart: (turn) => {
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
              log.info('agent done', { durationMs: Date.now() - turnStartRef.current });
              uiLog.event('send:done', { durationMs: Date.now() - turnStartRef.current });
              setTurnDurationMs(Date.now() - turnStartRef.current);
              setIsThinking(false);
              clearCountdown();
            },
            onPermissionRequired: (toolCall: ToolCall): Promise<PermissionResult> => {
              return new Promise((resolve) => {
                uiLog.event('permission:pending', {
                  tool: toolCall.name,
                  id: toolCall.id,
                });
                setPendingPermission({ toolCall, resolve });
              });
            },
            onUsage: (u: Usage) => {
              setUsage(u);
            },
            onModeChange: (newMode: PermissionMode) => {
              setMode(newMode);
            },
            onPlanApprovalRequired: (plan: string): Promise<PlanApprovalResult> => {
              return new Promise((resolve) => {
                uiLog.event('plan-approval:pending', { len: plan.length });
                setPendingPlanApproval({ plan, resolve });
              });
            },
            onRetry: (phase, attempt, max, delayMs) => {
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
                accumulatorRef.current?.addNestedToolCall(invocation);
              },
              onToolResult: (traceId: string, result: ToolResult) => {
                accumulatorRef.current?.addNestedToolResult(traceId, result);
              },
            },
            displayMessage: userMessage,
            allowedTools: commandContext?.allowedTools,
            modelOverride: commandContext?.modelOverride,
            commands: commandContext ? [commandContext.command] : undefined,
          },
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
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
    },
    [liveConfig, isThinking, mode, clearCountdown],
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
    accumulatorRef.current?.stop();
    accumulatorRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsThinking(false);
    streamingIdRef.current = null;
    setStreamingMessageId(null);
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
    send,
    clear,
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
