import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './app.js';
import type { AgentConfig, BackgroundShellRecord } from '../types/runtime.js';
import type { SlashCommand } from '../types/commands.js';
import { DEFAULT_SETTINGS } from '../settings.js';

/**
 * The transcript row a background shell leaves behind when it finishes. It is
 * the only surface that reports which command ended, and it is written as prose
 * — so the command inside it has to be quoted, not interpolated.
 */

const useAgentMock = vi.fn();
const useTasksMock = vi.fn();
const useBackgroundShellsMock = vi.fn();
const managedAgentManagerMock = {
  list: vi.fn(async () => []),
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
vi.mock('./hooks/useBackgroundShells.js', () => ({
  useBackgroundShells: (...args: unknown[]) => useBackgroundShellsMock(...args),
}));
vi.mock('../commands/loader.js', () => ({
  discoverCommands: (): SlashCommand[] => [],
  resolveCommandBody: vi.fn(),
}));
vi.mock('../skills.js', () => ({ discoverSkills: () => [] }));
vi.mock('../agents/manager.js', () => ({
  getOrCreateAgentManager: () => managedAgentManagerMock,
}));

function config(): AgentConfig {
  return {
    apiKey: 'test-key',
    authInputs: { providerOverride: 'auto' },
    baseUrl: 'http://localhost',
    model: 'model-x',
    maxTurns: 4,
    maxTokens: 128000,
    compactStrategy: 'summary',
    experimentalZeroMem: false,
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

function agentState(addLocalMessage: ReturnType<typeof vi.fn>) {
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
    sessionId: 'session-a',
    sessionName: undefined,
    send: vi.fn(async () => ({ status: 'completed' as const, messages: [] })),
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

function completed(overrides: Partial<BackgroundShellRecord>): BackgroundShellRecord {
  return {
    id: 'bash_1',
    command: 'sleep 1',
    effectiveCommand: 'sleep 1',
    title: 'sleep 1',
    workdir: '/tmp/book',
    status: 'exited',
    output: '',
    readOffset: 0,
    truncatedBytes: 0,
    exitCode: 0,
    startedAt: 0,
    finishedAt: 1,
    ...overrides,
  };
}

async function settle(ms = 90): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function announce(
  record: BackgroundShellRecord | undefined,
): Promise<ReturnType<typeof vi.fn>> {
  const addLocalMessage = vi.fn();
  // One frozen object across renders: `lastCompletion` is an effect dependency,
  // so a fresh record per render would re-announce forever.
  const state = {
    shells: [],
    lastCompletion: record,
    pendingUiCompletions: record ? [record] : [],
    pendingAgentCompletions: [],
    refresh: vi.fn(),
    stopOrDismiss: vi.fn(async () => {}),
    acknowledge: vi.fn(),
    acknowledgeAgentCompletion: vi.fn(),
  };
  useAgentMock.mockReturnValue(agentState(addLocalMessage));
  useTasksMock.mockReturnValue({ tasks: [], refresh: vi.fn() });
  useBackgroundShellsMock.mockReturnValue(state);
  render(<App config={config()} session={session} />);
  await settle();
  return addLocalMessage;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('background shell completion row', () => {
  it('quotes the command so markdown cannot eat part of it', async () => {
    const command = 'node -e "setInterval(()=>{},1000)/*KILLPROBE*/"';
    const addLocalMessage = await announce(completed({ title: command, command }));

    expect(addLocalMessage).toHaveBeenCalledWith(
      `✓ Background shell \`${command}\` exited (exit 0).`,
    );
  });

  it('picks a fence the command cannot close', async () => {
    const command = 'echo `date`';
    const addLocalMessage = await announce(completed({ title: command, command }));

    expect(addLocalMessage).toHaveBeenCalledWith(
      // Padded because the command's own backtick would otherwise fuse with
      // the closing fence; CommonMark strips the padding back out.
      '✓ Background shell `` echo `date` `` exited (exit 0).',
    );
  });

  it('quotes the id when the job has no title', async () => {
    const addLocalMessage = await announce(
      completed({ id: 'bash_7', title: undefined, status: 'failed', exitCode: 1 }),
    );

    expect(addLocalMessage).toHaveBeenCalledWith('✕ Background shell `bash_7` failed (exit 1).');
  });

  it('says nothing while no job has finished', async () => {
    const addLocalMessage = await announce(undefined);

    expect(addLocalMessage).not.toHaveBeenCalled();
  });
});
