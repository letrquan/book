import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App, CTRL_C_EXIT_HINT_MS, CTRL_C_EXIT_HINT_TEXT } from './app.js';
import type { AgentConfig } from '../types/runtime.js';
import type { AgentRecord } from '../agents/types.js';
import type { SlashCommand } from '../types/commands.js';
import { DEFAULT_SETTINGS } from '../settings.js';

/** Regression coverage for idle Ctrl+C confirmation and active-turn cancellation. */

const useAgentMock = vi.fn();
const useTasksMock = vi.fn();
const discoverCommandsMock = vi.fn((_workspace: string): SlashCommand[] => []);
const resolveCommandBodyMock = vi.fn();
const discoverSkillsMock = vi.fn((_workspace: string) => []);
const persistSettingLocalMock = vi.fn((_workspace: string, _key: string, _value: unknown) => ({
  ok: true,
}));
const readClipboardImageMock = vi.fn();
const managedAgentManagerMock = {
  list: vi.fn<() => Promise<AgentRecord[]>>(async () => []),
  listPendingCompletions: vi.fn(async () => []),
  subscribe: vi.fn(() => () => {}),
  setInteractivePermissions: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
  apply: vi.fn(),
  get: vi.fn(),
};

vi.mock('./hooks/useAgent.js', () => ({
  useAgent: (...args: unknown[]) => useAgentMock(...args),
}));

vi.mock('./hooks/useTasks.js', () => ({
  useTasks: (...args: unknown[]) => useTasksMock(...args),
}));

vi.mock('../commands/loader.js', () => ({
  discoverCommands: (workspace: string) => discoverCommandsMock(workspace),
  resolveCommandBody: (...args: unknown[]) => resolveCommandBodyMock(...args),
}));

vi.mock('../skills.js', () => ({
  discoverSkills: (workspace: string) => discoverSkillsMock(workspace),
}));

vi.mock('../input/clipboard-image.js', () => ({
  readClipboardImage: (...args: unknown[]) => readClipboardImageMock(...args),
}));

vi.mock('./persist.js', () => ({
  persistSettingLocal: (...args: [string, string, unknown]) => persistSettingLocalMock(...args),
}));

vi.mock('../agents/manager.js', () => ({
  getOrCreateAgentManager: () => managedAgentManagerMock,
}));

function config(): AgentConfig {
  return {
    apiKey: 'test-key',
    baseUrl: 'http://localhost',
    model: 'model-x',
    maxTurns: 4,
    maxTokens: 128000,
    compactStrategy: 'summary',
    autoCompactEnabled: true,
    workspace: '/tmp/book',
    animation: { typewriterSpeed: 3, spinnerStyle: 'braille' },
    accessibility: { screenReader: true, reducedMotion: true },
    settings: {
      ...DEFAULT_SETTINGS,
      model: 'model-x',
      maxTurns: 4,
      maxTokens: 128000,
      autoCompactEnabled: true,
      defaultMode: 'default',
      memory: {
        ...DEFAULT_SETTINGS.memory,
        enabled: false,
        autoSave: false,
        requireApproval: true,
      },
      retry: {
        ...DEFAULT_SETTINGS.retry,
        maxAttempts: 3,
        totalBudgetMs: 120000,
        requestTimeoutMs: 120000,
        streamStallTimeoutMs: 30000,
      },
    },
    retry: {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      totalBudgetMs: 120000,
      requestTimeoutMs: 120000,
      streamStallTimeoutMs: 30000,
      toolRetries: 1,
      watchdog: false,
    },
    provider: 'openai',
  };
}

const testSession = {
  sessionId: 'session-ctrl-c',
  history: [],
  source: 'startup' as const,
  persisted: false,
  created: true,
};

function agentState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    contextHistory: [],
    compactBoundaries: [],
    isThinking: false,
    streamingMessageId: null,
    error: null,
    currentTurn: 1,
    tokenCount: 0,
    usage: null,
    mode: 'default',
    pendingPermission: null,
    pendingPlanApproval: null,
    pendingUserQuestion: null,
    pendingUserQuestionCount: 0,
    pendingElicitation: null,
    pendingElicitationCount: 0,
    resolveElicitation: vi.fn(),
    elicitationHandler: undefined,
    agentTodos: [],
    liveConfig: config(),
    runtime: undefined,
    removableProviderIds: new Set<string>(),
    removableProviderModelCounts: new Map<string, number>(),
    sessionId: testSession.sessionId,
    sessionName: undefined,
    send: vi.fn(async () => ({ status: 'completed' as const, messages: [] })),
    sendAgentCompletions: vi.fn(async () => {}),
    sendBackgroundShellCompletion: vi.fn(async () => true),
    clear: vi.fn(),
    startNewConversation: vi.fn(async () => {}),
    resumeConversation: vi.fn(async () => {}),
    listSessions: vi.fn(() => []),
    endCurrentSession: vi.fn(async () => {}),
    resolvePermission: vi.fn(),
    resolvePlanApproval: vi.fn(),
    resolveUserQuestion: vi.fn(),
    cancel: vi.fn(),
    compact: vi.fn(),
    isCompacting: false,
    isRewinding: false,
    rewind: vi.fn(async () => ({ ok: true })),
    getRewindTargets: vi.fn(() => []),
    compactUi: null,
    setCompactUi: vi.fn(),
    cycleMode: vi.fn(),
    addLocalMessage: vi.fn(),
    setModel: vi.fn(),
    upsertProviderAndSelect: vi.fn(() => ({ ok: true })),
    removeProvider: vi.fn(() => ({ ok: false, error: 'not local' })),
    setEffort: vi.fn(() => ({ ok: true })),
    setAgentProfileModel: vi.fn(() => ({ ok: true })),
    setCompactModel: vi.fn(() => ({ ok: true })),
    setSkillActivation: vi.fn(),
    setSkillExecution: vi.fn(),
    setSkillsEnabled: vi.fn(),
    setMemoryAutoSave: vi.fn(),
    toggleMemoryAutoSave: vi.fn(),
    toggleShowThinking: vi.fn(() => ({ ok: true })),
    toggleStartupAnimation: vi.fn(() => ({ ok: true })),
    refreshMemoryContext: vi.fn(),
    persistPermissionRule: vi.fn(),
    removePermissionRule: vi.fn(),
    setDefaultPermissionMode: vi.fn(),
    turnDurationMs: 0,
    retryPhase: 'none',
    retryAttempt: 0,
    retryMax: 0,
    retryCountdownMs: 0,
    ...overrides,
  };
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function frameOf(view: ReturnType<typeof render>): string {
  return stripAnsi(view.lastFrame());
}

async function settle(ms = 90): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function installAgentState(state: ReturnType<typeof agentState>): void {
  useAgentMock.mockReturnValue(state);
  useTasksMock.mockReturnValue({
    tasks: [],
    addTask: vi.fn(),
    updateTaskStatus: vi.fn(),
    removeTask: vi.fn(),
    clearTasks: vi.fn(),
  });
}

async function startIdleApp(overrides: Record<string, unknown> = {}) {
  const state = agentState(overrides);
  installAgentState(state);
  const view = render(<App config={config()} session={testSession} />);
  await settle(150);
  return { view, state };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('idle Ctrl+C exit confirmation', () => {
  it('first press shows the "press again to exit" hint and keeps the app running', async () => {
    const { view, state } = await startIdleApp();

    view.stdin.write('\x03');
    await settle();

    expect(frameOf(view)).toContain(CTRL_C_EXIT_HINT_TEXT);
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('a second press within the window exits', async () => {
    const { view, state } = await startIdleApp();

    view.stdin.write('\x03');
    await settle(200);
    expect(frameOf(view)).toContain(CTRL_C_EXIT_HINT_TEXT);

    view.stdin.write('\x03');
    await settle(200);

    expect(state.endCurrentSession).toHaveBeenCalledWith('exit');
  });

  it('a press after the window has expired shows the hint again instead of exiting', async () => {
    const { view, state } = await startIdleApp();

    view.stdin.write('\x03');
    await settle(200);
    expect(frameOf(view)).toContain(CTRL_C_EXIT_HINT_TEXT);

    await settle(CTRL_C_EXIT_HINT_MS + 300);
    expect(frameOf(view)).not.toContain(CTRL_C_EXIT_HINT_TEXT);
    expect(state.endCurrentSession).not.toHaveBeenCalled();

    view.stdin.write('\x03');
    await settle(200);

    expect(frameOf(view)).toContain(CTRL_C_EXIT_HINT_TEXT);
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  }, 10_000);

  it('a non-empty composer is cleared instead of arming the exit window', async () => {
    const { view, state } = await startIdleApp();

    view.stdin.write('unsent draft');
    await settle(150);
    expect(frameOf(view)).toContain('unsent draft');

    view.stdin.write('\x03');
    await settle(200);

    const frame = frameOf(view);
    expect(frame).not.toContain('unsent draft');
    expect(frame).not.toContain(CTRL_C_EXIT_HINT_TEXT);
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('mid-turn Ctrl+C still cancels the turn instead of arming the exit window', async () => {
    const { view, state } = await startIdleApp({ isThinking: true });

    view.stdin.write('\x03');
    await settle(200);

    expect(state.cancel).toHaveBeenCalled();
    expect(frameOf(view)).not.toContain(CTRL_C_EXIT_HINT_TEXT);
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('requires two presses from the startup-fire splash', async () => {
    const fireConfig = config();
    fireConfig.accessibility = { screenReader: false, reducedMotion: false };
    const state = agentState({ liveConfig: fireConfig });
    installAgentState(state);
    const view = render(<App config={fireConfig} session={testSession} />);
    await settle(150);

    view.stdin.write('\x03');
    await settle(200);
    expect(frameOf(view)).toContain(CTRL_C_EXIT_HINT_TEXT);
    expect(state.endCurrentSession).not.toHaveBeenCalled();

    view.stdin.write('\x03');
    await settle(200);

    expect(state.endCurrentSession).toHaveBeenCalledWith('exit');
  });

  it('Ctrl+C on a recalled queued input removes it and lets the queue drain', async () => {
    const appConfig = config();
    const state = agentState({ isThinking: true });
    installAgentState(state);
    const view = render(<App config={appConfig} session={testSession} />);
    await settle(150);

    view.stdin.write('first queued');
    await settle(150);
    view.stdin.write('\r');
    await settle(150);
    view.stdin.write('second queued');
    await settle(150);
    view.stdin.write('\r');
    await settle(150);
    view.stdin.write('\x1b[A');
    await settle(150);
    expect(frameOf(view)).toContain('Editing queued input');

    installAgentState({ ...state, isThinking: false });
    view.rerender(<App config={appConfig} session={testSession} />);
    await settle(150);
    expect(state.send).not.toHaveBeenCalled();

    view.stdin.write('\x03');
    await settle(300);

    expect(frameOf(view)).not.toContain('Editing queued input');
    expect(state.send).toHaveBeenCalledWith('first queued');
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('a turn that starts inside the exit window disarms it', async () => {
    const appConfig = config();
    const state = agentState();
    installAgentState(state);
    const view = render(<App config={appConfig} session={testSession} />);
    await settle(150);

    view.stdin.write('\x03');
    await settle(200);
    expect(frameOf(view)).toContain(CTRL_C_EXIT_HINT_TEXT);

    installAgentState({ ...state, isThinking: true });
    view.rerender(<App config={appConfig} session={testSession} />);
    await settle(150);
    expect(frameOf(view)).not.toContain(CTRL_C_EXIT_HINT_TEXT);

    installAgentState({ ...state, isThinking: false });
    view.rerender(<App config={appConfig} session={testSession} />);
    await settle(150);

    view.stdin.write('\x03');
    await settle(200);

    expect(state.endCurrentSession).not.toHaveBeenCalled();
    expect(frameOf(view)).toContain(CTRL_C_EXIT_HINT_TEXT);
  });
});
