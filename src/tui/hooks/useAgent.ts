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
import { makeMessage, removeTrailingEmptyAssistantPlaceholder } from './streaming-state.js';
import { createDebugLoggerWithCounter, createUiDebugLogger } from '../../debug-log.js';
import { loadMemoryContext } from '../../memory-store.js';
import { persistSettingLocal, persistPermissionRuleLocal } from '../persist.js';
import { expandAtMentions, expandShellCommands } from '../input-expansion.js';

const log = createDebugLoggerWithCounter('tui:agent');
const uiLog = createUiDebugLogger('tui:agent');
import { createMessageAccumulator } from './message-accumulator.js';
import type { MessageAccumulator } from './message-accumulator.js';

type PendingPermission = {
  toolCall: ToolCall;
  resolve: (value: PermissionResult) => void;
};

type PendingPlanApproval = {
  plan: string;
  resolve: (value: PlanApprovalResult) => void;
};

/**
 * Idempotent permission settlement used by resolve/cancel/clear/unmount.
 * Exported for pure unit tests of the lifecycle contract.
 */
export function settlePermissionRequest(
  pendingRef: { current: PendingPermission | null },
  setPending: (value: PendingPermission | null) => void,
  result: PermissionResult,
  via: string,
): boolean {
  const pending = pendingRef.current;
  if (!pending) {
    uiLog.event('permission:settled:noop', { reason: 'no-pending', result, via });
    return false;
  }
  // Clear ref first so a re-entrant call cannot double-resolve.
  pendingRef.current = null;
  setPending(null);
  uiLog.event('permission:settled', {
    tool: pending.toolCall.name,
    id: pending.toolCall.id,
    result,
    via,
  });
  pending.resolve(result);
  return true;
}

/**
 * Idempotent plan-approval settlement used by resolve/cancel/clear/unmount.
 * Exported for pure unit tests of the lifecycle contract.
 */
export function settlePlanApprovalRequest(
  pendingRef: { current: PendingPlanApproval | null },
  setPending: (value: PendingPlanApproval | null) => void,
  result: PlanApprovalResult,
  via: string,
): boolean {
  const pending = pendingRef.current;
  if (!pending) {
    uiLog.event('plan-approval:settled:noop', { reason: 'no-pending', result, via });
    return false;
  }
  pendingRef.current = null;
  setPending(null);
  uiLog.event('plan-approval:settled', { result, via, len: pending.plan.length });
  pending.resolve(result);
  return true;
}

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
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [pendingPlanApproval, setPendingPlanApproval] = useState<PendingPlanApproval | null>(null);
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
  // Synchronous single-flight lock for send(). isThinking is UI-only and may
  // lag a render; this ref is the authoritative gate. Cancel aborts the stream
  // but leaves the lock held until send()'s finally block releases it.
  const sendInFlightRef = useRef(false);
  // Resolve handles for pending interactive prompts (refs for idempotent settle).
  const pendingPermissionRef = useRef<PendingPermission | null>(null);
  const pendingPlanApprovalRef = useRef<PendingPlanApproval | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const settlePermission = useCallback((result: PermissionResult, via: string) => {
    return settlePermissionRequest(pendingPermissionRef, setPendingPermission, result, via);
  }, []);

  const settlePlanApproval = useCallback((result: PlanApprovalResult, via: string) => {
    return settlePlanApprovalRequest(pendingPlanApprovalRef, setPendingPlanApproval, result, via);
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
      abortRef.current?.abort();
      abortRef.current = null;
      // Deny/reject so agent-loop promises never hang after unmount.
      settlePermissionRequest(pendingPermissionRef, () => {}, 'deny', 'unmount');
      settlePlanApprovalRequest(pendingPlanApprovalRef, () => {}, 'reject', 'unmount');
    };
  }, []);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  const finalizeStreamingMessages = useCallback(() => {
    setMessages((prev) => {
      const next = removeTrailingEmptyAssistantPlaceholder(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  const send = useCallback(
    async (userMessage: string, commandContext?: CommandContext) => {
      // Synchronous single-flight: reject concurrent sends even if React has
      // not yet committed isThinking=true from a prior call.
      if (sendInFlightRef.current) {
        uiLog.event('send:rejected', { reason: 'already-in-flight', len: userMessage.length });
        return;
      }
      sendInFlightRef.current = true;

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
              // UI may stop showing the spinner early; the single-flight lock
              // stays held until finally so a concurrent send cannot start yet.
              setIsThinking(false);
              clearCountdown();
            },
            onPermissionRequired: (toolCall: ToolCall): Promise<PermissionResult> => {
              return new Promise((resolve) => {
                uiLog.event('permission:pending', {
                  tool: toolCall.name,
                  id: toolCall.id,
                });
                const entry: PendingPermission = { toolCall, resolve };
                pendingPermissionRef.current = entry;
                setPendingPermission(entry);
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
                const entry: PendingPlanApproval = { plan, resolve };
                pendingPlanApprovalRef.current = entry;
                setPendingPlanApproval(entry);
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
        // Drop a trailing totally-empty assistant placeholder (e.g. cancelled
        // before any tokens/tools). Never strip partial or tool-bearing turns.
        finalizeStreamingMessages();
        setIsThinking(false);
        streamingIdRef.current = null;
        setStreamingMessageId(null);
        abortRef.current = null;
        clearCountdown();
        setRetryPhase('none');
        setRetryCountdownMs(0);
        // Release single-flight only after full cleanup so cancel cannot race a
        // new send while this invocation is still unwinding.
        sendInFlightRef.current = false;
        uiLog.event('send:finally', { durationMs: Date.now() - turnStartRef.current });
      }
    },
    [liveConfig, mode, clearCountdown, finalizeStreamingMessages],
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

  // Abort the in-flight agent stream (Esc while thinking).
  // Lock stays held until send()'s finally; only the abort signal is raised.
  const cancel = useCallback(() => {
    const hadAbort = abortRef.current !== null;
    const hadAccumulator = accumulatorRef.current !== null;
    const inFlight = sendInFlightRef.current;
    uiLog.event('cancel', { hadAbort, hadAccumulator, inFlight });
    settlePermission('deny', 'cancel');
    settlePlanApproval('reject', 'cancel');
    abortRef.current?.abort();
    // Do not null abortRef / release sendInFlightRef / stop accumulator here —
    // finally owns that so concurrent send cannot slip through mid-unwind.
    clearCountdown();
    setRetryPhase('none');
  }, [clearCountdown, settlePermission, settlePlanApproval]);

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
    // Abort + stop accumulator BEFORE wiping message state so no late flush
    // can resurrect content into a cleared conversation.
    accumulatorRef.current?.stop();
    accumulatorRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    settlePermission('deny', 'clear');
    settlePlanApproval('reject', 'clear');
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
    // isThinking / sendInFlightRef are released by send()'s finally after abort.
    // If nothing is in flight they are already false.
    if (!sendInFlightRef.current) {
      setIsThinking(false);
    }
    clearCountdown();
    setRetryPhase('none');
    setRetryCountdownMs(0);
  }, [clearCountdown, settlePermission, settlePlanApproval]);

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
  const addLocalMessage = useCallback((text: string) => {
    if (sendInFlightRef.current || isThinking) {
      uiLog.event('local-message:blocked', {
        reason: sendInFlightRef.current ? 'in-flight' : 'is-thinking',
        preview: text.slice(0, 40),
      });
      return; // don't clobber a streaming turn
    }
    uiLog.event('local-message:added', { preview: text.slice(0, 40) });
    const msg = makeMessage('assistant', text);
    setMessages((prev) => {
      const next = [...prev, msg];
      messagesRef.current = next;
      return next;
    });
  }, [isThinking]);

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
