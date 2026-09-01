import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { act } from 'react';
import { App, ownsModalInput, providerRemovalMessage, shouldPlayStartupFire } from './app.js';
import type { AgentConfig } from '../types/runtime.js';
import type { AgentRecord } from '../agents/types.js';
import type { SlashCommand } from '../types/commands.js';
import { DEFAULT_THEME } from '../types/theme.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { toolSuccess } from '../tools/result.js';

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

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Wait for a frame containing `text`, then return it.
 *
 * Dismissing the startup fire and restoring the typed draft take two committed
 * renders (App drops the splash and mounts InputBar; InputBar's mount effect
 * applies `draftRestore`). A fixed sleep turns "Ink had not repainted yet" into
 * a failure on a loaded machine, so the wait adapts while the assertion at the
 * call site stays exactly as strict.
 */
async function frameContaining(
  view: ReturnType<typeof render>,
  text: string,
  timeoutMs = 2000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = stripAnsi(view.lastFrame());
  while (!frame.includes(text) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    frame = stripAnsi(view.lastFrame());
  }
  return frame;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  discoverCommandsMock.mockImplementation((_workspace: string) => []);
  resolveCommandBodyMock.mockReset();
  vi.unstubAllEnvs();
});

describe('startup fire eligibility', () => {
  it('plays only for a newly created, empty startup session with motion enabled', () => {
    const startupConfig = config();
    startupConfig.accessibility = { screenReader: false, reducedMotion: false };

    expect(shouldPlayStartupFire(startupConfig, testSession)).toBe(true);
    expect(
      shouldPlayStartupFire(
        { ...startupConfig, accessibility: { screenReader: false, reducedMotion: true } },
        testSession,
      ),
    ).toBe(false);
    expect(
      shouldPlayStartupFire(startupConfig, { ...testSession, source: 'resume', created: false }),
    ).toBe(false);
    expect(
      shouldPlayStartupFire(startupConfig, { ...testSession, source: 'clear', created: true }),
    ).toBe(false);
    expect(shouldPlayStartupFire(startupConfig, { ...testSession, history: [{} as never] })).toBe(
      false,
    );

    const animationDisabled = {
      ...startupConfig,
      settings: {
        ...startupConfig.settings,
        ui: { ...startupConfig.settings.ui, startupAnimation: false },
      },
    };
    expect(shouldPlayStartupFire(animationDisabled, testSession)).toBe(false);
  });
});

describe('App session commands', () => {
  const submit = async (view: ReturnType<typeof render>, value: string) => {
    view.stdin.write(value);
    await new Promise((resolve) => setTimeout(resolve, 75));
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 75));
  };

  it('forwards typed input unchanged when it skips the startup fire', async () => {
    const startupConfig = config();
    startupConfig.accessibility = { screenReader: false, reducedMotion: false };
    const agentState = { ...pendingAgentState(), isThinking: false, pendingPlanApproval: null };
    agentState.liveConfig = startupConfig;
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={startupConfig} session={testSession} />);
    expect(stripAnsi(view.lastFrame())).toContain('Esc skip');

    view.stdin.write('preserve this draft');

    expect(await frameContaining(view, 'preserve this draft')).toContain('preserve this draft');
    expect(agentState.send).not.toHaveBeenCalled();
  });

  it('expands a clicked tool row in the active managed-agent transcript', async () => {
    const child: AgentRecord = {
      id: 'agent-mouse',
      parentSessionId: testSession.sessionId,
      profile: 'validator',
      displayName: 'Run child checks',
      profileDescription: 'Validate changes',
      purpose: 'Run tests',
      resolvedModel: 'gateway/review',
      isolation: 'worktree',
      name: 'validator',
      role: 'validator',
      description: 'Validate changes',
      status: 'running',
      applicationStatus: 'not_applied',
      prompt: 'Run tests',
      referencedEvidenceIds: [],
      transcript: [
        {
          id: 'child-message',
          role: 'assistant',
          content: '',
          includeInContext: true,
          timestamp: 1,
          toolCalls: [{ id: 'child-tool', name: 'Bash', arguments: { command: 'npm test' } }],
          toolResults: [
            toolSuccess('CHILD_MOUSE_OUTPUT', {
              toolCallId: 'child-tool',
            }),
          ],
        },
      ],
      pendingMessages: [],
      createdAt: 1,
      updatedAt: 2,
    };
    managedAgentManagerMock.list.mockResolvedValueOnce([child]);
    const liveConfig = config();
    liveConfig.accessibility = { screenReader: false, reducedMotion: true };
    const agentState = {
      ...pendingAgentState(),
      isThinking: false,
      pendingPlanApproval: null,
      liveConfig,
    };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });
    const view = render(<App config={liveConfig} session={testSession} />);

    await new Promise((resolve) => setTimeout(resolve, 25));
    view.stdin.write('\t');
    const childFrame = await frameContaining(view, 'main > Run child checks');
    expect(childFrame).not.toContain('CHILD_MOUSE_OUTPUT');
    const lines = childFrame.split('\n');
    const toolRow = lines.findIndex((line) => line.includes('npm test'));
    expect(toolRow).toBeGreaterThanOrEqual(0);
    const toolColumn = lines[toolRow].indexOf('npm test');

    view.stdin.write(`\x1b[<0;${toolColumn + 1};${toolRow + 1}M`);
    view.stdin.write(`\x1b[<0;${toolColumn + 1};${toolRow + 1}m`);

    expect(await frameContaining(view, 'CHILD_MOUSE_OUTPUT')).toContain('CHILD_MOUSE_OUTPUT');
  });

  it('ignores mouse reports while the startup fire is active', async () => {
    const startupConfig = config();
    startupConfig.accessibility = { screenReader: false, reducedMotion: false };
    const agentState = { ...pendingAgentState(), isThinking: false, pendingPlanApproval: null };
    agentState.liveConfig = startupConfig;
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={startupConfig} session={testSession} />);
    view.stdin.write('\x1b[<64;13;20M');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(stripAnsi(view.lastFrame())).toContain('Esc skip');
    expect(stripAnsi(view.lastFrame())).not.toContain('[<64;13;20M');

    view.stdin.write('draft');
    const frame = await frameContaining(view, 'draft');
    expect(frame).toContain('draft');
    expect(frame).not.toContain('[<64;13;20M');
  });

  it('accumulates paste chunks received before the startup fire rerenders', async () => {
    const startupConfig = config();
    startupConfig.accessibility = { screenReader: false, reducedMotion: false };
    const agentState = { ...pendingAgentState(), isThinking: false, pendingPlanApproval: null };
    agentState.liveConfig = startupConfig;
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={startupConfig} session={testSession} />);
    act(() => {
      view.stdin.write('chunk one ');
      view.stdin.write('chunk two');
    });

    expect(await frameContaining(view, 'chunk one chunk two')).toContain('chunk one chunk two');
    expect(agentState.send).not.toHaveBeenCalled();
  });

  it('revalidates vision support when the model changes after an image is attached', async () => {
    const attachment = {
      id: 'image-1',
      sha256: '1'.repeat(64),
      storageKey: `${'1'.repeat(64)}.png`,
      mediaType: 'image/png' as const,
      byteSize: 3,
    };
    const agentState = {
      ...pendingAgentState(),
      isThinking: false,
      pendingPlanApproval: null,
      liveConfig: { ...config(), modelInfo: { vision: true } },
    };
    const store = {
      saveImageAttachment: vi.fn(() => attachment),
    };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });
    readClipboardImageMock.mockResolvedValue({
      bytes: Uint8Array.from([137, 80, 78, 71, 1]),
      mediaType: 'image/png',
    });

    const view = render(
      <App config={config()} session={{ ...testSession, store: store as never }} />,
    );
    view.stdin.write('\x1bv');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stripAnsi(view.lastFrame())).toContain('[image 1 0 KB]');

    agentState.liveConfig = {
      ...agentState.liveConfig,
      model: 'text-only',
      modelInfo: { vision: false },
    };
    view.rerender(<App config={config()} session={{ ...testSession, store: store as never }} />);
    await new Promise((resolve) => setTimeout(resolve, 25));
    view.stdin.write('describe');
    await new Promise((resolve) => setTimeout(resolve, 25));
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agentState.send).not.toHaveBeenCalled();
    expect(agentState.addLocalMessage).toHaveBeenCalledWith(
      'text-only does not support image input.',
    );
    expect(stripAnsi(view.lastFrame())).toContain('[image 1 0 KB]');
  });

  it('uses the context-window fallback for status usage when model metadata is absent', () => {
    const liveConfig = { ...config(), maxTokens: 64_000, modelInfo: undefined };
    useAgentMock.mockReturnValue({
      ...pendingAgentState(),
      isThinking: false,
      pendingPlanApproval: null,
      tokenCount: 136_000,
      liveConfig,
    });
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={liveConfig} session={testSession} />);

    expect(stripAnsi(view.lastFrame())).toContain('ctx 50%');
  });

  it('leaves one blank row between transcript output and the input bar', () => {
    const agentState = {
      ...pendingAgentState(),
      isThinking: false,
      pendingPlanApproval: null,
      messages: [
        {
          id: 'assistant-spacing',
          role: 'assistant' as const,
          content: 'TRANSCRIPT_SPACING_MARKER',
          timestamp: 1,
          includeInContext: true,
        },
      ],
    };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    const lines = stripAnsi(view.lastFrame()).split('\n');
    const inputLine = lines.findIndex((line) => line.includes('Ask me anything'));

    expect(lines).toContainEqual(expect.stringContaining('TRANSCRIPT_SPACING_MARKER'));
    expect(inputLine).toBeGreaterThan(1);
    expect(lines[inputLine - 2]).toBe('');
  });

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

  it('/tasks opens the prompt-adjacent task panel while the parent is running', async () => {
    const agentState = { ...pendingAgentState(), pendingPlanApproval: null };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    await submit(view, '/tasks');

    expect(stripAnsi(view.lastFrame())).toContain('Background tasks');
    expect(stripAnsi(view.lastFrame())).toContain('No background tasks.');
    expect(agentState.cancel).not.toHaveBeenCalled();
  });

  it('queues a follow-up while the parent is running and drains it when idle', async () => {
    let agentState = { ...pendingAgentState(), pendingPlanApproval: null };
    useAgentMock.mockImplementation(() => agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    await submit(view, 'check the retry path');

    expect(agentState.send).not.toHaveBeenCalled();
    expect(stripAnsi(view.lastFrame())).toContain('Queued follow-up inputs (1)');
    expect(stripAnsi(view.lastFrame())).toContain('check the retry path');

    agentState = { ...agentState, isThinking: false };
    view.rerender(<App config={config()} session={testSession} />);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(agentState.send).toHaveBeenCalledWith('check the retry path');
  });

  it('requeues a follow-up when preparation fails before its user event is persisted', async () => {
    const send = vi.fn().mockResolvedValue({
      status: 'failed',
      phase: 'prepare',
      error: new Error('timeline unavailable'),
      userMessagePersisted: false,
    });
    let agentState = { ...pendingAgentState(), pendingPlanApproval: null, send };
    useAgentMock.mockImplementation(() => agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    await submit(view, 'preserve this follow-up');

    agentState = { ...agentState, isThinking: false };
    view.rerender(<App config={config()} session={testSession} />);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(send).toHaveBeenCalledWith('preserve this follow-up');
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('Queued follow-up inputs (1)');
    expect(frame).toContain('preserve this follow-up');
    expect(frame).toContain('Queued send did not start.');
  });

  it('waits for each queued send promise before dispatching the next item', async () => {
    let resolveFirst: ((value: { status: 'completed'; messages: [] }) => void) | undefined;
    const firstSend = new Promise<{ status: 'completed'; messages: [] }>((resolve) => {
      resolveFirst = resolve;
    });
    const send = vi
      .fn()
      .mockImplementationOnce(() => firstSend)
      .mockResolvedValue({ status: 'completed', messages: [] });
    let agentState = { ...pendingAgentState(), pendingPlanApproval: null, send };
    useAgentMock.mockImplementation(() => agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    await submit(view, 'first queued');
    await submit(view, 'second queued');

    agentState = { ...agentState, isThinking: false };
    view.rerender(<App config={config()} session={testSession} />);
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(1, 'first queued');

    resolveFirst?.({ status: 'completed', messages: [] });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(2, 'second queued');
  });

  it('recalls the newest queued follow-up with Up and Esc removes it without interrupting', async () => {
    const agentState = { ...pendingAgentState(), pendingPlanApproval: null };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    await submit(view, 'remove this follow-up');
    view.stdin.write('\u001B[A');
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(stripAnsi(view.lastFrame())).toContain('remove this follow-up');
    view.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(agentState.cancel).not.toHaveBeenCalled();
    expect(stripAnsi(view.lastFrame())).toContain('Queued input removed.');
    expect(stripAnsi(view.lastFrame())).not.toContain('Queued follow-up inputs (1)');
  });

  it('restores pending queued inputs ahead of the live draft on interrupt', async () => {
    const agentState = { ...pendingAgentState(), pendingPlanApproval: null };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    await submit(view, 'queued first');
    view.stdin.write('current draft');
    await new Promise((resolve) => setTimeout(resolve, 75));
    view.stdin.write('\x03');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const frame = stripAnsi(view.lastFrame());
    expect(agentState.cancel).toHaveBeenCalled();
    expect(frame).toContain('queued first');
    expect(frame).toContain('current draft');
    expect(frame.indexOf('queued first')).toBeLessThan(frame.indexOf('current draft'));
  });

  it('/agents gives configuration guidance instead of opening Agent Center', async () => {
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
    await submit(view, '/agents');

    expect(agentState.addLocalMessage).toHaveBeenCalledWith(expect.stringContaining('/tasks'));
    expect(stripAnsi(view.lastFrame())).not.toContain('Agent Center');
  });

  it('/config opens visual settings and subagent profile management', async () => {
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
    await submit(view, '/config');
    expect(stripAnsi(view.lastFrame())).toContain('Settings');
    expect(stripAnsi(view.lastFrame())).toContain('Subagent profiles');

    view.stdin.write('a');
    await new Promise((resolve) => setTimeout(resolve, 75));
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('explorer');
    expect(frame).toContain('patcher');
    expect(frame).toContain('validator');

    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(stripAnsi(view.lastFrame())).toContain('Choose subagent model');
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(agentState.setAgentProfileModel).toHaveBeenCalledWith('explorer', expect.any(String));
    expect(stripAnsi(view.lastFrame())).toContain('Subagent profiles');
  });

  it('/config opens the compact model picker without changing the active model', async () => {
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
    await submit(view, '/config');
    view.stdin.write('c');
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(stripAnsi(view.lastFrame())).toContain('Choose compact model');

    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(agentState.setCompactModel).toHaveBeenCalledWith(expect.any(String));
    expect(agentState.setModel).not.toHaveBeenCalled();
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

  it('restores image attachments with a rewound conversation prompt', async () => {
    const attachment = {
      id: 'image-rewind',
      sha256: '2'.repeat(64),
      storageKey: `${'2'.repeat(64)}.png`,
      mediaType: 'image/png' as const,
      byteSize: 2048,
    };
    const rewind = vi.fn(async () => ({
      ok: true as const,
      restoredPrompt: 'describe this image',
      restoredAttachments: [attachment],
    }));
    const agentState = {
      ...pendingAgentState(),
      isThinking: false,
      pendingPlanApproval: null,
      rewind,
      getRewindTargets: vi.fn(() => [
        {
          id: 'checkpoint-1',
          userEventId: 'user-1',
          prompt: 'describe this image',
          attachments: [attachment],
          timestamp: Date.now(),
          codeAvailable: false,
        },
      ]),
    };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    await submit(view, '/rewind');
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 50));
    view.stdin.write('\r');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(rewind).toHaveBeenCalledWith('checkpoint-1', 'conversation');
    expect(stripAnsi(view.lastFrame())).toContain('describe this image');
    expect(stripAnsi(view.lastFrame())).toContain('[image 1 2 KB]');
  });
});

describe('App interactive asset cache', () => {
  it('uses preloaded filesystem metadata without rediscovering during render', () => {
    useAgentMock.mockReturnValue({
      ...pendingAgentState(),
      isThinking: false,
      pendingPlanApproval: null,
    });
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    render(
      <App
        config={config()}
        session={testSession}
        interactiveAssets={{
          commands: [],
          skills: [],
          customThemes: [],
          initialTheme: { preference: 'dark', resolvedName: 'dark', tokens: DEFAULT_THEME },
        }}
      />,
    );

    expect(discoverCommandsMock).not.toHaveBeenCalled();
    expect(discoverSkillsMock).not.toHaveBeenCalled();
  });
});

describe('App custom command cancellation', () => {
  it('does not send shell error text after command resolution is aborted', async () => {
    const agentState = { ...pendingAgentState(), isThinking: false, pendingPlanApproval: null };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });
    discoverCommandsMock.mockReturnValue([
      {
        name: 'slow',
        description: 'Slow command',
        body: '!`slow command`',
        source: 'project',
      },
    ]);
    let observedSignal: AbortSignal | undefined;
    resolveCommandBodyMock.mockImplementation(
      (_command: unknown, _argument: unknown, _context: unknown, signal?: AbortSignal) =>
        new Promise((resolve) => {
          observedSignal = signal;
          signal?.addEventListener(
            'abort',
            () => resolve({ resolved: '[shell error: aborted]', shellErrors: ['aborted'] }),
            { once: true },
          );
        }),
    );

    const view = render(<App config={config()} session={testSession} />);
    view.stdin.write('/slow');
    await new Promise((resolve) => setTimeout(resolve, 75));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(resolveCommandBodyMock).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(stripAnsi(view.lastFrame())).toContain('Resolving command shell expansions...'),
    );

    view.stdin.write('\u001B');
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(agentState.send).not.toHaveBeenCalled();
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

describe('App agent plan visibility', () => {
  it('reveals a completed agent plan together with the Ctrl+T task panel', async () => {
    const agentState = {
      ...pendingAgentState(),
      isThinking: false,
      pendingPlanApproval: null,
      agentTodos: [{ content: 'Completed plan marker', status: 'completed' as const }],
    };
    useAgentMock.mockReturnValue(agentState);
    useTasksMock.mockReturnValue({
      tasks: [],
      addTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      removeTask: vi.fn(),
      clearTasks: vi.fn(),
    });

    const view = render(<App config={config()} session={testSession} />);
    expect(stripAnsi(view.lastFrame())).not.toContain('Completed plan marker');

    view.stdin.write('\x14');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(stripAnsi(view.lastFrame())).toContain('Completed plan marker');
    expect(stripAnsi(view.lastFrame())).toContain('Tasks (0)');
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

  it('keeps /config usable when effort is disabled', async () => {
    const liveConfig = { ...config(), modelInfo: { effort: false as const } };
    const { agentState, view } = renderIdle({ liveConfig });

    await submit(view, '/config');
    view.stdin.write('e');
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(stripAnsi(view.lastFrame())).toContain('Settings');
    expect(stripAnsi(view.lastFrame())).not.toContain('Set effort level');
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

  // The reference sheets used to be four independent booleans, so two open
  // panels pinned enough chrome above the composer to push the conversation off
  // a short terminal, and nothing but retyping the command closed either one.
  // `/status` stands in for the group here because `/help` runs taller than the
  // test terminal, so its own title scrolls out of the last frame.
  it('closes the open reference panel on Esc', async () => {
    const { view } = renderIdle();
    await submit(view, '/status');
    expect(stripAnsi(view.lastFrame() ?? '')).toContain('Session Status');

    view.stdin.write('\u001b');
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(stripAnsi(view.lastFrame() ?? '')).not.toContain('Session Status');
  });

  it('shows one reference panel at a time', async () => {
    const { view } = renderIdle();
    await submit(view, '/status');
    await submit(view, '/permissions');

    const frame = stripAnsi(view.lastFrame() ?? '');
    expect(frame).toContain('Permission Mode');
    expect(frame).not.toContain('Session Status');
  });

  it('states how to close on the panel itself', async () => {
    const { view } = renderIdle();
    await submit(view, '/status');
    expect(stripAnsi(view.lastFrame() ?? '')).toContain('Session Status  Esc to close');
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
      '✕ Theme "missing-theme" was not found. Choose dark, light, auto, catppuccin, nord, gruvbox, solarized-dark, or a theme from .book/themes.',
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
