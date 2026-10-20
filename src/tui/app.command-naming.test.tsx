import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './app.js';
import type { AgentConfig } from '../types/runtime.js';
import type { SlashCommand } from '../types/commands.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { deriveSessionName } from '../session/name.js';

/**
 * #524: a prompt-body command (`/init`, a custom command) names a fresh session after the line
 * the user typed, which the app passes to `send` as the name source. The generated body is what
 * the model reads and the transcript shows; it is not what names the session.
 */

const useAgentMock = vi.fn();
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

const deploy: SlashCommand = {
  name: 'deploy',
  description: 'Deploy',
  body: 'Roll out to the $1 environment and report.',
  source: 'user',
};

const setup: SlashCommand = {
  name: 'setup',
  description: 'Setup',
  body: 'Follow @.env when editing.',
  source: 'project',
};

vi.mock('./hooks/useAgent.js', () => ({
  useAgent: (...args: unknown[]) => useAgentMock(...args),
}));
vi.mock('./hooks/useTasks.js', () => ({
  useTasks: (...args: unknown[]) => useTasksMock(...args),
}));
vi.mock('../commands/loader.js', () => ({
  discoverCommands: (): SlashCommand[] => [deploy, setup],
  resolveCommandBody: vi.fn(async (command: SlashCommand, args: string) => ({
    resolved:
      command.source === 'project'
        ? command.body
        : `Roll out to the ${args} environment and report.`,
    shellErrors: [],
  })),
}));
vi.mock('../skills.js', () => ({ discoverSkills: () => [] }));
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

function startApp() {
  useAgentMock.mockReturnValue(agentState('session-a', vi.fn()));
  useTasksMock.mockReturnValue({ tasks: [], refresh: vi.fn() });
  return render(<App config={config()} session={session} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('naming a session after the command line the user typed', () => {
  it('passes /init as the name source, so the session is named "Init"', async () => {
    const view = startApp();
    await settle();

    await submit(view, '/init');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [body, , , nameSource] = sendMock.mock.calls[0]!;
    expect(String(body)).toContain('CLAUDE.md');
    expect(nameSource).toBe('/init');
    expect(deriveSessionName(String(nameSource))).toBe('Init');
    expect(deriveSessionName(String(body))).not.toBe('Init');
  });

  it('passes the raw line, arguments unsubstituted, for a custom command', async () => {
    const view = startApp();
    await settle();

    await submit(view, '/deploy staging');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [body, , , nameSource] = sendMock.mock.calls[0]!;
    expect(body).toBe('Roll out to the staging environment and report.');
    expect(nameSource).toBe('/deploy staging');
    expect(deriveSessionName(String(nameSource))).toBe('Deploy staging');
  });

  // #564: the mentions in a project command's body inline only committed files, so the host
  // has to say which bodies those are; a user command and a builtin are the user's and Book's.
  it('marks a project command body, and only that, as one', async () => {
    const view = startApp();
    await settle();

    await submit(view, '/setup');
    await submit(view, '/deploy staging');
    await submit(view, '/init');

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(sendMock.mock.calls.map((call) => [call[0] === setup.body, call[4]])).toEqual([
      [true, true],
      [false, false],
      [false, undefined],
    ]);
  });

  it('sends an ordinary prompt with no name source', async () => {
    const view = startApp();
    await settle();

    await submit(view, 'fix the flaky login test');

    expect(sendMock).toHaveBeenCalledWith('fix the flaky login test');
  });

  it('sends an unknown slash command as typed, with no name source', async () => {
    const view = startApp();
    await settle();

    await submit(view, '/nonesuch please');

    expect(sendMock).toHaveBeenCalledWith('/nonesuch please');
  });
});
