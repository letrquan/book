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

// Set by the crash-screen test: the transcript throws on render, so the error boundary's
// screen takes over the way a real render crash does.
const crashTranscript = vi.hoisted(() => ({ current: false }));

vi.mock('./components/TranscriptView.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./components/TranscriptView.js')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    TranscriptView: (props: Parameters<typeof actual.TranscriptView>[0]) => {
      if (crashTranscript.current) throw new Error('render blew up');
      return createElement(actual.TranscriptView, props);
    },
  };
});

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

// Every wait below polls for the state it needs; a fixed settle is a guess about how long a
// render takes, and a loaded runner loses that guess (the ByokWizard flake). The poller keeps
// the real timer captured here, so a test that fakes the clock never advances it by polling.
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

async function waitForFrameWithout(view: ReturnType<typeof render>, text: string): Promise<void> {
  await waitUntil(() => expect(frameOf(view)).not.toContain(text));
}

/**
 * Ink attaches its stdin listener from an effect, after the first frame is on screen, so a key
 * written before that is dropped. Wait for the listener rather than for a frame.
 */
async function inputReady(view: ReturnType<typeof render>): Promise<void> {
  await waitUntil(() => expect(view.stdin.listenerCount('readable')).toBeGreaterThan(0));
}

/**
 * Fakes the exit window's clock (its hint timer and Date.now), so the window cannot run out on
 * its own while a test waits for something else to end it. Call it before the arming press.
 */
function freezeExitWindow(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
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

/**
 * A commit barrier for the app under test: re-render it with the agent state already installed.
 * A legacy-root re-render flushes the effects still pending from earlier commits before it
 * renders, so every input handler Ink holds is the current render's once it returns.
 */
let settleApp: () => void = () => {};

/**
 * Press keys once the app has settled. A frame on screen does not mean Ink's handlers have
 * caught up with it (effects that run later re-subscribe them), so a key sent the moment a wait
 * sees a frame could reach the previous render's handler. Only the tests about that race write
 * to stdin directly.
 */
function press(view: ReturnType<typeof render>, keys: string): void {
  settleApp();
  view.stdin.write(keys);
}

async function startIdleApp(overrides: Record<string, unknown> = {}, appConfig = config()) {
  const state = agentState(overrides);
  installAgentState(state);
  const view = render(<App config={appConfig} session={testSession} />);
  settleApp = () => view.rerender(<App config={appConfig} session={testSession} />);
  await inputReady(view);
  /** Re-render with a changed agent state; the render commits before this returns. */
  const rerenderWith = (changes: Record<string, unknown>) => {
    installAgentState({ ...state, ...changes });
    view.rerender(<App config={appConfig} session={testSession} />);
  };
  return { view, state, rerenderWith };
}

function startupFireConfig(): AgentConfig {
  const fireConfig = config();
  fireConfig.accessibility = { screenReader: false, reducedMotion: false };
  return fireConfig;
}

/** Press Ctrl+C and wait for the exit hint it arms. */
async function armExit(view: ReturnType<typeof render>): Promise<void> {
  press(view, '\x03');
  await waitForFrame(view, CTRL_C_EXIT_HINT_TEXT);
}

/** Queue each text as a follow-up while a turn runs, then recall the newest with Up. */
async function queueAndRecallNewest(view: ReturnType<typeof render>, texts: string[]) {
  for (const [index, text] of texts.entries()) {
    press(view, text);
    await waitForFrame(view, `> ${text}`);
    press(view, '\r');
    await waitForFrame(view, `Queued follow-up inputs (${index + 1})`);
  }
  press(view, '\x1b[A');
  await waitForFrame(view, 'Editing queued input');
}

afterEach(() => {
  cleanup();
  settleApp = () => {};
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('idle Ctrl+C exit confirmation', () => {
  it('first press shows the "press again to exit" hint and keeps the app running', async () => {
    const { view, state } = await startIdleApp();

    await armExit(view);

    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('a second press within the window exits', async () => {
    const { view, state } = await startIdleApp();

    await armExit(view);
    press(view, '\x03');

    await waitUntil(() => expect(state.endCurrentSession).toHaveBeenCalledWith('exit'));
  });

  it('a press after the window has expired shows the hint again instead of exiting', async () => {
    const { view, state } = await startIdleApp();
    freezeExitWindow();

    await armExit(view);
    vi.advanceTimersByTime(CTRL_C_EXIT_HINT_MS + 1);
    await waitForFrameWithout(view, CTRL_C_EXIT_HINT_TEXT);
    expect(state.endCurrentSession).not.toHaveBeenCalled();

    await armExit(view);

    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('a non-empty composer is cleared instead of arming the exit window', async () => {
    const { view, state } = await startIdleApp();

    press(view, 'unsent draft');
    await waitForFrame(view, 'unsent draft');

    press(view, '\x03');
    await waitForFrameWithout(view, 'unsent draft');

    expect(frameOf(view)).not.toContain(CTRL_C_EXIT_HINT_TEXT);
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('mid-turn Ctrl+C still cancels the turn instead of arming the exit window', async () => {
    const { view, state, rerenderWith } = await startIdleApp({ isThinking: true });

    press(view, '\x03');
    await waitUntil(() => expect(state.cancel).toHaveBeenCalledTimes(1));
    rerenderWith({ isThinking: true });

    expect(frameOf(view)).not.toContain(CTRL_C_EXIT_HINT_TEXT);
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('requires two presses from the startup-fire splash', async () => {
    const fireConfig = startupFireConfig();
    const { view, state } = await startIdleApp({ liveConfig: fireConfig }, fireConfig);

    await armExit(view);
    expect(state.endCurrentSession).not.toHaveBeenCalled();

    press(view, '\x03');

    await waitUntil(() => expect(state.endCurrentSession).toHaveBeenCalledWith('exit'));
  });

  it('exits on the second press when a modal is waiting behind the startup-fire splash', async () => {
    const fireConfig = startupFireConfig();
    const { view, state } = await startIdleApp(
      {
        liveConfig: fireConfig,
        pendingPermission: {
          toolCall: { id: 'call-1', name: 'Bash', arguments: { command: 'ls' } },
        },
      },
      fireConfig,
    );

    await armExit(view);
    expect(state.endCurrentSession).not.toHaveBeenCalled();

    press(view, '\x03');

    await waitUntil(() => expect(state.endCurrentSession).toHaveBeenCalledWith('exit'));
  });

  it('keeps Ctrl+C a no-op in a modal once the exit window is not armed', async () => {
    const pendingPermission = {
      toolCall: { id: 'call-1', name: 'Bash', arguments: { command: 'ls' } },
    };
    const { view, state, rerenderWith } = await startIdleApp({ pendingPermission });

    press(view, '\x03');
    press(view, '\x03');
    // Useful as a barrier: a legacy-root re-render commits every update already queued.
    rerenderWith({ pendingPermission });

    expect(state.endCurrentSession).not.toHaveBeenCalled();
    expect(frameOf(view)).not.toContain(CTRL_C_EXIT_HINT_TEXT);
  });

  it('Ctrl+C on a recalled queued input removes it and lets the queue drain', async () => {
    const { view, state, rerenderWith } = await startIdleApp({ isThinking: true });
    await queueAndRecallNewest(view, ['first queued', 'second queued']);

    rerenderWith({ isThinking: false });
    expect(state.send).not.toHaveBeenCalled();

    press(view, '\x03');
    await waitForFrameWithout(view, 'Editing queued input');

    await waitUntil(() => expect(state.send).toHaveBeenCalledWith('first queued'));
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('a turn that starts inside the exit window disarms it', async () => {
    const { view, state, rerenderWith } = await startIdleApp();
    freezeExitWindow();

    await armExit(view);
    rerenderWith({ isThinking: true });
    await waitForFrameWithout(view, CTRL_C_EXIT_HINT_TEXT);
    rerenderWith({ isThinking: false });

    await armExit(view);
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it.each(['isCompacting', 'isRewinding'])(
    'the exit window is disarmed when %s starts, and one press while it runs only arms it',
    async (flag) => {
      const { view, state, rerenderWith } = await startIdleApp();
      freezeExitWindow();

      await armExit(view);
      rerenderWith({ [flag]: true });
      await waitForFrameWithout(view, CTRL_C_EXIT_HINT_TEXT);

      await armExit(view);
      expect(state.endCurrentSession).not.toHaveBeenCalled();
    },
  );

  it('the exit window is disarmed when command resolution starts', async () => {
    discoverCommandsMock.mockReturnValueOnce([
      { name: 'slow', description: 'Slow command', body: '!`slow command`', source: 'project' },
    ]);
    let failResolution: (error: Error) => void = () => {};
    resolveCommandBodyMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failResolution = reject;
        }),
    );
    const { view, state } = await startIdleApp();
    freezeExitWindow();

    await armExit(view);
    press(view, '/slow');
    await waitForFrame(view, '> /slow');
    press(view, '\r');
    await waitForFrame(view, 'Resolving command shell expansions...');
    await waitForFrameWithout(view, CTRL_C_EXIT_HINT_TEXT);

    failResolution(new Error('shell expansion failed'));
    await waitForFrameWithout(view, 'Resolving command shell expansions...');

    await armExit(view);
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('ignores presses once the exit has started, and exits when SessionEnd finishes', async () => {
    let finishSessionEnd: () => void = () => {};
    // The first call is a slow SessionEnd hook. Book's session-end guard returns at once for a
    // session that is already ending, which is what any later call would get.
    const endCurrentSession = vi
      .fn<(reason: string) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishSessionEnd = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const { view, rerenderWith } = await startIdleApp({ endCurrentSession });
    managedAgentManagerMock.setInteractivePermissions.mockClear();

    await armExit(view);
    press(view, '\x03');
    await waitUntil(() => expect(endCurrentSession).toHaveBeenCalledTimes(1));
    await waitForFrameWithout(view, CTRL_C_EXIT_HINT_TEXT);

    // Presses 3 and 4 land while SessionEnd is still running.
    press(view, '\x03');
    rerenderWith({ endCurrentSession });
    expect(frameOf(view)).not.toContain(CTRL_C_EXIT_HINT_TEXT);
    press(view, '\x03');
    expect(endCurrentSession).toHaveBeenCalledTimes(1);
    expect(managedAgentManagerMock.setInteractivePermissions).not.toHaveBeenCalledWith(false);

    finishSessionEnd();

    // Unmounting drops the managed-agent subscription, which turns its prompts off.
    await waitUntil(() =>
      expect(managedAgentManagerMock.setInteractivePermissions).toHaveBeenCalledWith(false),
    );
    expect(endCurrentSession).toHaveBeenCalledTimes(1);
  });

  it('a recalled queued input replaced by a slash command no longer claims Ctrl+C', async () => {
    const { view, state, rerenderWith } = await startIdleApp({ isThinking: true });
    await queueAndRecallNewest(view, ['queued follow-up']);
    rerenderWith({ isThinking: false });

    press(view, '\x15');
    await waitForFrameWithout(view, '> queued follow-up');
    press(view, '/status');
    await waitForFrame(view, '> /status');
    press(view, '\r');
    await waitForFrame(view, '§ Session');

    expect(frameOf(view)).not.toContain('Editing queued input');
    await armExit(view);
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  it('a slash command that replaces the recalled input leaves the rest of the queue paused', async () => {
    const { view, state, rerenderWith } = await startIdleApp({ isThinking: true });
    await queueAndRecallNewest(view, ['first queued', 'second queued']);
    rerenderWith({ isThinking: false });

    press(view, '\x15');
    await waitForFrameWithout(view, '> second queued');
    press(view, '/status');
    await waitForFrame(view, '> /status');
    press(view, '\r');
    await waitForFrame(view, '§ Session');
    await waitForFrame(view, 'Queue paused');
    rerenderWith({ isThinking: false });

    expect(frameOf(view)).not.toContain('Editing queued input');
    expect(state.send).not.toHaveBeenCalled();

    // What the notice says resumes it: Up recalls the input, Enter sends it.
    press(view, '\x1b[A');
    await waitForFrame(view, '> first queued');
    press(view, '\r');
    await waitUntil(() => expect(state.send).toHaveBeenCalledWith('first queued'));
  });

  it('a recalled input resubmitted as plain text goes back behind the inputs queued before it', async () => {
    const { view, state, rerenderWith } = await startIdleApp({ isThinking: true });
    await queueAndRecallNewest(view, ['first queued', 'second queued']);
    press(view, ' edited');
    await waitForFrame(view, '> second queued edited');
    rerenderWith({ isThinking: false });

    press(view, '\r');

    await waitUntil(() => expect(state.send).toHaveBeenCalledTimes(2));
    expect(state.send.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'first queued',
      'second queued edited',
    ]);
  });

  it('dispatches nothing once /exit has started, from the queue or the composer', async () => {
    const endCurrentSession = vi
      .fn<(reason: string) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockResolvedValue(undefined);
    const { view, state, rerenderWith } = await startIdleApp({
      isThinking: true,
      endCurrentSession,
    });
    await queueAndRecallNewest(view, ['first queued', 'second queued', 'third queued']);
    rerenderWith({ isThinking: false, endCurrentSession });

    press(view, '\x15');
    await waitForFrameWithout(view, '> third queued');
    press(view, '/exit');
    await waitForFrame(view, '> /exit');
    press(view, '\r');
    await waitUntil(() => expect(endCurrentSession).toHaveBeenCalledWith('exit'));
    rerenderWith({ isThinking: false, endCurrentSession });
    expect(state.send).not.toHaveBeenCalled();

    // While SessionEnd runs: a recalled input resubmitted, then another removed with Esc,
    // which would otherwise resume the queue.
    press(view, '\x1b[A');
    await waitForFrame(view, '> second queued');
    press(view, '\r');
    press(view, '\x1b');
    await waitForFrame(view, 'Queued input removed.');
    rerenderWith({ isThinking: false, endCurrentSession });

    expect(state.send).not.toHaveBeenCalled();
    expect(endCurrentSession).toHaveBeenCalledTimes(1);
  });

  it('the crash screen exits through the same latch', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    crashTranscript.current = true;
    try {
      const endCurrentSession = vi
        .fn<(reason: string) => Promise<void>>()
        .mockImplementationOnce(() => new Promise<void>(() => {}))
        .mockResolvedValue(undefined);
      const { view } = await startIdleApp({ endCurrentSession });
      await waitForFrame(view, 'Something went wrong');

      press(view, '\x03');
      await waitUntil(() => expect(endCurrentSession).toHaveBeenCalledTimes(1));
      press(view, '\x03');
      press(view, '\x03');

      expect(endCurrentSession).toHaveBeenCalledTimes(1);
    } finally {
      crashTranscript.current = false;
      consoleError.mockRestore();
    }
  });

  // The CI flake (#257): on a slow runner the render after Enter outlasted the poll interval, so
  // the poll saw the new frame before the effects that re-subscribe Ink's input handlers had
  // run, and Up reached the previous render's handler, which still held the typed text.
  it('Up recalls a queued input as soon as the Enter that queued it has rendered', async () => {
    const { view } = await startIdleApp({ isThinking: true });
    press(view, 'first queued');
    await waitForFrame(view, '> first queued');
    press(view, '\r');
    await waitForFrame(view, 'Queued follow-up inputs (1)');
    press(view, 'second queued');
    await waitForFrame(view, '> second queued');

    view.stdin.write('\r');
    // Step one check-phase task at a time: the render commits in one, and the effects it
    // schedules run in a later one, so Up lands between them, as the slow runner's poll did.
    for (let turn = 0; turn < 100 && !frameOf(view).includes('inputs (2)'); turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(frameOf(view)).toContain('Queued follow-up inputs (2)');
    view.stdin.write('\x1b[A');

    await waitForFrame(view, 'Editing queued input');
    expect(frameOf(view)).toContain('> second queued');
  });

  // The same race with no render in between: keys typed while the event loop is busy (a
  // streaming turn, when queueing happens) arrive in one read, and Ink hands every key in it
  // to the same handler.
  it('Up in the same read as the Enter that queued the input still recalls it', async () => {
    const { view } = await startIdleApp({ isThinking: true });
    press(view, 'first queued');
    await waitForFrame(view, '> first queued');
    press(view, '\r');
    await waitForFrame(view, 'Queued follow-up inputs (1)');
    press(view, 'second queued');
    await waitForFrame(view, '> second queued');

    view.stdin.write('\r\x1b[A');

    await waitForFrame(view, 'Editing queued input');
    expect(frameOf(view)).toContain('> second queued');
  });

  /**
   * Type a draft and step the event loop one check-phase task at a time until it renders, so the
   * next key lands after the commit and before the effects that follow it, as on a slow runner.
   */
  async function typeDraftUntilRendered(view: ReturnType<typeof render>, text: string) {
    view.stdin.write(text);
    for (let turn = 0; turn < 100 && !frameOf(view).includes(`> ${text}`); turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(frameOf(view)).toContain(`> ${text}`);
  }

  // The second CI flake (#257): the app decided what Ctrl+C does from a draft the composer only
  // reported from an effect, so a press between the render and that effect saw an empty
  // composer, armed the exit, and the composer wrote its stale empty value back over the draft.
  it('Ctrl+C right after a draft renders clears it instead of arming the exit window', async () => {
    const { view, state, rerenderWith } = await startIdleApp();
    await typeDraftUntilRendered(view, 'unsent draft');

    view.stdin.write('\x03');
    await waitForFrameWithout(view, '> unsent draft');
    rerenderWith({});

    expect(frameOf(view)).not.toContain(CTRL_C_EXIT_HINT_TEXT);
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });

  // The same stale write-back after the shortcuts the composer forwards to the app.
  it.each([
    ['Alt+M', '\x1bm'],
    ['Ctrl+E', '\x05'],
  ])('%s right after a draft renders keeps the draft', async (_name, sequence) => {
    const { view, rerenderWith } = await startIdleApp();
    await typeDraftUntilRendered(view, 'kept draft');

    view.stdin.write(sequence);
    for (let turn = 0; turn < 20; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    rerenderWith({});

    expect(frameOf(view)).toContain('> kept draft');
  });

  // The third CI flake (#257): Ctrl+C sent as soon as the "Resolving" line left the frame reached
  // the handler from the render before, which still saw the resolution running and cancelled it
  // instead of arming the exit window.
  it('Ctrl+C right after command resolution ends arms the exit window', async () => {
    discoverCommandsMock.mockReturnValueOnce([
      { name: 'slow', description: 'Slow command', body: '!`slow command`', source: 'project' },
    ]);
    let failResolution: (error: Error) => void = () => {};
    resolveCommandBodyMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failResolution = reject;
        }),
    );
    const { view, state } = await startIdleApp();
    press(view, '/slow');
    await waitForFrame(view, '> /slow');
    press(view, '\r');
    await waitForFrame(view, 'Resolving command shell expansions...');

    failResolution(new Error('shell expansion failed'));
    // One check-phase task at a time: the key lands after the commit that dropped the line and
    // before the effects that follow it.
    for (
      let turn = 0;
      turn < 100 && frameOf(view).includes('Resolving command shell expansions...');
      turn++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(frameOf(view)).not.toContain('Resolving command shell expansions...');
    view.stdin.write('\x03');

    await waitForFrame(view, CTRL_C_EXIT_HINT_TEXT);
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.endCurrentSession).not.toHaveBeenCalled();
  });
});

describe('queued follow-up notice', () => {
  // `send` resolves when the whole turn ends. The notice used to clear only
  // then, so "Sending queued follow-up..." sat under a reply that had been
  // streaming for minutes, reading as a queue that had stuck.
  it('clears once the queued turn starts, not when it finishes', async () => {
    const send = vi.fn(() => new Promise(() => {}));
    const { view, rerenderWith } = await startIdleApp({ isThinking: true, send });

    press(view, 'follow up');
    await waitForFrame(view, '> follow up');
    press(view, '\r');
    await waitForFrame(view, 'Queued follow-up inputs (1)');

    rerenderWith({ isThinking: false, send });
    await waitForFrame(view, 'Sending queued follow-up...');
    expect(send).toHaveBeenCalledWith('follow up');

    rerenderWith({ isThinking: true, send });
    await waitForFrameWithout(view, 'Sending queued follow-up...');
  });
});
