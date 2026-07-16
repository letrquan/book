import { Box, Text, useInput, useStdout, useApp } from 'ink';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { ChatPanel } from './components/ChatPanel.js';
import { InputBar } from './components/InputBar.js';
import { StatusLine } from './components/StatusLine.js';
import { WorkingIndicator } from './components/WorkingIndicator.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { TaskList } from './components/TaskList.js';
import { AgentTodoList } from './components/AgentTodoList.js';
import { ModelPicker } from './components/ModelPicker.js';
import { SessionPicker } from './components/SessionPicker.js';
import { TranscriptView } from './components/TranscriptView.js';
import { PermissionButtons } from './components/PermissionButtons.js';
import { PlanApprovalActions, PlanApprovalDetails } from './components/PlanApprovalButtons.js';
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
import type { AgentConfig, CommandContext, SessionStoreInterface } from '../types.js';
import type { SessionBootstrap } from '../session/resolve.js';
import { DEFAULT_THEME } from '../types.js';
import { useTheme } from './theme.js';
import { discoverCommands, resolveCommandBody } from '../commands/loader.js';
import { discoverSkills } from '../skills.js';
import { runGit } from '../tools/git.js';
import { costReport, usageReport } from '../pricing.js';
import { buildInitPrompt } from '../commands/init-prompt.js';
import {
  buildReviewPrompt,
  buildSecurityReviewPrompt,
  REVIEW_TOOLS,
  SECURITY_REVIEW_TOOLS,
} from '../commands/builtins-prompts.js';
import { buildMemoryInboxReport, buildMemoryReport, getMemoryIndex } from '../memory-display.js';
import {
  approveMemoryCandidate,
  discardMemoryCandidate,
  getProjectMemoryDir,
  listMemoryCandidates,
  loadMemoryContext,
} from '../memory-store.js';
import { buildContextReport } from '../context-report.js';
import { discoverClaudeMd } from '../claude-md.js';
import { discoverAgents } from '../subagent-discovery.js';
import { buildReleaseNotesReport, writeFeedbackReport } from '../version-info.js';
import { persistSettingLocal } from './persist.js';
import { buildModelOptions } from './model-options.js';
import { redactSettingValue, redactSettingsForDisplay } from '../settings-redaction.js';
import { createUiDebugLogger } from '../debug-log.js';
import { selectExpandedToolId } from './tool-traces.js';
import { useDebugMount, useDebugValueChange } from './debug.js';

const uiLog = createUiDebugLogger('tui:app');

export function ownsModalInput(
  pendingPermission: unknown,
  pendingPlanApproval: unknown,
  showModelPicker: boolean,
  showSessionPicker = false,
): boolean {
  return Boolean(pendingPermission || pendingPlanApproval || showModelPicker || showSessionPicker);
}

/** Settable top-level settings keys (for /config --help). Mirrors cli/config-cmd.ts allowlist. */
const SETTABLE_KEYS = [
  'model',
  'maxTurns',
  'maxTokens',
  'autoCompactEnabled',
  'defaultMode',
  'effort',
  'provider',
  'permissions',
  'sandbox',
  'hooks',
  'memory',
  'additionalDirectories',
  'env',
];

interface AppProps {
  config: AgentConfig;
  session: SessionBootstrap & { store?: SessionStoreInterface };
  redrawViewport?: () => void;
}

/**
 * Full-screen interactive TUI with an application-owned transcript viewport.
 *
 * The transcript scrolls independently while approvals, input, and status stay
 * visible. The default CLI enters the alternate screen; --scrollback preserves
 * linear terminal-owned history as an accessibility/fallback mode.
 *
 * Layout (top to bottom):
 *   1. Scrollable transcript and informational panels
 *   2. Fixed approval/picker interaction area
 *   3. Working indicator, input bar, and status line
 *
 * Keyboard shortcuts:
 *   Esc      — cancel permission / abort stream
 *   Ctrl+C   — abort stream
 *   Ctrl+T   — toggle task list
 *   Ctrl+L   — redraw
 *   Ctrl+J   — insert newline
 *   PgUp/PgDn, Ctrl+U/Ctrl+D — scroll transcript
 *   Ctrl+Home/Ctrl+End — jump to transcript start/latest
 *   Alt+M    — cycle permission mode
 *   Alt+P    — open model picker
 *   Shift+Tab — cycle permission mode
 *   Ctrl+/   — toggle keyboard shortcuts reference
 */
export function App({ config, session, redrawViewport }: AppProps) {
  const {
    messages,
    isThinking,
    streamingMessageId,
    error,
    currentTurn,
    tokenCount,
    usage,
    mode,
    pendingPermission,
    pendingPlanApproval,
    agentTodos,
    liveConfig,
    sessionId,
    sessionName,
    send,
    clear,
    startNewConversation,
    resumeConversation,
    listSessions,
    endCurrentSession,
    resolvePermission,
    resolvePlanApproval,
    cancel,
    compact,
    cycleMode,
    addLocalMessage,
    setModel,
    upsertProviderAndSelect,
    setEffort,
    setMemoryAutoSave,
    refreshMemoryContext,
    turnDurationMs,
    retryPhase,
    retryAttempt,
    retryMax,
    retryCountdownMs,
  } = useAgent(config, session);

  const [showTasks, setShowTasks] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [showAllToolOutput, setShowAllToolOutput] = useState(false);
  const [showPermissions, setShowPermissions] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [followRequestKey, setFollowRequestKey] = useState(0);
  const [currentTheme, setCurrentTheme] = useState<ThemeTokens>(DEFAULT_THEME);
  const { tasks, addTask, updateTaskStatus, removeTask, clearTasks } = useTasks();
  const theme = useTheme();
  const { exit: exitApp } = useApp();

  // Discover slash commands on startup.
  const commands = useMemo(() => discoverCommands(config.workspace), [config.workspace]);
  const skills = useMemo(() => discoverSkills(config.workspace), [config.workspace]);
  const modelOptions = useMemo(() => buildModelOptions(liveConfig.settings), [liveConfig.settings]);

  const { stdout } = useStdout();
  const readTerminalSize = useCallback(
    () => ({
      columns: Math.max(20, stdout?.columns ?? 80),
      rows: Math.max(8, stdout?.rows ?? 24),
    }),
    [stdout],
  );
  const [terminalSize, setTerminalSize] = useState(readTerminalSize);
  const lastAppliedSizeRef = useRef(terminalSize);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyTerminalSize = useCallback(
    (nextSize: { columns: number; rows: number }, redraw: boolean) => {
      const previousSize = lastAppliedSizeRef.current;
      if (nextSize.columns === previousSize.columns && nextSize.rows === previousSize.rows) return;
      if (redraw) redrawViewport?.();
      lastAppliedSizeRef.current = nextSize;
      setTerminalSize(nextSize);
    },
    [redrawViewport],
  );

  useEffect(() => {
    // Reconcile dimensions that changed between the initial render and effect
    // registration without destructively clearing the first frame.
    applyTerminalSize(readTerminalSize(), false);

    const updateSize = () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        applyTerminalSize(readTerminalSize(), true);
      }, 50);
    };

    stdout?.on?.('resize', updateSize);
    return () => {
      stdout?.off?.('resize', updateSize);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [applyTerminalSize, readTerminalSize, stdout]);

  const termWidth = terminalSize.columns;
  const termHeight = terminalSize.rows;
  const isNarrow = termWidth < 64;
  const isTiny = termWidth < 42 || termHeight < 12;
  const maxCommandMenuRows = Math.max(2, Math.min(isTiny ? 3 : 8, Math.floor(termHeight / 3)));
  const compactStatus = isNarrow || isTiny;
  const reducedMotion = Boolean(config.accessibility?.reducedMotion);
  // Keep the whole live region quiescent while the terminal viewport belongs
  // to the user reviewing a plan. Any animation repaint can snap scrollback.
  const motionDisabled = reducedMotion || Boolean(pendingPlanApproval);
  const screenReader = Boolean(config.accessibility?.screenReader);

  useDebugMount(uiLog, {
    workspace: config.workspace,
    model: config.model,
    provider: config.provider,
    commandsLen: commands.length,
    skillsLen: skills.length,
  });
  useDebugValueChange(uiLog, 'layout:width', termWidth);
  useDebugValueChange(uiLog, 'layout:height', termHeight);
  useDebugValueChange(uiLog, 'layout:compactStatus', compactStatus, (v) => String(v));
  useDebugValueChange(uiLog, 'showTasks', showTasks, (v) => String(v));
  useDebugValueChange(uiLog, 'showHelp', showHelp, (v) => String(v));
  useDebugValueChange(uiLog, 'showShortcuts', showShortcuts, (v) => String(v));
  useDebugValueChange(uiLog, 'showStatus', showStatus, (v) => String(v));
  useDebugValueChange(uiLog, 'showAllToolOutput', showAllToolOutput, (v) => String(v));
  useDebugValueChange(uiLog, 'showPermissions', showPermissions, (v) => String(v));
  useDebugValueChange(uiLog, 'showSkills', showSkills, (v) => String(v));
  useDebugValueChange(uiLog, 'showModelPicker', showModelPicker, (v) => String(v));

  useInput((input, key) => {
    // Modal prompts own the keyboard until they resolve. Let their own
    // useInput handlers receive the event, but do not open another modal or
    // mutate surrounding UI state from this global handler.
    if (
      ownsModalInput(pendingPermission, pendingPlanApproval, showModelPicker, showSessionPicker)
    ) {
      if (key.escape) {
        uiLog.event('input:Escape', { action: 'noop-modal-active' });
      } else if (key.ctrl && input === 'c') {
        uiLog.event('input:Ctrl+C', { action: 'noop-modal-active' });
      }
      return;
    }

    // Escape aborts an in-flight stream when no prompt owns the keyboard.
    if (key.escape) {
      if (isThinking) {
        uiLog.event('input:Escape', { action: 'cancel-stream' });
        cancel();
        return;
      }
      uiLog.event('input:Escape', { action: 'noop-idle' });
    }
    // Ctrl+C — cancel an in-flight stream; otherwise preserve normal terminal exit.
    if (key.ctrl && input === 'c') {
      if (isThinking) {
        uiLog.event('input:Ctrl+C', { action: 'cancel-stream' });
        cancel();
        return;
      }
      uiLog.event('input:Ctrl+C', { action: 'exit' });
      void endCurrentSession('exit').finally(exitApp);
      return;
    }
    // Ctrl+T — toggle task list
    if (key.ctrl && input === 't') {
      uiLog.event('input:Ctrl+T', { action: 'toggle-tasks' });
      setShowTasks((s) => !s);
      return;
    }
    // Alt+M — cycle mode
    if (key.meta && input === 'm') {
      uiLog.event('input:Alt+M', { action: 'cycle-mode' });
      cycleMode();
      return;
    }
    // Alt+P — open model picker
    if (key.meta && input === 'p') {
      uiLog.event('input:Alt+P', { action: 'open-model-picker' });
      setShowModelPicker(true);
      return;
    }
    // Ctrl+L — clear the visible viewport and force a fresh Ink frame.
    if (key.ctrl && input === 'l') {
      uiLog.event('input:Ctrl+L', { action: 'redraw' });
      redrawViewport?.();
      return;
    }
  });

  // Log slash-command dispatches at a coarse level (command name + arg).
  // The detailed branching in handleSubmit stays unchanged; this only emits
  // one event per submit to make the dispatch traceable.
  useEffect(() => {
    if (isThinking) {
      uiLog.event('state:thinking', { messages: messages.length, currentTurn });
    }
  }, [isThinking, messages.length, currentTurn]);

  // Keep the latest running tool open. Once it completes, preserve the newest
  // file mutation in the latest tool-bearing turn as a bounded diff preview.
  const expandedToolId = useMemo(() => selectExpandedToolId(messages), [messages]);

  const handleSubmit = useCallback(
    (value: string) => {
      setFollowRequestKey((key) => key + 1);
      // Coarse slash-command dispatch trace (one event per submit).
      if (value.startsWith('/')) {
        const spaceIdx = value.indexOf(' ');
        const cmdName = spaceIdx === -1 ? value.slice(1) : value.slice(1, spaceIdx);
        uiLog.event('slash:dispatch', {
          command: cmdName,
          hasArg: spaceIdx !== -1,
          disabled: isThinking,
        });
      } else {
        uiLog.event('submit:text', { len: value.length, disabled: isThinking });
      }
      // Slash commands: built-in first, then custom.
      const firstSpace = value.indexOf(' ');
      const commandName = firstSpace === -1 ? value.slice(1) : value.slice(1, firstSpace);
      const commandArg = firstSpace === -1 ? '' : value.slice(firstSpace + 1).trim();
      if (commandName === 'clear' || commandName === 'new' || commandName === 'reset') {
        clearTasks();
        setShowHelp(false);
        setShowStatus(false);
        setShowSessionPicker(false);
        void startNewConversation(commandArg || undefined).catch((err) => {
          addLocalMessage(`✕ ${err instanceof Error ? err.message : String(err)}`);
        });
        stdout?.write('\x1b[2J\x1b[3J\x1b[H');
      } else if (commandName === 'resume' || commandName === 'continue') {
        if (!commandArg) {
          setShowSessionPicker(true);
        } else {
          clearTasks();
          void resumeConversation(commandArg).catch((err) => {
            addLocalMessage(`✕ ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } else if (value.startsWith('/compact')) {
        compact();
      } else if (value.startsWith('/exit')) {
        void endCurrentSession('exit').finally(exitApp);
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
        const arg = value.slice('/model'.length).trim();
        if (arg) {
          const result = setModel(arg);
          addLocalMessage(
            result.ok ? `Switched to ${arg} (saved as default).` : `✕ ${result.error}`,
          );
        } else {
          setShowModelPicker(true);
        }
      } else if (value.startsWith('/config')) {
        const arg = value.slice('/config'.length).trim();
        if (!arg) {
          addLocalMessage(
            JSON.stringify(
              redactSettingsForDisplay({
                ...liveConfig.settings,
                model: liveConfig.modelSelection ?? liveConfig.model,
                baseUrl: liveConfig.baseUrl,
                workspace: liveConfig.workspace,
                maxTurns: liveConfig.maxTurns,
                maxTokens: liveConfig.maxTokens,
                effort: liveConfig.effort,
                activeProvider: liveConfig.provider,
                modelInfo: liveConfig.modelInfo,
              }),
              null,
              2,
            ),
          );
        } else if (arg === '--help') {
          addLocalMessage(
            'Settable keys (dot-separated):\n' +
              SETTABLE_KEYS.map((k) => `  ${k}`).join('\n') +
              '\n\nUsage: /config <key>=<value>',
          );
        } else if (arg.includes('=')) {
          const eq = arg.indexOf('=');
          const key = arg.slice(0, eq).trim();
          const raw = arg.slice(eq + 1).trim();
          let parsed: unknown = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* keep as string */
          }
          const r = persistSettingLocal(config.workspace, key, parsed);
          addLocalMessage(
            r.ok
              ? `Set ${key} = ${JSON.stringify(redactSettingValue(key, parsed))} in .book/settings.local.json (next session).`
              : `✕ ${r.error}`,
          );
        } else {
          addLocalMessage('Usage: /config [key=value] or /config --help');
        }
      } else if (value.startsWith('/diff')) {
        void runGit(['diff'], {
          workspaceRoot: config.workspace,
          env: process.env as Record<string, string>,
        }).then((result) => {
          addLocalMessage(
            result.error ? `✕ ${result.error}` : result.output.trim() || '(no changes)',
          );
        });
      } else if (value.startsWith('/status')) {
        setShowStatus((s) => !s);
      } else if (value === '/memory' || value.startsWith('/memory ')) {
        const arg = value.slice('/memory'.length).trim();

        if (!arg || arg === 'status') {
          // Respect the enabled gate: when memory loading is disabled, don't
          // walk the disk just to render a status line.
          const loaded = liveConfig.settings.memory.enabled
            ? (liveConfig.memoryContext ?? loadMemoryContext(config.workspace))
            : undefined;
          addLocalMessage(
            buildMemoryReport({
              workspace: config.workspace,
              settings: liveConfig.settings,
              loaded,
            }),
          );
        } else if (arg === 'inbox') {
          addLocalMessage(buildMemoryInboxReport({ workspace: config.workspace }));
        } else if (arg === 'path') {
          addLocalMessage(getProjectMemoryDir(config.workspace));
        } else if (arg === 'on' || arg === 'auto-save on') {
          setMemoryAutoSave(true);
          addLocalMessage(
            'Memory auto-capture enabled. New candidates will still require approval.',
          );
        } else if (arg === 'off' || arg === 'auto-save off') {
          setMemoryAutoSave(false);
          addLocalMessage('Memory auto-capture disabled. Existing approved memory can still load.');
        } else if (arg.startsWith('approve ') || arg.startsWith('discard ')) {
          const action = arg.startsWith('approve ') ? 'approve ' : 'discard ';
          const rest = arg.slice(action.length).trim();
          const candidates = listMemoryCandidates(config.workspace);
          const resolveCandidate = (raw: string): string | undefined => {
            if (!raw) return undefined;
            const idx = Number(raw);
            if (Number.isInteger(idx) && idx >= 1 && idx <= candidates.length)
              return candidates[idx - 1].name;
            return raw;
          };
          const target = resolveCandidate(rest);
          const r = target
            ? action === 'approve '
              ? approveMemoryCandidate(config.workspace, target)
              : discardMemoryCandidate(config.workspace, target)
            : { ok: false, error: 'Missing candidate id or filename.' };
          addLocalMessage(
            r.ok
              ? `${action === 'approve ' ? 'Approved' : 'Discarded'} memory candidate → ${r.path}`
              : `✕ ${r.error}`,
          );
          if (r.ok && action === 'approve ') refreshMemoryContext();
        } else {
          addLocalMessage(
            'Usage: /memory [status|inbox|approve <n|file>|discard <n|file>|on|off|path]',
          );
        }
      } else if (value.startsWith('/permissions')) {
        setShowPermissions((s) => !s);
      } else if (value.startsWith('/cost')) {
        addLocalMessage(costReport(liveConfig.model, usage));
      } else if (value.startsWith('/usage') || value.startsWith('/stats')) {
        addLocalMessage(
          usageReport(liveConfig.model, usage, {
            currentTurn,
            messageCount: messages.length,
            turnDurationMs,
          }),
        );
      } else if (value.startsWith('/context')) {
        addLocalMessage(
          buildContextReport(messages, {
            model: liveConfig.model,
            maxTokens: liveConfig.modelInfo?.contextWindow ?? liveConfig.maxTokens,
            skillCount: skills.length,
            commandCount: commands.length,
            subagentCount: discoverAgents(config.workspace).length,
            hasMemoryIndex: Boolean(
              liveConfig.memoryContext?.indexLoaded ?? getMemoryIndex(config.workspace).indexFile,
            ),
            hasClaudeMdLoader: discoverClaudeMd(config.workspace).length > 0,
          }),
        );
      } else if (value.startsWith('/skills')) {
        setShowSkills((s) => !s);
      } else if (value.startsWith('/init')) {
        const promptBody = buildInitPrompt(config.workspace);
        const initCmd = {
          name: 'init',
          description: 'Initialize CLAUDE.md',
          body: promptBody,
          source: 'project' as const,
        };
        const ctx: CommandContext = {
          command: initCmd,
          resolvedBody: promptBody,
          allowedTools: ['Read', 'Glob', 'Grep', 'Write'],
        };
        send(promptBody, ctx);
      } else if (value.startsWith('/reload-skills')) {
        // Force re-discovery of commands and skills on next render.
        send('Commands and skills have been reloaded. What would you like to do?');
      } else if (value.startsWith('/export')) {
        const filename = value.slice('/export'.length).trim() || 'conversation.txt';
        try {
          const text = messages.map((m) => `${m.role}:\n${m.content}`).join('\n\n---\n\n');
          writeFileSync(join(config.workspace, filename), text, 'utf-8');
          addLocalMessage(
            `Exported ${messages.length} messages to ${join(config.workspace, filename)}`,
          );
        } catch (e) {
          addLocalMessage(`✕ export failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (value.startsWith('/review')) {
        const arg = value.slice('/review'.length).trim();
        const promptBody = buildReviewPrompt(arg);
        const ctx: CommandContext = {
          command: {
            name: 'review',
            description: 'Review current diff',
            body: promptBody,
            source: 'project',
          },
          resolvedBody: promptBody,
          allowedTools: [...REVIEW_TOOLS],
        };
        send(promptBody, ctx);
      } else if (value.startsWith('/security-review')) {
        const arg = value.slice('/security-review'.length).trim();
        const promptBody = buildSecurityReviewPrompt(arg);
        const ctx: CommandContext = {
          command: {
            name: 'security-review',
            description: 'Security audit of current diff',
            body: promptBody,
            source: 'project',
          },
          resolvedBody: promptBody,
          allowedTools: [...SECURITY_REVIEW_TOOLS],
        };
        send(promptBody, ctx);
      } else if (value.startsWith('/release-notes')) {
        addLocalMessage(buildReleaseNotesReport(config.workspace));
      } else if (value.startsWith('/feedback')) {
        const note = value.slice('/feedback'.length).trim();
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const r = writeFeedbackReport({
          workspace: config.workspace,
          model: liveConfig.model,
          provider: liveConfig.provider,
          turn: currentTurn,
          messageCount: messages.length,
          lastUserPromptPreview: lastUser?.content,
          lastError: error,
          note: note || undefined,
        });
        addLocalMessage(
          r.ok
            ? `Saved feedback report to ${r.path}. Review it before sharing.`
            : `✕ feedback failed: ${r.error}`,
        );
      } else if (value.startsWith('/')) {
        // Custom slash command: /name [args]
        const spaceIdx = value.indexOf(' ');
        const cmdName = spaceIdx === -1 ? value.slice(1) : value.slice(1, spaceIdx);
        const cmdArgs = spaceIdx === -1 ? '' : value.slice(spaceIdx + 1);
        const cmd = commands.find((c) => c.name === cmdName);
        if (cmd) {
          const { resolved } = resolveCommandBody(cmd, cmdArgs, {
            sessionId,
            workspace: config.workspace,
            model: liveConfig.model,
          });
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
    [
      send,
      clear,
      startNewConversation,
      resumeConversation,
      clearTasks,
      compact,
      addTask,
      commands,
      exitApp,
      endCurrentSession,
      usage,
      liveConfig,
      addLocalMessage,
      setModel,
      messages,
      currentTurn,
      turnDurationMs,
      error,
      skills,
      sessionId,
      stdout,
      isThinking,
      redrawViewport,
    ],
  );

  const handleGlobalShortcut = useCallback(
    (
      input: string,
      key: {
        ctrl?: boolean;
        meta?: boolean;
        shift?: boolean;
        tab?: boolean;
        home?: boolean;
        end?: boolean;
      },
    ): boolean => {
      // Ctrl+/ and Ctrl+E must be handled here (not only in the parent useInput)
      // because ink-text-input consumes some Ctrl key events before they reach
      // the parent handler.
      if (showModelPicker) return true;
      if (key.ctrl && input === 'c') {
        if (pendingPermission || pendingPlanApproval) {
          uiLog.event('input:Ctrl+C', { action: 'noop-approval-active' });
          return true;
        }
        if (isThinking) {
          uiLog.event('input:Ctrl+C', { action: 'cancel-stream' });
          cancel();
          return true;
        }
        uiLog.event('input:Ctrl+C', { action: 'exit' });
        void endCurrentSession('exit').finally(exitApp);
        return true;
      }
      if (key.ctrl && input === 'l') {
        uiLog.event('input:Ctrl+L', { action: 'redraw' });
        redrawViewport?.();
        return true;
      }
      if (
        key.ctrl &&
        (input.toLowerCase() === 'u' || input.toLowerCase() === 'd' || key.home || key.end)
      ) {
        return true;
      }
      if (key.ctrl && (input === '/' || input === '_')) {
        setShowShortcuts((s) => !s);
        return true; // consumed
      }
      if (key.ctrl && (input === 'e' || input.charCodeAt(0) === 5)) {
        uiLog.event('input:Ctrl+E', { action: 'toggle-tool-output' });
        setShowAllToolOutput((s) => !s);
        return true; // consumed
      }
      return false; // not consumed — let text input handle it
    },
    [
      cancel,
      endCurrentSession,
      exitApp,
      isThinking,
      pendingPermission,
      pendingPlanApproval,
      redrawViewport,
      showModelPicker,
    ],
  );

  // Track input changes for command menu filtering — now handled inside InputBar.
  // handleGlobalShortcut remains for Ctrl+/ keyboard shortcut reference.

  const pickerOwnsTranscript = showModelPicker || showSessionPicker;

  return (
    <ThemeContext.Provider value={currentTheme}>
      <ErrorBoundary>
        <Box
          flexDirection="column"
          width={termWidth}
          height={Math.max(1, termHeight - 1)}
          overflow="hidden"
        >
          <TranscriptView
            key={sessionId}
            width={termWidth}
            isActive={!pickerOwnsTranscript}
            followRequestKey={followRequestKey}
          >
            <Box flexDirection="column" width={termWidth}>
              {error && (
                <Box paddingX={1} marginBottom={1}>
                  <Text color={theme.error}>✕ {error}</Text>
                </Box>
              )}
              <ChatPanel
                messages={messages}
                streamingMessageId={streamingMessageId}
                pendingPermission={pendingPermission}
                expandedToolCallId={expandedToolId}
                reducedMotion={motionDisabled}
                screenReader={screenReader}
                terminalWidth={termWidth}
                terminalHeight={termHeight}
                workspace={config.workspace}
                model={liveConfig.modelSelection ?? liveConfig.model}
                mode={mode}
                commandCount={commands.length}
                skillCount={skills.length}
                retryPhase={retryPhase}
                showAllToolOutput={showAllToolOutput}
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
                    <HelpRow
                      label="/clear [name]"
                      description="Start new; save previous (/new, /reset)"
                      theme={theme}
                    />
                    <HelpRow
                      label="/resume [id|name]"
                      description="Resume a saved conversation"
                      theme={theme}
                    />
                    <HelpRow
                      label="/compact"
                      description="Summarize this conversation"
                      theme={theme}
                    />
                    <HelpRow label="/task <subject>" description="Add a task" theme={theme} />
                    <HelpRow
                      label="/theme [dark|light|auto]"
                      description="Switch theme"
                      theme={theme}
                    />
                    <HelpRow
                      label="/model [name]"
                      description="Switch model or add a BYOK provider"
                      theme={theme}
                    />
                    <HelpRow label="/config" description="Show configuration" theme={theme} />
                    <HelpRow label="/diff" description="Show git diff" theme={theme} />
                    <HelpRow label="/status" description="Session status" theme={theme} />
                    <HelpRow label="/memory" description="Manage memory" theme={theme} />
                    <HelpRow label="/permissions" description="Permission rules" theme={theme} />
                    <HelpRow label="/cost" description="Token usage/cost" theme={theme} />
                    <HelpRow label="/skills" description="List skills" theme={theme} />
                    <HelpRow label="/init" description="Initialize CLAUDE.md" theme={theme} />
                    <HelpRow label="/reload-skills" description="Reload commands" theme={theme} />
                    <HelpRow
                      label="/export [file]"
                      description="Export conversation"
                      theme={theme}
                    />
                    <HelpRow
                      label="/usage"
                      description="Session cost & tokens (/stats)"
                      theme={theme}
                    />
                    <HelpRow
                      label="/context"
                      description="What fills the context window"
                      theme={theme}
                    />
                    <HelpRow
                      label="/review [scope]"
                      description="Review current git diff"
                      theme={theme}
                    />
                    <HelpRow
                      label="/security-review [scope]"
                      description="Security audit of the diff"
                      theme={theme}
                    />
                    <HelpRow
                      label="/release-notes"
                      description="Version + changelog"
                      theme={theme}
                    />
                    <HelpRow
                      label="/feedback [note]"
                      description="Save a bug-report snapshot"
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
                    <HelpRow
                      label="Model"
                      description={liveConfig.modelSelection ?? liveConfig.model}
                      theme={theme}
                    />
                    <HelpRow
                      label="Session"
                      description={`${sessionName ? `${sessionName} · ` : ''}${sessionId}`}
                      theme={theme}
                    />
                    <HelpRow label="Workspace" description={config.workspace} theme={theme} />
                    <HelpRow
                      label="Max Tokens"
                      description={String(config.maxTokens)}
                      theme={theme}
                    />
                    <HelpRow
                      label="Max Turns"
                      description={
                        config.maxTurns == null || config.maxTurns <= 0
                          ? 'unlimited'
                          : String(config.maxTurns)
                      }
                      theme={theme}
                    />
                    <HelpRow label="Mode" description={mode} theme={theme} />
                    <HelpRow label="Tokens Used" description={`${tokenCount}`} theme={theme} />
                    <HelpRow label="Turn" description={`${currentTurn}`} theme={theme} />
                    <HelpRow
                      label="Tasks"
                      description={`${tasks.length} (${tasks.filter((t) => t.status === 'in_progress').length} active)`}
                      theme={theme}
                    />
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
                    <HelpRow
                      label="Modes"
                      description="default, auto, plan, accept-edits, dontAsk, bypassPermissions"
                      theme={theme}
                    />
                    <HelpRow label="Switch" description="Alt+M or Shift+Tab" theme={theme} />
                  </Box>
                  <Box marginTop={1} flexDirection="column">
                    <Text color={theme.subtle} dimColor>
                      Permission rules (add via the "Always allow" option at tool prompts):
                    </Text>
                    <Text color={theme.subtle} dimColor>
                      {' '}
                      allow:
                    </Text>
                    {liveConfig.settings.permissions.allow.length === 0 ? (
                      <Text color={theme.subtle} dimColor>
                        {' '}
                        (none)
                      </Text>
                    ) : (
                      liveConfig.settings.permissions.allow.map((r) => (
                        <Text key={r} color={theme.subtle} dimColor>
                          {' '}
                          {r}
                        </Text>
                      ))
                    )}
                    <Text color={theme.subtle} dimColor>
                      {' '}
                      ask:
                    </Text>
                    {liveConfig.settings.permissions.ask.length === 0 ? (
                      <Text color={theme.subtle} dimColor>
                        {' '}
                        (none)
                      </Text>
                    ) : (
                      liveConfig.settings.permissions.ask.map((r) => (
                        <Text key={r} color={theme.subtle} dimColor>
                          {' '}
                          {r}
                        </Text>
                      ))
                    )}
                    <Text color={theme.subtle} dimColor>
                      {' '}
                      deny:
                    </Text>
                    {liveConfig.settings.permissions.deny.length === 0 ? (
                      <Text color={theme.subtle} dimColor>
                        {' '}
                        (none)
                      </Text>
                    ) : (
                      liveConfig.settings.permissions.deny.map((r) => (
                        <Text key={r} color={theme.subtle} dimColor>
                          {' '}
                          {r}
                        </Text>
                      ))
                    )}
                  </Box>
                </Box>
              )}
              {showSkills && (
                <Box
                  flexDirection="column"
                  borderStyle="single"
                  borderColor={theme.subtle}
                  paddingX={1}
                  marginTop={1}
                >
                  <Text bold color={theme.brand}>
                    Skills ({skills.length})
                  </Text>
                  <Box flexDirection="column" marginTop={1}>
                    {skills.length === 0 ? (
                      <Text color={theme.subtle} dimColor>
                        (none discovered in .book/skills/ or ~/.book/skills/)
                      </Text>
                    ) : (
                      skills.map((s) => (
                        <HelpRow
                          key={s.name}
                          label={s.name}
                          description={s.description}
                          theme={theme}
                        />
                      ))
                    )}
                  </Box>
                </Box>
              )}
              {pendingPlanApproval ? (
                <PlanApprovalDetails plan={pendingPlanApproval.plan} screenReader={screenReader} />
              ) : null}
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
                    <HelpRow label="Ctrl+C" description="Cancel current turn" theme={theme} />
                    <HelpRow label="Ctrl+T" description="Toggle task list" theme={theme} />
                    <HelpRow label="Ctrl+E" description="Toggle full tool output" theme={theme} />
                    <HelpRow label="Ctrl+L" description="Redraw screen" theme={theme} />
                    <HelpRow label="Alt+M" description="Cycle permission mode" theme={theme} />
                    <HelpRow label="Alt+P" description="Open model picker" theme={theme} />
                    <HelpRow label="Up/Down" description="Navigate input history" theme={theme} />
                    <HelpRow label="PgUp/PgDn" description="Scroll transcript" theme={theme} />
                    <HelpRow
                      label="Ctrl+U/Ctrl+D"
                      description="Scroll transcript half a page"
                      theme={theme}
                    />
                    <HelpRow
                      label="Ctrl+Home/End"
                      description="Jump to transcript start/latest"
                      theme={theme}
                    />
                    <HelpRow
                      label="Ctrl+J / Shift+Enter"
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
          </TranscriptView>

          <Box flexDirection="column" flexShrink={0} width={termWidth}>
            {pendingPermission ? (
              <PermissionButtons
                key={pendingPermission.toolCall.id}
                toolCall={pendingPermission.toolCall}
                onResolve={resolvePermission}
                screenReader={screenReader}
              />
            ) : null}
            {pendingPlanApproval ? (
              <PlanApprovalActions
                plan={pendingPlanApproval.plan}
                onResolve={resolvePlanApproval}
                screenReader={screenReader}
              />
            ) : null}
            {showSessionPicker ? (
              <SessionPicker
                sessions={listSessions()}
                currentSessionId={sessionId}
                onPick={(selected) => {
                  setShowSessionPicker(false);
                  clearTasks();
                  void resumeConversation(selected.id).catch((err) => {
                    addLocalMessage(`✕ ${err instanceof Error ? err.message : String(err)}`);
                  });
                }}
                onCancel={() => setShowSessionPicker(false)}
              />
            ) : null}
            {showModelPicker ? (
              <ModelPicker
                options={modelOptions}
                currentModel={liveConfig.modelSelection ?? liveConfig.model}
                currentEffort={liveConfig.effort}
                hasPriorOutput={messages.length > 0}
                providers={liveConfig.settings.provider}
                workspace={config.workspace}
                retry={liveConfig.retry}
                compact={isNarrow || isTiny}
                maxVisibleModels={Math.max(3, Math.min(10, termHeight - 10))}
                warnings={[
                  process.env.BOOK_MODEL
                    ? `BOOK_MODEL is set to "${process.env.BOOK_MODEL}" — it overrides settings.model on next startup.`
                    : '',
                  liveConfig.model.startsWith('claude-') &&
                  config.model &&
                  !config.model.startsWith('claude-')
                    ? 'Switching to an Anthropic model may need a separate API key.'
                    : '',
                ].filter(Boolean)}
                onPick={(model, saveDefault) => {
                  const result = setModel(model, { persist: saveDefault });
                  if (!result.ok) return result;
                  addLocalMessage(
                    saveDefault
                      ? `Switched to ${model} (saved as default).`
                      : `Switched to ${model} for this session only.`,
                  );
                  setShowModelPicker(false);
                  return result;
                }}
                onPickEffort={(level) => setEffort(level)}
                onSaveProvider={upsertProviderAndSelect}
                onProviderSaved={(request) => {
                  addLocalMessage(
                    `Added ${request.providerId} with ${request.models.length} model${request.models.length === 1 ? '' : 's'}; using ${request.providerId}/${request.activeModelId}.`,
                  );
                  setShowModelPicker(false);
                }}
                onCancel={() => setShowModelPicker(false)}
              />
            ) : null}
          </Box>

          <WorkingIndicator
            isThinking={isThinking}
            messages={messages}
            streamingMessageId={streamingMessageId}
            pendingPermission={pendingPermission}
            pendingPlanApproval={pendingPlanApproval}
            retryPhase={retryPhase}
            retryAttempt={retryAttempt}
            retryMax={retryMax}
            retryCountdownMs={retryCountdownMs}
            terminalWidth={termWidth}
            reducedMotion={motionDisabled}
            screenReader={screenReader}
          />

          {/* Input bar — above the status line. Command menu is built into InputBar. */}
          <Box flexDirection="column" flexShrink={0} width={termWidth}>
            <InputBar
              key={sessionId}
              onSubmit={handleSubmit}
              disabled={isThinking}
              mode={mode}
              onCycleMode={cycleMode}
              onInterrupt={cancel}
              inputSuppressed={ownsModalInput(
                pendingPermission,
                pendingPlanApproval,
                showModelPicker,
                showSessionPicker,
              )}
              onGlobalShortcut={handleGlobalShortcut}
              commands={commands}
              terminalWidth={termWidth}
              maxMenuRows={maxCommandMenuRows}
              compact={isNarrow || isTiny}
              reducedMotion={motionDisabled}
              screenReader={screenReader}
            />
          </Box>

          {/* Status line — stable footer */}
          <Box flexShrink={0} width={termWidth}>
            <StatusLine
              model={liveConfig.modelSelection ?? liveConfig.model}
              tokenCount={tokenCount}
              maxTokens={liveConfig.modelInfo?.contextWindow ?? liveConfig.maxTokens}
              mode={mode}
              taskCount={tasks.length}
              activeTaskCount={tasks.filter((t) => t.status === 'in_progress').length}
              terminalWidth={termWidth}
              compact={compactStatus}
              reducedMotion={motionDisabled}
              screenReader={screenReader}
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
