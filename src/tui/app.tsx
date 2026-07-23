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
import { useManagedAgents } from './hooks/useManagedAgents.js';
import { useAgentCompletionDelivery } from './hooks/useAgentCompletionDelivery.js';
import { SubagentPanel } from './components/SubagentPanel.js';
import { SubagentDetail } from './components/SubagentDetail.js';
import { projectManagedAgentTraces } from './managed-agent-transcript.js';
import {
  ThemeContext,
  listCustomThemes,
  resolveTheme,
  DARK_THEME,
  type ThemeTokens,
  type ResolvedTheme,
} from './theme.js';
import type { AgentConfig } from '../types/runtime.js';
import type { CommandContext } from '../types/commands.js';
import type { RewindSnapshotStoreInterface, SessionStoreInterface } from '../types/sessions.js';
import type { SessionBootstrap } from '../session/resolve.js';
import { displaySessionName } from '../session/name.js';
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
import { getMemoryIndex } from '../memory-display.js';
import { discoverClaudeMd } from '../claude-md.js';
import { discoverAgents } from '../subagent-discovery.js';
import { persistSettingLocal } from './persist.js';
import { buildModelOptions } from './model-options.js';
import { createUiDebugLogger } from '../debug-log.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { getOrCreateAgentManager } from '../agents/manager.js';
import { installAgentImports, previewAgentImport } from '../agents/importer.js';
import { join } from 'path';
import {
  selectExpandedToolId,
  selectLatestToolId,
  shouldDefaultExpandToolId,
} from './tool-traces.js';
import {
  getTranscriptShortcutAction,
  shouldExpandTool,
  type TranscriptMode,
} from './tool-presentation.js';
import { useDebugMount, useDebugValueChange } from './debug.js';
import { getAvailableEffortLevels, getEffortUnavailableError } from '../commands/effort.js';
import type { InteractiveAssets } from './interactive-assets.js';

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
  interactiveAssets?: InteractiveAssets;
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
 *   Shift+drag — select terminal text for copying
 *   Alt+M    — cycle permission mode
 *   Alt+P    — open model picker
 *   Shift+Tab — cycle permission mode
 *   Ctrl+/   — toggle keyboard shortcuts reference
 */
export function App({ config, session, redrawViewport, interactiveAssets }: AppProps) {
  const {
    messages,
    contextHistory,
    compactBoundaries,
    isThinking,
    isCompacting,
    isRewinding,
    compactUi,
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
    runtime,
    localProviderIds,
    localProviderModelCounts,
    sessionId,
    sessionName,
    send,
    sendAgentCompletions,
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
    persistPermissionRule,
    turnDurationMs,
    retryPhase,
    retryAttempt,
    retryMax,
    retryCountdownMs,
  } = useAgent(config, session);

  const managedAgentManager = useMemo(
    () =>
      getOrCreateAgentManager(
        liveConfig,
        createDefaultRegistry({ agents: true }).getDefinitions(),
        {
          runtime,
          permissionMode: mode,
          persistPermissionRule,
        },
      ),
    [liveConfig, mode, persistPermissionRule, runtime],
  );
  const managedAgents = useManagedAgents(managedAgentManager, sessionId);

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
  const [isResolvingCommand, setIsResolvingCommand] = useState(false);
  const [draftRestore, setDraftRestore] = useState<{ key: number; value: string }>();
  const [followRequestKey, setFollowRequestKey] = useState(0);
  const [detailTaskPickerOpen, setDetailTaskPickerOpen] = useState(false);
  const [detailTaskPickerAgentId, setDetailTaskPickerAgentId] = useState<string>();
  const commandResolutionRef = useRef<AbortController | null>(null);
  const [currentTheme, setCurrentTheme] = useState<ResolvedTheme>(
    () =>
      interactiveAssets?.initialTheme ??
      resolveTheme(config.workspace, config.settings.theme ?? 'dark') ?? {
        preference: 'dark',
        resolvedName: 'dark',
        tokens: DARK_THEME,
      },
  );
  const [customThemes, setCustomThemes] = useState<string[]>(
    () => interactiveAssets?.customThemes ?? listCustomThemes(config.workspace),
  );
  const { tasks, addTask, updateTaskStatus, removeTask, clearTasks } = useTasks();
  const theme = currentTheme.tokens;
  const { exit: exitApp } = useApp();
  const interrupt = useCallback(() => {
    commandResolutionRef.current?.abort();
    commandResolutionRef.current = null;
    cancel();
  }, [cancel]);

  useEffect(() => {
    return () => commandResolutionRef.current?.abort();
  }, []);

  useEffect(() => {
    setDetailTaskPickerOpen(false);
    setDetailTaskPickerAgentId(undefined);
    managedAgents.setSurface('main');
    managedAgents.selectAgent(undefined);
  }, [managedAgents.selectAgent, managedAgents.setSurface, sessionId]);

  useAgentCompletionDelivery({
    pending: managedAgents.pendingCompletions,
    parentSessionId: sessionId,
    blocked: Boolean(
      isThinking ||
      isCompacting ||
      isRewinding ||
      isResolvingCommand ||
      pendingPermission ||
      pendingPlanApproval ||
      pendingUserQuestion,
    ),
    deliver: sendAgentCompletions,
    acknowledge: managedAgents.acknowledgeCompletions,
  });

  const [commands, setCommands] = useState(
    () => interactiveAssets?.commands ?? discoverCommands(config.workspace),
  );
  const builtinCommandRegistry = useMemo(() => createBuiltinCommandRegistry(), []);
  const [skills, setSkills] = useState(
    () => interactiveAssets?.skills ?? discoverSkills(config.workspace),
  );
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
  const managedAgentUiEnabled = liveConfig.settings.agents.ui.enabled;
  const childPermission = managedAgents.pendingPermissions.find(
    (event) => event.type === 'agent_permission',
  );
  const childQuestion = managedAgents.pendingQuestions[0];
  const managedAgentTraces = useMemo(
    () => projectManagedAgentTraces(messages, managedAgents.records, managedAgents.activities),
    [managedAgents.activities, managedAgents.records, messages],
  );
  const returnToMain = useCallback(() => {
    setDetailTaskPickerOpen(false);
    setDetailTaskPickerAgentId(undefined);
    managedAgents.setSurface('main');
    managedAgents.selectAgent(undefined);
  }, [managedAgents.selectAgent, managedAgents.setSurface]);

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
        pendingPermission ?? childPermission ?? childQuestion,
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
          interrupt();
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

    if (key.escape && detailTaskPickerOpen) {
      setDetailTaskPickerOpen(false);
      setDetailTaskPickerAgentId(undefined);
      return;
    }
    if (key.escape && managedAgents.surface === 'detail') {
      returnToMain();
      return;
    }
    if (key.escape && managedAgents.surface === 'tasks') {
      managedAgents.setSurface('main');
      return;
    }

    // Escape aborts an in-flight stream when no prompt owns the keyboard.
    if (key.escape) {
      if (isThinking || isResolvingCommand) {
        uiLog.event('input:Escape', { action: 'cancel-stream' });
        interrupt();
        return;
      }
      uiLog.event('input:Escape', { action: 'noop-idle' });
    }
    // Ctrl+C — cancel an in-flight stream; otherwise preserve normal terminal exit.
    if (key.ctrl && input === 'c') {
      if (isThinking || isResolvingCommand) {
        uiLog.event('input:Ctrl+C', { action: 'cancel-stream' });
        interrupt();
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

  // Active tools open automatically; completed file mutations use their own default policy.
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
          defaultExpanded: shouldDefaultExpandToolId(messages, toolId),
          expansionOverrides: current,
          screenReader,
        });
        next.set(toolId, !isExpanded);
        return next;
      });
    },
    [expandedToolId, messages, screenReader, transcriptMode],
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
    async (value: string) => {
      setFollowRequestKey((key) => key + 1);
      const selectedChild = managedAgents.selectedAgentId
        ? managedAgents.records.get(managedAgents.selectedAgentId)
        : undefined;
      if (managedAgents.surface === 'detail' && !value.startsWith('/') && selectedChild) {
        await managedAgents.send(value);
        return;
      }
      if (managedAgents.surface === 'detail' && !value.startsWith('/') && !selectedChild) {
        managedAgents.setSurface('main');
        managedAgents.selectAgent(undefined);
      }
      if (managedAgents.surface === 'detail' && value.startsWith('/')) {
        addLocalMessage('Session commands apply to the main conversation while viewing a child.');
      }
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
      const commandName = parsedSlash?.name ?? '';
      const commandArg = parsedSlash?.rawArguments ?? '';
      if (parsedSlash) {
        const commandContext: BuiltinCommandContext = {
          workspace: config.workspace,
          sessionId,
          model: liveConfig.model,
          provider: liveConfig.provider,
          currentTurn,
          messages,
          lastError: error,
          effortUnavailableError: getEffortUnavailableError(liveConfig),
          runtimeConfig: liveConfig,
          mode,
          usage,
          turnDurationMs,
          contextHistory,
          compactBoundaries,
          commandCount: commands.length,
          skillCount: skills.length,
          resolveAmbientContext: () => ({
            subagentCount: discoverAgents(config.workspace).length,
            hasMemoryIndex: Boolean(
              liveConfig.memoryContext?.indexLoaded ?? getMemoryIndex(config.workspace).indexFile,
            ),
            hasClaudeMdLoader: discoverClaudeMd(config.workspace).length > 0,
          }),
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
          void send(effect.prompt, effect.context);
          return;
        }
        if (effect?.type === 'local-message') {
          if (effect.display) addLocalMessage(effect.content, effect.display);
          else addLocalMessage(effect.content);
          if (effect.refreshMemory) refreshMemoryContext();
          return;
        }
        if (effect?.type === 'start-new-conversation') {
          clearTasks();
          setShowHelp(false);
          setShowStatus(false);
          setShowSessionPicker(false);
          setShowRewindPicker(false);
          void startNewConversation(effect.previousName).catch((err) => {
            addLocalMessage(`✕ ${err instanceof Error ? err.message : String(err)}`);
          });
          stdout?.write('\x1b[2J\x1b[3J\x1b[H');
          return;
        }
        if (effect?.type === 'resume-conversation') {
          if (!effect.session) {
            setShowSessionPicker(true);
          } else {
            clearTasks();
            void resumeConversation(effect.session).catch((err) => {
              addLocalMessage(`✕ ${err instanceof Error ? err.message : String(err)}`);
            });
          }
          return;
        }
        if (effect?.type === 'compact') {
          void compact(effect.focus);
          return;
        }
        if (effect?.type === 'exit') {
          void endCurrentSession('exit').finally(exitApp);
          return;
        }
        if (effect?.type === 'show-modal') {
          if (effect.modal === 'model') setShowModelPicker(true);
          else if (effect.modal === 'rewind') setShowRewindPicker(true);
          else if (effect.modal === 'theme') {
            setCustomThemes(listCustomThemes(config.workspace));
            setShowThemePicker(true);
          } else setShowEffortPicker(true);
          return;
        }
        if (effect?.type === 'set-theme') {
          const result = applyThemePreference(effect.preference);
          addLocalMessage(result.ok ? themeAppliedMessage(result.theme) : `✕ ${result.error}`);
          return;
        }
        if (effect?.type === 'set-model') {
          const result = setModel(effect.selection);
          addLocalMessage(
            result.ok ? `Switched to ${effect.selection} (saved as default).` : `✕ ${result.error}`,
          );
          return;
        }
        if (effect?.type === 'set-effort') {
          const result = setEffort(effect.level);
          addLocalMessage(
            result.ok
              ? `Set effort level to ${effect.level} (saved as default).`
              : `✕ ${result.error}`,
          );
          return;
        }
        if (effect?.type === 'set-memory-auto-save') {
          setMemoryAutoSave(effect.enabled);
          addLocalMessage(
            effect.enabled
              ? 'Memory auto-capture enabled. New candidates will still require approval.'
              : 'Memory auto-capture disabled. Existing approved memory can still load.',
          );
          return;
        }
        if (effect?.type === 'toggle-panel') {
          if (effect.panel === 'help') setShowHelp((current) => !current);
          else if (effect.panel === 'status') setShowStatus((current) => !current);
          else if (effect.panel === 'permissions') setShowPermissions((current) => !current);
          else setShowSkills((current) => !current);
          return;
        }
        if (effect?.type === 'add-task') {
          addTask({ subject: effect.subject, status: 'pending' });
          return;
        }
        if (effect?.type === 'show-diff') {
          void runGit(['diff'], {
            workspaceRoot: config.workspace,
            env: process.env as Record<string, string>,
          }).then((result) => {
            addLocalMessage(
              result.error ? `✕ ${result.error}` : result.output.trim() || '(no changes)',
            );
          });
          return;
        }
        if (effect?.type === 'reload-assets') {
          setCommands(discoverCommands(config.workspace));
          setSkills(discoverSkills(config.workspace));
          setCustomThemes(listCustomThemes(config.workspace));
          addLocalMessage('Commands and skills have been reloaded.');
          return;
        }
        if (effect?.type === 'managed-agent') {
          const manager = managedAgentManager;
          const reportError = (managedError: unknown) =>
            addLocalMessage(
              `✕ ${managedError instanceof Error ? managedError.message : String(managedError)}`,
            );
          if (effect.operation === 'list') {
            managedAgents.setSurface('tasks');
            void managedAgents.refresh().catch(reportError);
          } else if (effect.operation === 'import') {
            try {
              const previews = previewAgentImport(effect.importPath!);
              if (previews.length === 0) throw new Error('No Markdown agent definitions found.');
              const report = previews
                .map((preview) =>
                  [
                    `${preview.name}: ${preview.description}`,
                    `tools: ${preview.tools.join(', ') || '(none)'}`,
                    `model: ${preview.model ?? 'inherit'}`,
                    ...preview.warnings.map((warning) => `warning: ${warning}`),
                  ].join('\n'),
                )
                .join('\n\n');
              if (!effect.confirmed) {
                addLocalMessage(
                  `${report}\n\nRun /agents import --confirm ${effect.importPath} to install.`,
                );
              } else {
                const installed = installAgentImports(
                  previews,
                  join(config.workspace, '.book', 'agents'),
                );
                addLocalMessage(`${report}\n\nInstalled:\n${installed.join('\n')}`);
                void managedAgents.refresh();
              }
            } catch (importError) {
              reportError(importError);
            }
          } else if (effect.operation === 'send') {
            void manager
              .send(effect.agentId!, effect.message ?? '')
              .then((record) => {
                managedAgents.selectAgent(record.id);
                managedAgents.setSurface('detail');
              })
              .catch(reportError);
          } else if (effect.operation === 'stop') {
            void manager
              .stop(effect.agentId!)
              .then((record) => addLocalMessage(`Stopped ${record.displayName ?? record.name}.`))
              .catch(reportError);
          } else if (effect.operation === 'apply') {
            void manager
              .apply(effect.agentId!, effect.evidenceId)
              .then((result) =>
                addLocalMessage(
                  result.status === 'applied'
                    ? `Applied validated candidate${result.commit ? ` (${result.commit})` : ''}.`
                    : `Application ${result.status}${result.error ? `: ${result.error}` : '.'}`,
                ),
              )
              .catch(reportError);
          } else {
            void manager
              .get(effect.agentId!)
              .then((record) => {
                if (!record) throw new Error(`Agent ${effect.agentId} was not found.`);
                managedAgents.selectAgent(record.id);
                managedAgents.setSurface('detail');
              })
              .catch(reportError);
          }
          return;
        }
      }
      if (value.startsWith('/')) {
        // Custom slash command: /name [args]
        const cmd = commands.find((c) => c.name === commandName);
        if (cmd) {
          const controller = new AbortController();
          commandResolutionRef.current?.abort();
          commandResolutionRef.current = controller;
          setIsResolvingCommand(true);
          let resolved: string;
          try {
            ({ resolved } = await resolveCommandBody(
              cmd,
              commandArg,
              {
                sessionId,
                workspace: config.workspace,
                model: liveConfig.model,
              },
              controller.signal,
            ));
          } catch (resolveError) {
            if (!controller.signal.aborted) {
              addLocalMessage(
                `✕ ${resolveError instanceof Error ? resolveError.message : String(resolveError)}`,
              );
            }
            return;
          } finally {
            if (commandResolutionRef.current === controller) {
              commandResolutionRef.current = null;
              setIsResolvingCommand(false);
            }
          }
          // Escape/Ctrl+C may abort after resolution succeeds; never dispatch stale input.
          if (controller.signal.aborted) return;
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
          void send(resolved, ctx);
        } else {
          // Unknown command — send as-is (the model might handle it).
          void send(value);
        }
      } else {
        void send(value);
      }
    },
    [
      send,
      commandResolutionRef,
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
      managedAgentManager,
      managedAgents,
    ],
  );

  const canSubmitWhileParentBusy = useCallback((value: string) => {
    return parseSlashInput(value)?.name === 'tasks';
  }, []);

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
          interrupt();
          return true;
        }
        if (pendingPermission || pendingPlanApproval) {
          uiLog.event('input:Ctrl+C', { action: 'noop-approval-active' });
          return true;
        }
        if (isThinking || isResolvingCommand) {
          uiLog.event('input:Ctrl+C', { action: 'cancel-stream' });
          interrupt();
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
      interrupt,
      endCurrentSession,
      exitApp,
      isThinking,
      isResolvingCommand,
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
            isActive={!pickerOwnsTranscript && managedAgents.surface !== 'tasks'}
            followRequestKey={followRequestKey}
            onToggleTool={toggleToolExpansion}
          >
            <Box flexDirection="column" width={termWidth}>
              {error && (
                <Box paddingX={1} marginBottom={1}>
                  <Text color={theme.error}>✕ {error}</Text>
                </Box>
              )}
              {managedAgents.surface === 'detail' &&
              managedAgents.selectedAgentId &&
              managedAgents.records.get(managedAgents.selectedAgentId) ? (
                <SubagentDetail
                  record={managedAgents.records.get(managedAgents.selectedAgentId)!}
                  liveText={managedAgents.liveText.get(managedAgents.selectedAgentId)}
                  width={termWidth}
                  height={termHeight}
                  reducedMotion={motionDisabled}
                  screenReader={screenReader}
                />
              ) : (
                <ChatPanel
                  messages={messages}
                  managedAgentTraces={managedAgentTraces}
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
              )}
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
                      label="/tasks"
                      description="Manage background subagents"
                      theme={theme}
                    />
                    <HelpRow
                      label="/agents"
                      description="Show subagent configuration guidance"
                      theme={theme}
                    />
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
                      description={displaySessionName(sessionName)}
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
                    <HelpRow
                      label="Ctrl+T"
                      description="Toggle the main agent checklist (not background tasks)"
                      theme={theme}
                    />
                    <HelpRow
                      label="/tasks"
                      description="Focus background tasks; ↑↓ select, Enter open, x stop"
                      theme={theme}
                    />
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
                      label="Shift+drag"
                      description="Select terminal text for copying"
                      theme={theme}
                    />
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
            ) : childPermission?.type === 'agent_permission' ? (
              <Box flexDirection="column">
                <Text color={theme.warning}>
                  ? {childPermission.request.displayName} (
                  {managedAgents.records.get(childPermission.agentId)?.profile ?? 'agent'}) requests{' '}
                  {childPermission.request.toolName}
                </Text>
                <PermissionButtons
                  key={childPermission.request.id}
                  toolCall={childPermission.request.toolCall}
                  onResolve={(result) =>
                    void managedAgents.resolvePermission(childPermission.request.id, result)
                  }
                  screenReader={screenReader}
                />
              </Box>
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
            ) : childQuestion ? (
              <AskUserQuestionWizard
                key={childQuestion.request.id}
                request={childQuestion.request}
                queueLength={managedAgents.pendingQuestions.length}
                terminalWidth={termWidth}
                onResolve={(response) =>
                  void managedAgents.resolveQuestion(childQuestion.agentId, response)
                }
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

          {compactUi && (compactUi.phase === 'error' || compactUi.phase === 'skipped') ? (
            <CompactDiffCard
              state={compactUi}
              terminalWidth={termWidth}
              reducedMotion={motionDisabled}
              screenReader={screenReader}
            />
          ) : null}

          {isResolvingCommand ? <Text dimColor>Resolving command shell expansions...</Text> : null}

          <WorkingIndicator
            isThinking={isThinking}
            isCompacting={isCompacting}
            compactTrigger={compactUi?.trigger}
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
              disabled={
                managedAgents.surface !== 'detail' &&
                (isThinking || isCompacting || isRewinding || isResolvingCommand)
              }
              mode={mode}
              onCycleMode={cycleMode}
              onInterrupt={interrupt}
              canSubmitWhileDisabled={canSubmitWhileParentBusy}
              onFocusBackgroundTask={() => {
                if (managedAgents.surface === 'detail') {
                  if (!managedAgentUiEnabled) return false;
                  setDetailTaskPickerAgentId(undefined);
                  setDetailTaskPickerOpen(true);
                  return true;
                }
                const firstAgent = managedAgents.summaries[0];
                if (!managedAgentUiEnabled || !firstAgent) return false;
                managedAgents.selectAgent(firstAgent.agentId);
                managedAgents.setSurface('tasks');
                return true;
              }}
              inputSuppressed={
                ownsModalInput(
                  pendingPermission ?? childPermission ?? childQuestion,
                  pendingPlanApproval,
                  showModelPicker,
                  showSessionPicker,
                  pendingUserQuestion,
                  showEffortPicker,
                  showThemePicker,
                  showRewindPicker,
                ) ||
                transcriptMode === 'detailed' ||
                managedAgents.surface === 'tasks' ||
                detailTaskPickerOpen
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

          {managedAgentUiEnabled &&
          (managedAgents.surface === 'main' ||
            managedAgents.surface === 'tasks' ||
            (managedAgents.surface === 'detail' && !detailTaskPickerOpen)) ? (
            <SubagentPanel
              agents={managedAgents.summaries}
              selectedAgentId={managedAgents.selectedAgentId}
              isActive={managedAgents.surface === 'tasks'}
              onSelect={managedAgents.selectAgent}
              onOpen={(agentId) => {
                managedAgents.selectAgent(agentId);
                managedAgents.setSurface('detail');
              }}
              onClose={() => managedAgents.setSurface('main')}
              onCancel={() => managedAgents.setSurface('main')}
              onStopOrDismiss={(agentId) => void managedAgents.stopOrDismiss(agentId)}
              width={termWidth}
              reducedMotion={motionDisabled}
              screenReader={screenReader}
            />
          ) : null}

          {managedAgentUiEnabled && managedAgents.surface === 'detail' && detailTaskPickerOpen ? (
            <SubagentPanel
              agents={managedAgents.summaries}
              selectedAgentId={detailTaskPickerAgentId}
              isActive
              onSelect={setDetailTaskPickerAgentId}
              onOpen={(agentId) => {
                setDetailTaskPickerOpen(false);
                setDetailTaskPickerAgentId(undefined);
                managedAgents.selectAgent(agentId);
              }}
              onClose={returnToMain}
              onCancel={() => {
                setDetailTaskPickerOpen(false);
                setDetailTaskPickerAgentId(undefined);
              }}
              onStopOrDismiss={(agentId) => void managedAgents.stopOrDismiss(agentId)}
              width={termWidth}
              reducedMotion={motionDisabled}
              screenReader={screenReader}
            />
          ) : null}

          {/* Status line — stable footer */}
          <Box flexShrink={0} width={termWidth}>
            <StatusLine
              model={liveConfig.modelSelection ?? liveConfig.model}
              tokenCount={tokenCount}
              maxTokens={liveConfig.modelInfo?.contextWindow ?? liveConfig.maxTokens}
              mode={mode}
              taskCount={tasks.length}
              activeTaskCount={tasks.filter((t) => t.status === 'in_progress').length}
              agentCount={managedAgentUiEnabled ? managedAgents.summaries.length : 0}
              activeAgentCount={
                managedAgentUiEnabled
                  ? managedAgents.summaries.filter(
                      (agent) =>
                        !['completed', 'failed', 'stopped', 'interrupted'].includes(agent.status),
                    ).length
                  : 0
              }
              needsInputAgentCount={
                managedAgentUiEnabled
                  ? managedAgents.summaries.filter(
                      (agent) =>
                        agent.status === 'waiting_input' || agent.status === 'waiting_permission',
                    ).length
                  : 0
              }
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
