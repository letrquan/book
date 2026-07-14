import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App, ownsModalInput } from './app.js';
import type { AgentConfig } from '../types.js';
import { DEFAULT_SETTINGS } from '../settings.js';

const useAgentMock = vi.fn();
const useTasksMock = vi.fn();
const discoverCommandsMock = vi.fn((_workspace: string) => []);
const discoverSkillsMock = vi.fn((_workspace: string) => []);

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
    cycleMode: vi.fn(),
    addLocalMessage: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
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
    expect(output).not.toContain('Switch model');
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
    expect(ownsModalInput(null, null, false)).toBe(false);
  });
});
