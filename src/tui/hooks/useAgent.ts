import { useState, useCallback, useMemo, useRef } from 'react';
import type { Message, ToolCall, ToolResult, PermissionResult, PermissionMode, Usage } from '../../types.js';
import { runAgentLoop } from '../../agent/loop.js';
import { createDefaultRegistry } from '../../tools/registry.js';
import { PermissionStore } from '../permissionStore.js';
import type { AgentConfig } from '../../types.js';

function makeMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
  };
}

export function useAgent(config: AgentConfig) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [mode, setMode] = useState<PermissionMode>('default');
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    resolve: (value: PermissionResult) => void;
  } | null>(null);
  const permissionStore = useMemo(() => new PermissionStore(config.workspace), [config.workspace]);

  // Mutable id of the assistant message currently being streamed into.
  // Callbacks read this ref (not state) so multi-turn updates always target
  // the latest in-progress message without stale-closure issues.
  const streamingIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const patchStreaming = useCallback(
    (patch: (m: Message) => Message) => {
      const id = streamingIdRef.current;
      if (!id) return;
      setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
    },
    [],
  );

  const send = useCallback(
    async (userMessage: string) => {
      if (isThinking) return;

      // --- Optimistic, Claude-Code-style update ---
      // Render the user's message IMMEDIATELY, and seed a fresh, empty
      // assistant message that we will stream into. Prior messages are never
      // touched, so they stay visible (scrolled above) while the reply streams.
      const userMsg = makeMessage('user', userMessage);
      const placeholder = makeMessage('assistant', '');
      streamingIdRef.current = placeholder.id;
      setStreamingMessageId(placeholder.id);
      setIsThinking(true);
      setError(null);
      setCurrentTurn(0);
      setUsage(null);
      setMessages((prev) => [...prev, userMsg, placeholder]);

      const registry = createDefaultRegistry();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // `messages` (pre-user state) is passed as history; the loop pushes its
        // own copy of the user message for API context. We ignore the loop's
        // returned history — the hook's state is authoritative and updated live.
        await runAgentLoop(config, registry, userMessage, messages, {
          onText: (text) => {
            patchStreaming((m) => ({ ...m, content: m.content + text }));
          },
          onToolCall: (call: ToolCall) => {
            patchStreaming((m) => ({
              ...m,
              toolCalls: [...(m.toolCalls ?? []), call],
            }));
          },
          onToolResult: (result: ToolResult) => {
            patchStreaming((m) => ({
              ...m,
              toolResults: [...(m.toolResults ?? []), result],
            }));
          },
          onError: (err) => {
            setError(err);
          },
          onTurnStart: (turn) => {
            setCurrentTurn(turn);
            // Each new agentic turn is its own assistant message, so the
            // previous turn's content stays intact above while we stream a
            // new one below — no overwriting.
            if (turn > 1) {
              const next = makeMessage('assistant', '');
              streamingIdRef.current = next.id;
              setStreamingMessageId(next.id);
              setMessages((prev) => [...prev, next]);
            }
          },
          onDone: () => {
            setIsThinking(false);
          },
          onPermissionRequired: (toolCall: ToolCall): Promise<PermissionResult> => {
            return new Promise((resolve) => {
              setPendingPermission({ toolCall, resolve });
            });
          },
          onUsage: (u: Usage) => {
            setUsage(u);
          },
        }, mode, permissionStore, { signal: controller.signal });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsThinking(false);
        streamingIdRef.current = null;
        setStreamingMessageId(null);
        abortRef.current = null;
      }
    },
    [config, isThinking, messages, mode, patchStreaming, permissionStore],
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
    abortRef.current?.abort();
    abortRef.current = null;
    setIsThinking(false);
    streamingIdRef.current = null;
    setStreamingMessageId(null);
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
    setError(null);
    setCurrentTurn(0);
    setUsage(null);
    setPendingPermission(null);
    streamingIdRef.current = null;
    setStreamingMessageId(null);
  }, []);

  const cycleMode = useCallback(() => {
    const modes: PermissionMode[] = ['default', 'auto', 'plan', 'accept-edits', 'dontAsk', 'bypassPermissions'];
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
    send,
    clear,
    resolvePermission,
    cancelPermission,
    cancel,
    cycleMode,
  };
}
