import { useState, useCallback, useRef } from 'react';
import type { Message, ToolCall, ToolResult, PermissionResult, PermissionMode } from '../../types.js';
import { runAgentLoop } from '../../agent/loop.js';
import { createDefaultRegistry } from '../../tools/registry.js';
import type { AgentConfig } from '../../types.js';

export function useAgent(config: AgentConfig) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [tokenCount, setTokenCount] = useState(0);
  const [mode, setMode] = useState<PermissionMode>('default');
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    resolve: (value: PermissionResult) => void;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (userMessage: string) => {
      if (isThinking) return;
      setIsThinking(true);
      setError(null);
      setStreamedText('');
      setCurrentTurn(0);
      setTokenCount(0);

      const registry = createDefaultRegistry();

      try {
        const newHistory = await runAgentLoop(config, registry, userMessage, messages, {
          onText: (text) => {
            setStreamedText((prev) => prev + text);
          },
          onToolCall: (_call: ToolCall) => {},
          onToolResult: (_result: ToolResult) => {},
          onError: (err) => {
            setError(err);
          },
          onTurnStart: (turn) => {
            setCurrentTurn(turn);
          },
          onDone: () => {
            setIsThinking(false);
          },
          onPermissionRequired: (toolCall: ToolCall): Promise<PermissionResult> => {
            return new Promise((resolve) => {
              setPendingPermission({ toolCall, resolve });
            });
          },
          onTokenCount: (count: number) => {
            setTokenCount((prev) => prev + count);
          },
        }, mode);
        setMessages(newHistory);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setIsThinking(false);
      }
    },
    [config, isThinking, messages, mode],
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

  const clear = useCallback(() => {
    setMessages([]);
    setError(null);
    setStreamedText('');
    setCurrentTurn(0);
    setTokenCount(0);
    setPendingPermission(null);
  }, []);

  const cycleMode = useCallback(() => {
    const modes: PermissionMode[] = ['default', 'auto', 'plan', 'accept-edits'];
    setMode((prev) => {
      const idx = modes.indexOf(prev);
      return modes[(idx + 1) % modes.length];
    });
  }, []);

  return {
    messages,
    isThinking,
    streamedText,
    error,
    currentTurn,
    tokenCount,
    mode,
    pendingPermission,
    send,
    clear,
    resolvePermission,
    cancelPermission,
    cycleMode,
  };
}
