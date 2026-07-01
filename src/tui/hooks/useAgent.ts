import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  Message,
  ToolCall,
  ToolResult,
  PermissionResult,
  PermissionMode,
  Usage,
  RetryPhase,
} from '../../types.js';
import { runAgentLoop } from '../../agent/loop.js';
import { createDefaultRegistry } from '../../tools/registry.js';
import type { Todo } from '../../tools/todo.js';
import type { AgentConfig } from '../../types.js';
import { makeMessage } from './streaming-state.js';
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
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    resolve: (value: PermissionResult) => void;
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
    async (userMessage: string) => {
      if (isThinking) return;

      // --- Optimistic, Claude-Code-style update ---
      // Render the user's message IMMEDIATELY, and seed a fresh, empty
      // assistant message that we will stream into. Prior messages are never
      // touched, so they stay visible (scrolled above) while the reply streams.
      const history = messagesRef.current;
      const userMsg = makeMessage('user', userMessage);
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
      // All streaming callbacks push to this queue; it flushes near 30fps.
      accumulatorRef.current = createMessageAccumulator(
        placeholder.id,
        setMessages,
        messagesRef,
        32,
      );
      accumulatorRef.current.start();

      const registry = createDefaultRegistry();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // `history` (pre-user state) is passed as context; the loop pushes its
        // own copy of the user message for API context. We ignore the loop's
        // returned history — the hook's state is authoritative and updated live.
        await runAgentLoop(
          config,
          registry,
          userMessage,
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
              setError(err);
            },
            onTurnStart: (turn) => {
              setCurrentTurn(turn);
              turnStartRef.current = Date.now();
              // Each new agentic turn is its own assistant message, so the
              // previous turn's content stays intact above while we stream a
              // new one below — no overwriting.
              if (turn > 1) {
                // Stop the old accumulator (flushes remaining ops, syncs messagesRef).
                accumulatorRef.current?.stop();
                const next = makeMessage('assistant', '');
                streamingIdRef.current = next.id;
                setStreamingMessageId(next.id);
                setMessages((prev) => {
                  const updated = [...prev, next];
                  messagesRef.current = updated;
                  return updated;
                });
                // Start a new accumulator for the new message.
                accumulatorRef.current = createMessageAccumulator(
                  next.id,
                  setMessages,
                  messagesRef,
                  32,
                );
                accumulatorRef.current.start();
              }
            },
            onDone: () => {
              setTurnDurationMs(Date.now() - turnStartRef.current);
              setIsThinking(false);
              clearCountdown();
            },
            onPermissionRequired: (toolCall: ToolCall): Promise<PermissionResult> => {
              return new Promise((resolve) => {
                setPendingPermission({ toolCall, resolve });
              });
            },
            onUsage: (u: Usage) => {
              setUsage(u);
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
          },
          mode,
          { signal: controller.signal },
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        accumulatorRef.current?.stop();
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
    [config, isThinking, mode, clearCountdown],
  );

  const resolvePermission = useCallback(
    (result: PermissionResult) => {
      if (pendingPermission) {
        pendingPermission.resolve(result);
        setPendingPermission(null);
      }
    },
    [pendingPermission],
  );

  const cancelPermission = useCallback(() => {
    if (pendingPermission) {
      pendingPermission.resolve('deny');
      setPendingPermission(null);
    }
  }, [pendingPermission]);

  // Abort the in-flight agent stream (Esc while thinking).
  const cancel = useCallback(() => {
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
    const { chatCompletionStream } = await import('../../provider/openai-compatible.js');
    let summary = '';
    try {
      const stream = chatCompletionStream(
        config,
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
  }, [config, messages]);

  const clear = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
    setError(null);
    setCurrentTurn(0);
    setUsage(null);
    setAgentTodos([]);
    setPendingPermission(null);
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

  return {
    messages,
    isThinking,
    streamingMessageId,
    error,
    currentTurn,
    tokenCount: usage?.totalTokens ?? 0,
    mode,
    pendingPermission,
    agentTodos,
    turnDurationMs,
    retryPhase,
    retryAttempt,
    retryMax,
    retryCountdownMs,
    send,
    clear,
    resolvePermission,
    cancelPermission,
    cancel,
    compact,
    cycleMode,
  };
}
