import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './app.js';
import type { AgentConfig } from '../types/runtime.js';
import type { SlashCommand } from '../types/commands.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import type { HostReviewRequest, HostReviewResult } from '../review/host.js';

/**
 * App-level lifecycle of `/review`: it outlives the keystroke that started it
 * by minutes, so the session has to own it — cancel it, route its output, and
 * refuse a second one — rather than fire and forget.
 */

const useAgentMock = vi.fn();
const useTasksMock = vi.fn();
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

/** Captured per call so a test can inspect the signal and drive completion. */
const reviewCalls: Array<{
  request: HostReviewRequest;
  finish: (result?: HostReviewResult) => void;
}> = [];

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
vi.mock('../review/host.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../review/host.js')>();
  return {
    ...actual,
    runHostReview: (request: HostReviewRequest) =>
      new Promise<HostReviewResult>((resolve) => {
        reviewCalls.push({
          request,
          finish: (result) => resolve(result ?? { segments: [] }),
        });
      }),
  };
});

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
    setShowThinking: vi.fn(() => ({ ok: true })),
    setStartupAnimation: vi.fn(() => ({ ok: true })),
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

function startApp(addLocalMessage: ReturnType<typeof vi.fn>, sessionId = 'session-a') {
  useAgentMock.mockReturnValue(agentState(sessionId, addLocalMessage));
  useTasksMock.mockReturnValue({ tasks: [], refresh: vi.fn() });
  return render(<App config={config()} session={session} />);
}

afterEach(() => {
  cleanup();
  reviewCalls.length = 0;
  vi.clearAllMocks();
});

describe('/review lifecycle in the session that started it', () => {
  it('runs the review and shows a cancellable status while it does', async () => {
    const addLocalMessage = vi.fn();
    const view = startApp(addLocalMessage);
    await settle();

    await submit(view, '/review --deep');

    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0]!.request.scope).toMatchObject({ deep: true, fix: false });
    expect(reviewCalls[0]!.request.signal?.aborted).toBe(false);
    const frame = (view.lastFrame() ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    expect(frame).toContain('Esc to cancel');
  });

  it('refuses a second review while one is still running', async () => {
    const addLocalMessage = vi.fn();
    const view = startApp(addLocalMessage);
    await settle();

    await submit(view, '/review');
    await submit(view, '/review');

    expect(reviewCalls).toHaveLength(1);
    expect(addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining('A review is already running'),
    );
  });

  it('cancels the review when the conversation is replaced', async () => {
    const addLocalMessage = vi.fn();
    const view = startApp(addLocalMessage);
    await settle();
    await submit(view, '/review');
    const call = reviewCalls[0]!;
    expect(call.request.signal?.aborted).toBe(false);

    // /new or /resume swaps the session out from under the running review.
    useAgentMock.mockReturnValue(agentState('session-b', addLocalMessage));
    view.rerender(<App config={config()} session={session} />);
    await settle();

    expect(call.request.signal?.aborted).toBe(true);
  });

  it('does not deliver a cancelled review’s output into the new conversation', async () => {
    const addLocalMessage = vi.fn();
    const view = startApp(addLocalMessage);
    await settle();
    await submit(view, '/review');
    const call = reviewCalls[0]!;

    useAgentMock.mockReturnValue(agentState('session-b', addLocalMessage));
    view.rerender(<App config={config()} session={session} />);
    await settle();

    // The pipeline's last segments can still arrive after the switch.
    addLocalMessage.mockClear();
    call.request.onSegment?.('■ Review cancelled. No findings were reported.');
    call.finish();
    await settle();

    expect(addLocalMessage).not.toHaveBeenCalled();
  });

  it('frees the slot once a review finishes', async () => {
    const addLocalMessage = vi.fn();
    const view = startApp(addLocalMessage);
    await settle();
    await submit(view, '/review');

    reviewCalls[0]!.finish({ segments: ['Verdict: clean'] });
    await settle();
    await submit(view, '/review');

    expect(reviewCalls).toHaveLength(2);
  });
});
