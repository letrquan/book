import { Box, Text, useInput, useStdout, useApp } from 'ink';
import { useState, useCallback, useEffect, useMemo } from 'react';
import { ChatPanel } from './components/ChatPanel.js';
import { InputBar } from './components/InputBar.js';
import { StatusLine } from './components/StatusLine.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { TaskList } from './components/TaskList.js';
import { AgentTodoList } from './components/AgentTodoList.js';
import { useAgent } from './hooks/useAgent.js';
import { useTasks } from './hooks/useTasks.js';
import {
  ThemeContext,
  loadCustomTheme,
  DARK_THEME,
  LIGHT_THEME,
  type ThemeTokens,
  type ThemeName,
} from './theme.js';
import type { AgentConfig } from '../types.js';
import { DEFAULT_THEME } from '../types.js';
import { useTheme } from './theme.js';
import { discoverCommands, resolveCommandBody } from '../commands/loader.js';

interface AppProps {
  config: AgentConfig;
}

/**
 * Pi-style interactive TUI.
 *
 * Renders to the main terminal screen (no alternate screen buffer).
 * The terminal emulator owns scrollback — users scroll with Shift+PgUp,
 * mouse wheel, or tmux copy mode. The input bar and status line scroll
 * off-screen when browsing history and reappear when scrolled to bottom.
 *
 * Layout (top to bottom):
 *   1. ASCII BOOK banner
 *   2. Chat panel — all messages rendered in order, no viewport culling
 *   3. Status line — model, turn, tokens, usage meter, mode, git, tasks
 *   4. Input bar — supports @mentions, !commands, history
 *
 * Keyboard shortcuts:
 *   Esc      — cancel permission / abort stream
 *   Ctrl+T   — toggle task list
 *   Ctrl+L   — redraw
 *   Alt+M    — cycle permission mode
 *   Shift+Tab — cycle permission mode
 *   ?        — toggle keyboard shortcuts reference
 */
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
    cancel,
    compact,
    cycleMode,
    turnDurationMs,
    retryPhase,
    retryAttempt,
    retryMax,
    retryCountdownMs,
  } = useAgent(config);

  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<ThemeTokens>(DEFAULT_THEME);
  const { tasks, addTask, updateTaskStatus, removeTask } = useTasks();
  const theme = useTheme();
  const { exit: exitApp } = useApp();

  // Discover slash commands on startup.
  const commands = useMemo(() => discoverCommands(config.workspace), [config.workspace]);

  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  useInput((input, key) => {
    // Escape cancels a pending permission (handled by PermissionButtons),
    // or aborts an in-flight stream. Do NOT double-handle Esc when
    // a permission prompt is active — PermissionButtons has its own handler.
    if (key.escape) {
      if (pendingPermission) {
        // PermissionButtons handles Esc internally. Do nothing here.
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
    // Alt+M — cycle mode
    if (key.meta && input === 'm') {
      cycleMode();
      return;
    }
    // Ctrl+L — redraw (simulated by Ink re-render)
    if (key.ctrl && input === 'l') {
      return;
    }
  });

  // Auto-expand the latest tool call while it's running; collapse when done.
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'assistant' && lastMsg.toolCalls?.length) {
      const latestTool = lastMsg.toolCalls[lastMsg.toolCalls.length - 1];
      if (!lastMsg.toolResults?.find((r) => r.toolCallId === latestTool.id)) {
        setExpandedToolId(latestTool.id);
      }
    } else {
      setExpandedToolId(null);
    }
  }, [messages]);

  const handleSubmit = useCallback(
    (value: string) => {
      // Slash commands: built-in first, then custom.
      if (value.startsWith('/clear')) {
        clear();
      } else if (value.startsWith('/compact')) {
        compact();
      } else if (value.startsWith('/exit')) {
        exitApp();
      } else if (value.startsWith('/help')) {
        setShowHelp((s) => !s);
      } else if (value.startsWith('/task ')) {
        addTask({ subject: value.slice(6), status: 'pending' });
      } else if (value.startsWith('/theme')) {
        const themeName = (value.slice(7).trim() || 'dark') as ThemeName;
        if (themeName === 'dark') {
          setCurrentTheme(DARK_THEME);
        } else if (themeName === 'light') {
          setCurrentTheme(LIGHT_THEME);
        } else if (themeName === 'auto') {
          // Detect terminal background: if COLORFGBG env var has a dark bg
          // (common on most terminals), use dark; otherwise light.
          const colorFgBg = process.env.COLORFGBG || '';
          const isLightBg = colorFgBg.includes('15;') || colorFgBg.includes('7;');
          setCurrentTheme(isLightBg ? LIGHT_THEME : DARK_THEME);
        } else {
          // Try loading a custom theme from .book/themes/<name>.json
          try {
            const custom = loadCustomTheme(config.workspace, themeName);
            if (custom) setCurrentTheme(custom);
          } catch {
            // ignore — keep current theme
          }
        }
      } else if (value.startsWith('/')) {
        // Custom slash command: /name [args]
        const spaceIdx = value.indexOf(' ');
        const cmdName = spaceIdx === -1 ? value.slice(1) : value.slice(1, spaceIdx);
        const cmdArgs = spaceIdx === -1 ? '' : value.slice(spaceIdx + 1);
        const cmd = commands.find((c) => c.name === cmdName);
        if (cmd) {
          const resolved = resolveCommandBody(cmd, cmdArgs);
          send(resolved);
        } else {
          // Unknown command — send as-is (the model might handle it).
          send(value);
        }
      } else {
        send(value);
      }
    },
    [send, clear, compact, addTask, commands, exitApp],
  );

  const handleGlobalShortcut = useCallback(
    (
      input: string,
      key: { ctrl?: boolean; meta?: boolean; shift?: boolean; tab?: boolean },
    ): boolean => {
      // Ctrl+/ — toggle keyboard shortcuts reference.
      // Must be handled here (not in the parent useInput) because ink-text-input
      // consumes Ctrl key events before they reach the parent handler.
      if (key.ctrl && input === '/') {
        setShowShortcuts((s) => !s);
        return true; // consumed
      }
      return false; // not consumed — let text input handle it
    },
    [],
  );

  return (
    <ThemeContext.Provider value={currentTheme}>
      <ErrorBoundary>
        <Box flexDirection="column">

          {/* Message area — all messages rendered in order */}
          <Box flexDirection="column">
            {error && (
              <Box paddingX={1} marginBottom={1}>
                <Text color={theme.error}>✕ {error}</Text>
              </Box>
            )}
            <ChatPanel
              messages={messages}
              streamingMessageId={streamingMessageId}
              pendingPermission={pendingPermission}
              onResolvePermission={resolvePermission}
              activeToolCallId={expandedToolId}
              reducedMotion={config.accessibility?.reducedMotion}
              screenReader={config.accessibility?.screenReader}
              terminalWidth={termWidth}
              retryPhase={retryPhase}
              retryAttempt={retryAttempt}
              retryMax={retryMax}
              retryCountdownMs={retryCountdownMs}
            />
            {agentTodos.length > 0 && <AgentTodoList todos={agentTodos} />}
            {showTasks && (
              <TaskList tasks={tasks} onUpdateStatus={updateTaskStatus} onRemove={removeTask} />
            )}
            {showHelp && (
              <Box
                flexDirection="column"
                borderStyle="single"
                borderColor={theme.subtle}
                paddingX={1}
                marginTop={1}
              >
                <Text bold color={theme.brand}>
                  Slash Commands
                </Text>
                <Box flexDirection="column" marginTop={1}>
                  <HelpRow label="/help" description="Toggle this help" theme={theme} />
                  <HelpRow label="/clear" description="Clear conversation" theme={theme} />
                  <HelpRow label="/compact" description="Summarize older turns" theme={theme} />
                  <HelpRow label="/task <subject>" description="Add a task" theme={theme} />
                  <HelpRow
                    label="/theme [dark|light|auto]"
                    description="Switch theme"
                    theme={theme}
                  />
                  <HelpRow label="/exit" description="Exit book" theme={theme} />
                  {commands.length > 0 && (
                    <>
                      <Text color={theme.subtle} dimColor>
                        ─── Custom (.book/commands/) ───
                      </Text>
                      {commands.map((cmd) => (
                        <HelpRow
                          key={cmd.name}
                          label={`/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`}
                          description={cmd.description}
                          theme={theme}
                        />
                      ))}
                    </>
                  )}
                </Box>
              </Box>
            )}
            {showShortcuts && (
              <Box
                flexDirection="column"
                borderStyle="single"
                borderColor={theme.subtle}
                paddingX={1}
                marginTop={1}
              >
                <Text bold color={theme.brand}>
                  Keyboard Shortcuts
                </Text>
                <Box flexDirection="column" marginTop={1}>
                  <HelpRow
                    label="Esc"
                    description="Cancel permission / abort stream"
                    theme={theme}
                  />
                  <HelpRow label="Ctrl+T" description="Toggle task list" theme={theme} />
                  <HelpRow label="Ctrl+L" description="Redraw screen" theme={theme} />
                  <HelpRow label="Alt+M" description="Cycle permission mode" theme={theme} />
                  <HelpRow label="Up/Down" description="Navigate input history" theme={theme} />
                  <HelpRow
                    label="Shift+Enter"
                    description="Insert newline (multiline)"
                    theme={theme}
                  />
                  <HelpRow label="Ctrl+/" description="Toggle this reference" theme={theme} />
                  <HelpRow label="@path" description="Expand file contents" theme={theme} />
                  <HelpRow label="!cmd" description="Run shell command" theme={theme} />
                </Box>
              </Box>
            )}
          </Box>

          {/* Input bar — above the status line */}
          <Box paddingX={1}>
            <InputBar
              onSubmit={handleSubmit}
              disabled={isThinking}
              mode={mode}
              onCycleMode={cycleMode}
              onGlobalShortcut={handleGlobalShortcut}
            />
          </Box>

          {/* Status line — absolute bottom */}
          <Box>
            <StatusLine
              model={config.model}
              tokenCount={tokenCount}
              maxTokens={config.maxTokens}
              mode={mode}
              taskCount={tasks.length}
              activeTaskCount={tasks.filter((t) => t.status === 'in_progress').length}
            />
          </Box>
        </Box>
      </ErrorBoundary>
    </ThemeContext.Provider>
  );
}

function HelpRow({
  label,
  description,
  theme,
}: {
  label: string;
  description: string;
  theme: { brand: string; text: string; subtle: string };
}) {
  return (
    <Box>
      <Text color={theme.brand}>{label}</Text>
      <Text color={theme.subtle}> — {description}</Text>
    </Box>
  );
}
