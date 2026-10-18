import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './app.js';
import type { AgentRecord } from '../agents/types.js';
import type { AgentConfig } from '../types/runtime.js';
import { DEFAULT_SETTINGS } from '../settings.js';

/**
 * #554: the agent detail view shows this session's agents only, so `/agent <id>` for one of
 * another session's refuses rather than opening a view that waits on `Loading subagent…` for good,
 * and `/agent send` to one says it was sent rather than switching to that view.
 */

const useAgentMock = vi.fn();
const useTasksMock = vi.fn();
const sendMock = vi.fn(async (..._args: unknown[]) => ({
  status: 'completed' as const,
  messages: [],
}));

function agentRecord(id: string, parentSessionId: string | undefined): AgentRecord {
  return {
    id,
    profile: 'patcher',
    displayName: `Patch ${id}`,
    resolvedModel: 'gateway/code',
    isolation: 'worktree',
    name: 'patcher',
    role: 'patcher',
    description: 'Patch the code',
    status: 'completed',
    applicationStatus: 'not_applied',
    prompt: 'Patch the code',
    referencedEvidenceIds: [],
    transcript: [],
    pendingMessages: [],
    parentSessionId,
    createdAt: 1,
    updatedAt: 2,
  };
}

const records = new Map<string, AgentRecord>([
  ['agent-mine', agentRecord('agent-mine', 'session-a')],
  ['agent-other', agentRecord('agent-other', 'session-b')],
  ['agent-orphan', agentRecord('agent-orphan', undefined)],
]);

const managedAgentManagerMock = {
  list: vi.fn(async () => Array.from(records.values())),
  listPendingCompletions: vi.fn(async () => []),
  subscribe: vi.fn(() => () => {}),
  setInteractivePermissions: vi.fn(),
  send: vi.fn(async (id: string) => records.get(id)!),
  spawn: vi.fn(),
  stop: vi.fn(),
  apply: vi.fn(),
  get: vi.fn(async (id: string) => records.get(id)),
};

vi.mock('./hooks/useAgent.js', () => ({
  useAgent: (...args: unknown[]) => useAgentMock(...args),
}));
vi.mock('./hooks/useTasks.js', () => ({
  useTasks: (...args: unknown[]) => useTasksMock(...args),
}));
vi.mock('../commands/loader.js', () => ({
  discoverCommands: () => [],
  resolveCommandBody: vi.fn(),
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
  const addLocalMessage = vi.fn();
  const appConfig = config();
  useAgentMock.mockReturnValue(agentState('session-a', addLocalMessage));
  useTasksMock.mockReturnValue({ tasks: [], refresh: vi.fn() });
  const view = render(<App config={appConfig} session={session} />);
  const rerender = () => view.rerender(<App config={appConfig} session={session} />);
  return { view, addLocalMessage, rerender };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SENT_ELSEWHERE = (id: string) =>
  `Sent to agent ${id}. It belongs to another session, so its view is not shown here.`;

describe('/agent for an agent of another session (#554)', () => {
  it("opens this session's agent", async () => {
    const { view, addLocalMessage } = startApp();
    await settle();

    await submit(view, '/agent agent-mine');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('main > Patch agent-mine'));
    expect(addLocalMessage).not.toHaveBeenCalled();
  });

  it('refuses one that belongs to another session, and stays where it was', async () => {
    const { view, addLocalMessage } = startApp();
    await settle();

    await submit(view, '/agent agent-other');

    await vi.waitFor(() =>
      expect(addLocalMessage).toHaveBeenCalledWith(
        '✕ Agent agent-other belongs to another session.',
      ),
    );
    expect(view.lastFrame()).not.toContain('Loading subagent');
    expect(view.lastFrame()).not.toContain('main > Patch agent-other');
  });

  it('refuses one that belongs to no session', async () => {
    const { view, addLocalMessage } = startApp();
    await settle();

    await submit(view, '/agent agent-orphan');

    await vi.waitFor(() =>
      expect(addLocalMessage).toHaveBeenCalledWith(
        '✕ Agent agent-orphan belongs to another session.',
      ),
    );
    expect(view.lastFrame()).not.toContain('Loading subagent');
  });

  it('sends to one, says so, and does not open its view', async () => {
    const { view, addLocalMessage } = startApp();
    await settle();

    await submit(view, '/agent send agent-other one more change');

    await vi.waitFor(() =>
      expect(addLocalMessage).toHaveBeenCalledWith(SENT_ELSEWHERE('agent-other')),
    );
    expect(managedAgentManagerMock.send).toHaveBeenCalledWith('agent-other', 'one more change');
    expect(view.lastFrame()).not.toContain('Loading subagent');
    expect(view.lastFrame()).not.toContain('main > Patch agent-other');
  });

  it("opens this session's agent after a send to it", async () => {
    const { view } = startApp();
    await settle();

    await submit(view, '/agent send agent-mine one more change');

    await vi.waitFor(() => expect(view.lastFrame()).toContain('main > Patch agent-mine'));
  });

  it('judges a send by the session it lands in, not the one it was typed in', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    managedAgentManagerMock.send.mockImplementationOnce(async (id: string) => {
      await held;
      return records.get(id)!;
    });
    const { view, addLocalMessage, rerender } = startApp();
    await settle();

    await submit(view, '/agent send agent-mine one more change');
    // A `/clear` while the send is pending: the app is on a new session when it lands.
    useAgentMock.mockReturnValue(agentState('session-c', addLocalMessage));
    rerender();
    await settle();
    release();

    await vi.waitFor(() =>
      expect(addLocalMessage).toHaveBeenCalledWith(SENT_ELSEWHERE('agent-mine')),
    );
    expect(view.lastFrame()).not.toContain('Loading subagent');
  });
});
