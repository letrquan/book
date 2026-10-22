import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './app.js';
import type { AgentConfig } from '../types/runtime.js';
import type { SlashCommand } from '../types/commands.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { READ_ONLY_GIT_ARGS } from '../tools/git.js';

/** `/diff` shows what the `GitDiff` tool would, read the same way. */

const useAgentMock = vi.fn();
const readOnlyGitMock = vi.fn(async (..._args: unknown[]) => ({
  success: true,
  output: 'diff --git a/a.txt b/a.txt\n',
}));
const useTasksMock = vi.fn();
const sendMock = vi.fn(async (..._args: unknown[]) => ({
  status: 'completed' as const,
  messages: [],
}));
const managedAgentManagerMock = {
  list: vi.fn(async () => []),
  listPendingCompletions: vi.fn(async () => []),
  subscribe: vi.fn(() => () => {}),
  setInteractivePermissions: vi.fn(),
  send: vi.fn(),
  spawn: vi.fn(),
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
  discoverCommands: (): SlashCommand[] => [],
  resolveCommandBody: vi.fn(),
}));
vi.mock('../skills.js', () => ({ discoverSkills: () => [] }));
vi.mock('../agents/manager.js', () => ({
  getOrCreateAgentManager: () => managedAgentManagerMock,
}));
vi.mock('../tools/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/git.js')>()),
  readOnlyGit: (...args: unknown[]) => readOnlyGitMock(...args),
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
      },
      ui: { ...DEFAULT_SETTINGS.ui, startupAnimation: false },
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

function agentState(sessionId: string, addLocalMessage: ReturnType<typeof vi.fn>) {
  return {
    messages: [],
    isThinking: false,
    streamingMessageId: null,
    error: null,
    currentTurn: 1,
    tokenCount: 0,
    usage: null,
    mode: 'default',
    pendingPermission: null,
    pendingPlanApproval: null,
    agentTodos: [],
    liveConfig: config(),
    removableProviderIds: new Set<string>(),
    removableProviderModelCounts: new Map<string, number>(),
    sessionId,
    sessionName: undefined,
    send: sendMock,
    clear: vi.fn(),
    startNewConversation: vi.fn(async () => {}),
    resumeConversation: vi.fn(async () => {}),
    listSessions: vi.fn(() => []),
    endCurrentSession: vi.fn(),
    resolvePermission: vi.fn(),
    resolvePlanApproval: vi.fn(),
    cancel: vi.fn(),
    compact: vi.fn(),
    isCompacting: false,
    isRewinding: false,
    rewind: vi.fn(async () => ({ ok: true })),
    getRewindTargets: vi.fn(() => []),
    compactUi: null,
    setCompactUi: vi.fn(),
    cycleMode: vi.fn(),
    addLocalMessage,
    startHostRun: vi.fn(() => ({ rootRunId: 'root', runId: 'run' })),
    setModel: vi.fn(),
    upsertProviderAndSelect: vi.fn(() => ({ ok: true })),
    removeProvider: vi.fn(() => ({ ok: false, error: 'not local' })),
    setEffort: vi.fn(() => ({ ok: true })),
    setAgentProfileModel: vi.fn(() => ({ ok: true })),
    setCompactModel: vi.fn(() => ({ ok: true })),
    setMemoryAutoSave: vi.fn(),
    toggleShowThinking: vi.fn(() => ({ ok: true })),
    toggleStartupAnimation: vi.fn(() => ({ ok: true })),
    toggleMemoryAutoSave: vi.fn(() => ({ ok: true })),
    refreshMemoryContext: vi.fn(),
    turnDurationMs: 0,
    retryPhase: 'none',
    retryAttempt: 0,
    retryMax: 0,
    retryCountdownMs: 0,
  };
}

const session = {
  sessionId: 'session-a',
  history: [],
  source: 'startup' as const,
  persisted: false,
  created: true,
};

async function settle(ms = 90): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function submit(view: ReturnType<typeof render>, value: string): Promise<void> {
  view.stdin.write(value);
  await settle(75);
  view.stdin.write('\r');
  await settle(75);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('/diff', () => {
  it('reads the diff the way GitDiff does, in the workspace', async () => {
    const addLocalMessage = vi.fn();
    useAgentMock.mockReturnValue(agentState('session-a', addLocalMessage));
    useTasksMock.mockReturnValue({ tasks: [], refresh: vi.fn() });
    const view = render(<App config={config()} session={session} />);
    await settle();

    await submit(view, '/diff');

    expect(readOnlyGitMock).toHaveBeenCalledTimes(1);
    const [args, ctx, options] = readOnlyGitMock.mock.calls[0]!;
    expect(args).toEqual(READ_ONLY_GIT_ARGS.GitDiff);
    expect(ctx).toMatchObject({ workspaceRoot: '/tmp/book' });
    // A command the user typed keeps lazy fetch, as the tool does.
    expect(options).toBeUndefined();
    expect(addLocalMessage).toHaveBeenCalledWith('diff --git a/a.txt b/a.txt');
  });

  it('says so when there is nothing to show', async () => {
    readOnlyGitMock.mockResolvedValueOnce({ success: true, output: '(no output)' });
    const addLocalMessage = vi.fn();
    useAgentMock.mockReturnValue(agentState('session-a', addLocalMessage));
    useTasksMock.mockReturnValue({ tasks: [], refresh: vi.fn() });
    const view = render(<App config={config()} session={session} />);
    await settle();

    await submit(view, '/diff');

    expect(addLocalMessage).toHaveBeenCalledWith('(no changes)');
  });
});
