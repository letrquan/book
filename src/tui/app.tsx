import { Box, Text, useInput, useStdout, useApp } from 'ink';
import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { panelGrid } from './layout.js';
import { ChatPanel } from './components/ChatPanel.js';
import { InputBar } from './components/InputBar.js';
import { QueuedInputPreview } from './components/QueuedInputPreview.js';
import { StatusLine } from './components/StatusLine.js';
import { WorkingIndicator } from './components/WorkingIndicator.js';
import { StartupFire } from './components/StartupFire.js';
import { CompactDiffCard } from './components/CompactDiffCard.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { TaskList } from './components/TaskList.js';
import { AgentTodoList, shouldShowAgentPlan } from './components/AgentTodoList.js';
import { ModelPicker, type ProviderRemovalResult } from './components/ModelPicker.js';
import { EffortPicker } from './components/EffortPicker.js';
import { PermissionModePicker } from './components/PermissionModePicker.js';
import { ThemePicker } from './components/ThemePicker.js';
import { ConfigMenu, type ConfigSection } from './components/ConfigMenu.js';
import { SkillManager } from './components/SkillManager.js';
import { AgentProfilePicker } from './components/AgentProfilePicker.js';
import { LoginPicker } from './components/LoginPicker.js';
import { listAuthProfiles, type AuthProfile } from '../auth/profiles.js';
import { listCredentials } from '../auth/store.js';
import { SessionPicker } from './components/SessionPicker.js';
import { RewindPicker } from './components/RewindPicker.js';
import { TranscriptView } from './components/TranscriptView.js';
import { PermissionButtons } from './components/PermissionButtons.js';
import { PlanApprovalActions, PlanApprovalDetails } from './components/PlanApprovalButtons.js';
import { AskUserQuestionWizard } from './components/AskUserQuestionWizard.js';
import { McpElicitationForm } from './components/McpElicitationForm.js';
import { McpServerApprovalPrompt } from './components/McpServerApprovalPrompt.js';
import { useAgent } from './hooks/useAgent.js';
import { useTasks } from './hooks/useTasks.js';
import { useManagedAgents } from './hooks/useManagedAgents.js';
import { useBackgroundShells } from './hooks/useBackgroundShells.js';
import { useGitStatus } from './hooks/useGitStatus.js';
import { useAgentCompletionDelivery } from './hooks/useAgentCompletionDelivery.js';
import { SubagentPanel } from './components/SubagentPanel.js';
import { SubagentDetail } from './components/SubagentDetail.js';
import { BackgroundShellDetail } from './components/BackgroundShellDetail.js';
import { projectManagedAgentTraces } from './managed-agent-transcript.js';
import { inlineCode } from './markdown-inline.js';
import {
  ThemeContext,
  listCustomThemes,
  resolveTheme,
  DARK_THEME,
  type ThemeTokens,
  type ResolvedTheme,
} from './theme.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { McpHostSnapshot, McpSessionHost } from '../mcp-host.js';
import { resolvePermissionMode } from '../permission-mode.js';
import type { ImageAttachment } from '../types/messages.js';
import type { CommandContext } from '../types/commands.js';
import type { RewindSnapshotStoreInterface, SessionStoreInterface } from '../types/sessions.js';
import type { SessionBootstrap } from '../session/resolve.js';
import { displaySessionName } from '../session/name.js';
import { DensityContext, resolveTuiDensity } from './density.js';
import { discoverCommands, resolveCommandBody } from '../commands/loader.js';
import { commandEnforcementContext, parseSlashInput } from '../commands/resolve.js';
import {
  createBuiltinCommandRegistry,
  type BuiltinCommandContext,
  type BuiltinCommandEffect,
} from '../commands/builtins.js';
import { discoverSkills, type Skill } from '../skills.js';
import { runGit } from '../tools/git.js';
import { getMemoryIndex } from '../memory-display.js';
import { discoverClaudeMd } from '../claude-md.js';
import { discoverAgents } from '../subagent-discovery.js';
import { withBuiltInAgents } from '../agents/profiles.js';
import { ShellJobManager } from '../jobs/shell-manager.js';
import { persistSettingLocal } from './persist.js';
import { buildModelOptions } from './model-options.js';
import { createUiDebugLogger } from '../debug-log.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { getOrCreateAgentManager, type AgentManager } from '../agents/manager.js';
import { installAgentImports, previewAgentImport } from '../agents/importer.js';
import { runHostReview } from '../review/host.js';
import { fixRunnerFor, reviewRunnerFor } from '../review/runner.js';
import type { ReviewScope } from '../review/types.js';
import { join } from 'path';
import { selectExpandedToolId, selectLatestToolId } from './tool-traces.js';
import {
  getTranscriptShortcutAction,
  isShortcutsToggleKey,
  type TranscriptMode,
} from './tool-presentation.js';
import { permissionResultOf } from '../permissions.js';
import { PermissionsPanel } from './components/PermissionsPanel.js';
import { useDebugMount, useDebugValueChange } from './debug.js';
import { getAvailableEffortLevels, getEffortUnavailableError } from '../commands/effort.js';
import type { InteractiveAssets } from './interactive-assets.js';
import { resolveContextWindow } from '../models.js';
import { wordWrap } from './components/word-wrap.js';
import {
  createQueuedInput,
  enqueueQueuedInput,
  recallNewestQueuedInput,
  restoreQueuedInputAttachments,
  restoreQueuedInputText,
  shouldRequeueQueuedSend,
  type QueuedInput,
} from './queued-inputs.js';
import { readClipboardImage } from '../input/clipboard-image.js';
import { stripSgrMouseSequences } from './mouse.js';

const uiLog = createUiDebugLogger('tui:app');
const MAIN_TRANSCRIPT_SCOPE = 'main';
const EMPTY_TOOL_EXPANSION_OVERRIDES = new Map<string, boolean>();
const EMPTY_AUTH_PROFILES: AuthProfile[] = [];
const EMPTY_PROFILE_IDS: readonly string[] = Object.freeze([]);
const EMPTY_SHOW_ALL_TOOL_OUTPUT_IDS = new Set<string>();

export function ownsModalInput(
  pendingPermission: unknown,
  pendingPlanApproval: unknown,
  showModelPicker: boolean,
  showSessionPicker = false,
  pendingUserQuestion?: unknown,
  showEffortPicker = false,
  showThemePicker = false,
  showRewindPicker = false,
  showConfigPicker = false,
  showAgentProfilePicker = false,
  showPermissionModePicker = false,
  showSkills = false,
  pendingMcpApproval: unknown = undefined,
  pendingElicitation: unknown = undefined,
  showLoginPicker = false,
): boolean {
  return Boolean(
    pendingPermission ||
    pendingPlanApproval ||
    pendingUserQuestion ||
    pendingElicitation ||
    showModelPicker ||
    showSessionPicker ||
    showEffortPicker ||
    showPermissionModePicker ||
    showThemePicker ||
    showRewindPicker ||
    showConfigPicker ||
    showAgentProfilePicker ||
    showSkills ||
    showLoginPicker ||
    pendingMcpApproval,
  );
}

export function shouldPlayStartupFire(config: AgentConfig, session: SessionBootstrap): boolean {
  return Boolean(
    config.settings.ui.startupAnimation &&
    !config.accessibility.screenReader &&
    !config.accessibility.reducedMotion &&
    session.source === 'startup' &&
    session.created &&
    (session.transcript ?? session.history).length === 0,
  );
}

function containsDraftInput(input: string): boolean {
  return Array.from(input).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint !== 0x7f;
  });
}

type ApplyThemeResult = { ok: true; theme: ResolvedTheme } | { ok: false; error: string };

/**
 * The read-only reference sheets, at most one of which is open at a time.
 *
 * They are all the same kind of surface — a pinned block of text the user opened
 * deliberately and expects Esc to close — so they share one slot rather than a
 * boolean each.
 */
type ReferencePanel = 'help' | 'status' | 'permissions' | 'shortcuts';

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

/**
 * Sequencing lives in `review/host.ts` so print mode runs the identical steps.
 * The TUI is the host that can apply patches, so it is the one that supplies a
 * fix runner, and it renders each segment as it is produced rather than waiting
 * for the (minutes-long) fix pass to finish.
 *
 * `parentSessionId` is what puts the reviewer, lens, verifier and patcher agents
 * in this session's agent panel and status line while they work; the runner
 * suppresses their completion notifications separately, so live progress costs
 * no extra model turn.
 */
async function runReviewCommand(
  scope: ReviewScope,
  manager: AgentManager,
  workspace: string,
  sessionId: string,
  report: (message: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const attribution = { parentSessionId: sessionId };
  await runHostReview({
    scope,
    workspace,
    runner: reviewRunnerFor(manager, attribution),
    fixRunner: fixRunnerFor(manager, attribution),
    onSegment: report,
    signal,
  });
}

/** Status text for a review in flight. Names the passes so the wait has a shape. */
function reviewStatusLabel(scope: ReviewScope): string {
  if (scope.fix) return 'Reviewing, then applying verified fixes';
  if (scope.deep) return 'Deep review: four lenses, then verification';
  return 'Review in progress';
}

const EMPTY_MCP_SNAPSHOT: McpHostSnapshot = { servers: [], pendingApprovals: [], events: [] };

interface AppProps {
  config: AgentConfig;
  permissionMode?: PermissionMode;
  interactiveAssets?: InteractiveAssets;
  /** Session MCP owner; servers connect in the background and tools join per send. */
  mcp?: McpSessionHost;
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
 *   Mouse wheel — scroll transcript
 *   Drag — select and copy visible text
 *   Shift+drag — terminal-native selection fallback
 *   Alt+M    — cycle permission mode
 *   Alt+P    — open model picker
 *   Alt+V    — attach clipboard image
 *   Shift+Tab — cycle permission mode
 *   Ctrl+/   — toggle keyboard shortcuts reference
 */
export function App({
  config,
  permissionMode,
  session,
  redrawViewport,
  interactiveAssets,
  mcp,
}: AppProps) {
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
    pendingElicitation,
    pendingElicitationCount,
    resolveElicitation,
    elicitationHandler,
    agentTodos,
    liveConfig,
    runtime,
    removableProviderIds,
    removableProviderModelCounts,
    sessionId,
    sessionName,
    send,
    sendAgentCompletions,
    sendBackgroundShellCompletion,
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
    applyAuthLogin,
    previewAuthLogin,
    upsertProviderAndSelect,
    removeProvider,
    setEffort,
    setAgentProfileModel,
    setCompactModel,
    setSkillActivation,
    setSkillExecution,
    setSkillsEnabled,
    setMemoryAutoSave,
    toggleMemoryAutoSave,
    toggleShowThinking,
    toggleStartupAnimation,
    refreshMemoryContext,
    persistPermissionRule,
    removePermissionRule,
    setDefaultPermissionMode,
    turnDurationMs,
    retryPhase,
    retryAttempt,
    retryMax,
    retryCountdownMs,
  } = useAgent(config, {
    ...session,
    permissionMode,
    additionalTools: mcp ? () => mcp.getToolDefinitions() : undefined,
  });

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
  const shellManager = useMemo(() => {
    const resolved = runtime?.shellManager ?? new ShellJobManager({ nextId: 1, shells: new Map() });
    resolved.configureWorkspace(liveConfig.workspace);
    return resolved;
  }, [liveConfig.workspace, runtime]);
  const backgroundShells = useBackgroundShells(shellManager, sessionId);
  // Branch and dirty state are what people glance at the footer for; the hook
  // existed with no consumer before the status line was reworked.
  const gitStatus = useGitStatus(config.workspace);

  const [showTasks, setShowTasks] = useState(false);
  const [startupFireActive, setStartupFireActive] = useState(() =>
    shouldPlayStartupFire(config, session),
  );
  // The four reference sheets share one slot. They were four independent
  // booleans, so `/help` then `/status` pinned 43 rows of chrome above the
  // composer and pushed the conversation off a 40-row terminal entirely. One
  // slot makes that impossible rather than merely discouraged, and gives Esc a
  // single thing to close.
  const [referencePanel, setReferencePanel] = useState<ReferencePanel | null>(null);
  const showHelp = referencePanel === 'help';
  const showShortcuts = referencePanel === 'shortcuts';
  const showStatus = referencePanel === 'status';
  const [showAllDetailedOutput, setShowAllDetailedOutput] = useState(false);
  const [showAllToolOutputIdsByTranscript, setShowAllToolOutputIdsByTranscript] = useState<
    Map<string, Set<string>>
  >(() => new Map());
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>('compact');
  const [toolExpansionOverridesByTranscript, setToolExpansionOverridesByTranscript] = useState<
    Map<string, Map<string, boolean>>
  >(() => new Map());
  const [focusedToolIdsByTranscript, setFocusedToolIdsByTranscript] = useState<Map<string, string>>(
    () => new Map(),
  );
  const showPermissions = referencePanel === 'permissions';
  const [showSkills, setShowSkills] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showEffortPicker, setShowEffortPicker] = useState(false);
  const [showPermissionModePicker, setShowPermissionModePicker] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showConfigPicker, setShowConfigPicker] = useState(false);
  const [showAgentProfilePicker, setShowAgentProfilePicker] = useState(false);
  /**
   * The `/config` row a sub-picker was opened from, or null when it was opened
   * directly by its own command.
   *
   * `/config` is the only surface that exists to be *browsed* — it is the one
   * place the two settings with no command of their own (compact model,
   * subagent profiles) can be found — and it used to close the moment a row was
   * chosen, so browsing it was impossible and changing two settings meant
   * opening it twice. Two rows already came back, but only because
   * `selectingCompactModel` and `agentProfileForModel` happened to imply where
   * the picker had been opened from. Recording the origin explicitly is what
   * lets the other five come back too, and it is a ref rather than state
   * because the close handlers read it back inside their own keypress batch.
   */
  const configReturnRow = useRef<number | null>(null);
  const [configInitialRow, setConfigInitialRow] = useState(0);

  /** Reopen `/config` on the row a picker was launched from, if it was. */
  const returnToConfig = useCallback((): void => {
    const row = configReturnRow.current;
    configReturnRow.current = null;
    if (row === null) return;
    setConfigInitialRow(row);
    setShowConfigPicker(true);
  }, []);

  /**
   * Forget the origin, for the paths that must end at the composer: a picker
   * opened by its own command, and `/skills`'s "use this skill", which exists
   * to put text in the input bar.
   */
  const forgetConfigOrigin = useCallback(() => {
    configReturnRow.current = null;
  }, []);
  const [showLoginPicker, setShowLoginPicker] = useState(false);
  const [loginProfileHint, setLoginProfileHint] = useState<string | undefined>(undefined);
  // Bumped when a login stores a credential, so the list below re-reads the
  // store exactly then rather than on every render of the app.
  const [authStoreRevision, setAuthStoreRevision] = useState(0);
  const [agentProfileForModel, setAgentProfileForModel] = useState<string>();
  const [selectingCompactModel, setSelectingCompactModel] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [showRewindPicker, setShowRewindPicker] = useState(false);
  const [isResolvingCommand, setIsResolvingCommand] = useState(false);
  /** Set for the lifetime of a `/review`; drives its status line and Esc. */
  const [reviewStatus, setReviewStatus] = useState<string | undefined>(undefined);
  const reviewAbortRef = useRef<AbortController | null>(null);
  /** The conversation currently on screen, for routing a review's late output. */
  const reviewSessionRef = useRef(sessionId);
  const [draftRestore, setDraftRestore] = useState<{
    key: number;
    value: string;
    attachments?: ImageAttachment[];
  }>();
  const [queuedInputs, setQueuedInputs] = useState<QueuedInput[]>([]);
  const [editingQueuedInput, setEditingQueuedInput] = useState<QueuedInput | undefined>(undefined);
  const [queueNotice, setQueueNotice] = useState<string | undefined>(undefined);
  const [copyNotice, setCopyNotice] = useState<string | undefined>(undefined);
  const copyNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopiedNotice = useCallback((message: string) => {
    setCopyNotice(message);
    if (copyNoticeTimerRef.current) clearTimeout(copyNoticeTimerRef.current);
    copyNoticeTimerRef.current = setTimeout(() => {
      copyNoticeTimerRef.current = null;
      setCopyNotice(undefined);
    }, 2_000);
  }, []);
  const [sendInFlight, setSendInFlight] = useState(false);
  const [, setQueueDrainTick] = useState(0);
  const [shellCompletionRetryTick, setShellCompletionRetryTick] = useState(0);
  const [followRequestKey, setFollowRequestKey] = useState(0);
  const [detailTaskPickerOpen, setDetailTaskPickerOpen] = useState(false);
  const [detailTaskPickerAgentId, setDetailTaskPickerAgentId] = useState<string | undefined>(
    undefined,
  );
  const [selectedShellId, setSelectedShellId] = useState<string>();
  const commandResolutionRef = useRef<AbortController | null>(null);
  const queuedInputsRef = useRef<QueuedInput[]>([]);
  const editingQueuedInputRef = useRef<QueuedInput | undefined>(undefined);
  const dispatchingQueuedIdRef = useRef<string | undefined>(undefined);
  const draftRef = useRef('');
  const startupDraftRef = useRef('');
  const draftAttachmentsRef = useRef<ImageAttachment[]>([]);
  const queueDrainRunningRef = useRef(false);
  const shellCompletionDeliveryRef = useRef(false);
  const shellCompletionRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueDrainPausedRef = useRef(false);
  const queueInterruptEpochRef = useRef(0);
  const queueSessionRef = useRef(sessionId);
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
  const replaceQueuedInputs = useCallback((next: QueuedInput[]) => {
    queuedInputsRef.current = next;
    setQueuedInputs(next);
  }, []);
  const replaceEditingQueuedInput = useCallback((next?: QueuedInput) => {
    editingQueuedInputRef.current = next;
    setEditingQueuedInput(next);
  }, []);
  const dispatchAgentSend = useCallback(
    async (value: string, commandContext?: CommandContext, attachments?: ImageAttachment[]) => {
      setSendInFlight(true);
      try {
        if (attachments && attachments.length > 0) {
          return await send(value, commandContext, attachments);
        }
        return commandContext === undefined ? await send(value) : await send(value, commandContext);
      } finally {
        setSendInFlight(false);
      }
    },
    [send],
  );
  const enqueueFollowUp = useCallback(
    (value: string, attachments: ImageAttachment[] = []): boolean => {
      const edited = editingQueuedInputRef.current;
      const input = createQueuedInput(value, sessionId, attachments, edited);
      const result = enqueueQueuedInput(queuedInputsRef.current, input);
      if (!result.accepted) {
        setQueueNotice('Queue is full. Edit or clear a queued message before adding another.');
        return false;
      }
      replaceQueuedInputs(result.queue);
      replaceEditingQueuedInput(undefined);
      queueDrainPausedRef.current = false;
      setQueueNotice(undefined);
      return true;
    },
    [replaceEditingQueuedInput, replaceQueuedInputs, sessionId],
  );
  const recallQueuedInput = useCallback(():
    { value: string; attachments?: ImageAttachment[] } | undefined => {
    const result = recallNewestQueuedInput(queuedInputsRef.current, dispatchingQueuedIdRef.current);
    if (!result.recalled) return undefined;
    replaceQueuedInputs(result.queue);
    replaceEditingQueuedInput(result.recalled);
    queueDrainPausedRef.current = true;
    setQueueNotice('Editing queued input. Enter resubmits; Esc removes it.');
    return { value: result.recalled.value, attachments: result.recalled.attachments };
  }, [replaceEditingQueuedInput, replaceQueuedInputs]);
  const cancelQueuedEdit = useCallback(() => {
    replaceEditingQueuedInput(undefined);
    queueDrainPausedRef.current = false;
    setQueueNotice('Queued input removed.');
    setDraftRestore((current) => ({
      key: (current?.key ?? 0) + 1,
      value: '',
    }));
  }, [replaceEditingQueuedInput]);
  const pasteClipboardImage = useCallback(async (): Promise<ImageAttachment> => {
    if (liveConfig.modelInfo?.vision === false) {
      throw new Error(`${liveConfig.model} does not support image input.`);
    }
    const store = session.timelineStore ?? session.store;
    if (!store?.saveImageAttachment) {
      throw new Error('Session attachment storage is unavailable.');
    }
    const image = await readClipboardImage();
    return store.saveImageAttachment(sessionId, {
      bytes: image.bytes,
      mediaType: image.mediaType,
      displayName: `clipboard-${Date.now()}.${image.mediaType.split('/')[1]}`,
    });
  }, [
    liveConfig.model,
    liveConfig.modelInfo?.vision,
    session.store,
    session.timelineStore,
    sessionId,
  ]);
  const interrupt = useCallback(() => {
    queueInterruptEpochRef.current += 1;
    commandResolutionRef.current?.abort();
    commandResolutionRef.current = null;
    const pending = queuedInputsRef.current;
    if (pending.length > 0) {
      const restored = restoreQueuedInputText(pending, draftRef.current);
      replaceQueuedInputs([]);
      setDraftRestore((current) => ({
        key: (current?.key ?? 0) + 1,
        value: restored,
        attachments: restoreQueuedInputAttachments(pending, draftAttachmentsRef.current),
      }));
      setQueueNotice('Queued inputs restored to the composer after interrupt.');
    }
    replaceEditingQueuedInput(undefined);
    queueDrainPausedRef.current = true;
    cancel();
  }, [cancel, replaceEditingQueuedInput, replaceQueuedInputs]);

  useEffect(() => {
    return () => commandResolutionRef.current?.abort();
  }, []);

  /**
   * Start a review and keep a handle on it.
   *
   * A review outlives the keystroke that started it by minutes, so the session
   * has to hold onto something cancellable: without it the only way out of a
   * wrong or wedged review was Ctrl+C, which exits Book and orphans the agents
   * it spawned.
   */
  const startReview = useCallback(
    (scope: ReviewScope) => {
      if (reviewAbortRef.current) {
        addLocalMessage('A review is already running. Cancel it with Esc before starting another.');
        return;
      }
      const controller = new AbortController();
      reviewAbortRef.current = controller;
      setReviewStatus(reviewStatusLabel(scope));
      // A review's output belongs to the conversation that asked for it. Its
      // last segments can still arrive after a `/new`, and appending them to an
      // unrelated transcript is worse than dropping them.
      const startedIn = sessionId;
      const report = (message: string) => {
        if (reviewSessionRef.current !== startedIn) return;
        addLocalMessage(message);
      };
      void runReviewCommand(
        scope,
        managedAgentManager,
        config.workspace,
        sessionId,
        report,
        controller.signal,
      )
        .catch((reviewError) =>
          report(`✕ ${reviewError instanceof Error ? reviewError.message : String(reviewError)}`),
        )
        .finally(() => {
          if (reviewAbortRef.current !== controller) return;
          reviewAbortRef.current = null;
          setReviewStatus(undefined);
          // An ordinary agent leaves the panel when its completion is
          // acknowledged. These have no completion by design, so without this
          // every finished lens and verifier would stay pinned there — and in
          // the status-line count — for the rest of the session.
          void managedAgents.refresh().catch(() => {});
        });
    },
    [addLocalMessage, config.workspace, managedAgentManager, managedAgents.refresh, sessionId],
  );

  /** Returns whether a review was actually cancelled, so callers can fall through. */
  const cancelReview = useCallback((): boolean => {
    const controller = reviewAbortRef.current;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    setReviewStatus('Cancelling review — stopping its agents');
    return true;
  }, []);

  // Abort on unmount so a review cannot keep spawning agents into a dead UI.
  useEffect(() => {
    return () => reviewAbortRef.current?.abort();
  }, []);

  /**
   * End a review when the conversation it belongs to does.
   *
   * A review is scoped to the session that started it: its agents are owned by
   * that `parentSessionId`, so after a `/new` or `/resume` they are invisible,
   * and its report would be appended to a conversation that never asked for it.
   * The run also holds the single-review slot, so leaving it alive would refuse
   * a `/review` typed in the new session.
   */
  useEffect(() => {
    if (reviewSessionRef.current === sessionId) return;
    reviewSessionRef.current = sessionId;
    const controller = reviewAbortRef.current;
    if (!controller) return;
    controller.abort();
    reviewAbortRef.current = null;
    setReviewStatus(undefined);
  }, [sessionId]);

  useEffect(() => {
    setDetailTaskPickerOpen(false);
    setDetailTaskPickerAgentId(undefined);
    setSelectedShellId(undefined);
    managedAgents.setSurface('main');
    managedAgents.selectAgent(undefined);
  }, [managedAgents.selectAgent, managedAgents.setSurface, sessionId]);

  useEffect(() => {
    if (queueSessionRef.current === sessionId) return;
    queueSessionRef.current = sessionId;
    queueInterruptEpochRef.current += 1;
    replaceQueuedInputs([]);
    replaceEditingQueuedInput(undefined);
    dispatchingQueuedIdRef.current = undefined;
    queueDrainRunningRef.current = false;
    queueDrainPausedRef.current = false;
    setQueueNotice(undefined);
    draftRef.current = '';
  }, [replaceEditingQueuedInput, replaceQueuedInputs, sessionId]);

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
      pendingUserQuestion ||
      pendingElicitation,
    ),
    deliver: sendAgentCompletions,
    acknowledge: managedAgents.acknowledgeCompletions,
  });

  const [commands, setCommands] = useState(
    () => interactiveAssets?.commands ?? discoverCommands(config.workspace),
  );
  const builtinCommandRegistry = useMemo(() => createBuiltinCommandRegistry(), []);
  const [skills, setSkills] = useState(
    () =>
      interactiveAssets?.skills ??
      discoverSkills(config.workspace, config.settings.skills.overrides, {
        executionOverrides: config.settings.skills.execution,
        enabled: config.settings.skills.enabled,
      }),
  );
  const [skillCatalogDirty, setSkillCatalogDirty] = useState(false);
  const [skillWatcherError, setSkillWatcherError] = useState<string>();
  useEffect(() => {
    if (!runtime) return;
    return runtime.subscribeSkillChanges(
      config.workspace,
      () => {
        const watcherError = runtime.skillWatcherError;
        setSkillWatcherError(watcherError);
        if (!watcherError) setSkillCatalogDirty(true);
      },
      liveConfig.settings.skills.enabled,
    );
  }, [config.workspace, liveConfig.settings.skills.enabled, runtime]);
  useEffect(() => {
    if (!runtime || !skillCatalogDirty || isThinking) return;
    const refreshed = runtime.consumeSkillChanges(config.workspace, liveConfig.settings.skills);
    setSkills(refreshed.list());
    setSkillWatcherError(undefined);
    setSkillCatalogDirty(false);
  }, [config.workspace, isThinking, liveConfig.settings.skills, runtime, skillCatalogDirty]);
  const [agentProfiles, setAgentProfiles] = useState(() =>
    withBuiltInAgents(discoverAgents(config.workspace)),
  );
  const modelOptions = useMemo(() => buildModelOptions(liveConfig.settings), [liveConfig.settings]);
  const configuredAgentModels = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(liveConfig.settings.agents.profiles).map(([name, profile]) => [
          name,
          profile.model,
        ]),
      ),
    [liveConfig.settings.agents.profiles],
  );
  const activeAgentProfile = agentProfileForModel
    ? agentProfiles.find((profile) => profile.name === agentProfileForModel)
    : undefined;
  const modelPickerSelection = selectingCompactModel
    ? (liveConfig.compactModel ??
      liveConfig.settings.compactModel ??
      liveConfig.modelSelection ??
      liveConfig.model)
    : activeAgentProfile
      ? (configuredAgentModels[activeAgentProfile.name] ??
        activeAgentProfile.model ??
        liveConfig.modelSelection ??
        liveConfig.model)
      : (liveConfig.modelSelection ?? liveConfig.model);
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
  const motionDisabled =
    reducedMotion || Boolean(pendingPlanApproval || pendingUserQuestion || pendingElicitation);
  const screenReader = Boolean(config.accessibility?.screenReader);
  const managedAgentUiEnabled = liveConfig.settings.agents.ui.enabled;
  const childPermission = managedAgents.pendingPermissions.find(
    (event) => event.type === 'agent_permission',
  );
  const childQuestion = managedAgents.pendingQuestions[0];

  const subscribeMcp = useCallback(
    (listener: () => void) => mcp?.subscribe(listener) ?? (() => {}),
    [mcp],
  );
  const readMcpSnapshot = useCallback(() => mcp?.getSnapshot() ?? EMPTY_MCP_SNAPSHOT, [mcp]);
  const mcpSnapshot = useSyncExternalStore(subscribeMcp, readMcpSnapshot);
  // Servers connect in the background; this binds their elicitation prompts to
  // this session's interaction queue once the UI exists to answer them.
  useEffect(() => {
    if (!mcp) return;
    mcp.setElicitationHandler(elicitationHandler);
    return () => mcp.setElicitationHandler(undefined);
  }, [mcp, elicitationHandler]);
  const pendingMcpApproval = mcpSnapshot.pendingApprovals[0];
  // The trust prompt yields to every other modal surface and reappears once idle.
  const showMcpApproval =
    Boolean(pendingMcpApproval) &&
    !ownsModalInput(
      pendingPermission ?? childPermission ?? childQuestion,
      pendingPlanApproval,
      showModelPicker,
      showSessionPicker,
      pendingUserQuestion,
      showEffortPicker,
      showThemePicker,
      showRewindPicker,
      showConfigPicker,
      showAgentProfilePicker,
      showPermissionModePicker,
      showSkills,
      undefined,
      pendingElicitation,
      showLoginPicker,
    );

  // Surface connection outcomes as transcript notices once the turn is idle;
  // addLocalMessage drops messages mid-turn, so consumption waits for idle.
  const lastMcpEventIdRef = useRef(0);
  useEffect(() => {
    const events = mcpSnapshot.events;
    const fresh = events.filter((event) => event.id > lastMcpEventIdRef.current);
    if (fresh.length === 0) return;
    if (isThinking || sendInFlight) return;
    lastMcpEventIdRef.current = fresh[fresh.length - 1].id;
    for (const event of fresh) {
      if (event.type === 'connected') {
        addLocalMessage(
          `MCP: connected to "${event.server}" (${event.toolCount} tool${event.toolCount === 1 ? '' : 's'}).`,
        );
      } else if (event.type === 'failed') {
        addLocalMessage(`MCP: failed to connect "${event.server}": ${event.error}`);
      } else if (event.type === 'disconnected') {
        addLocalMessage(`MCP: "${event.server}" disconnected.`);
      } else {
        addLocalMessage(`MCP: "${event.server}" tool list updated (${event.toolCount} tools).`);
      }
    }
  }, [mcpSnapshot, isThinking, sendInFlight, addLocalMessage]);
  const queueDrainBlocked = Boolean(
    isThinking ||
    sendInFlight ||
    isCompacting ||
    isRewinding ||
    isResolvingCommand ||
    pendingPermission ||
    pendingPlanApproval ||
    pendingUserQuestion ||
    pendingElicitation ||
    childPermission ||
    childQuestion ||
    editingQueuedInput ||
    managedAgents.surface !== 'main',
  );

  const scheduleShellCompletionRetry = useCallback(() => {
    if (shellCompletionRetryTimerRef.current) {
      clearTimeout(shellCompletionRetryTimerRef.current);
    }
    shellCompletionRetryTimerRef.current = setTimeout(() => {
      shellCompletionRetryTimerRef.current = null;
      setShellCompletionRetryTick((current) => current + 1);
    }, 1_000);
  }, []);

  useEffect(
    () => () => {
      if (shellCompletionRetryTimerRef.current) {
        clearTimeout(shellCompletionRetryTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const completion = backgroundShells.pendingAgentCompletions[0];
    if (!completion || queueDrainBlocked || shellCompletionDeliveryRef.current) return;
    shellCompletionDeliveryRef.current = true;
    void sendBackgroundShellCompletion(completion)
      .then((accepted) => {
        if (accepted) {
          if (shellCompletionRetryTimerRef.current) {
            clearTimeout(shellCompletionRetryTimerRef.current);
            shellCompletionRetryTimerRef.current = null;
          }
          backgroundShells.acknowledgeAgentCompletion(completion.id, completion.completionSequence);
        } else {
          scheduleShellCompletionRetry();
        }
      })
      .catch(() => scheduleShellCompletionRetry())
      .finally(() => {
        shellCompletionDeliveryRef.current = false;
      });
  }, [
    backgroundShells.acknowledgeAgentCompletion,
    backgroundShells.pendingAgentCompletions,
    queueDrainBlocked,
    scheduleShellCompletionRetry,
    sendBackgroundShellCompletion,
    shellCompletionRetryTick,
  ]);
  const managedAgentTraces = useMemo(
    () => projectManagedAgentTraces(messages, managedAgents.records, managedAgents.activities),
    [managedAgents.activities, managedAgents.records, messages],
  );
  const returnToMain = useCallback(() => {
    setDetailTaskPickerOpen(false);
    setDetailTaskPickerAgentId(undefined);
    setSelectedShellId(undefined);
    managedAgents.setSurface('main');
    managedAgents.selectAgent(undefined);
  }, [managedAgents.selectAgent, managedAgents.setSurface]);

  const selectBackgroundJob = useCallback(
    (jobId?: string) => {
      if (!jobId) {
        setSelectedShellId(undefined);
        managedAgents.selectAgent(undefined);
        return;
      }
      if (backgroundShells.shells.some((shell) => shell.id === jobId)) {
        setSelectedShellId(jobId);
        managedAgents.selectAgent(undefined);
      } else {
        setSelectedShellId(undefined);
        managedAgents.selectAgent(jobId);
      }
    },
    [backgroundShells.shells, managedAgents.selectAgent],
  );

  // Terminal jobs are removed from the active list as soon as they finish or
  // stop. Leave their detail view even when notifications are disabled.
  useEffect(() => {
    if (selectedShellId && !backgroundShells.shells.some((shell) => shell.id === selectedShellId)) {
      returnToMain();
    }
  }, [backgroundShells.shells, returnToMain, selectedShellId]);

  useEffect(() => {
    const completed = backgroundShells.lastCompletion;
    if (!completed) return;
    const exit = completed.exitCode !== undefined ? ` (exit ${completed.exitCode ?? 'none'})` : '';
    // The title defaults to the whole command, and this row is what a user
    // reads to confirm *which* command finished — so it has to survive the
    // prose renderer that the rest of this sentence is written for. Inline
    // code also matches the `ToolCallBlock` that started the job.
    addLocalMessage(
      `${completed.status === 'exited' ? '✓' : '✕'} Background shell ${inlineCode(completed.title || completed.id)} ${completed.status}${exit}.`,
    );
    backgroundShells.acknowledge(completed.id);
    if (selectedShellId === completed.id) returnToMain();
  }, [
    addLocalMessage,
    backgroundShells.acknowledge,
    backgroundShells.lastCompletion,
    returnToMain,
    selectedShellId,
  ]);

  const readSelectedShellTail = useCallback(
    () => (selectedShellId ? (shellManager.readTail(selectedShellId, 16_000) ?? '') : ''),
    [selectedShellId, shellManager],
  );

  // Tab cycles focus flatly through [main, ...spawned agents], opening each
  // child's transcript directly. Wrapping past the last agent returns to main.
  // Returns false when there is nothing to cycle so InputBar can fall back to
  // its default Tab behavior.
  const cycleAgentFocus = useCallback((): boolean => {
    if (!managedAgentUiEnabled) return false;
    const jobIds = [
      ...managedAgents.summaries.map((agent) => agent.agentId),
      ...backgroundShells.shells.map((shell) => shell.id),
    ];
    if (jobIds.length === 0) return false;
    const rows: Array<string | undefined> = [undefined, ...jobIds];
    const currentId =
      managedAgents.surface === 'detail'
        ? (selectedShellId ?? managedAgents.selectedAgentId)
        : undefined;
    const currentIndex = currentId ? rows.indexOf(currentId) : 0;
    const next = rows[((currentIndex < 0 ? 0 : currentIndex) + 1) % rows.length];
    if (next === undefined) {
      returnToMain();
    } else {
      selectBackgroundJob(next);
      managedAgents.setSurface('detail');
    }
    return true;
  }, [
    backgroundShells.shells,
    managedAgentUiEnabled,
    managedAgents,
    returnToMain,
    selectBackgroundJob,
    selectedShellId,
  ]);

  useEffect(() => {
    if (
      queueDrainBlocked ||
      queueDrainRunningRef.current ||
      queueDrainPausedRef.current ||
      queuedInputs.length === 0
    ) {
      return;
    }

    const item = queuedInputsRef.current[0];
    if (!item) return;
    if (item.sessionId !== sessionId) {
      replaceQueuedInputs(queuedInputsRef.current.slice(1));
      setQueueNotice('Discarded a queued input from a previous session.');
      return;
    }

    queueDrainRunningRef.current = true;
    dispatchingQueuedIdRef.current = item.id;
    const interruptEpoch = queueInterruptEpochRef.current;
    replaceQueuedInputs(queuedInputsRef.current.slice(1));
    setQueueNotice('Sending queued follow-up...');

    void (async () => {
      try {
        const result = await dispatchAgentSend(item.value, undefined, item.attachments);
        if (queueInterruptEpochRef.current !== interruptEpoch && shouldRequeueQueuedSend(result)) {
          if (queueSessionRef.current === item.sessionId) {
            const restored = restoreQueuedInputText([item], draftRef.current);
            setDraftRestore((current) => ({
              key: (current?.key ?? 0) + 1,
              value: restored,
              attachments: restoreQueuedInputAttachments([item], draftAttachmentsRef.current),
            }));
            setQueueNotice('Interrupted queued input restored to the composer.');
          }
          return;
        }
        if (shouldRequeueQueuedSend(result)) {
          replaceQueuedInputs([item, ...queuedInputsRef.current]);
          queueDrainPausedRef.current = true;
          setQueueNotice(
            'Queued send did not start. Press Up to edit it or Enter another message.',
          );
        } else if (result.status === 'failed') {
          queueDrainPausedRef.current = true;
          setQueueNotice('Queued send failed. Automatic queue dispatch is paused.');
        } else {
          setQueueNotice(undefined);
        }
      } catch (sendError) {
        replaceQueuedInputs([item, ...queuedInputsRef.current]);
        queueDrainPausedRef.current = true;
        setQueueNotice(
          `Queued send failed before dispatch: ${
            sendError instanceof Error ? sendError.message : String(sendError)
          }`,
        );
      } finally {
        dispatchingQueuedIdRef.current = undefined;
        queueDrainRunningRef.current = false;
        setQueueDrainTick((tick) => tick + 1);
      }
    })();
  }, [dispatchAgentSend, queueDrainBlocked, queuedInputs.length, replaceQueuedInputs, sessionId]);

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
  useDebugValueChange(uiLog, 'showPermissionModePicker', showPermissionModePicker, (v) =>
    String(v),
  );
  useDebugValueChange(uiLog, 'showThemePicker', showThemePicker, (v) => String(v));
  useDebugValueChange(uiLog, 'showConfigPicker', showConfigPicker, (v) => String(v));
  useDebugValueChange(uiLog, 'showAgentProfilePicker', showAgentProfilePicker, (v) => String(v));

  useInput((input, key) => {
    if (startupFireActive) {
      if (key.ctrl && input === 'c') {
        uiLog.event('input:Ctrl+C', { action: 'exit-startup-fire' });
        void endCurrentSession('exit').finally(exitApp);
        return;
      }
      if (key.escape) {
        uiLog.event('input:Escape', { action: 'skip-startup-fire' });
        setStartupFireActive(false);
        return;
      }
      const draftInput = stripSgrMouseSequences(input);
      if (!key.ctrl && !key.meta && containsDraftInput(draftInput)) {
        uiLog.event('input:printable', { action: 'skip-startup-fire' });
        // React may deliver several stdin chunks before the splash dismissal commits.
        startupDraftRef.current += draftInput;
        const startupDraft = startupDraftRef.current;
        setDraftRestore((current) => ({
          key: (current?.key ?? 0) + 1,
          value: startupDraft,
        }));
        setStartupFireActive(false);
        return;
      }
      return;
    }

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
        showConfigPicker,
        showAgentProfilePicker,
        showPermissionModePicker,
        showSkills,
        showMcpApproval,
        pendingElicitation,
        showLoginPicker,
      )
    ) {
      if (key.escape) {
        uiLog.event('input:Escape', { action: 'noop-modal-active' });
      } else if (key.ctrl && input === 'c') {
        if (pendingUserQuestion || pendingElicitation) {
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

    if (key.escape && editingQueuedInput) {
      uiLog.event('input:Escape', { action: 'cancel-queued-edit' });
      cancelQueuedEdit();
      return;
    }

    // Escape aborts an in-flight stream when no prompt owns the keyboard.
    // A streaming turn outranks a background review: cancelling the thing the
    // user is watching is the established meaning of Esc.
    if (key.escape) {
      if (isThinking || sendInFlight || isResolvingCommand) {
        uiLog.event('input:Escape', { action: 'cancel-stream' });
        interrupt();
        return;
      }
      if (cancelReview()) {
        uiLog.event('input:Escape', { action: 'cancel-review' });
        return;
      }
      // Nothing is in flight, so Esc falls through to the reference sheet the
      // user opened. It ranks last deliberately: a panel is a static block of
      // text, and Esc must never stop meaning "cancel the running turn".
      if (referencePanel) {
        uiLog.event('input:Escape', { action: 'close-panel', panel: referencePanel });
        setReferencePanel(null);
        return;
      }
      uiLog.event('input:Escape', { action: 'noop-idle' });
    }
    // Ctrl+C — cancel in-flight work; otherwise preserve normal terminal exit.
    if (key.ctrl && input === 'c') {
      if (isThinking || sendInFlight || isResolvingCommand) {
        uiLog.event('input:Ctrl+C', { action: 'cancel-stream' });
        interrupt();
        return;
      }
      // A review is in-flight work too, and exiting here would orphan the
      // agents it spawned. A second Ctrl+C still exits, as it does mid-stream.
      if (cancelReview()) {
        uiLog.event('input:Ctrl+C', { action: 'cancel-review' });
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
  const selectedManagedAgentRecord = managedAgents.selectedAgentId
    ? managedAgents.records.get(managedAgents.selectedAgentId)
    : undefined;
  const selectedManagedAgentLiveText = managedAgents.selectedAgentId
    ? managedAgents.liveText.get(managedAgents.selectedAgentId)
    : undefined;
  const activeTranscriptMessages =
    managedAgents.surface === 'detail' && !selectedShellId && selectedManagedAgentRecord
      ? selectedManagedAgentRecord.transcript
      : messages;
  const activeTranscriptScope =
    activeTranscriptMessages === messages
      ? MAIN_TRANSCRIPT_SCOPE
      : `managed:${selectedManagedAgentRecord!.id}`;
  const activeExpandedToolId = useMemo(
    () =>
      activeTranscriptMessages === messages
        ? expandedToolId
        : selectExpandedToolId(activeTranscriptMessages),
    [activeTranscriptMessages, expandedToolId, messages],
  );
  const toolExpansionOverrides =
    toolExpansionOverridesByTranscript.get(activeTranscriptScope) ?? EMPTY_TOOL_EXPANSION_OVERRIDES;
  const focusedToolId = focusedToolIdsByTranscript.get(activeTranscriptScope) ?? null;
  const showAllToolOutputIds =
    showAllToolOutputIdsByTranscript.get(activeTranscriptScope) ?? EMPTY_SHOW_ALL_TOOL_OUTPUT_IDS;
  const updateToolExpansionOverrides = useCallback(
    (update: (current: Map<string, boolean>) => Map<string, boolean>) => {
      setToolExpansionOverridesByTranscript((current) => {
        const currentOverrides = current.get(activeTranscriptScope) ?? new Map<string, boolean>();
        const nextOverrides = update(currentOverrides);
        if (nextOverrides === currentOverrides) return current;
        return new Map(current).set(activeTranscriptScope, nextOverrides);
      });
    },
    [activeTranscriptScope],
  );
  const focusTool = useCallback(
    (toolId: string) => {
      setFocusedToolIdsByTranscript((current) =>
        new Map(current).set(activeTranscriptScope, toolId),
      );
    },
    [activeTranscriptScope],
  );
  const showAllToolOutput = useCallback(
    (toolId: string) => {
      setShowAllToolOutputIdsByTranscript((current) => {
        const nextIds = new Set(current.get(activeTranscriptScope) ?? []).add(toolId);
        return new Map(current).set(activeTranscriptScope, nextIds);
      });
    },
    [activeTranscriptScope],
  );
  const selectedManagedAgentLiveRows = selectedManagedAgentLiveText
    ? wordWrap(selectedManagedAgentLiveText.slice(-1000), Math.max(1, termWidth - 2)).split('\n')
        .length
    : 0;
  const transcriptLayoutRevision = useMemo(
    () =>
      JSON.stringify([
        error ?? '',
        streamingMessageId ?? '',
        transcriptMode,
        activeExpandedToolId ?? '',
        [...toolExpansionOverrides.entries()].sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
        showAllDetailedOutput,
        [...showAllToolOutputIds].sort(),
        liveConfig.settings.ui.showThinking,
        pendingPermission?.toolCall.id ?? '',
        managedAgents.surface,
        managedAgents.selectedAgentId ?? '',
        selectedManagedAgentRecord?.status ?? '',
        selectedManagedAgentRecord?.referencedEvidenceIds.length ?? 0,
        selectedManagedAgentLiveRows,
        showAgentPlan
          ? agentTodos.map((todo) => [todo.status, todo.content, todo.activeForm ?? ''])
          : [],
        showTasks ? tasks.map((task) => [task.id, task.status, task.subject]) : [],
        showHelp,
        showStatus,
        showPermissions,
        showSkills,
        showShortcuts,
        pendingPlanApproval?.plan ?? '',
      ]),
    [
      error,
      streamingMessageId,
      transcriptMode,
      activeExpandedToolId,
      toolExpansionOverrides,
      showAllDetailedOutput,
      showAllToolOutputIds,
      liveConfig.settings.ui.showThinking,
      pendingPermission,
      managedAgents.surface,
      managedAgents.selectedAgentId,
      selectedManagedAgentRecord,
      selectedManagedAgentLiveRows,
      showAgentPlan,
      agentTodos,
      showTasks,
      tasks,
      showHelp,
      showStatus,
      showPermissions,
      showSkills,
      showShortcuts,
      pendingPlanApproval,
    ],
  );

  useEffect(() => {
    setTranscriptMode('compact');
    setShowAllDetailedOutput(false);
    setShowAllToolOutputIdsByTranscript(new Map());
    setToolExpansionOverridesByTranscript(new Map());
    setFocusedToolIdsByTranscript(new Map());
  }, [sessionId]);

  useEffect(
    () => () => {
      if (copyNoticeTimerRef.current) clearTimeout(copyNoticeTimerRef.current);
    },
    [],
  );

  const toggleToolExpansion = useCallback(
    (toolId: string, expanded: boolean) => {
      focusTool(toolId);
      updateToolExpansionOverrides((current) => new Map(current).set(toolId, !expanded));
    },
    [focusTool, updateToolExpansionOverrides],
  );

  const applyThemePreference = useCallback(
    (preference: string): ApplyThemeResult => {
      const resolved = resolveTheme(config.workspace, preference);
      if (!resolved) {
        return {
          ok: false,
          error: `Theme "${preference}" was not found. Choose dark, light, auto, catppuccin, nord, gruvbox, solarized-dark, or a theme from .book/themes.`,
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
    async (value: string, attachments: ImageAttachment[] = []) => {
      if (attachments.length > 0 && liveConfig.modelInfo?.vision === false) {
        addLocalMessage(`${liveConfig.model} does not support image input.`);
        setDraftRestore((current) => ({
          key: (current?.key ?? 0) + 1,
          value,
          attachments,
        }));
        return;
      }
      setFollowRequestKey((key) => key + 1);
      const selectedChild = managedAgents.selectedAgentId
        ? managedAgents.records.get(managedAgents.selectedAgentId)
        : undefined;
      if (
        managedAgents.surface === 'detail' &&
        !value.startsWith('/') &&
        selectedChild &&
        attachments.length === 0
      ) {
        await managedAgents.send(value);
        return;
      }
      if (managedAgents.surface === 'detail' && attachments.length > 0) {
        addLocalMessage('Image attachments are sent to the main conversation.');
        returnToMain();
      }
      if (
        managedAgents.surface === 'detail' &&
        !value.startsWith('/') &&
        (!selectedChild || selectedShellId)
      ) {
        returnToMain();
      }
      if (managedAgents.surface === 'detail' && value.startsWith('/')) {
        addLocalMessage('Session commands apply to the main conversation while viewing a child.');
      }
      // Coarse slash-command dispatch trace (one event per submit).
      const parsedSlash = parseSlashInput(value);
      if (parsedSlash && attachments.length > 0) {
        addLocalMessage('✕ Image attachments cannot be combined with slash commands.');
        return;
      }
      if (parsedSlash?.name === 'queue') {
        const operation = parsedSlash.rawArguments.trim().toLowerCase();
        if (operation === 'clear') {
          replaceQueuedInputs([]);
          replaceEditingQueuedInput(undefined);
          queueDrainPausedRef.current = false;
          setQueueNotice('Queued follow-up inputs cleared.');
        } else {
          const count = queuedInputsRef.current.length;
          setQueueNotice(
            count === 0
              ? 'The follow-up queue is empty.'
              : `${count} follow-up input${count === 1 ? '' : 's'} queued. Up edits the newest.`,
          );
        }
        return;
      }
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
          skillSnapshot: runtime?.inspectSkills(currentTurn),
          mcpSnapshot,
          toolCallStats: runtime?.toolCallStats,
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
          void dispatchAgentSend(effect.prompt, effect.context);
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
          setReferencePanel(null);
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
          // Opened by its own command, so Esc belongs to the composer rather
          // than to a `/config` menu the user may have visited earlier.
          forgetConfigOrigin();
          if (effect.modal === 'config') {
            setConfigInitialRow(0);
            setShowConfigPicker(true);
          } else if (effect.modal === 'login') {
            setLoginProfileHint(effect.profile);
            setShowLoginPicker(true);
          } else if (effect.modal === 'model') {
            setSelectingCompactModel(false);
            setShowModelPicker(true);
          } else if (effect.modal === 'rewind') setShowRewindPicker(true);
          else if (effect.modal === 'skills') setShowSkills(true);
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
        if (effect?.type === 'set-compact-model') {
          const result = setCompactModel(effect.model);
          addLocalMessage(
            result.ok
              ? `Set compact model to ${effect.model} (saved as default).`
              : `✕ ${result.error}`,
          );
          return;
        }
        if (effect?.type === 'set-default-permission-mode') {
          const result = setDefaultPermissionMode(effect.mode);
          addLocalMessage(
            result.ok
              ? `Default permission mode is now ${effect.mode} (saved as default).`
              : `✕ ${result.error}`,
          );
          return;
        }
        if (effect?.type === 'set-show-thinking') {
          const result = toggleShowThinking(effect.enabled);
          addLocalMessage(
            result.ok
              ? `Show thinking is now ${effect.enabled ? 'on' : 'off'} (saved as default).`
              : `✕ ${result.error ?? 'Could not save thinking setting.'}`,
          );
          return;
        }
        if (effect?.type === 'set-startup-animation') {
          const result = toggleStartupAnimation(effect.enabled);
          addLocalMessage(
            result.ok
              ? `Startup fire is now ${effect.enabled ? 'on' : 'off'} (saved as default).`
              : `✕ ${result.error ?? 'Could not save the startup animation setting.'}`,
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
          const panel = effect.panel;
          setReferencePanel((current) => (current === panel ? null : panel));
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
          const refreshedSkills = runtime?.reloadSkills(
            config.workspace,
            liveConfig.settings.skills,
            'command',
          );
          setSkills(
            refreshedSkills?.list() ??
              discoverSkills(config.workspace, liveConfig.settings.skills.overrides, {
                executionOverrides: liveConfig.settings.skills.execution,
                enabled: liveConfig.settings.skills.enabled,
              }),
          );
          setSkillWatcherError(runtime?.skillWatcherError);
          setCustomThemes(listCustomThemes(config.workspace));
          setAgentProfiles(withBuiltInAgents(discoverAgents(config.workspace)));
          addLocalMessage('Commands and skills have been reloaded.');
          return;
        }
        if (effect?.type === 'review') {
          startReview(effect.scope);
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
            backgroundShells.refresh();
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
                setAgentProfiles(withBuiltInAgents(discoverAgents(config.workspace)));
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
                projectCommands: liveConfig.settings.commands.projectCommands,
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
          // Shared with print/headless so both hosts enforce it identically.
          void dispatchAgentSend(resolved, commandEnforcementContext(cmd, resolved));
        } else {
          // Unknown command — send as-is (the model might handle it).
          void dispatchAgentSend(value);
        }
      } else {
        replaceEditingQueuedInput(undefined);
        void dispatchAgentSend(value, undefined, attachments);
      }
    },
    [
      dispatchAgentSend,
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
      mcpSnapshot,
      sessionId,
      stdout,
      isThinking,
      redrawViewport,
      applyThemePreference,
      builtinCommandRegistry,
      managedAgentManager,
      managedAgents,
      replaceEditingQueuedInput,
      replaceQueuedInputs,
    ],
  );

  const canSubmitWhileParentBusy = useCallback((value: string) => {
    const name = parseSlashInput(value)?.name;
    return name === 'tasks' || name === 'jobs' || name === 'queue';
  }, []);
  const canQueueWhileParentBusy = useCallback(
    (value: string) => !value.trimStart().startsWith('/'),
    [],
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
      if (
        showModelPicker ||
        showEffortPicker ||
        showPermissionModePicker ||
        showThemePicker ||
        showRewindPicker ||
        showConfigPicker ||
        showAgentProfilePicker ||
        showSkills
      )
        return true;
      if (key.ctrl && input === 'c') {
        if (pendingUserQuestion || pendingElicitation) {
          uiLog.event('input:Ctrl+C', { action: 'cancel-question-turn' });
          interrupt();
          return true;
        }
        if (pendingPermission || pendingPlanApproval) {
          uiLog.event('input:Ctrl+C', { action: 'noop-approval-active' });
          return true;
        }
        if (isThinking || sendInFlight || isResolvingCommand) {
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
      if (isShortcutsToggleKey(input, key)) {
        uiLog.event('input:Ctrl+/', { action: 'toggle-shortcuts' });
        setReferencePanel((current) => (current === 'shortcuts' ? null : 'shortcuts'));
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
        const targetToolId =
          activeExpandedToolId ?? focusedToolId ?? selectLatestToolId(activeTranscriptMessages);
        uiLog.event('input:Ctrl+E', { action: 'expand-current-tool', toolId: targetToolId });
        if (targetToolId) {
          updateToolExpansionOverrides((current) => new Map(current).set(targetToolId, true));
          showAllToolOutput(targetToolId);
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
      sendInFlight,
      isResolvingCommand,
      pendingPermission,
      pendingPlanApproval,
      pendingUserQuestion,
      pendingElicitation,
      redrawViewport,
      showEffortPicker,
      showPermissionModePicker,
      showModelPicker,
      showThemePicker,
      showRewindPicker,
      showConfigPicker,
      showAgentProfilePicker,
      showSkills,
      activeExpandedToolId,
      activeTranscriptMessages,
      focusedToolId,
      showAllToolOutput,
      updateToolExpansionOverrides,
    ],
  );

  // Track input changes for command menu filtering — now handled inside InputBar.
  // handleGlobalShortcut remains for Ctrl+/ keyboard shortcut reference.

  // Hoisted so the composer and the interactive /permissions sheet agree on who
  // holds the keyboard, instead of restating the same fifteen flags twice.
  const modalOwnsInput = ownsModalInput(
    pendingPermission ?? childPermission ?? childQuestion,
    pendingPlanApproval,
    showModelPicker,
    showSessionPicker,
    pendingUserQuestion,
    showEffortPicker,
    showThemePicker,
    showRewindPicker,
    showConfigPicker,
    showAgentProfilePicker,
    showPermissionModePicker,
    showSkills,
    showMcpApproval,
    pendingElicitation,
    showLoginPicker,
  );

  // The subset of `modalOwnsInput` that is genuinely a question. Everything else
  // it covers is a sheet holding the keyboard while it is open, and telling
  // someone to answer `/config` describes a prompt that is not there.
  const awaitingAnswer =
    Boolean(
      pendingPermission ??
      childPermission ??
      childQuestion ??
      pendingPlanApproval ??
      pendingUserQuestion ??
      pendingElicitation,
    ) || showMcpApproval;

  // Both read files, so they are computed only while the overlay is open —
  // this is App's render body, which re-runs on every streaming tick.
  const loginProfiles = useMemo(
    () => (showLoginPicker ? listAuthProfiles(liveConfig.settings) : EMPTY_AUTH_PROFILES),
    [showLoginPicker, liveConfig.settings],
  );
  const signedInProfiles = useMemo(
    () =>
      showLoginPicker
        ? listCredentials().map((credential) => credential.profile)
        : EMPTY_PROFILE_IDS,
    [showLoginPicker, authStoreRevision],
  );

  const pickerOwnsTranscript =
    showModelPicker ||
    showEffortPicker ||
    showPermissionModePicker ||
    showThemePicker ||
    showSessionPicker ||
    showRewindPicker ||
    showConfigPicker ||
    showAgentProfilePicker ||
    showLoginPicker ||
    showSkills;

  // A render crash replaces the whole UI, so the error box is the only thing
  // left to say whether the conversation survived. It did — the session file is
  // appended synchronously — but only when there is a store to have written it,
  // and only worth reopening once it holds more than its own header. A crash
  // during startup would otherwise promise a conversation and hand back an
  // empty one.
  const resumeCommand =
    session.store && messages.length > 0 ? `book --resume ${sessionId}` : undefined;
  // The boundary cannot lean on the global handler below: that handler is still
  // mounted with whatever state it held when the render blew up, so it swallows
  // Ctrl+C behind `ownsModalInput` if a picker was open and spends it on
  // `interrupt()` if a turn was streaming. It gets the same exit path either
  // way, so the session still ends cleanly.
  const exitFromCrash = () => {
    void endCurrentSession('exit').finally(exitApp);
  };

  if (startupFireActive) {
    return (
      <AppProviders theme={currentTheme.tokens} density={density}>
        <ErrorBoundary resumeCommand={resumeCommand} onExit={exitFromCrash}>
          <StartupFire
            width={termWidth}
            height={Math.max(1, termHeight - 1)}
            onComplete={() => setStartupFireActive(false)}
          />
        </ErrorBoundary>
      </AppProviders>
    );
  }

  const contextWindow = resolveContextWindow(liveConfig);

  return (
    <AppProviders theme={currentTheme.tokens} density={density}>
      <ErrorBoundary resumeCommand={resumeCommand} onExit={exitFromCrash}>
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
            layoutRevision={transcriptLayoutRevision}
            onToggleTool={toggleToolExpansion}
            onNotify={handleCopiedNotice}
            onRedrawViewport={redrawViewport}
          >
            <Box flexDirection="column" width={termWidth}>
              {error && (
                <Box paddingX={1} marginBottom={1}>
                  <Text color={theme.error}>✕ {error}</Text>
                </Box>
              )}
              {managedAgents.surface === 'detail' && selectedShellId ? (
                backgroundShells.shells.find((shell) => shell.id === selectedShellId) ? (
                  <BackgroundShellDetail
                    shell={backgroundShells.shells.find((shell) => shell.id === selectedShellId)!}
                    readTail={readSelectedShellTail}
                    width={termWidth}
                  />
                ) : (
                  <Box paddingX={1}>
                    <Text color={theme.subtle}>Loading background shell…</Text>
                  </Box>
                )
              ) : managedAgents.surface === 'detail' && managedAgents.selectedAgentId ? (
                // Viewing a child: never fall back to the main conversation.
                // The record can briefly lag its summary (a status event lists
                // an agent before its record is stored), so show a loading
                // placeholder until it arrives rather than the parent transcript.
                managedAgents.records.get(managedAgents.selectedAgentId) ? (
                  <SubagentDetail
                    record={managedAgents.records.get(managedAgents.selectedAgentId)!}
                    liveText={managedAgents.liveText.get(managedAgents.selectedAgentId)}
                    width={termWidth}
                    height={termHeight}
                    reducedMotion={motionDisabled}
                    screenReader={screenReader}
                    transcriptMode={transcriptMode}
                    automaticToolCallId={activeExpandedToolId}
                    toolExpansionOverrides={toolExpansionOverrides}
                    showAllToolOutput={showAllDetailedOutput}
                    showAllToolOutputIds={showAllToolOutputIds}
                  />
                ) : (
                  <Box paddingX={1}>
                    <Text color={theme.subtle}>Loading subagent…</Text>
                  </Box>
                )
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
                  showThinking={liveConfig.settings.ui.showThinking}
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
              {showAgentPlan && <AgentTodoList todos={agentTodos} terminalWidth={termWidth} />}
              {showTasks && (
                <TaskList tasks={tasks} onUpdateStatus={updateTaskStatus} onRemove={removeTask} />
              )}
              {showHelp && (
                <Box
                  flexDirection="column"
                  borderStyle="round"
                  borderColor={theme.border}
                  paddingX={1}
                  width={panelGrid(termWidth).width}
                >
                  <PanelHeading title="Slash Commands" theme={theme} />
                  <Box flexDirection="column">
                    <HelpRow label="/help" description="Toggle this help" theme={theme} />
                    <HelpRow label="/exit" description="Exit book" theme={theme} />
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
                      label="/login [profile]"
                      description="Sign in with a provider subscription (OAuth)"
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
                    <HelpRow label="/skills" description="Manage skills" theme={theme} />
                    <HelpRow label="/init" description="Initialize CLAUDE.md" theme={theme} />
                    <HelpRow
                      label="/reload-skills"
                      description="Reload commands and skills"
                      theme={theme}
                    />
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
                  width={panelGrid(termWidth).width}
                >
                  <PanelHeading title="Session Status" theme={theme} />
                  <Box flexDirection="column">
                    <HelpRow
                      label="Model"
                      description={liveConfig.modelSelection ?? liveConfig.model}
                      theme={theme}
                    />
                    <HelpRow
                      label="Auth"
                      description={
                        liveConfig.authProfile
                          ? `subscription · ${liveConfig.authProfile}`
                          : liveConfig.apiKey
                            ? 'API key'
                            : 'none'
                      }
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
                  width={panelGrid(termWidth).width}
                >
                  <PanelHeading title="Permission Mode" theme={theme} />
                  <PermissionsPanel
                    mode={mode}
                    permissions={liveConfig.settings.permissions}
                    onRemove={removePermissionRule}
                    active={!modalOwnsInput}
                    terminalWidth={termWidth}
                    screenReader={screenReader}
                  />
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
                  width={panelGrid(termWidth).width}
                >
                  <PanelHeading title="Keyboard Shortcuts" theme={theme} />
                  <Box flexDirection="column">
                    <HelpRow
                      label="Esc"
                      description="Deny a prompt, cancel the turn, or close this panel"
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
                      description="Expand current tool output (empty prompt)"
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
                    <HelpRow label="Alt+V" description="Attach clipboard image" theme={theme} />
                    <HelpRow label="Up/Down" description="Navigate input history" theme={theme} />
                    <HelpRow label="Wheel" description="Scroll transcript" theme={theme} />
                    <HelpRow
                      label="Drag"
                      description="Select visible text and copy on release"
                      theme={theme}
                    />
                    <HelpRow
                      label="Shift+drag"
                      description="Use terminal-native text selection"
                      theme={theme}
                    />
                    <HelpRow label="PgUp/PgDn" description="Scroll transcript" theme={theme} />
                    <HelpRow
                      label="Ctrl+U/Ctrl+D"
                      description="Scroll transcript half a page (empty prompt)"
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
                    <HelpRow
                      label="Ctrl+A / Ctrl+E"
                      description="Move to start / end of the prompt"
                      theme={theme}
                    />
                    <HelpRow
                      label="Ctrl+W / Alt+Bksp"
                      description="Delete the previous word"
                      theme={theme}
                    />
                    <HelpRow
                      label="Ctrl+U / Ctrl+K"
                      description="Delete to start / end of the prompt"
                      theme={theme}
                    />
                    <HelpRow
                      label="Ctrl+Y"
                      description="Put back the last deletion"
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
                  onResolve={(decision) =>
                    void managedAgents.resolvePermission(
                      childPermission.request.id,
                      // A managed agent persists rules through its own manager,
                      // which has no scope ladder, so only the result travels.
                      permissionResultOf(decision),
                    )
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
            {pendingElicitation ? (
              <McpElicitationForm
                key={pendingElicitation.request.id}
                request={pendingElicitation.request}
                queueLength={pendingElicitationCount}
                terminalWidth={termWidth}
                onResolve={resolveElicitation}
                screenReader={screenReader}
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
                      attachments: result.restoredAttachments,
                    }));
                  }
                  setShowRewindPicker(false);
                  setFollowRequestKey((key) => key + 1);
                  return { ok: true };
                }}
                onCancel={() => setShowRewindPicker(false)}
              />
            ) : null}
            {showSkills ? (
              <SkillManager
                skills={skills}
                enabled={liveConfig.settings.skills.enabled}
                watcherError={skillWatcherError}
                lifecycleEvents={runtime?.inspectSkills(currentTurn)?.events}
                activeSkillNames={runtime
                  ?.inspectSkills(currentTurn)
                  ?.active.map((frame) => frame.skillName)}
                terminalWidth={termWidth}
                maxVisible={Math.max(3, Math.min(10, termHeight - 10))}
                onChangeActivation={(skillName, activation) => {
                  const result = setSkillActivation(skillName, activation);
                  if (!result.ok) return result;
                  setSkills((current) =>
                    current.map((skill) =>
                      skill.name === skillName ? { ...skill, activation } : skill,
                    ),
                  );
                  return result;
                }}
                onChangeExecution={(skillName, execution) => {
                  const result = setSkillExecution(skillName, execution);
                  if (!result.ok) return result;
                  setSkills((current) =>
                    current.map((skill) =>
                      skill.name === skillName ? { ...skill, execution } : skill,
                    ),
                  );
                  return result;
                }}
                onChangeEnabled={(enabled) => {
                  const result = setSkillsEnabled(enabled);
                  if (result.ok) {
                    setSkills(
                      discoverSkills(config.workspace, liveConfig.settings.skills.overrides, {
                        executionOverrides: liveConfig.settings.skills.execution,
                        enabled,
                      }),
                    );
                  }
                  return result;
                }}
                onUse={(skill: Skill) => {
                  setDraftRestore((current) => ({
                    key: (current?.key ?? 0) + 1,
                    value: `$${skill.name} `,
                  }));
                  forgetConfigOrigin();
                  setShowSkills(false);
                }}
                onReload={() => {
                  const refreshed = runtime?.reloadSkills(
                    config.workspace,
                    liveConfig.settings.skills,
                  );
                  setSkills(
                    refreshed?.list() ??
                      discoverSkills(config.workspace, liveConfig.settings.skills.overrides, {
                        executionOverrides: liveConfig.settings.skills.execution,
                        enabled: liveConfig.settings.skills.enabled,
                      }),
                  );
                  setSkillWatcherError(runtime?.skillWatcherError);
                }}
                onCancel={() => {
                  setShowSkills(false);
                  returnToConfig();
                }}
              />
            ) : null}
            {showConfigPicker ? (
              <ConfigMenu
                model={liveConfig.modelSelection ?? liveConfig.model}
                compactModel={liveConfig.compactModel ?? liveConfig.settings.compactModel}
                effort={liveConfig.effort}
                themeName={currentTheme.preference}
                memoryAutoSave={liveConfig.settings.memory.autoSave}
                showThinking={liveConfig.settings.ui.showThinking}
                startupAnimation={liveConfig.settings.ui.startupAnimation}
                agentCount={agentProfiles.length}
                skillCount={skills.length}
                defaultPermissionMode={resolvePermissionMode(liveConfig.settings)}
                terminalWidth={termWidth}
                initialSelection={configInitialRow}
                onOpen={(section: ConfigSection, rowIndex: number) => {
                  if (section === 'effort') {
                    const unavailable = getEffortUnavailableError(liveConfig);
                    if (unavailable) {
                      addLocalMessage(`✕ ${unavailable}`);
                      return;
                    }
                  }
                  configReturnRow.current = rowIndex;
                  setShowConfigPicker(false);
                  if (section === 'model') {
                    setSelectingCompactModel(false);
                    setAgentProfileForModel(undefined);
                    setShowModelPicker(true);
                  } else if (section === 'compact-model') {
                    setSelectingCompactModel(true);
                    setAgentProfileForModel(undefined);
                    setShowModelPicker(true);
                  } else if (section === 'effort') {
                    setShowEffortPicker(true);
                  } else if (section === 'theme') {
                    setCustomThemes(listCustomThemes(config.workspace));
                    setShowThemePicker(true);
                  } else if (section === 'permission-mode') {
                    setShowPermissionModePicker(true);
                  } else if (section === 'skills') {
                    setShowSkills(true);
                  } else {
                    setShowAgentProfilePicker(true);
                  }
                }}
                onToggleMemory={() => toggleMemoryAutoSave()}
                onToggleThinking={() => {
                  const result = toggleShowThinking();
                  if (!result.ok)
                    addLocalMessage(`✕ ${result.error ?? 'Could not save thinking setting.'}`);
                }}
                onToggleStartupAnimation={() => {
                  const result = toggleStartupAnimation();
                  if (!result.ok) {
                    addLocalMessage(
                      `✕ ${result.error ?? 'Could not save startup animation setting.'}`,
                    );
                  }
                }}
                onCancel={() => {
                  forgetConfigOrigin();
                  setShowConfigPicker(false);
                }}
              />
            ) : null}
            {showAgentProfilePicker ? (
              <AgentProfilePicker
                profiles={agentProfiles}
                parentModel={liveConfig.modelSelection ?? liveConfig.model}
                configuredModels={configuredAgentModels}
                terminalWidth={termWidth}
                onSelect={(profile) => {
                  setSelectingCompactModel(false);
                  setAgentProfileForModel(profile);
                  setShowAgentProfilePicker(false);
                  setShowModelPicker(true);
                }}
                onReset={(profile) => {
                  const result = setAgentProfileModel(profile);
                  addLocalMessage(
                    result.ok
                      ? `${profile} now inherits the parent model.`
                      : `✕ ${result.error ?? `Could not reset ${profile}.`}`,
                  );
                }}
                onCancel={() => {
                  setShowAgentProfilePicker(false);
                  returnToConfig();
                }}
              />
            ) : null}
            {showModelPicker ? (
              <ModelPicker
                title={selectingCompactModel ? 'Choose compact model' : undefined}
                options={modelOptions}
                currentModel={modelPickerSelection}
                currentEffort={selectingCompactModel ? undefined : liveConfig.effort}
                effortLevels={
                  selectingCompactModel || agentProfileForModel ? [] : (effortLevels ?? [])
                }
                hasPriorOutput={
                  !selectingCompactModel && !agentProfileForModel && messages.length > 0
                }
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
                  if (selectingCompactModel) {
                    const result = setCompactModel(model);
                    if (!result.ok) return result;
                    addLocalMessage(`Set compact model to ${model}.`);
                    setSelectingCompactModel(false);
                    setShowModelPicker(false);
                    returnToConfig();
                    return result;
                  }
                  if (agentProfileForModel) {
                    const result = setAgentProfileModel(agentProfileForModel, model);
                    if (!result.ok) return result;
                    addLocalMessage(`Set ${agentProfileForModel} subagent model to ${model}.`);
                    setAgentProfileForModel(undefined);
                    setShowModelPicker(false);
                    setShowAgentProfilePicker(true);
                    return result;
                  }
                  const result = setModel(model, { persist: saveDefault });
                  if (!result.ok) return result;
                  addLocalMessage(
                    saveDefault
                      ? `Switched to ${model} (saved as default).`
                      : `Switched to ${model} for this session only.`,
                  );
                  setShowModelPicker(false);
                  returnToConfig();
                  return result;
                }}
                onPickEffort={(level) => setEffort(level)}
                allowProviderManagement={!selectingCompactModel && !agentProfileForModel}
                onSaveProvider={upsertProviderAndSelect}
                removableProviderIds={removableProviderIds}
                removableProviderModelCounts={removableProviderModelCounts}
                onRemoveProvider={(providerId) => {
                  const result = removeProvider(providerId);
                  if (!result.ok) return result;
                  addLocalMessage(providerRemovalMessage(result));
                  setShowModelPicker(false);
                  returnToConfig();
                  return result;
                }}
                onProviderSaved={(request) => {
                  addLocalMessage(
                    `Added ${request.providerId} with ${request.models.length} model${request.models.length === 1 ? '' : 's'}; using ${request.providerId}/${request.activeModelId}.`,
                  );
                  setShowModelPicker(false);
                  returnToConfig();
                }}
                onCancel={() => {
                  // A model chosen *for a profile* was reached through the
                  // profile picker, which is one step deeper than the menu; its
                  // own cancel carries the user the rest of the way back, so the
                  // recorded `/config` row must survive this close.
                  const returnToAgents = Boolean(agentProfileForModel);
                  setSelectingCompactModel(false);
                  setAgentProfileForModel(undefined);
                  setShowModelPicker(false);
                  if (returnToAgents) setShowAgentProfilePicker(true);
                  else returnToConfig();
                }}
              />
            ) : null}
            {showLoginPicker ? (
              <LoginPicker
                profiles={loginProfiles}
                signedIn={signedInProfiles}
                activeProfile={liveConfig.authProfile}
                initialProfileId={loginProfileHint}
                previewActivation={previewAuthLogin}
                onSignedIn={() => setAuthStoreRevision((revision) => revision + 1)}
                onActivate={(profile) => {
                  const result = applyAuthLogin(profile);
                  if (result.ok) {
                    addLocalMessage(
                      `Signed in to ${profile.label}. This session now spends that subscription.`,
                    );
                  }
                  return result;
                }}
                onClose={() => {
                  setShowLoginPicker(false);
                  setLoginProfileHint(undefined);
                }}
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
                  returnToConfig();
                  return result;
                }}
                onCancel={() => {
                  setShowEffortPicker(false);
                  returnToConfig();
                }}
              />
            ) : null}
            {showPermissionModePicker ? (
              <PermissionModePicker
                current={resolvePermissionMode(liveConfig.settings)}
                availableModes={
                  [
                    'default',
                    'auto',
                    'plan',
                    'accept-edits',
                    'dontAsk',
                    ...(liveConfig.settings.disableBypassPermissionsMode
                      ? []
                      : ['bypassPermissions']),
                  ] as PermissionMode[]
                }
                onSelect={(nextMode) => {
                  const result = setDefaultPermissionMode(nextMode);
                  if (!result.ok) return result;
                  addLocalMessage(`Default permission mode set to ${nextMode} globally.`);
                  setShowPermissionModePicker(false);
                  returnToConfig();
                  return result;
                }}
                onCancel={() => {
                  setShowPermissionModePicker(false);
                  returnToConfig();
                }}
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
                  returnToConfig();
                  return { ok: true };
                }}
                onCancel={() => {
                  setShowThemePicker(false);
                  returnToConfig();
                }}
              />
            ) : null}
            {showMcpApproval && pendingMcpApproval && mcp ? (
              <McpServerApprovalPrompt
                key={pendingMcpApproval.name}
                server={pendingMcpApproval}
                remainingCount={mcpSnapshot.pendingApprovals.length - 1}
                onApprove={() => mcp.approve(pendingMcpApproval.name)}
                onReject={() => mcp.reject(pendingMcpApproval.name)}
                onDefer={() => mcp.defer(pendingMcpApproval.name)}
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

          {reviewStatus ? <Text dimColor>{reviewStatus}... (Esc to cancel)</Text> : null}

          {managedAgents.persistenceEvent ? (
            <Text
              color={
                managedAgents.persistenceEvent.state === 'degraded' ? theme.warning : theme.success
              }
            >
              {managedAgents.persistenceEvent.state === 'degraded' ? '! ' : '✓ '}
              {managedAgents.persistenceEvent.message}
            </Text>
          ) : null}

          <WorkingIndicator
            isThinking={isThinking}
            isCompacting={isCompacting}
            compactTrigger={compactUi?.trigger}
            messages={messages}
            streamingMessageId={streamingMessageId}
            pendingPermission={pendingPermission}
            pendingPlanApproval={pendingPlanApproval}
            pendingUserQuestion={pendingUserQuestion}
            pendingElicitation={pendingElicitation}
            retryPhase={retryPhase}
            retryAttempt={retryAttempt}
            retryMax={retryMax}
            retryCountdownMs={retryCountdownMs}
            terminalWidth={termWidth}
            reducedMotion={motionDisabled}
            screenReader={screenReader}
          />

          {/* Input bar — above the status line. Command menu is built into InputBar. */}
          <Box
            flexDirection="column"
            flexShrink={0}
            width={termWidth}
            marginTop={messages.length > 0 ? 1 : 0}
          >
            <QueuedInputPreview
              items={queuedInputs}
              terminalWidth={termWidth}
              notice={queueNotice ?? copyNotice}
            />
            <InputBar
              key={sessionId}
              onSubmit={handleSubmit}
              onPasteImage={pasteClipboardImage}
              submissionMode={
                managedAgents.surface === 'detail'
                  ? 'submit'
                  : isThinking || sendInFlight
                    ? 'queue'
                    : isCompacting || isRewinding || isResolvingCommand
                      ? 'blocked'
                      : 'submit'
              }
              mode={mode}
              onCycleMode={cycleMode}
              canSubmitWhileBusy={canSubmitWhileParentBusy}
              canQueueWhileBusy={canQueueWhileParentBusy}
              onQueue={enqueueFollowUp}
              onRecallQueued={managedAgents.surface === 'main' ? recallQueuedInput : undefined}
              onCancelQueuedEdit={cancelQueuedEdit}
              editingQueuedInput={Boolean(editingQueuedInput)}
              onDraftChange={(value, attachments) => {
                draftRef.current = value;
                draftAttachmentsRef.current = attachments ?? [];
              }}
              onCycleAgentFocus={cycleAgentFocus}
              onFocusBackgroundTask={() => {
                if (managedAgents.surface === 'detail') {
                  if (!managedAgentUiEnabled) return false;
                  setDetailTaskPickerAgentId(undefined);
                  setDetailTaskPickerOpen(true);
                  return true;
                }
                const firstJobId =
                  managedAgents.summaries[0]?.agentId ?? backgroundShells.shells[0]?.id;
                if (!managedAgentUiEnabled || !firstJobId) return false;
                selectBackgroundJob(firstJobId);
                managedAgents.setSurface('tasks');
                return true;
              }}
              inputSuppressed={
                modalOwnsInput ||
                // The rules sheet is a list, not a page of text: while it is up
                // it takes the arrows, so the composer must not also read them
                // as history navigation. Esc closes it, as it does every panel.
                showPermissions ||
                transcriptMode === 'detailed' ||
                managedAgents.surface === 'tasks' ||
                detailTaskPickerOpen
              }
              awaitingAnswer={awaitingAnswer}
              onGlobalShortcut={handleGlobalShortcut}
              commands={commands}
              skills={skills}
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
              shells={backgroundShells.shells}
              selectedJobId={selectedShellId ?? managedAgents.selectedAgentId}
              isActive={managedAgents.surface === 'tasks'}
              onSelect={selectBackgroundJob}
              onOpen={(jobId) => {
                selectBackgroundJob(jobId);
                if (backgroundShells.shells.some((shell) => shell.id === jobId)) {
                  backgroundShells.acknowledge(jobId);
                }
                managedAgents.setSurface('detail');
              }}
              onClose={() => managedAgents.setSurface('main')}
              onCancel={() => managedAgents.setSurface('main')}
              onStopOrDismiss={(jobId) => {
                if (backgroundShells.shells.some((shell) => shell.id === jobId)) {
                  void backgroundShells.stopOrDismiss(jobId);
                } else {
                  void managedAgents.stopOrDismiss(jobId);
                }
              }}
              width={termWidth}
              reducedMotion={motionDisabled}
              screenReader={screenReader}
            />
          ) : null}

          {managedAgentUiEnabled && managedAgents.surface === 'detail' && detailTaskPickerOpen ? (
            <SubagentPanel
              agents={managedAgents.summaries}
              shells={backgroundShells.shells}
              selectedJobId={detailTaskPickerAgentId}
              isActive
              onSelect={setDetailTaskPickerAgentId}
              onOpen={(jobId) => {
                setDetailTaskPickerOpen(false);
                setDetailTaskPickerAgentId(undefined);
                selectBackgroundJob(jobId);
              }}
              onClose={returnToMain}
              onCancel={() => {
                setDetailTaskPickerOpen(false);
                setDetailTaskPickerAgentId(undefined);
              }}
              onStopOrDismiss={(jobId) => {
                if (backgroundShells.shells.some((shell) => shell.id === jobId)) {
                  void backgroundShells.stopOrDismiss(jobId);
                } else {
                  void managedAgents.stopOrDismiss(jobId);
                }
              }}
              width={termWidth}
              reducedMotion={motionDisabled}
              screenReader={screenReader}
            />
          ) : null}

          {/* Status line — stable footer */}
          <Box flexShrink={0} width={termWidth}>
            <StatusLine
              gitBranch={gitStatus.branch}
              gitStatus={gitStatus.status}
              model={liveConfig.modelSelection ?? liveConfig.model}
              tokenCount={tokenCount}
              maxTokens={contextWindow.window}
              maxTokensSource={contextWindow.source}
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

/**
 * Title row for a reference sheet, carrying the way out.
 *
 * These panels are pinned above the composer until something dismisses them, so
 * the exit has to be written on the panel itself — a reader who does not
 * already know the toggle command has nothing else to go on. It rides the title
 * rather than a footer line because `/help` already runs taller than a short
 * terminal, and a panel that has to scroll to reveal how to close it is no
 * better than one that never says.
 */
function PanelHeading({
  title,
  theme,
}: {
  title: string;
  theme: { brand: string; subtle: string };
}) {
  return (
    <Box>
      <Text bold color={theme.brand}>
        {title}
      </Text>
      <Text color={theme.subtle} dimColor>
        {'  Esc to close'}
      </Text>
    </Box>
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
