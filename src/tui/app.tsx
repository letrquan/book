import { Box, Text, useInput, useStdout, useApp } from 'ink';
import { useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ChatPanel } from './components/ChatPanel.js';
import { InputBar } from './components/InputBar.js';
import { StatusLine } from './components/StatusLine.js';
import { WorkingIndicator } from './components/WorkingIndicator.js';
import { CompactDiffCard } from './components/CompactDiffCard.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { TaskList } from './components/TaskList.js';
import { AgentTodoList, shouldShowAgentPlan } from './components/AgentTodoList.js';
import { ModelPicker, type ProviderRemovalResult } from './components/ModelPicker.js';
import { EffortPicker } from './components/EffortPicker.js';
import { ThemePicker } from './components/ThemePicker.js';
import { SessionPicker } from './components/SessionPicker.js';
import { RewindPicker } from './components/RewindPicker.js';
import { TranscriptView } from './components/TranscriptView.js';
import { PermissionButtons } from './components/PermissionButtons.js';
import { PlanApprovalActions, PlanApprovalDetails } from './components/PlanApprovalButtons.js';
import { AskUserQuestionWizard } from './components/AskUserQuestionWizard.js';
import { useAgent } from './hooks/useAgent.js';
import { useTasks } from './hooks/useTasks.js';
import {
  ThemeContext,
  listCustomThemes,
  resolveTheme,
  DARK_THEME,
  type ThemeTokens,
  type ResolvedTheme,
} from './theme.js';
import type {
  AgentConfig,
  CommandContext,
  RewindSnapshotStoreInterface,
  SessionStoreInterface,
} from '../types.js';
import type { SessionBootstrap } from '../session/resolve.js';
import { DensityContext, resolveTuiDensity } from './density.js';
import { discoverCommands, resolveCommandBody } from '../commands/loader.js';
import { parseSlashInput } from '../commands/resolve.js';
import {
  createBuiltinCommandRegistry,
  type BuiltinCommandContext,
  type BuiltinCommandEffect,
} from '../commands/builtins.js';
import { discoverSkills } from '../skills.js';
import { runGit } from '../tools/git.js';
import { costReport, PRICING, usageReport } from '../pricing.js';
import { buildMemoryInboxReport, buildMemoryReport, getMemoryIndex } from '../memory-display.js';
import {
  approveMemoryCandidate,
  discardMemoryCandidate,
  getProjectMemoryDir,
  listMemoryCandidates,
  loadMemoryContext,
} from '../memory-store.js';
import { buildContextBreakdown, buildContextReport } from '../context-report.js';
import { discoverClaudeMd } from '../claude-md.js';
import { discoverAgents } from '../subagent-discovery.js';
import { persistSettingLocal } from './persist.js';
import { buildModelOptions } from './model-options.js';
import { redactSettingValue, redactSettingsForDisplay } from '../settings-redaction.js';
import { createUiDebugLogger } from '../debug-log.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { getOrCreateAgentManager } from '../agents/manager.js';
import { selectExpandedToolId, selectLatestToolId } from './tool-traces.js';
import {
  getTranscriptShortcutAction,
  shouldExpandTool,
  type TranscriptMode,
} from './tool-presentation.js';
import { useDebugMount, useDebugValueChange } from './debug.js';
import {
  EFFORT_USAGE,
  getAvailableEffortLevels,
  getEffortUnavailableError,
  isEffortLevel,
} from './effort.js';

const uiLog = createUiDebugLogger('tui:app');

export function ownsModalInput(
  pendingPermission: unknown,
  pendingPlanApproval: unknown,
  showModelPicker: boolean,
  showSessionPicker = false,
  pendingUserQuestion?: unknown,
  showEffortPicker = false,
  showThemePicker = false,
  showRewindPicker = false,
): boolean {
  return Boolean(
    pendingPermission ||
    pendingPlanApproval ||
    pendingUserQuestion ||
    showModelPicker ||
    showSessionPicker ||
    showEffortPicker ||
    showThemePicker ||
    showRewindPicker,
  );
}

/** Settable top-level settings keys (for /config --help). Mirrors cli/config-cmd.ts allowlist. */
const SETTABLE_KEYS = [
  'model',
  'maxTurns',
  'maxTokens',
  'autoCompactEnabled',
  'defaultMode',
  'effort',
  'theme',
  'provider',
  'permissions',
  'sandbox',
  'hooks',
  'memory',
  'additionalDirectories',
  'env',
];

type ApplyThemeResult = { ok: true; theme: ResolvedTheme } | { ok: false; error: string };

function themeAppliedMessage(theme: ResolvedTheme): string {
  if (theme.preference === 'auto') {
    return `Theme set to auto (currently ${theme.resolvedName}) and saved as default.`;
  }
  return `Switched to ${theme.preference} theme (saved as default).`;
}

export function providerRemovalMessage(
  result: Extract<ProviderRemovalResult, { ok: true }>,
): string {
  if (result.inheritedProviderRevealed) {
    return `Removed the local ${result.providerId} override; the inherited ${result.providerId} provider remains configured.`;
  }
  if (result.switched) {
    return `Removed local BYOK provider ${result.providerId} and switched to ${result.activeModel}.`;
  }
  const models = `${result.removedModelCount} model${result.removedModelCount === 1 ? '' : 's'}`;
  return `Removed local BYOK provider ${result.providerId} and its ${models}.`;
}

interface AppProps {
  config: AgentConfig;
  session: SessionBootstrap & {
    store?: SessionStoreInterface;
    timelineStore?: SessionStoreInterface;
    snapshotStore?: RewindSnapshotStoreInterface;
  };
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
 *   Ctrl+O   — toggle detailed transcript
 *   Ctrl+E   — expand the current tool output
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
    contextHistory,
    compactBoundaries,
    isThinking,
    isCompacting,
    isRewinding,
    compactUi,
    setCompactUi,
    streamingMessageId,
    error,
    currentTurn,
    tokenCount,
    usage,
    mode,
    pendingPermission,
    pendingPlanApproval,
    pendingUserQuestion,
    pendingUserQuestionCount,
    agentTodos,
    liveConfig,
    localProviderIds,
    localProviderModelCounts,
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
    resolveUserQuestion,
    cancel,
    compact,
    rewind,
    getRewindTargets,
    cycleMode,
    addLocalMessage,
    setModel,
    upsertProviderAndSelect,
    removeProvider,
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
  const [showAllDetailedOutput, setShowAllDetailedOutput] = useState(false);
  const [showAllToolOutputIds, setShowAllToolOutputIds] = useState<Set<string>>(() => new Set());
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>('compact');
  const [toolExpansionOverrides, setToolExpansionOverrides] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const [focusedToolId, setFocusedToolId] = useState<string | null>(null);
  const [showPermissions, setShowPermissions] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showEffortPicker, setShowEffortPicker] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [showRewindPicker, setShowRewindPicker] = useState(false);
  const [draftRestore, setDraftRestore] = useState<{ key: number; value: string }>();
  const [followRequestKey, setFollowRequestKey] = useState(0);
  const [currentTheme, setCurrentTheme] = useState<ResolvedTheme>(
    () =>
      resolveTheme(config.workspace, config.settings.theme ?? 'dark') ?? {
        preference: 'dark',
        resolvedName: 'dark',
        tokens: DARK_THEME,
      },
  );
  const [customThemes, setCustomThemes] = useState<string[]>(() =>
    listCustomThemes(config.workspace),
  );
  const { tasks, addTask, updateTaskStatus, removeTask, clearTasks } = useTasks();
  const theme = currentTheme.tokens;
  const { exit: exitApp } = useApp();

  // Discover slash commands on startup.
  const commands = useMemo(() => discoverCommands(config.workspace), [config.workspace]);
  const builtinCommandRegistry = useMemo(() => createBuiltinCommandRegistry(), []);
  const skills = useMemo(() => discoverSkills(config.workspace), [config.workspace]);
  const modelOptions = useMemo(() => buildModelOptions(liveConfig.settings), [liveConfig.settings]);
  const effortLevels = useMemo(() => getAvailableEffortLevels(liveConfig), [liveConfig.modelInfo]);

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
  const density = resolveTuiDensity(termHeight);
  const reducedMotion = Boolean(config.accessibility?.reducedMotion);
  // Keep the whole live region quiescent while the terminal viewport belongs
  // to the user reviewing a plan. Any animation repaint can snap scrollback.
  const motionDisabled = reducedMotion || Boolean(pendingPlanApproval || pendingUserQuestion);
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
  useDebugValueChange(uiLog, 'showAllDetailedOutput', showAllDetailedOutput, (v) => String(v));
  useDebugValueChange(uiLog, 'transcriptMode', transcriptMode);
  useDebugValueChange(uiLog, 'showPermissions', showPermissions, (v) => String(v));
  useDebugValueChange(uiLog, 'showSkills', showSkills, (v) => String(v));
  useDebugValueChange(uiLog, 'showModelPicker', showModelPicker, (v) => String(v));
  useDebugValueChange(uiLog, 'showEffortPicker', showEffortPicker, (v) => String(v));
  useDebugValueChange(uiLog, 'showThemePicker', showThemePicker, (v) => String(v));

  useInput((input, key) => {
    // Modal prompts own the keyboard until they resolve. Let their own
    // useInput handlers receive the event, but do not open another modal or
    // mutate surrounding UI state from this global handler.
    if (
      ownsModalInput(
        pendingPermission,
        pendingPlanApproval,
        showModelPicker,
        showSessionPicker,
        pendingUserQuestion,
        showEffortPicker,
        showThemePicker,
        showRewindPicker,
      )
    ) {
      if (key.escape) {
        uiLog.event('input:Escape', { action: 'noop-modal-active' });
      } else if (key.ctrl && input === 'c') {
        if (pendingUserQuestion) {
          uiLog.event('input:Ctrl+C', { action: 'cancel-question-turn' });
          cancel();
        } else {
          uiLog.event('input:Ctrl+C', { action: 'noop-modal-active' });
        }
      }
      return;
    }

    if (transcriptMode === 'detailed') {
      const transcriptAction = getTranscriptShortcutAction(transcriptMode, input, key);
      if (transcriptAction === 'exit-detailed') {
        uiLog.event('input:detail-exit', {
          key: key.ctrl ? 'Ctrl+O' : key.escape ? 'Escape' : 'q',
        });
        setTranscriptMode('compact');
        setShowAllDetailedOutput(false);
        return;
      }
      if (transcriptAction === 'expand-output') {
        uiLog.event('input:Ctrl+E', { action: 'show-all-detailed-output' });
        setShowAllDetailedOutput(true);
        return;
      }
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

  // Compact mode automatically opens only the latest unfinished action.
  const expandedToolId = useMemo(() => selectExpandedToolId(messages), [messages]);
  const showAgentPlan = shouldShowAgentPlan(agentTodos, showTasks);

  useEffect(() => {
    setTranscriptMode('compact');
    setShowAllDetailedOutput(false);
    setShowAllToolOutputIds(new Set());
    setToolExpansionOverrides(new Map());
    setFocusedToolId(null);
  }, [sessionId]);

  const toggleToolExpansion = useCallback(
    (toolId: string) => {
      setFocusedToolId(toolId);
      setToolExpansionOverrides((current) => {
        const next = new Map(current);
        const isExpanded = shouldExpandTool({
          mode: transcriptMode,
          toolId,
          automaticToolId: expandedToolId,
          expansionOverrides: current,
          screenReader,
        });
        next.set(toolId, !isExpanded);
        return next;
      });
    },
    [expandedToolId, screenReader, transcriptMode],
  );

  const applyThemePreference = useCallback(
    (preference: string): ApplyThemeResult => {
      const resolved = resolveTheme(config.workspace, preference);
      if (!resolved) {
        return {
          ok: false,
          error: `Theme "${preference}" was not found. Choose dark, light, auto, or a theme from .book/themes.`,
        };
      }
      const persisted = persistSettingLocal(config.workspace, 'theme', resolved.preference);
      if (!persisted.ok) {
        return {
          ok: false,
          error: `Could not save theme: ${persisted.error ?? 'unknown settings error'}`,
        };
      }
      setCurrentTheme(resolved);
      return { ok: true, theme: resolved };
    },
    [config.workspace],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      setFollowRequestKey((key) => key + 1);
      // Coarse slash-command dispatch trace (one event per submit).
      const parsedSlash = parseSlashInput(value);
      if (parsedSlash) {
        uiLog.event('slash:dispatch', {
          command: parsedSlash.name,
          hasArg: parsedSlash.rawArguments.length > 0,
          disabled: isThinking,
        });
      } else {
        uiLog.event('submit:text', { len: value.length, disabled: isThinking });
      }
      // Built-ins resolve through the shared exact-name registry before custom commands.
      let commandName = parsedSlash?.name ?? '';
      let commandArg = parsedSlash?.rawArguments ?? '';
      if (parsedSlash) {
        const commandContext: BuiltinCommandContext = {
          workspace: config.workspace,
          sessionId,
          model: liveConfig.model,
          provider: liveConfig.provider,
          currentTurn,
          messages,
          lastError: error,
        };
        let effect: BuiltinCommandEffect | undefined;
        try {
          effect = builtinCommandRegistry.execute(
            parsedSlash.name,
            parsedSlash.rawArguments,
            commandContext,
          );
        } catch (commandError) {
          addLocalMessage(
            `✕ ${commandError instanceof Error ? commandError.message : String(commandError)}`,
          );
          return;
        }
        if (effect?.type === 'send-prompt') {
          send(effect.prompt, effect.context);
          return;
        }
        if (effect?.type === 'local-message') {
          addLocalMessage(effect.content);
          return;
        }
        if (effect?.type === 'legacy') {
          commandName = effect.commandName;
          commandArg = effect.rawArguments;
        }
      }
      if (commandName === 'clear' || commandName === 'new' || commandName === 'reset') {
        clearTasks();
        setShowHelp(false);
        setShowStatus(false);
        setShowSessionPicker(false);
        setShowRewindPicker(false);
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
      } else if (commandName === 'compact') {
        void compact(commandArg || undefined);
      } else if (commandName === 'rewind') {
        if (commandArg) addLocalMessage('Usage: /rewind');
        else setShowRewindPicker(true);
      } else if (commandName === 'exit') {
        void endCurrentSession('exit').finally(exitApp);
      } else if (commandName === 'help') {
        setShowHelp((s) => !s);
      } else if (commandName === 'agents') {
        const manager = getOrCreateAgentManager(
          liveConfig,
          createDefaultRegistry({ agents: true }).getDefinitions(),
        );
        void manager
          .list()
          .then((records) => {
            addLocalMessage(
              records.length === 0
                ? 'No managed agents for this repository.'
                : records
                    .map(
                      (record) =>
                        `${record.id}  ${record.role}/${record.name}  ${record.status}  apply:${record.applicationStatus}`,
                    )
                    .join('\n'),
            );
          })
          .catch((error) =>
            addLocalMessage(`✕ ${error instanceof Error ? error.message : String(error)}`),
          );
      } else if (commandName === 'agent') {
        const manager = getOrCreateAgentManager(
          liveConfig,
          createDefaultRegistry({ agents: true }).getDefinitions(),
        );
        const [actionOrId, id, ...rest] = commandArg.split(/\s+/).filter(Boolean);
        const reportError = (error: unknown) =>
          addLocalMessage(`✕ ${error instanceof Error ? error.message : String(error)}`);
        if (!actionOrId) {
          addLocalMessage(
            'Usage: /agent <id> | /agent send <id> <message> | /agent stop <id> | /agent apply <id> [evidence-id]',
          );
        } else if (actionOrId === 'send' && id) {
          void manager
            .send(id, rest.join(' '))
            .then((record) => addLocalMessage(JSON.stringify(record, null, 2)))
            .catch(reportError);
        } else if (actionOrId === 'stop' && id) {
          void manager
            .stop(id)
            .then((record) => addLocalMessage(JSON.stringify(record, null, 2)))
            .catch(reportError);
        } else if (actionOrId === 'apply' && id) {
          if (mode === 'plan') {
            addLocalMessage('✕ Agent apply is unavailable in plan mode.');
          } else {
            void manager
              .apply(id, rest[0])
              .then((result) => addLocalMessage(JSON.stringify(result, null, 2)))
              .catch(reportError);
          }
        } else {
          void manager
            .get(actionOrId)
            .then((record) =>
              addLocalMessage(
                record ? JSON.stringify(record, null, 2) : `✕ Agent ${actionOrId} was not found.`,
              ),
            )
            .catch(reportError);
        }
      } else if (commandName === 'task' && commandArg) {
        addTask({ subject: commandArg, status: 'pending' });
      } else if (commandName === 'theme') {
        if (!commandArg) {
          setCustomThemes(listCustomThemes(config.workspace));
          setShowThemePicker(true);
        } else {
          const result = applyThemePreference(commandArg);
          addLocalMessage(result.ok ? themeAppliedMessage(result.theme) : `✕ ${result.error}`);
        }
      } else if (commandName === 'model') {
        if (commandArg) {
          const result = setModel(commandArg);
          addLocalMessage(
            result.ok ? `Switched to ${commandArg} (saved as default).` : `✕ ${result.error}`,
          );
        } else {
          setShowModelPicker(true);
        }
      } else if (commandName === 'providers') {
        if (commandArg) addLocalMessage('Usage: /providers');
        else setShowModelPicker(true);
      } else if (commandName === 'effort') {
        if (!commandArg) {
          const unavailable = getEffortUnavailableError(liveConfig);
          if (unavailable) addLocalMessage(`✕ ${unavailable}`);
          else setShowEffortPicker(true);
        } else {
          const normalized = commandArg.toLowerCase();
          if (!isEffortLevel(normalized)) {
            addLocalMessage(EFFORT_USAGE);
          } else {
            const result = setEffort(normalized);
            addLocalMessage(
              result.ok
                ? `Set effort level to ${normalized} (saved as default).`
                : `✕ ${result.error}`,
            );
          }
        }
      } else if (commandName === 'config') {
        const arg = commandArg;
        if (!arg) {
          const snapshot = redactSettingsForDisplay({
            ...liveConfig.settings,
            model: liveConfig.modelSelection ?? liveConfig.model,
            baseUrl: liveConfig.baseUrl,
            workspace: liveConfig.workspace,
            maxTurns: liveConfig.maxTurns,
            maxTokens: liveConfig.maxTokens,
            effort: liveConfig.effort,
            activeProvider: liveConfig.provider,
            modelInfo: liveConfig.modelInfo,
          }) as Record<string, unknown>;
          addLocalMessage(JSON.stringify(snapshot, null, 2), {
            kind: 'config',
            snapshot,
            runtime: {
              model: liveConfig.modelSelection ?? liveConfig.model,
              provider: liveConfig.provider ?? 'auto',
              effort: liveConfig.effort,
              mode,
              maxTokens: liveConfig.modelInfo?.contextWindow ?? liveConfig.maxTokens,
              workspace: liveConfig.workspace,
            },
          });
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
      } else if (commandName === 'diff') {
        void runGit(['diff'], {
          workspaceRoot: config.workspace,
          env: process.env as Record<string, string>,
        }).then((result) => {
          addLocalMessage(
            result.error ? `✕ ${result.error}` : result.output.trim() || '(no changes)',
          );
        });
      } else if (commandName === 'status') {
        setShowStatus((s) => !s);
      } else if (commandName === 'memory') {
        const arg = commandArg;

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
      } else if (commandName === 'permissions') {
        setShowPermissions((s) => !s);
      } else if (commandName === 'cost') {
        addLocalMessage(costReport(liveConfig.model, usage));
      } else if (commandName === 'usage' || commandName === 'stats') {
        const rate = PRICING[liveConfig.model];
        const estimatedCostUsd =
          usage && rate
            ? (usage.promptTokens * rate.in + usage.completionTokens * rate.out) / 1_000_000
            : undefined;
        addLocalMessage(
          usageReport(liveConfig.model, usage, {
            currentTurn,
            messageCount: messages.length,
            turnDurationMs,
          }),
          {
            kind: 'usage',
            model: liveConfig.model,
            currentTurn,
            messageCount: messages.length,
            turnDurationMs,
            usage,
            rate: rate ? { inputPerMillion: rate.in, outputPerMillion: rate.out } : undefined,
            estimatedCostUsd,
          },
        );
      } else if (commandName === 'context') {
        const ambient = {
          model: liveConfig.model,
          maxTokens: liveConfig.modelInfo?.contextWindow ?? liveConfig.maxTokens,
          contextHistory,
          compactBoundaries,
          skillCount: skills.length,
          commandCount: commands.length,
          subagentCount: discoverAgents(config.workspace).length,
          hasMemoryIndex: Boolean(
            liveConfig.memoryContext?.indexLoaded ?? getMemoryIndex(config.workspace).indexFile,
          ),
          hasClaudeMdLoader: discoverClaudeMd(config.workspace).length > 0,
        };
        const breakdown = buildContextBreakdown(contextHistory);
        addLocalMessage(buildContextReport(messages, ambient), {
          kind: 'context',
          model: ambient.model,
          maxTokens: ambient.maxTokens,
          estimatedTokens: breakdown.estimatedTokens,
          totalMessages: breakdown.totalMessages,
          userMessages: breakdown.userMessages,
          assistantMessages: breakdown.assistantMessages,
          toolCalls: breakdown.toolCalls,
          toolResults: breakdown.toolResults,
          userTokens: breakdown.byRole.user,
          assistantTokens: breakdown.byRole.assistant,
          ambient: {
            commandCount: ambient.commandCount,
            skillCount: ambient.skillCount,
            subagentCount: ambient.subagentCount,
            hasMemoryIndex: ambient.hasMemoryIndex,
            hasClaudeMdLoader: ambient.hasClaudeMdLoader,
          },
        });
      } else if (commandName === 'skills') {
        setShowSkills((s) => !s);
      } else if (commandName === 'reload-skills') {
        // Force re-discovery of commands and skills on next render.
        addLocalMessage('Commands and skills have been reloaded.');
      } else if (value.startsWith('/')) {
        // Custom slash command: /name [args]
        const cmd = commands.find((c) => c.name === commandName);
        if (cmd) {
          const { resolved } = resolveCommandBody(cmd, commandArg, {
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
      setEffort,
      messages,
      currentTurn,
      turnDurationMs,
      error,
      skills,
      sessionId,
      stdout,
      isThinking,
      redrawViewport,
      applyThemePreference,
      builtinCommandRegistry,
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
      if (showModelPicker || showEffortPicker || showThemePicker || showRewindPicker) return true;
      if (key.ctrl && input === 'c') {
        if (pendingUserQuestion) {
          uiLog.event('input:Ctrl+C', { action: 'cancel-question-turn' });
          cancel();
          return true;
        }
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
      const transcriptAction = getTranscriptShortcutAction(transcriptMode, input, key);
      if (transcriptAction === 'enter-detailed') {
        uiLog.event('input:Ctrl+O', { action: 'enter-detailed-transcript' });
        setTranscriptMode('detailed');
        setShowAllDetailedOutput(false);
        return true;
      }
      if (transcriptAction === 'expand-output') {
        const targetToolId = expandedToolId ?? focusedToolId ?? selectLatestToolId(messages);
        uiLog.event('input:Ctrl+E', { action: 'expand-current-tool', toolId: targetToolId });
        if (targetToolId) {
          setToolExpansionOverrides((current) => new Map(current).set(targetToolId, true));
        }
        if (targetToolId) {
          setShowAllToolOutputIds((current) => new Set(current).add(targetToolId));
        }
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
      pendingUserQuestion,
      redrawViewport,
      showEffortPicker,
      showModelPicker,
      showThemePicker,
      showRewindPicker,
      expandedToolId,
      focusedToolId,
      messages,
    ],
  );

  // Track input changes for command menu filtering — now handled inside InputBar.
  // handleGlobalShortcut remains for Ctrl+/ keyboard shortcut reference.

  const pickerOwnsTranscript =
    showModelPicker || showEffortPicker || showThemePicker || showSessionPicker || showRewindPicker;

  return (
    <AppProviders theme={currentTheme.tokens} density={density}>
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
            onToggleTool={toggleToolExpansion}
          >
            <Box flexDirection="column" width={termWidth}>
              {error && (
                <Box paddingX={1} marginBottom={1}>
                  <Text color={theme.error}>✕ {error}</Text>
                </Box>
              )}
              <ChatPanel
                messages={messages}
                compactBoundaries={compactBoundaries}
                streamingMessageId={streamingMessageId}
                pendingPermission={pendingPermission}
                transcriptMode={transcriptMode}
                automaticToolCallId={expandedToolId}
                toolExpansionOverrides={toolExpansionOverrides}
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
                showAllToolOutput={showAllDetailedOutput}
                showAllToolOutputIds={showAllToolOutputIds}
                retryAttempt={retryAttempt}
                retryMax={retryMax}
                retryCountdownMs={retryCountdownMs}
              />
              {showAgentPlan && <AgentTodoList todos={agentTodos} />}
              {showTasks && (
                <TaskList tasks={tasks} onUpdateStatus={updateTaskStatus} onRemove={removeTask} />
              )}
              {showHelp && (
                <Box
                  flexDirection="column"
                  borderStyle="round"
                  borderColor={theme.border}
                  paddingX={1}
                >
                  <Text bold color={theme.brand}>
                    Slash Commands
                  </Text>
                  <Box flexDirection="column">
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
                      label="/compact [focus]"
                      description="Summarize conversation (optional focus)"
                      theme={theme}
                    />
                    <HelpRow
                      label="/rewind"
                      description="Restore conversation, code, or both"
                      theme={theme}
                    />
                    <HelpRow label="/task <subject>" description="Add a task" theme={theme} />
                    <HelpRow
                      label="/theme [dark|light|auto|name]"
                      description="Choose and save a color theme"
                      theme={theme}
                    />
                    <HelpRow
                      label="/model [name]"
                      description="Switch models and manage BYOK providers"
                      theme={theme}
                    />
                    <HelpRow
                      label="/providers"
                      description="Add providers; Alt+D removes selected local BYOK"
                      theme={theme}
                    />
                    <HelpRow
                      label="/effort [low|medium|high|xhigh|max]"
                      description="Set thinking effort"
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
                  borderStyle="round"
                  borderColor={theme.border}
                  paddingX={1}
                >
                  <Text bold color={theme.brand}>
                    Session Status
                  </Text>
                  <Box flexDirection="column">
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
                  borderStyle="round"
                  borderColor={theme.border}
                  paddingX={1}
                >
                  <Text bold color={theme.brand}>
                    Permission Mode
                  </Text>
                  <Box flexDirection="column">
                    <HelpRow label="Current Mode" description={mode} theme={theme} />
                    <HelpRow
                      label="Modes"
                      description="default, auto, plan, accept-edits, dontAsk, bypassPermissions"
                      theme={theme}
                    />
                    <HelpRow label="Switch" description="Alt+M or Shift+Tab" theme={theme} />
                  </Box>
                  <Box flexDirection="column">
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
                  borderStyle="round"
                  borderColor={theme.border}
                  paddingX={1}
                >
                  <Text bold color={theme.brand}>
                    Skills ({skills.length})
                  </Text>
                  <Box flexDirection="column">
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
                <PlanApprovalDetails
                  plan={pendingPlanApproval.plan}
                  screenReader={screenReader}
                  terminalWidth={termWidth}
                />
              ) : null}
              {showShortcuts && (
                <Box
                  flexDirection="column"
                  borderStyle="round"
                  borderColor={theme.border}
                  paddingX={1}
                >
                  <Text bold color={theme.brand}>
                    Keyboard Shortcuts
                  </Text>
                  <Box flexDirection="column">
                    <HelpRow
                      label="Esc"
                      description="Cancel permission / abort stream"
                      theme={theme}
                    />
                    <HelpRow label="Ctrl+C" description="Cancel current turn" theme={theme} />
                    <HelpRow label="Ctrl+T" description="Toggle task list" theme={theme} />
                    <HelpRow
                      label="Ctrl+O"
                      description="Toggle detailed transcript"
                      theme={theme}
                    />
                    <HelpRow
                      label="Ctrl+E"
                      description="Expand current tool output"
                      theme={theme}
                    />
                    <HelpRow
                      label="Click"
                      description="Expand or collapse a tool summary"
                      theme={theme}
                    />
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
                terminalWidth={termWidth}
              />
            ) : null}
            {pendingUserQuestion ? (
              <AskUserQuestionWizard
                key={pendingUserQuestion.request.id}
                request={pendingUserQuestion.request}
                queueLength={pendingUserQuestionCount}
                terminalWidth={termWidth}
                onResolve={resolveUserQuestion}
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
            {showRewindPicker ? (
              <RewindPicker
                targets={getRewindTargets()}
                isRewinding={isRewinding}
                onAction={async (target, action) => {
                  const result = await rewind(target.id, action);
                  if (!result.ok) return result;
                  if (action === 'conversation' || action === 'both') clearTasks();
                  if (result.restoredPrompt !== undefined) {
                    setDraftRestore((current) => ({
                      key: (current?.key ?? 0) + 1,
                      value: result.restoredPrompt!,
                    }));
                  }
                  setShowRewindPicker(false);
                  setFollowRequestKey((key) => key + 1);
                  return { ok: true };
                }}
                onCancel={() => setShowRewindPicker(false)}
              />
            ) : null}
            {showModelPicker ? (
              <ModelPicker
                options={modelOptions}
                currentModel={liveConfig.modelSelection ?? liveConfig.model}
                currentEffort={liveConfig.effort}
                effortLevels={effortLevels ?? []}
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
                removableProviderIds={localProviderIds}
                removableProviderModelCounts={localProviderModelCounts}
                onRemoveProvider={(providerId) => {
                  const result = removeProvider(providerId);
                  if (!result.ok) return result;
                  addLocalMessage(providerRemovalMessage(result));
                  setShowModelPicker(false);
                  return result;
                }}
                onProviderSaved={(request) => {
                  addLocalMessage(
                    `Added ${request.providerId} with ${request.models.length} model${request.models.length === 1 ? '' : 's'}; using ${request.providerId}/${request.activeModelId}.`,
                  );
                  setShowModelPicker(false);
                }}
                onCancel={() => setShowModelPicker(false)}
              />
            ) : null}
            {showEffortPicker && effortLevels ? (
              <EffortPicker
                current={liveConfig.effort}
                availableLevels={effortLevels}
                onSelect={(level) => {
                  const result = setEffort(level);
                  if (!result.ok) return result;
                  addLocalMessage(`Set effort level to ${level} (saved as default).`);
                  setShowEffortPicker(false);
                  return result;
                }}
                onCancel={() => setShowEffortPicker(false)}
              />
            ) : null}
            {showThemePicker ? (
              <ThemePicker
                current={currentTheme.preference}
                customThemes={customThemes}
                onSelect={(name) => {
                  const result = applyThemePreference(name);
                  if (!result.ok) return result;
                  addLocalMessage(themeAppliedMessage(result.theme));
                  setShowThemePicker(false);
                  return { ok: true };
                }}
                onCancel={() => setShowThemePicker(false)}
              />
            ) : null}
          </Box>

          {compactUi && compactUi.phase !== 'working' ? (
            <CompactDiffCard
              state={compactUi}
              terminalWidth={termWidth}
              reducedMotion={motionDisabled}
              screenReader={screenReader}
              onSettled={() => {
                if (compactUi.phase === 'diff') {
                  setCompactUi({ ...compactUi, phase: 'done' });
                }
              }}
            />
          ) : null}

          <WorkingIndicator
            isThinking={isThinking}
            isCompacting={isCompacting}
            compactTrigger={compactUi?.trigger}
            compactComplete={compactUi?.phase === 'diff'}
            messages={messages}
            streamingMessageId={streamingMessageId}
            pendingPermission={pendingPermission}
            pendingPlanApproval={pendingPlanApproval}
            pendingUserQuestion={pendingUserQuestion}
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
              disabled={isThinking || isCompacting || isRewinding}
              mode={mode}
              onCycleMode={cycleMode}
              onInterrupt={cancel}
              inputSuppressed={
                ownsModalInput(
                  pendingPermission,
                  pendingPlanApproval,
                  showModelPicker,
                  showSessionPicker,
                  pendingUserQuestion,
                  showEffortPicker,
                  showThemePicker,
                  showRewindPicker,
                ) || transcriptMode === 'detailed'
              }
              onGlobalShortcut={handleGlobalShortcut}
              commands={commands}
              terminalWidth={termWidth}
              maxMenuRows={maxCommandMenuRows}
              compact={isNarrow || isTiny}
              reducedMotion={motionDisabled}
              screenReader={screenReader}
              draftRestore={draftRestore}
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
    </AppProviders>
  );
}

function AppProviders({
  theme,
  density,
  children,
}: {
  theme: ThemeTokens;
  density: ReturnType<typeof resolveTuiDensity>;
  children: ReactNode;
}) {
  return (
    <ThemeContext.Provider value={theme}>
      <DensityContext.Provider value={density}>{children}</DensityContext.Provider>
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
