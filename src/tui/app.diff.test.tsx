import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './app.js';
import type { AgentConfig } from '../types/runtime.js';
import type { SlashCommand } from '../types/commands.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { READ_ONLY_GIT_ARGS } from '../tools/git.js';

/** `/diff` shows what the `GitDiff` tool would, read the same way. */

const useAgentMock = vi.fn();
const readOnlyGitMock = vi.fn(
  async (..._args: unknown[]): Promise<{ success: boolean; output: string; error?: string }> => ({
    success: true,
    output: 'diff --git a/a.txt b/a.txt\n',
  }),
);
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

const SAMPLE_DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index ce01362..94954ab 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1 +1,2 @@',
  ' hello',
  '+world',
].join('\n');

function frameOf(view: ReturnType<typeof render>): string {
  return (view.lastFrame() ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

/** The dialog's last line, its keys, in the composer's place. */
const DIALOG_KEYS = 'Esc to close';

async function renderApp(addLocalMessage = vi.fn()) {
  useAgentMock.mockReturnValue(agentState('session-a', addLocalMessage));
  useTasksMock.mockReturnValue({ tasks: [], refresh: vi.fn() });
  const view = render(<App config={config()} session={session} />);
  await settle();
  return { view, addLocalMessage };
}

describe('/diff', () => {
  it('reads the diff the way GitDiff does, in the workspace, into a dialog', async () => {
    readOnlyGitMock.mockResolvedValueOnce({ success: true, output: `${SAMPLE_DIFF}\n` });
    const { view, addLocalMessage } = await renderApp();

    await submit(view, '/diff');

    expect(readOnlyGitMock).toHaveBeenCalledTimes(1);
    const [args, ctx] = readOnlyGitMock.mock.calls[0]!;
    expect(args).toEqual(READ_ONLY_GIT_ARGS.GitDiff);
    expect(ctx).toMatchObject({ workspaceRoot: '/tmp/book' });
    const frame = frameOf(view);
    expect(frame).toContain('Diff');
    expect(frame).toContain('world');
    expect(frame).toContain('1 file · +1 −0');
    expect(frame.indexOf(DIALOG_KEYS)).toBeGreaterThan(frame.indexOf('world'));
    // A lookup is not conversation: nothing reaches the transcript or the session file.
    expect(addLocalMessage).not.toHaveBeenCalled();
  });

  it('says so when there is nothing to show', async () => {
    readOnlyGitMock.mockResolvedValueOnce({ success: true, output: '(no output)' });
    const { view, addLocalMessage } = await renderApp();

    await submit(view, '/diff');

    expect(frameOf(view)).toContain('No unstaged changes.');
    expect(addLocalMessage).not.toHaveBeenCalled();
  });

  it("gives git's reason alone when git refuses, not the usage text after it", async () => {
    readOnlyGitMock.mockResolvedValueOnce({
      success: false,
      output: '',
      error: [
        'warning: Not a git repository. Use --no-index to compare two paths outside a working tree',
        'usage: git diff --no-index [<options>] <path> <path> [<pathspec>...]',
        '',
        '    --[no-]quiet          disable all output of the program',
      ].join('\n'),
    });
    const { view } = await renderApp();

    await submit(view, '/diff');

    const frame = frameOf(view);
    expect(frame).toContain('✕ warning: Not a git repository.');
    expect(frame).not.toContain('usage: git diff');
  });

  it('closes on Esc', async () => {
    readOnlyGitMock.mockResolvedValueOnce({ success: true, output: SAMPLE_DIFF });
    const { view } = await renderApp();

    await submit(view, '/diff');
    expect(frameOf(view)).toContain(DIALOG_KEYS);

    view.stdin.write('\x1b');
    await settle();
    expect(frameOf(view)).not.toContain(DIALOG_KEYS);
    expect(frameOf(view)).not.toContain('world');
  });

  it('drops a diff that arrives after the user has moved on', async () => {
    let finish: (value: { success: boolean; output: string }) => void = () => {};
    readOnlyGitMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { view } = await renderApp();

    await submit(view, '/diff');
    await submit(view, 'thanks');
    finish({ success: true, output: SAMPLE_DIFF });
    await settle();

    expect(frameOf(view)).not.toContain(DIALOG_KEYS);
  });
});

describe('lookup commands', () => {
  it('open /context in a dialog instead of the transcript', async () => {
    const { view, addLocalMessage } = await renderApp();

    await submit(view, '/context');

    // The test config runs with a screen reader on, so the dialog carries the text report.
    expect(frameOf(view)).toContain('Model context budget');
    expect(addLocalMessage).not.toHaveBeenCalled();

    view.stdin.write('\x1b');
    await settle();
    expect(frameOf(view)).not.toContain('Model context budget');
  });

  it('open /cost in a dialog instead of the transcript', async () => {
    const { view, addLocalMessage } = await renderApp();

    await submit(view, '/cost');

    const frame = frameOf(view);
    expect(frame).toContain('Cost');
    expect(frame).toContain(DIALOG_KEYS);
    expect(addLocalMessage).not.toHaveBeenCalled();
  });

  it('open one after another, once Esc has closed the first', async () => {
    readOnlyGitMock.mockResolvedValueOnce({ success: true, output: SAMPLE_DIFF });
    const { view } = await renderApp();

    await submit(view, '/diff');
    expect(frameOf(view)).toContain('world');
    view.stdin.write('\x1b');
    await settle();
    await submit(view, '/cost');

    const frame = frameOf(view);
    expect(frame).toContain('Cost');
    expect(frame).not.toContain('world');
  });
});

describe('the dialog', () => {
  it('puts the prompt away under it and gives it back with the draft', async () => {
    const { view } = await renderApp();

    view.stdin.write('keep this draft');
    await settle(75);
    expect(frameOf(view)).toContain('keep this draft');

    view.stdin.write('\x1f'); // Ctrl+/: the shortcuts, which open over a draft.
    await settle();
    expect(frameOf(view)).toContain('Keyboard shortcuts');
    expect(frameOf(view)).not.toContain('keep this draft');

    view.stdin.write('\x1b');
    await settle();
    expect(frameOf(view)).not.toContain(DIALOG_KEYS);
    expect(frameOf(view)).toContain('keep this draft');
  });

  it('closes on Esc while a turn runs, and the turn keeps running', async () => {
    const addLocalMessage = vi.fn();
    const { view } = await renderApp(addLocalMessage);

    await submit(view, '/cost');
    const busy = { ...agentState('session-a', addLocalMessage), isThinking: true };
    useAgentMock.mockReturnValue(busy);
    view.rerender(<App config={config()} session={session} />);
    await settle();
    expect(frameOf(view)).toContain(DIALOG_KEYS);

    view.stdin.write('\x1b');
    await settle();
    expect(frameOf(view)).not.toContain(DIALOG_KEYS);
    expect(busy.cancel).not.toHaveBeenCalled();
  });

  it('opens every reference panel the same way, not only a lookup', async () => {
    const { view } = await renderApp();

    await submit(view, '/help');
    expect(frameOf(view)).toContain('Commands');
    expect(frameOf(view)).toContain(DIALOG_KEYS);

    view.stdin.write('\x1b');
    await settle();
    expect(frameOf(view)).not.toContain(DIALOG_KEYS);
  });
});
