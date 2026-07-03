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
import type { AgentConfig, CommandContext } from '../types.js';
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
  const [showStatus, setShowStatus] = useState(false);
  const [showPermissions, setShowPermissions] = useState(false);
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
          const colorFgBg = process.env.COLORFGBG || '';
          const isLightBg = colorFgBg.includes('15;') || colorFgBg.includes('7;');
          setCurrentTheme(isLightBg ? LIGHT_THEME : DARK_THEME);
        } else {
          try {
            const custom = loadCustomTheme(config.workspace, themeName);
            if (custom) setCurrentTheme(custom);
          } catch {
            // ignore — keep current theme
          }
        }
      } else if (value.startsWith('/model')) {
        // /model <name> — switch model.
        const modelName = value.slice(7).trim();
        if (modelName) {
          send(`Switch to the ${modelName} model for subsequent responses. Confirm the switch.`);
        } else {
          send('List the available AI models I can switch to with /model <name>.');
        }
      } else if (value.startsWith('/config')) {
        // /config — show current configuration (delegated to agent)
        send('Show me the current configuration settings (model, max tokens, workspace, etc.)');
      } else if (value.startsWith('/diff')) {
        send('Show me the current git diff for the working tree.');
      } else if (value.startsWith('/status')) {
        setShowStatus((s) => !s);
      } else if (value.startsWith('/memory')) {
        send('Show me what\'s in the current memory/CLAUDE.md and help me manage it.');
      } else if (value.startsWith('/permissions')) {
        setShowPermissions((s) => !s);
      } else if (value.startsWith('/cost')) {
        send('Show me the current token usage and estimated cost for this session.');
      } else if (value.startsWith('/skills')) {
        send('List all available skills that are currently loaded.');
      } else if (value.startsWith('/init')) {
        send('Analyze this project and create or update the CLAUDE.md file with project documentation. Follow the init skill pattern.');
      } else if (value.startsWith('/reload-skills')) {
        // Force re-discovery of commands and skills on next render.
        send('Commands and skills have been reloaded. What would you like to do?');
      } else if (value.startsWith('/export')) {
        const filename = value.slice(8).trim() || 'conversation.txt';
        send(`Export this conversation to a file named "${filename}".`);
      } else if (value.startsWith('/')) {
        // Custom slash command: /name [args]
        const spaceIdx = value.indexOf(' ');
        const cmdName = spaceIdx === -1 ? value.slice(1) : value.slice(1, spaceIdx);
        const cmdArgs = spaceIdx === -1 ? '' : value.slice(spaceIdx + 1);
        const cmd = commands.find((c) => c.name === cmdName);
        if (cmd) {
          const { resolved } = resolveCommandBody(cmd, cmdArgs);
          // Pass command context for allowed-tools and model enforcement.
          const ctx: CommandContext | undefined =
            cmd.allowedTools || cmd.model
              ? {
                  command: cmd,
                  resolvedBody: resolved,
                  modelOverride: cmd.model,
                  allowedTools: cmd.allowedTools,
                }
              : undefined;
          send(resolved, ctx);
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

  // Track input changes for command menu filtering — now handled inside InputBar.
  // handleGlobalShortcut remains for Ctrl+/ keyboard shortcut reference.

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
                  <HelpRow label="/theme [dark|light|auto]" description="Switch theme" theme={theme} />
                  <HelpRow label="/model <name>" description="Switch AI model" theme={theme} />
                  <HelpRow label="/config" description="Show configuration" theme={theme} />
                  <HelpRow label="/diff" description="Show git diff" theme={theme} />
                  <HelpRow label="/status" description="Session status" theme={theme} />
                  <HelpRow label="/memory" description="Manage memory" theme={theme} />
                  <HelpRow label="/permissions" description="Permission rules" theme={theme} />
                  <HelpRow label="/cost" description="Token usage/cost" theme={theme} />
                  <HelpRow label="/skills" description="List skills" theme={theme} />
                  <HelpRow label="/init" description="Initialize CLAUDE.md" theme={theme} />
                  <HelpRow label="/reload-skills" description="Reload commands" theme={theme} />
                  <HelpRow label="/export [file]" description="Export conversation" theme={theme} />
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
            {showStatus && (
              <Box
                flexDirection="column"
                borderStyle="single"
                borderColor={theme.subtle}
                paddingX={1}
                marginTop={1}
              >
                <Text bold color={theme.brand}>
                  Session Status
                </Text>
                <Box flexDirection="column" marginTop={1}>
                  <HelpRow label="Model" description={config.model} theme={theme} />
                  <HelpRow label="Workspace" description={config.workspace} theme={theme} />
                  <HelpRow label="Max Tokens" description={String(config.maxTokens)} theme={theme} />
                  <HelpRow label="Max Turns" description={String(config.maxTurns)} theme={theme} />
                  <HelpRow label="Mode" description={mode} theme={theme} />
                  <HelpRow label="Tokens Used" description={`${tokenCount}`} theme={theme} />
                  <HelpRow label="Turn" description={`${currentTurn}`} theme={theme} />
                  <HelpRow label="Tasks" description={`${tasks.length} (${tasks.filter((t) => t.status === 'in_progress').length} active)`} theme={theme} />
                </Box>
              </Box>
            )}
            {showPermissions && (
              <Box
                flexDirection="column"
                borderStyle="single"
                borderColor={theme.subtle}
                paddingX={1}
                marginTop={1}
              >
                <Text bold color={theme.brand}>
                  Permission Mode
                </Text>
                <Box flexDirection="column" marginTop={1}>
                  <HelpRow label="Current Mode" description={mode} theme={theme} />
                  <HelpRow label="Modes" description="default, auto, plan, accept-edits, dontAsk, bypassPermissions" theme={theme} />
                  <HelpRow label="Switch" description="Alt+M or Shift+Tab" theme={theme} />
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

          {/* Input bar — above the status line. Command menu is built into InputBar. */}
          <Box paddingX={1} flexDirection="column">
            <InputBar
              onSubmit={handleSubmit}
              disabled={isThinking}
              mode={mode}
              onCycleMode={cycleMode}
              onInterrupt={isThinking ? cancel : undefined}
              onGlobalShortcut={handleGlobalShortcut}
              commands={commands}
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
