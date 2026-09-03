import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './app.js';
import type { AgentConfig } from '../types/runtime.js';
import type { SlashCommand } from '../types/commands.js';
import { DEFAULT_SETTINGS } from '../settings.js';

/**
 * `/config` is the only settings surface meant to be *browsed*: it is where the
 * two settings with no command of their own — compact model and subagent
 * profiles — can be found at all. It used to close the moment a row was chosen
 * and never come back, so choosing anything ended the browse, and changing two
 * settings meant opening the menu twice. These tests pin the round trip.
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
    setModel: vi.fn(() => ({ ok: true })),
    upsertProviderAndSelect: vi.fn(() => ({ ok: true })),
    removeProvider: vi.fn(() => ({ ok: false, error: 'not local' })),
    setEffort: vi.fn(() => ({ ok: true })),
    setAgentProfileModel: vi.fn(() => ({ ok: true })),
    setCompactModel: vi.fn(() => ({ ok: true })),
    setDefaultPermissionMode: vi.fn(() => ({ ok: true })),
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

function frameOf(view: ReturnType<typeof render>): string {
  return (view.lastFrame() ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function startApp(addLocalMessage: ReturnType<typeof vi.fn>) {
  useAgentMock.mockReturnValue(agentState(addLocalMessage));
  useTasksMock.mockReturnValue({ tasks: [], refresh: vi.fn() });
  return render(<App config={config()} session={session} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the /config menu survives the picker it opens', () => {
  it('comes back on the same row when a sub-picker is cancelled', async () => {
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/config');
    expect(frameOf(view)).toContain('Settings');

    view.stdin.write('t');
    await settle();
    expect(frameOf(view)).toContain('Choose theme');
    expect(frameOf(view)).not.toContain('Choose a setting to change');

    view.stdin.write('\x1b');
    await settle();
    const frame = frameOf(view);
    expect(frame).toContain('Choose a setting to change');
    // Back on Theme, not on Model: the menu remounts, so the row has to be
    // carried across the trip rather than reset to the top.
    expect(frame).toContain('› T  Theme');
  });

  it('comes back after a sub-picker saves, so a second setting costs no reopen', async () => {
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/config');
    view.stdin.write('p');
    await settle();
    expect(frameOf(view)).toContain('permission');

    view.stdin.write('\r');
    await settle();
    const frame = frameOf(view);
    expect(frame).toContain('Choose a setting to change');
    expect(frame).toContain('› P  Default permissions');
  });

  it('keeps the origin through the profile picker, which is a step deeper', async () => {
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/config');
    view.stdin.write('a');
    await settle();
    expect(frameOf(view)).toContain('Subagent');

    // Choosing a profile opens the model picker *for that profile*. Cancelling
    // it must land back on the profile picker and leave the `/config` origin
    // untouched — the profile picker's own cancel is what carries the rest of
    // the way back. Consuming the origin here would strand the user one surface
    // short, and nothing else in the suite exercises the nested case.
    view.stdin.write('\r');
    await settle();
    expect(frameOf(view)).toContain('Choose subagent model');

    view.stdin.write('\x1b');
    await settle();
    expect(frameOf(view)).toContain('Subagent');
    expect(frameOf(view)).not.toContain('Choose a setting to change');

    view.stdin.write('\x1b');
    await settle();
    const frame = frameOf(view);
    expect(frame).toContain('Choose a setting to change');
    expect(frame).toContain('› A  Subagent profiles');
  });

  it('leaves a picker opened by its own command at the composer', async () => {
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/theme');
    await settle();
    expect(frameOf(view)).not.toContain('Choose a setting to change');

    view.stdin.write('\x1b');
    await settle();
    // No `/config` was open, so Esc belongs to the composer. A menu appearing
    // here would be the mirror-image bug: an origin remembered too long.
    expect(frameOf(view)).not.toContain('Choose a setting to change');
  });

  it('closes to the composer when the menu itself is dismissed', async () => {
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/config');
    expect(frameOf(view)).toContain('Choose a setting to change');

    view.stdin.write('\x1b');
    await settle();
    expect(frameOf(view)).not.toContain('Choose a setting to change');
  });
});
