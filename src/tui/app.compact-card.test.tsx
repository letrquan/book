import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './app.js';
import type { CompactUiState } from './hooks/useAgent.js';
import type { AgentConfig } from '../types/runtime.js';
import type { AgentRecord } from '../agents/types.js';
import { DEFAULT_SETTINGS } from '../settings.js';

const useAgentMock = vi.fn();
const useTasksMock = vi.fn();
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

vi.mock('../agents/manager.js', () => ({
  getOrCreateAgentManager: () => managedAgentManagerMock,
}));

function config(accessibility: { screenReader: boolean; reducedMotion: boolean }): AgentConfig {
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
    accessibility,
    settings: {
      ...DEFAULT_SETTINGS,
      model: 'model-x',
      maxTurns: 4,
      maxTokens: 128000,
      autoCompactEnabled: true,
      defaultMode: 'default',
      memory: { ...DEFAULT_SETTINGS.memory, enabled: false, autoSave: false },
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
  source: 'resume' as const,
  persisted: false,
  created: false,
};

function agentState(
  compactUi: CompactUiState | null,
  appConfig: AgentConfig,
  compaction: { isCompacting?: boolean; isCompactCommitted?: boolean } = {},
) {
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
    liveConfig: appConfig,
    removableProviderIds: new Set<string>(),
    removableProviderModelCounts: new Map<string, number>(),
    sessionId: 'session-test',
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
    isCompacting: compaction.isCompacting ?? false,
    isCompactCommitted: compaction.isCompactCommitted ?? false,
    isRewinding: false,
    rewind: vi.fn(async () => ({ ok: true })),
    getRewindTargets: vi.fn(() => []),
    compactUi,
    cycleMode: vi.fn(),
    addLocalMessage: vi.fn(),
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

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

const motionConfig = config({ screenReader: false, reducedMotion: false });

function mount(
  compactUi: CompactUiState | null,
  compaction?: { isCompacting?: boolean; isCompactCommitted?: boolean },
) {
  useAgentMock.mockReturnValue(agentState(compactUi, motionConfig, compaction));
  return render(<App config={motionConfig} session={testSession} />);
}

beforeEach(() => {
  useTasksMock.mockReturnValue({
    tasks: [],
    addTask: vi.fn(),
    updateTaskStatus: vi.fn(),
    removeTask: vi.fn(),
    clearTasks: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('App compaction footer', () => {
  it('shows nothing for a finished compaction, with or without a warning', () => {
    // A successful compaction leaves no card state at all: its row is in the transcript.
    const view = mount(null, { isCompacting: false, isCompactCommitted: true });

    const frame = stripAnsi(view.lastFrame());
    expect(frame).not.toContain('Compact conversation');
    expect(frame).not.toContain('Compacted');
    expect(frame).not.toContain('100%');
  });

  it('shows the running bar while compacting', () => {
    const view = mount(
      { phase: 'working', trigger: 'auto' },
      { isCompacting: true, isCompactCommitted: false },
    );

    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('Auto-compacting');
    expect(frame).toContain('%');
  });

  it('drops the bar once a committed compaction has finished', () => {
    const view = mount({ phase: 'working', trigger: 'manual' }, { isCompacting: true });
    expect(stripAnsi(view.lastFrame())).toContain('Compacting');

    useAgentMock.mockReturnValue(
      agentState(null, motionConfig, { isCompacting: false, isCompactCommitted: true }),
    );
    view.rerender(<App config={motionConfig} session={testSession} />);

    const frame = stripAnsi(view.lastFrame());
    expect(frame).not.toContain('Compact');
    expect(frame).not.toContain('100%');
  });

  it.each([
    ['error', { phase: 'error', message: 'Compaction failed: boom' }],
    ['skipped', { phase: 'skipped', message: 'Compaction blocked by PreCompact hook.' }],
  ] as const)('keeps a %s card up', async (_name, card) => {
    const view = mount({ trigger: 'auto', ...card });

    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(stripAnsi(view.lastFrame())).toContain(card.message);
  });
});
