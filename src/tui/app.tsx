import { Box, Text, useInput, useStdout, useStdin } from 'ink';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { ChatPanel, estimateMessageLines } from './components/ChatPanel.js';
import { InputBar } from './components/InputBar.js';
import { StatusLine } from './components/StatusLine.js';
import { AsciiBanner } from './components/AsciiBanner.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { TaskList } from './components/TaskList.js';
import { AgentTodoList } from './components/AgentTodoList.js';
import { useAgent } from './hooks/useAgent.js';
import { useTasks } from './hooks/useTasks.js';
import { ThemeContext, loadCustomTheme, DARK_THEME, LIGHT_THEME, type ThemeTokens, type ThemeName } from './theme.js';
import type { AgentConfig } from '../types.js';
import { DEFAULT_THEME } from '../types.js';
import { useTheme } from './theme.js';
import { discoverCommands, resolveCommandBody } from '../commands/loader.js';
import type { SlashCommand } from '../commands/loader.js';
import { exit } from '../cli/exit.js';

interface AppProps {
  config: AgentConfig;
}

/**
 * Claude Code-style interactive TUI.
 *
 * Layout (top to bottom):
 *   1. ASCII BOOK banner
 *   2. Chat panel — message area with Up/Down/PgUp/PgDn scroll through history
 *   3. Status line — model, turn, tokens, usage meter, mode, git, tasks
 *   4. Input bar — always visible, supports @mentions, !commands, history
 *
 * Keyboard shortcuts:
 *   Esc      — cancel permission / abort stream
 *   Ctrl+T   — toggle task list
 *   Ctrl+L   — redraw
 *   Alt+M    — cycle permission mode
 *   Shift+Tab — cycle permission mode
 *   ?        — toggle keyboard shortcuts reference
 *   Up/Down  — scroll 1 line through message history
 *   PgUp/PgDn — scroll 1 page through message history
 *   Home/End — jump to top/bottom of history
 *   Mouse wheel — scroll through message history
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
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevScrollRef = useRef(0);
  const [currentTheme, setCurrentTheme] = useState<ThemeTokens>(DEFAULT_THEME);
  const { tasks, addTask, updateTaskStatus, removeTask } = useTasks();
  const theme = useTheme();

  // Keep a ref to scrollOffset so the useInput closure always has the latest value
  // for the "resume auto-scroll when scrolled back to bottom" logic.
  useEffect(() => {
    prevScrollRef.current = scrollOffset;
  }, [scrollOffset]);

  // Discover slash commands on startup.
  const commands = useMemo(() => discoverCommands(config.workspace), [config.workspace]);

  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 40;
  const termWidth = stdout?.columns ?? 80;

  // Layout heights (in rows).
  // Banner: 6 lines of ASCII art
  // StatusLine: 1 divider + 1 data row (flattened single-row)
  // InputBar: 1 divider line + 1 input line = 2
  // The chat area gets the remaining space.
  const HEADER_ROWS = 6; // banner only
  const STATUS_ROWS = 1 + 1; // divider + data row
  const INPUT_ROWS = 2; // divider + input line
  const FIXED_ROWS = HEADER_ROWS + STATUS_ROWS + INPUT_ROWS;
  const chatHeight = Math.max(5, termHeight - FIXED_ROWS);

  // Maximum scroll offset: total estimated message lines minus visible height.
  // Prevents scrolling past the oldest message.
  const maxScrollOffset = useMemo(() => {
    if (messages.length === 0) return 0;
    let totalLines = 0;
    for (const msg of messages) {
      totalLines += estimateMessageLines(msg, termWidth);
    }
    return Math.max(0, totalLines - chatHeight);
  }, [messages, termWidth, chatHeight]);

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
    // Ctrl+S — toggle auto-scroll
    if (key.ctrl && input === 's') {
      setAutoScroll((s) => !s);
      return;
    }
    // Up arrow — scroll up 1 line through message history
    if (key.upArrow) {
      setScrollOffset((prev) => Math.min(prev + 1, maxScrollOffset));
      // Pause auto-scroll when user manually scrolls while streaming.
      if (streamingMessageId && autoScroll) {
        setAutoScroll(false);
      }
      return;
    }
    // Down arrow — scroll down 1 line through message history
    if (key.downArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
      if (prevScrollRef.current <= 1) {
        // At bottom — resume auto-scroll if it was paused.
        setAutoScroll(true);
      }
      return;
    }
    // PgUp — scroll up one page (screenful) through message history
    if (key.pageUp) {
      setScrollOffset((prev) => Math.min(prev + chatHeight - 2, maxScrollOffset));
      if (streamingMessageId && autoScroll) {
        setAutoScroll(false);
      }
      return;
    }
    // PgDn — scroll down one page through message history
    if (key.pageDown) {
      setScrollOffset((prev) => Math.max(0, prev - (chatHeight - 2)));
      return;
    }
    // Home — jump to top of history
    if (key.home) {
      setScrollOffset(maxScrollOffset);
      return;
    }
    // End — jump to bottom (tail)
    if (key.end) {
      setScrollOffset(0);
      setAutoScroll(true);
      return;
    }
  });

  // --- Mouse wheel scrolling ---
  // Enable SGR extended mouse mode so the terminal sends mouse wheel events
  // as CSI sequences (scroll up = <64, scroll down = <65).
  // We listen on the raw stdin event emitter because Ink's useInput does not
  // expose mouse events.
  const { internal_eventEmitter: stdinEvents } = useStdin();
  const scrollOffsetRef = useRef(scrollOffset);
  scrollOffsetRef.current = scrollOffset;
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  const maxScrollOffsetRef = useRef(maxScrollOffset);
  maxScrollOffsetRef.current = maxScrollOffset;
  const streamingRef = useRef(streamingMessageId);
  streamingRef.current = streamingMessageId;

  useEffect(() => {
    if (!stdout) return;

    // Enable SGR extended mouse mode (tracking + SGR format)
    stdout.write('\x1b[?1000;1006h');

    const handleInput = (input: string) => {
      // SGR mouse wheel events: \x1b[<64;col;rowM (up) or \x1b[<65;col;rowM (down)
      const wheelMatch = input.match(/^\x1b\[<(6[45]);\d+;\d+[Mm]/);
      if (!wheelMatch) return;

      const button = parseInt(wheelMatch[1], 10); // 64 = scroll up, 65 = scroll down
      const linesPerTick = 3; // scroll 3 lines per wheel tick

      if (button === 64) {
        // Scroll up — show older messages
        setScrollOffset((prev) =>
          Math.min(prev + linesPerTick, maxScrollOffsetRef.current),
        );
        if (streamingRef.current && autoScrollRef.current) {
          setAutoScroll(false);
        }
      } else if (button === 65) {
        // Scroll down — show newer messages
        setScrollOffset((prev) => Math.max(0, prev - linesPerTick));
        if (scrollOffsetRef.current <= linesPerTick) {
          setAutoScroll(true);
        }
      }
    };

    stdinEvents.on('input', handleInput);

    return () => {
      // Disable SGR mouse mode on cleanup
      stdout.write('\x1b[?1000;1006l');
      stdinEvents.off('input', handleInput);
    };
  }, [stdinEvents, stdout]); // stable reference — only mount/unmount once

  // Auto-expand the latest tool call while it's running; collapse when done.
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

  // Smart auto-scroll: when the user is already at/near the tail, keep the
  // viewport pinned there as streamed text changes height. Manual scrolling
  // disables auto-scroll, so this does not fight history browsing.
  useEffect(() => {
    if (autoScroll && streamingMessageId && prevScrollRef.current <= 5) {
      setScrollOffset(0);
    }
  }, [messages, streamingMessageId, autoScroll]);

  const handleSubmit = useCallback(
    (value: string) => {
      // Reset scroll when user submits a new message.
      setScrollOffset(0);
      // Slash commands: built-in first, then custom.
      if (value.startsWith('/clear')) {
        clear();
      } else if (value.startsWith('/compact')) {
        compact();
      } else if (value.startsWith('/exit')) {
        exit(0);
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
    [send, clear, compact, addTask, commands],
  );

  const handleGlobalShortcut = useCallback(
    (input: string, key: { ctrl?: boolean; meta?: boolean; shift?: boolean; tab?: boolean }): boolean => {
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
        <Box flexDirection="column" height={termHeight}>
        {/* ASCII BOOK banner at the top */}
        <Box overflow="hidden">
          <AsciiBanner />
        </Box>

        {/* Message area — fills remaining space between banner and bottom panels */}
        <Box flexDirection="column" flexGrow={1} height={chatHeight}>
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
            scrollOffset={scrollOffset}
            autoScroll={autoScroll}
            maxHeight={chatHeight}
            terminalWidth={termWidth}
            retryPhase={retryPhase}
            retryAttempt={retryAttempt}
            retryMax={retryMax}
            retryCountdownMs={retryCountdownMs}
          />
          {agentTodos.length > 0 && <AgentTodoList todos={agentTodos} />}
          {showTasks && (
            <TaskList
              tasks={tasks}
              onUpdateStatus={updateTaskStatus}
              onRemove={removeTask}
            />
          )}
          {showHelp && (
            <Box flexDirection="column" borderStyle="single" borderColor={theme.subtle} paddingX={1} marginTop={1}>
              <Text bold color={theme.brand}>Slash Commands</Text>
              <Box flexDirection="column" marginTop={1}>
                <HelpRow label="/help" description="Toggle this help" theme={theme} />
                <HelpRow label="/clear" description="Clear conversation" theme={theme} />
                <HelpRow label="/compact" description="Summarize older turns" theme={theme} />
                <HelpRow label="/task <subject>" description="Add a task" theme={theme} />
                <HelpRow label="/theme [dark|light|auto]" description="Switch theme" theme={theme} />
                <HelpRow label="/exit" description="Exit book" theme={theme} />
                {commands.length > 0 && (
                  <>
                    <Text color={theme.subtle} dimColor>─── Custom (.book/commands/) ───</Text>
                    {commands.map((cmd) => (
                      <HelpRow key={cmd.name} label={`/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`} description={cmd.description} theme={theme} />
                    ))}
                  </>
                )}
              </Box>
            </Box>
          )}
          {showShortcuts && (
            <Box flexDirection="column" borderStyle="single" borderColor={theme.subtle} paddingX={1} marginTop={1}>
              <Text bold color={theme.brand}>Keyboard Shortcuts</Text>
              <Box flexDirection="column" marginTop={1}>
                <HelpRow label="Esc" description="Cancel permission / abort stream" theme={theme} />
                <HelpRow label="Ctrl+T" description="Toggle task list" theme={theme} />
                <HelpRow label="Ctrl+L" description="Redraw screen" theme={theme} />
                <HelpRow label="Alt+M" description="Cycle permission mode" theme={theme} />
                <HelpRow label="PgUp/PgDn" description="Scroll through message history" theme={theme} />
                <HelpRow label="Home/End" description="Jump to top/bottom of history" theme={theme} />
                <HelpRow label="Mouse wheel" description="Scroll through message history" theme={theme} />
                <HelpRow label="Up/Down" description="Navigate input history" theme={theme} />
                <HelpRow label="Shift+Enter" description="Insert newline (multiline)" theme={theme} />
                <HelpRow label="Ctrl+/" description="Toggle this reference" theme={theme} />
                <HelpRow label="Ctrl+S" description="Toggle auto-scroll" theme={theme} />
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
        <Box overflow="hidden">
          <StatusLine
            model={config.model}
            tokenCount={tokenCount}
            maxTokens={config.maxTokens}
            mode={mode}
            taskCount={tasks.length}
            activeTaskCount={tasks.filter(t => t.status === 'in_progress').length}
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
