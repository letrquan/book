import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * A session whose main model is on Anthropic's endpoint, with one configured provider that lists
 * `gateway/big`. A bare advisor id (`claude-opus-5`) would resolve against the default endpoint
 * with the main key, so the advisor refuses it (#419); `gateway/<model>` is the way to name one.
 */
function advisorConfig(): AgentConfig {
  const base = config();
  return {
    ...base,
    apiKey: 'sk-ant-test',
    defaultApiKey: 'sk-ant-test',
    baseUrl: 'https://api.anthropic.com',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultBaseUrlExplicit: false,
    settings: {
      ...base.settings,
      provider: {
        gateway: { type: 'anthropic', baseURL: 'https://gateway.example', models: { big: {} } },
      },
    },
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
    setAdvisorModel: vi.fn(() => ({ ok: true })),
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

function startApp(
  addLocalMessage: ReturnType<typeof vi.fn>,
  overrides: Record<string, unknown> = {},
) {
  useAgentMock.mockReturnValue({ ...agentState(addLocalMessage), ...overrides });
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

    view.stdin.write('c');
    await settle();
    expect(frameOf(view)).toContain('Choose compact model');
    expect(frameOf(view)).not.toContain('Choose a setting to change');

    view.stdin.write('\x1b');
    await settle();
    const frame = frameOf(view);
    expect(frame).toContain('Choose a setting to change');
    // Back on Compact model, not on Model: the menu remounts, so the row has to be
    // carried across the trip rather than reset to the top.
    expect(frame).toContain('› C  Compact model');
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

    await submit(view, '/model');
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

/**
 * The startup-animation row writes to `~/.book/settings.json`, and
 * `BOOK_STARTUP_ANIMATION` outranks that file at every launch. Without a word
 * about it the save reads as the change taking effect — which it will not, for
 * as long as the variable is set.
 */
describe('toggling the startup animation under BOOK_STARTUP_ANIMATION', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.BOOK_STARTUP_ANIMATION;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.BOOK_STARTUP_ANIMATION;
    else process.env.BOOK_STARTUP_ANIMATION = previous;
  });

  it('says in the reply that the variable decides, not the value just saved', async () => {
    process.env.BOOK_STARTUP_ANIMATION = '0';
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/config ui.startupAnimation=true');
    await settle();

    const frame = frameOf(view);
    expect(frame).toContain('Startup animation on');
    expect(frame).toContain('BOOK_STARTUP_ANIMATION is set to "0"');
  });

  it('warns on the row itself while the menu is open', async () => {
    process.env.BOOK_STARTUP_ANIMATION = '0';
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/config');

    expect(frameOf(view)).toContain('BOOK_STARTUP_ANIMATION is set to "0"');
  });

  it('says nothing when the variable is not set', async () => {
    delete process.env.BOOK_STARTUP_ANIMATION;
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/config ui.startupAnimation=true');
    await settle();

    const frame = frameOf(view);
    expect(frame).toContain('Startup animation on');
    expect(frame).not.toContain('BOOK_STARTUP_ANIMATION');
  });
});

/**
 * `/advisor` with no argument used to print its usage line, so the only way to
 * choose an advisor was to type a model id from memory — and a mistyped one
 * (`/advisor claude`) was saved without complaint and matched nothing. It now
 * opens the same picker `/model` and the Compact model row use, aimed at the
 * advisor, with an Off row because the advisor is the one model that can be unset.
 */
describe('the /advisor model picker', () => {
  let previousAdvisorEnv: string | undefined;

  beforeEach(() => {
    previousAdvisorEnv = process.env.BOOK_ADVISOR_MODEL;
    delete process.env.BOOK_ADVISOR_MODEL;
  });

  afterEach(() => {
    if (previousAdvisorEnv === undefined) delete process.env.BOOK_ADVISOR_MODEL;
    else process.env.BOOK_ADVISOR_MODEL = previousAdvisorEnv;
  });

  it('opens for a bare /advisor, instead of printing the usage line', async () => {
    const addLocalMessage = vi.fn();
    const view = startApp(addLocalMessage);
    await settle();

    await submit(view, '/advisor');

    const frame = frameOf(view);
    expect(frame).toContain('Choose advisor model');
    expect(frame).toContain('Claude Opus 5');
    // Not the effort sheet the show-modal catch-all would open for a modal it
    // does not know, and not the text report either.
    expect(frame).not.toContain('Choose how much reasoning');
    expect(addLocalMessage).not.toHaveBeenCalled();
  });

  it('offers neither a session-only pick nor an effort level', async () => {
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/advisor');

    // The advisor is saved user-global and has no effort of its own, so the
    // chords the main picker advertises would do nothing here.
    const frame = frameOf(view);
    expect(frame).toContain('Enter save');
    expect(frame).not.toContain('Alt+S');
    expect(frame).not.toContain('Alt+E');
  });

  it('saves the model that is picked, reports it, and closes', async () => {
    const addLocalMessage = vi.fn();
    const setAdvisorModel = vi.fn(() => ({ ok: true }));
    const view = startApp(addLocalMessage, { setAdvisorModel, liveConfig: advisorConfig() });
    await settle();

    await submit(view, '/advisor');
    view.stdin.write('gateway/big');
    await settle();
    view.stdin.write('\r');
    await settle();

    expect(setAdvisorModel).toHaveBeenCalledTimes(1);
    expect(setAdvisorModel).toHaveBeenCalledWith('gateway/big');
    expect(addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining('Advisor set to gateway/big'),
    );
    expect(frameOf(view)).not.toContain('Choose advisor model');
  });

  it('refuses a picked id the advisor would refuse, in the picker, and saves nothing (#419)', async () => {
    const addLocalMessage = vi.fn();
    const setAdvisorModel = vi.fn(() => ({ ok: true }));
    const view = startApp(addLocalMessage, { setAdvisorModel, liveConfig: advisorConfig() });
    await settle();

    await submit(view, '/advisor');
    // A built-in, bare id: listed, but its key and endpoint are ambiguous.
    view.stdin.write('opus-5');
    await settle();
    view.stdin.write('\r');
    await settle();

    expect(setAdvisorModel).not.toHaveBeenCalled();
    const frame = frameOf(view);
    expect(frame).toContain('Choose advisor model');
    expect(frame).toContain('advisor model "claude-opus-5-5" names no configured provider');
    // The picker shows the refusal in place; the transcript says nothing.
    expect(addLocalMessage).not.toHaveBeenCalled();
  });

  it('switches the advisor off from the Off row', async () => {
    const addLocalMessage = vi.fn();
    const setAdvisorModel = vi.fn(() => ({ ok: true }));
    const view = startApp(addLocalMessage, { setAdvisorModel });
    await settle();

    await submit(view, '/advisor');
    // No advisor is set, so the picker opens with the cursor on the Off row.
    expect(frameOf(view)).toContain('› Off — no advisor');

    view.stdin.write('\r');
    await settle();

    expect(setAdvisorModel).toHaveBeenCalledTimes(1);
    expect(setAdvisorModel).toHaveBeenCalledWith(null);
    expect(addLocalMessage).toHaveBeenCalledWith('Advisor disabled');
    expect(frameOf(view)).not.toContain('Choose advisor model');
  });

  it('keeps the picker open and shows the error when the save fails', async () => {
    const addLocalMessage = vi.fn();
    const setAdvisorModel = vi.fn(() => ({ ok: false, error: 'settings.json is read-only' }));
    const view = startApp(addLocalMessage, { setAdvisorModel });
    await settle();

    await submit(view, '/advisor');
    view.stdin.write('\r');
    await settle();

    const frame = frameOf(view);
    expect(frame).toContain('Choose advisor model');
    expect(frame).toContain('settings.json is read-only');
    // The picker shows the failure in place; a second report in the transcript
    // would say it twice.
    expect(addLocalMessage).not.toHaveBeenCalled();
  });

  it('says so when the saved advisor matches no model in the list', async () => {
    const view = startApp(vi.fn(), { liveConfig: { ...config(), advisorModel: 'claude' } });
    await settle();

    await submit(view, '/advisor');

    expect(frameOf(view)).toContain('Current advisor "claude" is not in your model list.');
  });

  it('names BOOK_ADVISOR_MODEL in the picker and in the report when it outranks the pick', async () => {
    process.env.BOOK_ADVISOR_MODEL = 'gateway/big';
    const addLocalMessage = vi.fn();
    const view = startApp(addLocalMessage);
    await settle();

    await submit(view, '/advisor');
    expect(frameOf(view)).toContain('BOOK_ADVISOR_MODEL is set to "gateway/big"');

    view.stdin.write('\r');
    await settle();

    expect(addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining('BOOK_ADVISOR_MODEL=gateway/big'),
    );
  });

  it('still saves /advisor <model> directly, through the same report', async () => {
    process.env.BOOK_ADVISOR_MODEL = 'gateway/big';
    const addLocalMessage = vi.fn();
    const setAdvisorModel = vi.fn(() => ({ ok: true }));
    const view = startApp(addLocalMessage, { setAdvisorModel, liveConfig: advisorConfig() });
    await settle();

    await submit(view, '/advisor gateway/big');
    await settle();

    expect(setAdvisorModel).toHaveBeenCalledWith('gateway/big');
    expect(addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining('Advisor set to gateway/big'),
    );
    expect(addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining('BOOK_ADVISOR_MODEL=gateway/big'),
    );
    expect(frameOf(view)).not.toContain('Choose advisor model');
  });

  it('still saves a typed /advisor id that is not listed, and says so after the describe text', async () => {
    process.env.BOOK_ADVISOR_MODEL = 'gateway/big';
    const addLocalMessage = vi.fn();
    const setAdvisorModel = vi.fn(() => ({ ok: true }));
    const view = startApp(addLocalMessage, { setAdvisorModel, liveConfig: advisorConfig() });
    await settle();

    // A configured provider may serve a model nobody listed.
    await submit(view, '/advisor gateway/small');
    await settle();

    expect(setAdvisorModel).toHaveBeenCalledWith('gateway/small');
    const message = String(addLocalMessage.mock.calls[0]?.[0]);
    const note = 'Note: gateway/small is not in your model list. Run /advisor to pick one.';
    expect(message).toContain(note);
    expect(message.indexOf('Advisor set to gateway/small')).toBeLessThan(message.indexOf(note));
    expect(message.indexOf(note)).toBeLessThan(message.indexOf('BOOK_ADVISOR_MODEL='));
  });

  it('refuses a typed /advisor id the advisor would refuse, saving nothing (#419)', async () => {
    const addLocalMessage = vi.fn();
    const setAdvisorModel = vi.fn(() => ({ ok: true }));
    const view = startApp(addLocalMessage, { setAdvisorModel, liveConfig: advisorConfig() });
    await settle();

    await submit(view, '/advisor claude');
    await settle();

    expect(setAdvisorModel).not.toHaveBeenCalled();
    expect(addLocalMessage).not.toHaveBeenCalledWith(expect.stringContaining('Advisor set to'));
  });

  it('shows the unknown-prefix warning once for a typed id, without the unlisted note', async () => {
    const addLocalMessage = vi.fn();
    const setAdvisorModel = vi.fn(() => ({ ok: true }));
    // A session on the default endpoint with its own key: the bare resolution is its own.
    const liveConfig = { ...advisorConfig(), baseUrl: 'https://api.openai.com/v1' };
    const view = startApp(addLocalMessage, { setAdvisorModel, liveConfig });
    await settle();

    await submit(view, '/advisor antropic/x');
    await settle();

    expect(setAdvisorModel).toHaveBeenCalledWith('antropic/x');
    const message = String(addLocalMessage.mock.calls[0]?.[0]);
    expect(message).toContain('Advisor set to antropic/x');
    expect(message.match(/⚠/g)).toHaveLength(1);
    expect(message).toContain('names provider "antropic", which is not configured');
    expect(message).not.toContain('not in your model list');
  });

  it('does not add the unlisted note for a listed /advisor id', async () => {
    const addLocalMessage = vi.fn();
    const setAdvisorModel = vi.fn(() => ({ ok: true }));
    const view = startApp(addLocalMessage, { setAdvisorModel, liveConfig: advisorConfig() });
    await settle();

    await submit(view, '/advisor gateway/big');
    await settle();

    expect(addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining('Advisor set to gateway/big'),
    );
    expect(String(addLocalMessage.mock.calls[0]?.[0])).not.toContain('not in your model list');
  });

  it('reports a failed /advisor <model> save in the transcript', async () => {
    const addLocalMessage = vi.fn();
    const setAdvisorModel = vi.fn(() => ({ ok: false, error: 'settings.json is read-only' }));
    const view = startApp(addLocalMessage, { setAdvisorModel, liveConfig: advisorConfig() });
    await settle();

    await submit(view, '/advisor gateway/big');
    await settle();

    expect(addLocalMessage).toHaveBeenCalledWith('✕ settings.json is read-only');
  });

  it('is the Advisor row of /config, and Esc comes back to that row', async () => {
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/config');
    expect(frameOf(view)).toContain('Advisor');

    view.stdin.write('v');
    await settle();
    expect(frameOf(view)).toContain('Choose advisor model');
    expect(frameOf(view)).not.toContain('Choose a setting to change');

    view.stdin.write('\x1b');
    await settle();
    const frame = frameOf(view);
    expect(frame).toContain('Choose a setting to change');
    expect(frame).toContain('› V  Advisor');
  });

  it('comes back to /config after a pick, so a second setting costs no reopen', async () => {
    const setAdvisorModel = vi.fn(() => ({ ok: true }));
    const view = startApp(vi.fn(), { setAdvisorModel });
    await settle();

    await submit(view, '/config');
    view.stdin.write('v');
    await settle();
    view.stdin.write('\r');
    await settle();

    expect(setAdvisorModel).toHaveBeenCalledTimes(1);
    const frame = frameOf(view);
    expect(frame).toContain('Choose a setting to change');
    expect(frame).toContain('› V  Advisor');
  });

  it('leaves the other pickers aimed where they were', async () => {
    const view = startApp(vi.fn());
    await settle();

    await submit(view, '/advisor');
    view.stdin.write('\x1b');
    await settle();
    expect(frameOf(view)).not.toContain('Choose advisor model');

    // The same component serves /model: an advisor target that outlived its
    // picker would turn it into a list with an Off row and no way to add a
    // provider. Up from the first row wraps to the one row that follows the models.
    await submit(view, '/model');
    view.stdin.write('\x1b[A');
    await settle();
    const model = frameOf(view);
    expect(model).toContain('› + Add BYOK provider…');
    expect(model).toContain('Alt+S session');
    expect(model).not.toContain('Off — no advisor');
    view.stdin.write('\x1b');
    await settle();

    await submit(view, '/config');
    view.stdin.write('c');
    await settle();
    view.stdin.write('\x1b[A');
    await settle();
    const compact = frameOf(view);
    expect(compact).toContain('Choose compact model');
    expect(compact).not.toContain('Off — no advisor');
    expect(compact).not.toContain('Alt+S');
  });
});
