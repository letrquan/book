import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App, ownsModalInput, providerRemovalMessage } from './app.js';
import type { AgentConfig } from '../types.js';
import { DEFAULT_SETTINGS } from '../settings.js';

const useAgentMock = vi.fn();
const useTasksMock = vi.fn();
const discoverCommandsMock = vi.fn((_workspace: string) => []);
const discoverSkillsMock = vi.fn((_workspace: string) => []);
const persistSettingLocalMock = vi.fn((_workspace: string, _key: string, _value: unknown) => ({
  ok: true,
}));

vi.mock('./hooks/useAgent.js', () => ({
  useAgent: (...args: unknown[]) => useAgentMock(...args),
}));

vi.mock('./hooks/useTasks.js', () => ({
  useTasks: (...args: unknown[]) => useTasksMock(...args),
}));

vi.mock('../commands/loader.js', () => ({
  discoverCommands: (workspace: string) => discoverCommandsMock(workspace),
  resolveCommandBody: vi.fn(),
}));

vi.mock('../skills.js', () => ({
  discoverSkills: (workspace: string) => discoverSkillsMock(workspace),
}));

vi.mock('./persist.js', () => ({
  persistSettingLocal: (...args: [string, string, unknown]) => persistSettingLocalMock(...args),
}));

function config(): AgentConfig {
  return {
    apiKey: 'test-key',
    baseUrl: 'http://localhost',
    model: 'model-x',
    maxTurns: 4,
    maxTokens: 128000,
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
      memory: { enabled: false, autoSave: false, requireApproval: true },
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
  sessionId: 'session-test',
  history: [],
  source: 'startup' as const,
  persisted: false,
  created: true,
};

function pendingAgentState() {
  const resolvePlanApproval = vi.fn();
  return {
    messages: [],
    isThinking: true,
    streamingMessageId: null,
    error: null,
    currentTurn: 1,
    tokenCount: 0,
    usage: null,
    mode: 'plan',
    pendingPermission: null,
    pendingPlanApproval: { plan: 'Review this plan.', resolve: vi.fn() },
    agentTodos: [],
    liveConfig: config(),
    localProviderIds: new Set<string>(),
    localProviderModelCounts: new Map<string, number>(),
    sessionId: 'session-test',
    sessionName: undefined,
    send: vi.fn(),
    clear: vi.fn(),
    startNewConversation: vi.fn(async () => {}),
    resumeConversation: vi.fn(async () => {}),
    listSessions: vi.fn(() => []),
    endCurrentSession: vi.fn(),
    resolvePermission: vi.fn(),
    resolvePlanApproval,
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
    setMemoryAutoSave: vi.fn(),
    refreshMemoryContext: vi.fn(),
    turnDurationMs: 0,
    retryPhase: 'none',
    retryAttempt: 0,
    retryMax: 0,
    retryCountdownMs: 0,
  };
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('App session commands', () => {
  const submit = async (view: ReturnType<typeof render>, value: string) => {
    view.stdin.write(value);
    await new Promise((resolve) => setTimeout(resolve, 75));
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 75));
  };

  it('/new dispatches a new conversation', async () => {
    const agentState = { ...pendingAgentState(), isThinking: false, pendingPlanApproval: null };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    await submit(view, '/new previous');

    expect(agentState.startNewConversation).toHaveBeenCalledWith('previous');
    expect(agentState.clear).not.toHaveBeenCalled();
  });

  it('/newline is not treated as /new', async () => {
    const agentState = { ...pendingAgentState(), isThinking: false, pendingPlanApproval: null };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    await submit(view, '/newline value');

    expect(agentState.startNewConversation).not.toHaveBeenCalled();
    expect(agentState.send).toHaveBeenCalledWith('/newline value');
  });

  it('/providers opens provider management and documents removal in help', async () => {
    const agentState = { ...pendingAgentState(), isThinking: false, pendingPlanApproval: null };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    await submit(view, '/providers');
    expect(stripAnsi(view.lastFrame())).toContain('Models & BYOK providers');

    view.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 75));
    await submit(view, '/help');
    const output = view.frames.map(stripAnsi).join('\n');
    expect(output).toContain('/providers');
    expect(output).toContain('Alt+D removes selected local BYOK');
  });

  it('opens /rewind only without arguments and lists it in help', async () => {
    const agentState = { ...pendingAgentState(), isThinking: false, pendingPlanApproval: null };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });
    const view = render(<App config={config()} session={testSession} />);

    await submit(view, '/rewind now');
    expect(agentState.addLocalMessage).toHaveBeenCalledWith('Usage: /rewind');

    await submit(view, '/rewind');
    expect(stripAnsi(view.lastFrame())).toContain('no user prompts to rewind');

    view.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 75));
    await submit(view, '/help');
    expect(view.frames.map(stripAnsi).join('\n')).toContain('/rewind');
  });
});

describe('provider removal transcript messages', () => {
  it('reports non-active removal with the model count', () => {
    expect(
      providerRemovalMessage({
        ok: true,
        providerId: 'gateway',
        removedModelCount: 3,
        activeModel: 'project-model',
        switched: false,
        inheritedProviderRevealed: false,
      }),
    ).toBe('Removed local BYOK provider gateway and its 3 models.');
  });

  it.each([
    ['project-model', 'Removed local BYOK provider gateway and switched to project-model.'],
    ['gpt-4o', 'Removed local BYOK provider gateway and switched to gpt-4o.'],
  ])('reports an active-provider switch to %s', (activeModel, expected) => {
    expect(
      providerRemovalMessage({
        ok: true,
        providerId: 'gateway',
        removedModelCount: 3,
        activeModel,
        switched: true,
        inheritedProviderRevealed: false,
      }),
    ).toBe(expected);
  });

  it('reports when an inherited provider is revealed', () => {
    expect(
      providerRemovalMessage({
        ok: true,
        providerId: 'gateway',
        removedModelCount: 3,
        activeModel: 'gateway/inherited',
        switched: false,
        inheritedProviderRevealed: true,
      }),
    ).toBe(
      'Removed the local gateway override; the inherited gateway provider remains configured.',
    );
  });
});

describe('App effort command', () => {
  const submit = async (view: ReturnType<typeof render>, value: string) => {
    view.stdin.write(value);
    await new Promise((resolve) => setTimeout(resolve, 75));
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 75));
  };

  function renderIdle(overrides: Record<string, unknown> = {}) {
    const agentState = {
      ...pendingAgentState(),
      isThinking: false,
      pendingPlanApproval: null,
      ...overrides,
    };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });
    return { agentState, view: render(<App config={config()} session={testSession} />) };
  }

  it('opens a dedicated picker with the current effort highlighted', async () => {
    const liveConfig = {
      ...config(),
      effort: 'high' as const,
      modelInfo: { effort: { levels: ['low', 'medium', 'high'] as const } },
    };
    const { view } = renderIdle({ liveConfig });

    await submit(view, '/effort');
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('Set effort level');
    expect(frame).toContain('❯ high');
    expect(frame).not.toContain('Maximum reasoning depth');
  });

  it('applies direct arguments case-insensitively and reports success', async () => {
    const { agentState, view } = renderIdle();

    await submit(view, '/effort XHIGH');

    expect(agentState.setEffort).toHaveBeenCalledWith('xhigh');
    expect(agentState.addLocalMessage).toHaveBeenCalledWith(
      'Set effort level to xhigh (saved as default).',
    );
  });

  it('shows accepted usage for invalid levels', async () => {
    const { agentState, view } = renderIdle();

    await submit(view, '/effort turbo');

    expect(agentState.setEffort).not.toHaveBeenCalled();
    expect(agentState.addLocalMessage).toHaveBeenCalledWith(
      'Usage: /effort [low|medium|high|xhigh|max]',
    );
  });

  it('does not open for models with effort disabled', async () => {
    const liveConfig = { ...config(), modelInfo: { effort: false as const } };
    const { agentState, view } = renderIdle({ liveConfig });

    await submit(view, '/effort');

    expect(stripAnsi(view.lastFrame())).not.toContain('Set effort level');
    expect(agentState.setEffort).not.toHaveBeenCalled();
    expect(agentState.addLocalMessage).toHaveBeenCalledWith(
      '✕ Model "model-x" does not support configurable effort.',
    );
  });

  it('surfaces selection failures without closing the picker', async () => {
    const setEffort = vi.fn(() => ({ ok: false, error: 'Failed to save effort level: denied' }));
    const { view } = renderIdle({ setEffort });

    await submit(view, '/effort');
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 75));

    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('Set effort level');
    expect(frame).toContain('Failed to save effort level: denied');
  });

  it('dispatches only the exact /effort command', async () => {
    const { agentState, view } = renderIdle();

    await submit(view, '/effortless high');

    expect(agentState.setEffort).not.toHaveBeenCalled();
    expect(agentState.send).toHaveBeenCalledWith('/effortless high');
  });

  it('lists /effort in /help', async () => {
    const { view } = renderIdle();
    await submit(view, '/help');
    expect(view.frames.map(stripAnsi).join('\n')).toContain('/effort [low|medium|high|xhigh|max]');
  });
});

describe('App theme command', () => {
  const submit = async (view: ReturnType<typeof render>, value: string) => {
    view.stdin.write(value);
    await new Promise((resolve) => setTimeout(resolve, 75));
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 75));
  };

  function renderIdle(appConfig = config()) {
    const agentState = {
      ...pendingAgentState(),
      isThinking: false,
      pendingPlanApproval: null,
      liveConfig: appConfig,
    };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });
    return { agentState, view: render(<App config={appConfig} session={testSession} />) };
  }

  it('opens a dedicated picker with the current theme highlighted', async () => {
    const appConfig = config();
    appConfig.settings.theme = 'light';
    const { view } = renderIdle(appConfig);

    await submit(view, '/theme');
    const frame = stripAnsi(view.lastFrame());

    expect(frame).toContain('Choose theme');
    expect(frame).toMatch(/› light\s+Soft parchment/);
    expect(frame).toContain('(current)');
  });

  it('selects and persists a theme from the picker', async () => {
    const { agentState, view } = renderIdle();

    await submit(view, '/theme');
    view.stdin.write('\x1b[B');
    await new Promise((resolve) => setTimeout(resolve, 30));
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(persistSettingLocalMock).toHaveBeenCalledWith('/tmp/book', 'theme', 'light');
    expect(agentState.addLocalMessage).toHaveBeenCalledWith(
      'Switched to light theme (saved as default).',
    );
    expect(stripAnsi(view.lastFrame())).not.toContain('Choose theme');
  });

  it('applies direct arguments and reports auto resolution', async () => {
    vi.stubEnv('COLORFGBG', '0;15');
    const { agentState, view } = renderIdle();

    await submit(view, '/theme AUTO');

    expect(persistSettingLocalMock).toHaveBeenCalledWith('/tmp/book', 'theme', 'auto');
    expect(agentState.addLocalMessage).toHaveBeenCalledWith(
      'Theme set to auto (currently light) and saved as default.',
    );
  });

  it('reports missing themes instead of failing silently', async () => {
    const { agentState, view } = renderIdle();

    await submit(view, '/theme missing-theme');

    expect(persistSettingLocalMock).not.toHaveBeenCalled();
    expect(agentState.addLocalMessage).toHaveBeenCalledWith(
      '✕ Theme "missing-theme" was not found. Choose dark, light, auto, or a theme from .book/themes.',
    );
  });

  it('dispatches only the exact /theme command', async () => {
    const { agentState, view } = renderIdle();

    await submit(view, '/themes light');

    expect(persistSettingLocalMock).not.toHaveBeenCalled();
    expect(agentState.send).toHaveBeenCalledWith('/themes light');
  });
});

describe('App plan approval keyboard ownership', () => {
  it('does not open the model picker while plan approval owns input', () => {
    const agentState = pendingAgentState();
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    expect(stripAnsi(view.lastFrame())).toContain('Plan approval required.');

    view.stdin.write('\x1bp');

    const output = stripAnsi(view.lastFrame());
    expect(output).not.toContain('Models & BYOK providers');
    expect(agentState.resolvePlanApproval).not.toHaveBeenCalled();
  });

  it('does not cycle permission mode while plan approval owns input', () => {
    const agentState = pendingAgentState();
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    view.stdin.write('\x1bm');

    expect(agentState.cycleMode).not.toHaveBeenCalled();
    expect(stripAnsi(view.lastFrame())).toContain('Plan approval required.');
  });

  it('suppresses the input bar while the model picker owns input', () => {
    expect(ownsModalInput(null, null, true)).toBe(true);
    expect(ownsModalInput(null, null, false, false, true)).toBe(true);
    expect(ownsModalInput(null, null, false)).toBe(false);
    expect(ownsModalInput(null, null, false, false, { request: {} })).toBe(true);
    expect(ownsModalInput(null, null, false, false, null, false, true)).toBe(true);
  });
});
