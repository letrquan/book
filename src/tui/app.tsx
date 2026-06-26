import { Box, Text, useInput } from 'ink';
import { useState, useCallback, useEffect } from 'react';
import { ChatPanel } from './components/ChatPanel.js';
import { InputBar } from './components/InputBar.js';
import { TaskList } from './components/TaskList.js';
import { AgentTodoList } from './components/AgentTodoList.js';
import { useAgent } from './hooks/useAgent.js';
import { useTasks } from './hooks/useTasks.js';
import { ThemeContext } from './theme.js';
import type { AgentConfig } from '../types.js';
import { DEFAULT_THEME } from '../types.js';
import { useTheme } from './theme.js';

interface AppProps {
  config: AgentConfig;
}

export function App({ config }: AppProps) {
  const {
    messages,
    isThinking,
    streamingMessageId,
    error,
    currentTurn,
    tokenCount,
    mode,
    pendingPermission,
    agentTodos,
    send,
    clear,
    resolvePermission,
    cancelPermission,
    cancel,
    compact,
    cycleMode,
  } = useAgent(config);

  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const { tasks, addTask, updateTaskStatus, removeTask } = useTasks();
  const theme = useTheme();

  useInput((input, key) => {
    // Escape cancels a pending permission, or aborts an in-flight stream.
    if (key.escape) {
      if (pendingPermission) {
        cancelPermission();
        return;
      }
      if (isThinking) {
        cancel();
        return;
      }
    }
    // Ctrl+T — toggle task list
    if (key.ctrl && input === 't') {
      setShowTasks((s) => !s);
      return;
    }
    // Alt+M — cycle mode (alternate)
    if (key.meta && input === 'm') {
      cycleMode();
      return;
    }
    // Ctrl+L — redraw (simulated by Ink re-render)
    if (key.ctrl && input === 'l') {
      // Ink handles this naturally
      return;
    }
    // Ctrl+E — toggle expand/collapse for current tool (handled per-tool in ToolCallBlock)
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
      } else if (value.startsWith('/compact')) {
        compact();
      } else if (value.startsWith('/exit')) {
        process.exit(0);
      } else if (value.startsWith('/task ')) {
        addTask({ subject: value.slice(6), status: 'pending' });
      } else {
        send(value);
      }
    },
    [send, clear, addTask],
  );

  return (
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <Box flexDirection="column" padding={1} height={process.stdout.rows}>
        <ChatPanel
          messages={messages}
          streamingMessageId={streamingMessageId}
          pendingPermission={pendingPermission}
          onResolvePermission={resolvePermission}
          activeToolCallId={expandedToolId}
          reducedMotion={config.accessibility?.reducedMotion}
          screenReader={config.accessibility?.screenReader}
        />
        {error && (
          <Box>
            <Text color={theme.error}>{error}</Text>
          </Box>
        )}
        {agentTodos.length > 0 && <AgentTodoList todos={agentTodos} />}
        {showTasks && (
          <TaskList
            tasks={tasks}
            onUpdateStatus={updateTaskStatus}
            onRemove={removeTask}
          />
        )}
        <InputBar
          onSubmit={handleSubmit}
          disabled={isThinking || pendingPermission !== null}
          mode={mode}
          onCycleMode={cycleMode}
        />
      </Box>
    </ThemeContext.Provider>
  );
}
