import { Box, Text, useInput } from 'ink';
import { useState, useCallback, useEffect } from 'react';
import { ChatPanel } from './components/ChatPanel.js';
import { InputBar } from './components/InputBar.js';
import { StatusLine } from './components/StatusLine.js';
import { useAgent } from './hooks/useAgent.js';
import type { AgentConfig } from '../types.js';

interface AppProps {
  config: AgentConfig;
}

export function App({ config }: AppProps) {
  const {
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
  } = useAgent(config);

  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);

  const streamingMessage = isThinking
    ? messages[messages.length - 1]
    : undefined;

  useInput((_input, key) => {
    if (key.escape && pendingPermission) {
      cancelPermission();
    }
  });

  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'assistant' && lastMsg.toolCalls?.length) {
      const latestTool = lastMsg.toolCalls[lastMsg.toolCalls.length - 1];
      if (!lastMsg.toolResults?.find(r => r.toolCallId === latestTool.id)) {
        setExpandedToolId(latestTool.id);
      }
    } else {
      setExpandedToolId(null);
    }
  }, [messages]);

  const handleSubmit = useCallback(
    (value: string) => {
      if (value.startsWith('/clear')) {
        clear();
      } else if (value.startsWith('/exit')) {
        process.exit(0);
      } else {
        send(value);
      }
    },
    [send, clear],
  );

  return (
    <Box flexDirection="column" padding={1} height={process.stdout.rows}>
      <ChatPanel
        messages={messages}
        streamingMessage={streamingMessage}
        streamedText={streamedText}
        pendingPermission={pendingPermission}
        onResolvePermission={resolvePermission}
        activeToolCallId={expandedToolId}
      />
      {error && (
        <Box>
          <Text color="red">{error}</Text>
        </Box>
      )}
      <StatusLine
        model={config.model}
        currentTurn={currentTurn}
        maxTurns={config.maxTurns}
        tokenCount={tokenCount}
        workspace={config.workspace}
      />
      <InputBar
        onSubmit={handleSubmit}
        disabled={isThinking || pendingPermission !== null}
        mode={mode}
        onCycleMode={cycleMode}
      />
    </Box>
  );
}
