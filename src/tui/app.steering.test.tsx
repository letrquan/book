import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './app.js';
import type { AgentConfig } from '../types/runtime.js';
import type { SlashCommand } from '../types/commands.js';
import type { QueuedInput } from './queued-inputs.js';
import { DEFAULT_SETTINGS } from '../settings.js';

/**
 * Steering from the app (#661): Enter on a plain prompt while the main agent runs hands the words
 * to the running turn, Tab queues them for the end of the run, and the two queues the composer
 * can recall from (waiting steers, follow-ups) keep their order when the run is interrupted or
 * ends.
 */

const useAgentMock = vi.fn();
const useTasksMock = vi.fn();
const discoverCommandsMock = vi.fn((_workspace: string): SlashCommand[] => []);
const discoverSkillsMock = vi.fn((_workspace: string) => []);
const persistSettingLocalMock = vi.fn((_workspace: string, _key: string, _value: unknown) => ({
  ok: true,
}));
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

vi.mock('../commands/loader.js', () => ({
  discoverCommands: (workspace: string) => discoverCommandsMock(workspace),
  resolveCommandBody: vi.fn(),
}));

vi.mock('../skills.js', () => ({
  discoverSkills: (workspace: string) => discoverSkillsMock(workspace),
}));

vi.mock('../input/clipboard-image.js', () => ({
  readClipboardImage: vi.fn(),
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
  sessionId: 'session-steer',
  history: [],
  source: 'startup' as const,
  persisted: false,
  created: true,
};

function steerItem(id: string, value: string, createdAt: number): QueuedInput {
  return { id, sessionId: testSession.sessionId, value, createdAt };
}

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
    steer: vi.fn(async () => 'steered' as const),
    canSteer: false,
    pendingSteers: [] as QueuedInput[],
    recallSteer: vi.fn(() => undefined),
    takeSteers: vi.fn(() => [] as QueuedInput[]),
    dropSteers: vi.fn(),
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

const realSetTimeout = globalThis.setTimeout;

async function waitUntil(check: () => void, timeoutMs = 3_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (performance.now() > deadline) throw error;
    }
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
}

async function waitForFrame(view: ReturnType<typeof render>, text: string): Promise<void> {
  await waitUntil(() => expect(frameOf(view)).toContain(text));
}

async function inputReady(view: ReturnType<typeof render>): Promise<void> {
  await waitUntil(() => expect(view.stdin.listenerCount('readable')).toBeGreaterThan(0));
}

let settleApp: () => void = () => {};

function press(view: ReturnType<typeof render>, keys: string): void {
  settleApp();
  view.stdin.write(keys);
}

async function startApp(overrides: Record<string, unknown> = {}) {
  const state = agentState(overrides);
  useAgentMock.mockReturnValue(state);
  useTasksMock.mockReturnValue({
    tasks: [],
    addTask: vi.fn(),
    updateTaskStatus: vi.fn(),
    removeTask: vi.fn(),
    clearTasks: vi.fn(),
  });
  const appConfig = config();
  const view = render(<App config={appConfig} session={testSession} />);
  settleApp = () => view.rerender(<App config={appConfig} session={testSession} />);
  await inputReady(view);
  const rerenderWith = (changes: Record<string, unknown>) => {
    useAgentMock.mockReturnValue({ ...state, ...changes });
    view.rerender(<App config={appConfig} session={testSession} />);
  };
  return { view, state, rerenderWith };
}

afterEach(() => {
  cleanup();
  settleApp = () => {};
  vi.clearAllMocks();
});

describe('steering from the composer', () => {
  it('sends Enter to the running turn instead of the queue', async () => {
    const { view, state } = await startApp({ isThinking: true, canSteer: true });

    press(view, 'use the other branch');
    await waitForFrame(view, '> use the other branch');
    press(view, '\r');

    await waitUntil(() =>
      expect(state.steer).toHaveBeenCalledWith('use the other branch', undefined),
    );
    expect(state.send).not.toHaveBeenCalled();
    await waitUntil(() => expect(frameOf(view)).not.toContain('> use the other branch'));
    expect(frameOf(view)).not.toContain('Queued for when this run ends');
  });

  it('queues Tab while the turn is running, which is where Enter used to put a prompt', async () => {
    const { view, state } = await startApp({ isThinking: true, canSteer: true });

    press(view, 'after you finish');
    await waitForFrame(view, '> after you finish');
    press(view, '\t');

    await waitForFrame(view, 'Queued for when this run ends (1)');
    expect(frameOf(view)).toContain('after you finish');
    expect(state.steer).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
  });

  it('queues rather than steers a slash command', async () => {
    const { view, state } = await startApp({ isThinking: true, canSteer: true });

    press(view, '/diff');
    await waitForFrame(view, '> /diff');
    press(view, '\r');

    // A slash command is not the user's words to the model, so no steer is attempted and the
    // composer keeps the draft (the busy rules refuse it), instead of silently dropping it.
    await new Promise((resolve) => realSetTimeout(resolve, 60));
    expect(state.steer).not.toHaveBeenCalled();
    expect(frameOf(view)).toContain('/diff');
  });

  it('queues a `!` shell line instead of steering it, as Enter did before #661', async () => {
    const { view, state } = await startApp({ isThinking: true, canSteer: true });

    press(view, '!ls');
    await waitForFrame(view, '> !ls');
    press(view, '\r');

    await waitForFrame(view, 'Queued for when this run ends (1)');
    expect(frameOf(view)).toContain('!ls');
    expect(state.steer).not.toHaveBeenCalled();
  });
});

describe('the two queues when a run ends', () => {
  it('restores waiting steers ahead of queued follow-ups on interrupt', async () => {
    const waiting = [
      steerItem('steer-1', 'steered first', 2),
      steerItem('steer-2', 'steered second', 3),
    ];
    const { view, state } = await startApp({
      isThinking: true,
      canSteer: true,
      pendingSteers: waiting,
      takeSteers: vi.fn(() => waiting),
    });

    // Two follow-ups queued with Tab, then Esc: the steers go in first, in order, then the
    // follow-ups, then whatever the user had started typing.
    press(view, 'queued one');
    await waitForFrame(view, '> queued one');
    press(view, '\t');
    await waitForFrame(view, 'Queued for when this run ends (1)');
    press(view, 'queued two');
    await waitForFrame(view, '> queued two');
    press(view, '\t');
    await waitForFrame(view, 'Queued for when this run ends (2)');
    press(view, 'live draft');
    await waitForFrame(view, '> live draft');

    press(view, '\x1b');
    await waitUntil(() => expect(state.cancel).toHaveBeenCalled());
    await waitForFrame(view, 'steered second');

    const frame = frameOf(view);
    expect(frame.indexOf('steered first')).toBeLessThan(frame.indexOf('steered second'));
    expect(frame.indexOf('steered second')).toBeLessThan(frame.indexOf('queued one'));
    expect(frame.indexOf('queued one')).toBeLessThan(frame.indexOf('queued two'));
    expect(frame.indexOf('queued two')).toBeLessThan(frame.indexOf('live draft'));
  });

  it('appends a steer the abort handed back to the restored draft, not over it', async () => {
    // The loop takes a steer, the run is cancelled before it is appended, and the loop requeues
    // it: it reaches the host only when the send settles, after Esc has already put the other
    // words back. Both must survive.
    const handedBack = [steerItem('steer-taken', 'taken by the loop', 1)];
    let settle: (result: unknown) => void = () => {};
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const { view, rerenderWith } = await startApp({ send });
    press(view, 'first prompt');
    await waitForFrame(view, '> first prompt');
    press(view, '\r');
    await waitUntil(() => expect(send).toHaveBeenCalled());
    // The run is going: the send has not returned, and the composer queues behind it.
    rerenderWith({ send, isThinking: true });

    press(view, 'queued one');
    await waitForFrame(view, '> queued one');
    press(view, '\t');
    await waitForFrame(view, 'Queued for when this run ends (1)');
    press(view, 'live draft');
    await waitForFrame(view, '> live draft');

    press(view, '\x1b');
    await waitForFrame(view, 'Queued inputs restored to the composer after interrupt.');

    settle({ status: 'cancelled', messages: [], pendingSteers: handedBack });
    await waitForFrame(view, 'taken by the loop');

    const frame = frameOf(view);
    expect(frame.indexOf('taken by the loop')).toBeLessThan(frame.indexOf('queued one'));
    expect(frame.indexOf('queued one')).toBeLessThan(frame.indexOf('live draft'));
  });

  it('puts steers the run never delivered at the front of the queue', async () => {
    const late = [steerItem('steer-late', 'late report', 2)];
    const send = vi.fn(async () => ({
      status: 'completed' as const,
      messages: [],
      pendingSteers: late,
    }));
    const { view, state } = await startApp({ send });

    press(view, 'first prompt');
    await waitForFrame(view, '> first prompt');
    press(view, '\r');

    // The run ended without delivering the steer, so it is sent next as its own run.
    await waitUntil(() => expect(state.send).toHaveBeenCalledWith('late report'));
    expect(state.send).toHaveBeenCalledTimes(2);
  });

  it('recalls a waiting steer with Up so it can be edited', async () => {
    const waiting = [steerItem('steer-1', 'change of plan', 2)];
    const { view, rerenderWith } = await startApp({
      isThinking: true,
      canSteer: true,
      pendingSteers: waiting,
    });
    rerenderWith({
      isThinking: true,
      canSteer: true,
      pendingSteers: waiting,
      recallSteer: vi.fn(() => waiting[0]),
    });

    press(view, '\x1b[A');
    await waitForFrame(view, '> change of plan');
    await waitForFrame(view, 'Editing a message sent during the run');
  });

  it('leaves the follow-up queue alone when Up recalls a steer', async () => {
    const waiting = [steerItem('steer-1', 'change of plan', 2)];
    const { view, rerenderWith } = await startApp({ isThinking: true, canSteer: true });

    press(view, 'queued behind the run');
    await waitForFrame(view, '> queued behind the run');
    press(view, '\t');
    await waitForFrame(view, 'Queued for when this run ends (1)');

    rerenderWith({
      isThinking: true,
      canSteer: true,
      pendingSteers: waiting,
      recallSteer: vi.fn(() => waiting[0]),
    });
    press(view, '\x1b[A');

    // The steer is the more urgent one, so it is what the composer gets; the follow-up is still
    // where it was, waiting for the run to end.
    await waitForFrame(view, '> change of plan');
    expect(frameOf(view)).toContain('Queued for when this run ends (1)');
    expect(frameOf(view)).toContain('queued behind the run');
  });
});
