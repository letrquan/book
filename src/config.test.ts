import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  advisorModelRefusal,
  applyModelDefaults,
  clampEffortToCatalog,
  compactsOnSessionModel,
  configuredAdvisorModel,
  freezeAgentConfig,
  loadConfig,
  resolveAdvisorModelConfig,
  resolveCompactModelConfig,
  resolveEffortExplicit,
  resolveModelProviderConfig,
  resolveReducerModelConfig,
} from './config.js';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { defaultConfig } from './test/fixtures.js';
import { collectWithheldProviderNotices } from './project-approval-notices.js';
import { tmpdir } from 'os';
import {
  legacyBaseUrlFingerprint,
  persistWorkspaceProviderChoice,
  workspaceProviderFingerprint,
} from './provider-approvals.js';

// A pass-through: it only lets the workspace-provider tests see which paths were read, to show
// that a `{file:…}` key of an unapproved provider is never opened (#418).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let workspace: string;
let isolatedHome: string;
const origEnv = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, origEnv);

  workspace = mkdtempSync(join(tmpdir(), 'book-config-test-'));
  mkdirSync(join(workspace, '.book'), { recursive: true });
  // Clear all BOOK_* env vars for clean test state.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('BOOK_')) delete process.env[key];
  }
  // Set required API key.
  process.env.BOOK_API_KEY = 'test-key';
  // Pin the user-global layer at an empty directory. Without this, clearing BOOK_HOME
  // above sends resolveBookHome() to the developer's real ~/.book, so their own
  // settings.json leaks into these assertions -- a second configured provider is enough
  // to fail this suite on one machine and pass it on another.
  // Pin the user-global layer at an empty directory of this file's own. Without it the
  // BOOK_* wipe just above sends resolveBookHome() to the developer's real ~/.book and their
  // settings.json merges into these assertions. It is per-test rather than shared because
  // this file asserts on the *absence* of user settings, which a directory shared with every
  // other suite under maxWorkers:1 cannot guarantee once another suite writes into it.
  isolatedHome = mkdtempSync(join(tmpdir(), 'book-config-home-'));
  process.env.BOOK_HOME = isolatedHome;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_PROXY_KEY;
});

afterEach(() => {
  // Restore env in `finally`: a throwing rmSync (EPERM/EBUSY on Windows, which force:true
  // does not suppress) would otherwise leave BOOK_HOME pointing at a deleted directory for
  // every later file in the worker -- the unit tier shares one process (maxWorkers: 1).
  try {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, origEnv);
  }
});

describe('loadConfig retry defaults', () => {
  it('loads default retry config (10 attempts, 600s timeout)', () => {
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.maxAttempts).toBe(10);
    expect(config.retry.requestTimeoutMs).toBe(600000);
    expect(config.retry.streamStallTimeoutMs).toBe(20000);
    expect(config.retry.firstDeltaStallTimeoutMs).toBe(120000);
    expect(config.retry.toolRetries).toBe(1);
    expect(config.retry.watchdog).toBe(false);
    expect(config.retry.baseDelayMs).toBe(1000);
    expect(config.retry.maxDelayMs).toBe(30000);
    expect(config.retry.totalBudgetMs).toBe(0);
  });

  it('overrides and clamps firstDeltaStallTimeoutMs (#379)', () => {
    process.env.BOOK_FIRST_DELTA_STALL_TIMEOUT_MS = '300000';
    expect(loadConfig(workspace, { noSettings: true }).retry.firstDeltaStallTimeoutMs).toBe(300000);

    // The same range the settings schema enforces: 5 s to 30 min.
    process.env.BOOK_FIRST_DELTA_STALL_TIMEOUT_MS = '100';
    expect(loadConfig(workspace, { noSettings: true }).retry.firstDeltaStallTimeoutMs).toBe(5000);
    process.env.BOOK_FIRST_DELTA_STALL_TIMEOUT_MS = '99999999';
    expect(loadConfig(workspace, { noSettings: true }).retry.firstDeltaStallTimeoutMs).toBe(
      1_800_000,
    );
  });

  it('loads firstDeltaStallTimeoutMs from settings.json (#379)', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ retry: { firstDeltaStallTimeoutMs: 240000 } }),
    );
    expect(loadConfig(workspace).retry.firstDeltaStallTimeoutMs).toBe(240000);
  });
});

describe('loadConfig model defaults', () => {
  it('uses the 64k output budget when no model limit is configured', () => {
    const config = loadConfig(workspace, { noSettings: true });

    expect(config.model).toBe('gpt-4o');
    expect(config.maxTokens).toBe(64_000);
    expect(config.defaultMaxTokens).toBe(64_000);
    expect(config.maxTokensExplicit).toBe(false);
  });

  it('loads the compact model from settings with an environment override', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ compactModel: 'router/settings-reducer' }),
    );

    expect(loadConfig(workspace).compactModel).toBe('router/settings-reducer');

    process.env.BOOK_COMPACT_MODEL = 'router/env-reducer';
    expect(loadConfig(workspace).compactModel).toBe('router/env-reducer');
  });

  it('uses summary compaction, which is the only strategy', () => {
    expect(loadConfig(workspace, { noSettings: true }).compactStrategy).toBe('summary');
  });

  /**
   * Zero-Mem's selector survives in real settings files. Removing the feature
   * must not take a working install down with it: `compactStrategy` is now
   * `"summary"` only, so an obsolete value would fail the whole document and
   * stop Book from starting.
   */
  it('starts normally when a settings file still selects the removed Zero-Mem strategy', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ compactStrategy: 'zero-mem', maxTurns: 12 }),
    );

    const config = loadConfig(workspace);

    expect(config.compactStrategy).toBe('summary');
    // The rest of the document still applies; only the removed key is dropped.
    expect(config.settings.maxTurns).toBe(12);
  });
});

describe('loadConfig permission defaults', () => {
  it('loads the configured default permission mode from settings', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ defaultMode: 'plan' }),
    );

    const config = loadConfig(workspace);
    expect(config.settings.defaultMode).toBe('plan');
  });
});

/**
 * The startup splash is on by default, so anything driving Book headlessly — the
 * run-book PTY driver, a script, a CI capture — has to turn it off without owning
 * a settings layer it would have to merge with whatever the user passes.
 *
 * The spellings and the "says nothing" rule live in `parseEnvBoolean` and are
 * tested there; what matters here is the precedence over every layer, which is
 * the only thing `loadConfig` can be the one place to get right.
 */
describe('BOOK_STARTUP_ANIMATION', () => {
  const setSplash = (startupAnimation: boolean) =>
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ ui: { startupAnimation } }),
    );

  it('turns the splash off from the environment over the setting', () => {
    setSplash(true);
    process.env.BOOK_STARTUP_ANIMATION = '0';

    expect(loadConfig(workspace).settings.ui.startupAnimation).toBe(false);
  });

  it('turns the splash on from the environment over the setting', () => {
    setSplash(false);
    process.env.BOOK_STARTUP_ANIMATION = 'on';

    expect(loadConfig(workspace).settings.ui.startupAnimation).toBe(true);
  });

  it('keeps the setting when the environment says nothing', () => {
    setSplash(false);
    expect(loadConfig(workspace).settings.ui.startupAnimation).toBe(false);

    process.env.BOOK_STARTUP_ANIMATION = 'maybe';
    expect(loadConfig(workspace).settings.ui.startupAnimation).toBe(false);

    setSplash(true);
    expect(loadConfig(workspace).settings.ui.startupAnimation).toBe(true);
  });
});

describe('freezeAgentConfig', () => {
  it('deep-freezes resolved configuration without runtime resource fields', () => {
    const config = freezeAgentConfig(loadConfig(workspace, { noSettings: true }));

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.settings)).toBe(true);
    expect(Object.isFrozen(config.settings.permissions.allow)).toBe(true);
    expect(config).not.toHaveProperty('tasks');
    expect(config).not.toHaveProperty('backgroundShells');
    expect(config).not.toHaveProperty('fileObservationLedger');
    expect(config).not.toHaveProperty('agentManager');
    expect(config).not.toHaveProperty('toolDiscoveryState');
  });
});

describe('loadConfig retry — env var overrides', () => {
  it('overrides retry.maxAttempts from BOOK_RETRY_MAX_ATTEMPTS', () => {
    process.env.BOOK_RETRY_MAX_ATTEMPTS = '5';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.maxAttempts).toBe(5);
  });

  it('overrides retry.baseDelayMs from BOOK_RETRY_BASE_DELAY_MS', () => {
    process.env.BOOK_RETRY_BASE_DELAY_MS = '500';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.baseDelayMs).toBe(500);
  });

  it('overrides retry.requestTimeoutMs from BOOK_REQUEST_TIMEOUT_MS', () => {
    process.env.BOOK_REQUEST_TIMEOUT_MS = '30000';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.requestTimeoutMs).toBe(30000);
  });

  it('enables watchdog mode via BOOK_RETRY_WATCHDOG=1', () => {
    process.env.BOOK_RETRY_WATCHDOG = '1';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.watchdog).toBe(true);
  });

  it('clamps maxAttempts to valid range (0-15)', () => {
    process.env.BOOK_RETRY_MAX_ATTEMPTS = '999';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.maxAttempts).toBe(15); // clamped to max 15
  });

  it('clamps requestTimeoutMs to min 5000', () => {
    process.env.BOOK_REQUEST_TIMEOUT_MS = '100';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.requestTimeoutMs).toBe(5000);
  });

  it('overrides toolRetries from BOOK_TOOL_RETRIES', () => {
    process.env.BOOK_TOOL_RETRIES = '3';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.toolRetries).toBe(3);
  });
});

describe('loadConfig retry — settings.json', () => {
  it('loads retry settings from settings.json', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({
        retry: {
          maxAttempts: 5,
          baseDelayMs: 500,
          requestTimeoutMs: 120000,
          watchdog: true,
        },
      }),
    );

    const config = loadConfig(workspace);
    expect(config.retry.maxAttempts).toBe(5);
    expect(config.retry.baseDelayMs).toBe(500);
    expect(config.retry.requestTimeoutMs).toBe(120000);
    expect(config.retry.watchdog).toBe(true);
  });
});

describe('loadConfig provider registry', () => {
  it('allows the interactive TUI to start before BYOK is configured', () => {
    delete process.env.BOOK_API_KEY;
    const config = loadConfig(workspace, { noSettings: true, allowMissingApiKey: true });
    expect(config.apiKey).toBe('');
  });

  it('still requires a key for non-interactive callers', () => {
    delete process.env.BOOK_API_KEY;
    expect(() => loadConfig(workspace, { noSettings: true })).toThrow(/BOOK_API_KEY/);
  });

  it('resolves provider/model, env api key, metadata, max tokens, and effort=false', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'openrouter/deepseek-chat',
        provider: {
          openrouter: {
            type: 'openai',
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: '{env:OPENROUTER_API_KEY}',
            models: {
              'deepseek-chat': {
                label: 'DeepSeek Chat',
                contextWindow: 128000,
                maxOutputTokens: 8192,
                effort: false,
              },
            },
          },
        },
      }),
    );
    delete process.env.BOOK_API_KEY;

    const config = loadConfig(workspace);
    expect(config.provider).toBe('openai');
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(config.model).toBe('deepseek-chat');
    expect(config.modelSelection).toBe('openrouter/deepseek-chat');
    expect(config.apiKey).toBe('or-key');
    expect(config.maxTokens).toBe(8192);
    expect(config.effort).toBeUndefined();
    expect(config.modelInfo?.contextWindow).toBe(128000);
  });

  it('reports a provider prefix that matches no configured provider', () => {
    // The failure this exists for: one provider `9router` configured, a layer
    // pinning `qc/qwen3.7-max`, and no `qc` anywhere. Book fell back to
    // https://api.openai.com/v1 and said nothing, so the only symptom was a
    // credentials line that sent the user hunting for a missing key.
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'qc/qwen3.7-max',
        provider: {
          '9router': { baseURL: 'https://9router.example/v1', apiKey: 'k', models: {} },
        },
      }),
    );

    const config = loadConfig(workspace);
    expect(config.modelProviderWarning).toMatch(
      /Model "qc\/qwen3\.7-max" names provider "qc", which is not configured \(configured: 9router\)/,
    );
    // Still resolved, not thrown: the fallback is right for a namespaced id.
    expect(config.model).toBe('qc/qwen3.7-max');
  });

  it('says nothing about a prefix that does resolve', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'openrouter/deepseek-chat',
        provider: {
          openrouter: {
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: '{env:OPENROUTER_API_KEY}',
            models: {},
          },
        },
      }),
    );

    expect(loadConfig(workspace).modelProviderWarning).toBeUndefined();
  });

  it('says nothing about a namespaced model id when no providers are configured', () => {
    // `meta-llama/llama-3-70b` is one model name an OpenAI-compatible endpoint
    // expects verbatim, not a provider reference. Warning here would fire on
    // every ordinary BOOK_BASE_URL setup.
    process.env.BOOK_MODEL = 'meta-llama/llama-3-70b';

    const config = loadConfig(workspace, { noSettings: true });
    expect(config.modelProviderWarning).toBeUndefined();
    expect(config.model).toBe('meta-llama/llama-3-70b');
  });

  it('lets explicit max tokens override model metadata', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.BOOK_MAX_TOKENS = '12345';
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'openrouter/foo',
        provider: {
          openrouter: {
            type: 'openai',
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: '{env:OPENROUTER_API_KEY}',
            models: { foo: { maxOutputTokens: 8192 } },
          },
        },
      }),
    );
    delete process.env.BOOK_API_KEY;

    expect(loadConfig(workspace).maxTokens).toBe(12345);
  });

  it('uses model effort default when supported', () => {
    process.env.ANTHROPIC_PROXY_KEY = 'proxy-key';
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'proxy/claude-sonnet-5',
        provider: {
          proxy: {
            type: 'anthropic',
            baseURL: 'https://proxy.example',
            apiKey: '{env:ANTHROPIC_PROXY_KEY}',
            models: {
              'claude-sonnet-5': {
                effort: { default: 'medium', levels: ['low', 'medium', 'high'] },
              },
            },
          },
        },
      }),
    );
    delete process.env.BOOK_API_KEY;

    const config = loadConfig(workspace);
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-5');
    expect(config.effort).toBe('medium');
  });

  it('treats --effort as an explicit choice, not just a value', () => {
    // effortExplicit read only BOOK_EFFORT and settings.effort, so on an
    // OpenAI-compatible provider -- which sends reasoning_effort only for an
    // explicit level -- `--effort max` was accepted, reported, and discarded.
    const config = loadConfig(workspace, { effortOverride: 'max' });
    expect(config.effort).toBe('max');
    expect(config.effortExplicit).toBe(true);
  });

  it('outranks BOOK_EFFORT, settings.effort, and model metadata', () => {
    process.env.BOOK_EFFORT = 'low';
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'router/some-model',
        effort: 'medium',
        provider: {
          router: {
            baseURL: 'https://router.example',
            apiKey: 'k',
            models: { 'some-model': { effort: { default: 'low' } } },
          },
        },
      }),
    );

    expect(loadConfig(workspace, { effortOverride: 'xhigh' }).effort).toBe('xhigh');
  });

  it('leaves effort resolution alone when the flag is absent', () => {
    // The flag carried a commander default of 'high', so it was never absent and
    // overwrote every other source. Without an override the lower-priority
    // sources must still decide.
    process.env.BOOK_EFFORT = 'low';
    const config = loadConfig(workspace, { effortOverride: undefined });
    expect(config.effort).toBe('low');
    expect(config.effortExplicit).toBe(true);
  });

  it('reports effort as inexplicit when nothing chose it', () => {
    const config = loadConfig(workspace);
    expect(config.effort).toBe('high');
    expect(config.effortExplicit).toBe(false);
  });

  it('errors clearly when provider api key env var is missing', () => {
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'openrouter/foo',
        provider: {
          openrouter: {
            type: 'openai',
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: '{env:MISSING_KEY}',
          },
        },
      }),
    );
    delete process.env.BOOK_API_KEY;

    expect(() => loadConfig(workspace)).toThrow(/BOOK_API_KEY or provider/);
  });

  it('clears provider routing when switching to a plain model', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'openrouter/foo',
        provider: {
          openrouter: {
            type: 'openai',
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: '{env:OPENROUTER_API_KEY}',
            models: { foo: { maxOutputTokens: 8192 } },
          },
        },
      }),
    );

    const switched = applyModelDefaults(
      resolveModelProviderConfig(loadConfig(workspace), 'gpt-4o'),
    );
    expect(switched.model).toBe('gpt-4o');
    expect(switched.provider).toBe('auto');
    expect(switched.baseUrl).toBe('https://api.openai.com/v1');
    expect(switched.apiKey).toBe('test-key');
    expect(switched.modelInfo).toBeUndefined();
  });

  it('clears provider routing for unknown provider-prefixed models', () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'openrouter/foo',
        provider: {
          openrouter: {
            type: 'openai',
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: '{env:OPENROUTER_API_KEY}',
            models: { foo: { maxOutputTokens: 8192 } },
          },
        },
      }),
    );

    const switched = applyModelDefaults(
      resolveModelProviderConfig(loadConfig(workspace), 'missing/gpt-4o'),
    );
    expect(switched.model).toBe('missing/gpt-4o');
    expect(switched.provider).toBe('auto');
    expect(switched.baseUrl).toBe('https://api.openai.com/v1');
    expect(switched.apiKey).toBe('test-key');
    expect(switched.modelInfo).toBeUndefined();
  });

  it("never carries a provider's key to another endpoint (#419)", () => {
    delete process.env.BOOK_API_KEY;
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'anthropic/claude-sonnet-5-5',
        provider: {
          anthropic: {
            type: 'anthropic',
            baseURL: 'https://api.anthropic.com',
            apiKey: 'anthropic-key',
          },
          lab: { type: 'openai', baseURL: 'http://localhost:9/v1' },
        },
      }),
    );
    const config = loadConfig(workspace);
    expect(config.apiKey).toBe('anthropic-key');

    // An unprefixed id goes to the default endpoint, where that key does not belong.
    const plain = resolveModelProviderConfig(config, 'claude');
    expect(plain.baseUrl).toBe('https://api.openai.com/v1');
    expect(plain.apiKey).toBe('');
    const advisor = resolveAdvisorModelConfig({ ...config, advisorModel: 'claude' });
    expect(advisor?.baseUrl).toBe('https://api.openai.com/v1');
    expect(advisor?.apiKey).toBe('');
    // Nor does a keyless provider entry elsewhere inherit it.
    expect(resolveModelProviderConfig(config, 'lab/model').apiKey).toBe('');

    // BOOK_API_KEY is the user's own key for anything without one, and still goes.
    process.env.BOOK_API_KEY = 'default-key';
    const withDefault = loadConfig(workspace);
    expect(resolveModelProviderConfig(withDefault, 'claude').apiKey).toBe('default-key');
    expect(resolveModelProviderConfig(withDefault, 'lab/model').apiKey).toBe('default-key');
  });

  describe('a Sign in with ChatGPT provider (type "chatgpt")', () => {
    const settings = {
      model: 'plan/gpt-plan',
      provider: {
        // Its baseURL, apiKey and api are ignored: the route is fixed.
        plan: { type: 'chatgpt', baseURL: 'https://elsewhere.example/v1', apiKey: 'ignored-key' },
      },
    };
    const signIn = (): void =>
      writeFileSync(
        join(isolatedHome, 'chatgpt-signin.json'),
        JSON.stringify({
          version: 1,
          hostId: 'urn:uuid:test',
          account: {
            clientId: 'oaiapp_1',
            subject: 's',
            tokens: {
              accessToken: 'plan-access-token',
              idToken: 'id',
              expiresAt: Date.now() + 3_600_000,
              scopes: ['chatgpt.tokens.use.direct'],
              savedAt: 0,
            },
          },
        }),
      );

    it('resolves to the fixed OpenAI route with no key, even with BOOK_API_KEY set', () => {
      process.env.BOOK_API_KEY = 'api-account-key';
      writeFileSync(join(isolatedHome, 'settings.json'), JSON.stringify(settings));
      signIn();
      const config = loadConfig(workspace);
      expect(config).toMatchObject({
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-plan',
        provider: 'openai',
        providerApi: 'responses',
        providerAuth: 'chatgpt',
      });
      // A bare id afterwards is an ordinary API request: the key it gets is BOOK_API_KEY, never
      // the plan token, and it is no longer a chatgpt request.
      const plain = resolveModelProviderConfig(config, 'gpt-4o');
      expect(plain).toMatchObject({ apiKey: 'api-account-key', providerAuth: undefined });
      delete process.env.BOOK_API_KEY;
      expect(resolveModelProviderConfig(loadConfig(workspace), 'gpt-4o').apiKey).toBe('');
    });

    it('stops print mode and the SDK without a sign-in, naming the login command; the TUI starts', () => {
      delete process.env.BOOK_API_KEY;
      writeFileSync(join(isolatedHome, 'settings.json'), JSON.stringify(settings));
      expect(() => loadConfig(workspace)).toThrow(/not signed in\. Run `book auth login`/);
      expect(loadConfig(workspace, { allowMissingApiKey: true }).providerAuth).toBe('chatgpt');
      signIn();
      expect(loadConfig(workspace).providerAuth).toBe('chatgpt');
    });

    it("lets no workspace layer or agent definition choose a plan model, only the user's own settings", () => {
      writeFileSync(
        join(isolatedHome, 'settings.json'),
        JSON.stringify({ ...settings, model: 'gpt-4o', advisorModel: 'plan/gpt-plan' }),
      );
      mkdirSync(join(workspace, '.book'), { recursive: true });
      writeFileSync(
        join(workspace, '.book', 'settings.json'),
        JSON.stringify({ model: 'plan/gpt-plan', compactModel: 'plan/gpt-plan' }),
      );
      signIn();
      const config = loadConfig(workspace);
      expect(config.model).toBe('gpt-4o');
      expect(config.providerAuth).toBeUndefined();
      expect(config.settings.compactModel).toBeUndefined();
      // The user's own advisor choice stands.
      expect(config.settings.advisorModel).toBe('plan/gpt-plan');
      expect(config.workspaceProviderGate?.withheldSelections).toEqual([
        expect.objectContaining({
          key: 'model',
          value: 'plan/gpt-plan',
          reason: 'plan',
          fallback: 'gpt-4o',
        }),
        expect.objectContaining({ key: 'compactModel', reason: 'plan', fallback: undefined }),
      ]);
      // An id a workspace controls (an agent definition) is refused at resolution.
      expect(() => resolveModelProviderConfig(config, 'plan/gpt-plan')).toThrow(
        /ChatGPT plan model/,
      );
      expect(
        resolveModelProviderConfig(config, 'plan/gpt-plan', { trustedSelection: true })
          .providerAuth,
      ).toBe('chatgpt');
    });

    it('keeps a legacy .bookrc.json model naming another of your providers next to a plan one', () => {
      writeFileSync(
        join(isolatedHome, 'settings.json'),
        JSON.stringify({
          provider: {
            ...settings.provider,
            lab: { type: 'openai', baseURL: 'http://localhost:9/v1' },
          },
        }),
      );
      writeFileSync(join(workspace, '.bookrc.json'), JSON.stringify({ model: 'lab/m' }));
      const config = loadConfig(workspace, { allowMissingApiKey: true });
      expect(config.modelSelection).toBe('lab/m');
      expect(config.workspaceProviderGate?.withheldSelections).toEqual([]);
    });

    it('names the ignored plan model when the fallback leaves print mode without a key', () => {
      delete process.env.BOOK_API_KEY;
      writeFileSync(
        join(isolatedHome, 'settings.json'),
        JSON.stringify({ provider: settings.provider }),
      );
      writeFileSync(join(workspace, '.bookrc.json'), JSON.stringify({ model: 'plan/gpt-plan' }));
      signIn();
      expect(() => loadConfig(workspace)).toThrow(
        /BOOK_API_KEY or provider\.<id>\.apiKey not set[\s\S]*"plan\/gpt-plan" from .*\.bookrc\.json ignored: "plan" bills your ChatGPT plan[\s\S]*--model plan\/gpt-plan/,
      );
    });

    it('ignores a plan model a repository ships in a legacy .bookrc.json', () => {
      delete process.env.BOOK_API_KEY;
      writeFileSync(
        join(isolatedHome, 'settings.json'),
        JSON.stringify({ provider: settings.provider }),
      );
      writeFileSync(join(workspace, '.bookrc.json'), JSON.stringify({ model: 'plan/gpt-plan' }));
      signIn();
      const config = loadConfig(workspace, { allowMissingApiKey: true });
      expect(config.model).toBe('gpt-4o');
      expect(config.providerAuth).toBeUndefined();
      expect(config.workspaceProviderGate?.withheldSelections).toEqual([
        expect.objectContaining({
          key: 'model',
          value: 'plan/gpt-plan',
          reason: 'plan',
          path: join(workspace, '.bookrc.json'),
        }),
      ]);
      // Launch says so, without suggesting an approval that does not exist.
      const notices = collectWithheldProviderNotices(config.workspaceProviderGate!, workspace);
      expect(notices).toEqual([expect.stringMatching(/"plan" bills your ChatGPT plan/)]);
      expect(notices.join('\n')).not.toMatch(/book trust provider/);
    });

    it('is refused when only a workspace declares it, approved or not', () => {
      const config = defaultConfig({
        workspaceProviderGate: { declared: ['team'], withheld: [] } as unknown as NonNullable<
          ReturnType<typeof defaultConfig>['workspaceProviderGate']
        >,
      });
      config.settings.provider.team = { type: 'chatgpt', models: {} };
      expect(() => resolveModelProviderConfig(config, 'team/gpt-plan')).toThrow(
        /only this workspace declares/,
      );
    });
  });

  it("carries a provider's `api` to the request config, and no further", () => {
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'resp/gpt-5',
        provider: {
          resp: { type: 'openai', baseURL: 'http://localhost:9/v1', api: 'responses' },
          chat: { type: 'openai', baseURL: 'http://localhost:8/v1' },
          claude: { type: 'anthropic', baseURL: 'https://api.anthropic.com', api: 'responses' },
        },
      }),
    );
    const config = loadConfig(workspace);
    expect(config.providerApi).toBe('responses');
    expect(resolveModelProviderConfig(config, 'chat/gpt-4o').providerApi).toBeUndefined();
    // A bare id goes to the default endpoint, which speaks Chat Completions.
    expect(resolveModelProviderConfig(config, 'gpt-4o').providerApi).toBeUndefined();
    // `api` is an OpenAI setting; an Anthropic entry ignores it.
    expect(
      resolveModelProviderConfig(config, 'claude/claude-opus-5-5').providerApi,
    ).toBeUndefined();
  });

  it('inherits the session key across endpoints that differ only by a trailing slash', () => {
    delete process.env.BOOK_API_KEY;
    const write = (labBaseUrl: string) =>
      writeFileSync(
        join(isolatedHome, 'settings.json'),
        JSON.stringify({
          model: 'openai/gpt-4o',
          provider: {
            openai: { type: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'openai-key' },
            lab: { type: 'openai', baseURL: labBaseUrl },
          },
        }),
      );

    write('https://API.openai.com/v1/');
    expect(resolveModelProviderConfig(loadConfig(workspace), 'lab/m').apiKey).toBe('openai-key');
    // A different port, scheme or path is another endpoint, and gets no key.
    for (const other of [
      'https://api.openai.com:8443/v1',
      'http://api.openai.com/v1',
      'https://api.openai.com/v2',
    ]) {
      write(other);
      expect(resolveModelProviderConfig(loadConfig(workspace), 'lab/m').apiKey, other).toBe('');
    }
  });

  it('treats an inherited property name as an unconfigured provider', () => {
    const config = loadConfig(workspace);
    for (const id of ['constructor/x', '__proto__/x', 'toString/x']) {
      const resolved = resolveModelProviderConfig(config, id);
      expect(resolved.model, id).toBe(id);
      expect(resolved.baseUrl, id).toBe(config.defaultBaseUrl);
    }
  });

  it("keeps a provider's key on an unprefixed switch to the same endpoint", () => {
    delete process.env.BOOK_API_KEY;
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({
        model: 'openai/gpt-4o',
        provider: { openai: { type: 'openai', apiKey: 'openai-key' } },
      }),
    );

    // The entry names no baseURL, so it already sends its key to the default endpoint.
    const switched = resolveModelProviderConfig(loadConfig(workspace), 'gpt-4o-mini');
    expect(switched.baseUrl).toBe('https://api.openai.com/v1');
    expect(switched.apiKey).toBe('openai-key');
  });

  it('rejects provider-prefixed models with an empty model name', () => {
    writeFileSync(
      join(isolatedHome, 'settings.json'),
      JSON.stringify({ model: 'openrouter/', provider: { openrouter: { type: 'openai' } } }),
    );

    expect(() => loadConfig(workspace)).toThrow(/Expected "provider\/model"/);
  });

  it('blocks relative file secrets that escape the workspace', () => {
    const secretName = `book-secret-${crypto.randomUUID()}`;
    const secret = join(workspace, '..', secretName);
    writeFileSync(secret, 'stolen-key');
    try {
      writeFileSync(
        join(isolatedHome, 'settings.json'),
        JSON.stringify({
          model: 'openrouter/foo',
          provider: { openrouter: { type: 'openai', apiKey: `{file:../${secretName}}` } },
        }),
      );
      delete process.env.BOOK_API_KEY;

      expect(() => loadConfig(workspace)).toThrow(/BOOK_API_KEY or provider/);
    } finally {
      rmSync(secret, { force: true });
    }
  });

  it('applies model metadata defaults on runtime provider switches', () => {
    const config = defaultConfig({
      maxTokens: 8192,
      defaultMaxTokens: 128000,
      settings: {
        ...defaultConfig().settings,
        provider: {
          openrouter: {
            type: 'openai',
            baseURL: 'https://openrouter.ai/api/v1',
            models: { bar: { maxOutputTokens: 4096 } },
          },
        },
      },
    });

    const switched = applyModelDefaults(resolveModelProviderConfig(config, 'openrouter/bar'));
    expect(switched.maxTokens).toBe(4096);
  });

  it('resolves the compact model without changing the active model config', () => {
    const config = defaultConfig({
      apiKey: 'active-key',
      baseUrl: 'https://active.example/v1',
      model: 'active-model',
      modelSelection: 'active/active-model',
      compactModel: 'reducer/flash',
      settings: {
        ...defaultConfig().settings,
        provider: {
          reducer: {
            type: 'openai',
            baseURL: 'https://reducer.example/v1',
            apiKey: 'reducer-key',
            models: {
              flash: {
                maxOutputTokens: 4096,
                effort: { default: 'medium', levels: ['low', 'medium', 'high'] },
              },
            },
          },
        },
      },
      defaultMaxTokens: 64_000,
      defaultEffort: 'high',
      effortExplicit: false,
    });

    const reducer = resolveCompactModelConfig(config);

    expect(config).toMatchObject({
      model: 'active-model',
      baseUrl: 'https://active.example/v1',
      apiKey: 'active-key',
    });
    expect(reducer).toMatchObject({
      model: 'flash',
      modelSelection: 'reducer/flash',
      baseUrl: 'https://reducer.example/v1',
      apiKey: 'reducer-key',
      maxTokens: 4096,
      effort: 'medium',
    });
  });

  it('resolves compact reducer effort capped at medium by default with maxAttempts 2', () => {
    const config = defaultConfig({
      effort: 'max',
      effortExplicit: true,
      compactModel: 'reducer/flash',
      settings: {
        ...defaultConfig().settings,
        provider: {
          reducer: {
            type: 'openai',
            baseURL: 'https://reducer.example/v1',
            apiKey: 'reducer-key',
            models: {
              flash: {
                maxOutputTokens: 4096,
                effort: { default: 'medium', levels: ['low', 'medium', 'high', 'max'] },
              },
            },
          },
        },
      },
    });

    const reducer = resolveReducerModelConfig(config);
    expect(reducer.effort).toBe('medium');
    expect(reducer.effortExplicit).toBe(true);
    expect(reducer.retry.maxAttempts).toBe(2);
    expect(config.effort).toBe('max');
  });

  it('respects compactEffort override for the reducer', () => {
    const config = defaultConfig({
      effort: 'max',
      effortExplicit: true,
      compactEffort: 'high',
      compactModel: 'reducer/flash',
      settings: {
        ...defaultConfig().settings,
        provider: {
          reducer: {
            type: 'openai',
            baseURL: 'https://reducer.example/v1',
            apiKey: 'reducer-key',
            models: {
              flash: {
                maxOutputTokens: 4096,
                effort: { default: 'medium', levels: ['low', 'medium', 'high', 'max'] },
              },
            },
          },
        },
      },
    });

    const reducer = resolveReducerModelConfig(config);
    expect(reducer.effort).toBe('high');
    expect(reducer.effortExplicit).toBe(true);
    expect(config.compactEffort).toBe('high');
    expect(config.effort).toBe('max');
  });

  it('preserves low effort when session effort is low', () => {
    const config = defaultConfig({
      effort: 'low',
      effortExplicit: true,
      compactModel: 'reducer/flash',
      settings: {
        ...defaultConfig().settings,
        provider: {
          reducer: {
            type: 'openai',
            baseURL: 'https://reducer.example/v1',
            apiKey: 'reducer-key',
            models: {
              flash: {
                maxOutputTokens: 4096,
                effort: { default: 'medium', levels: ['low', 'medium', 'high'] },
              },
            },
          },
        },
      },
    });

    const reducer = resolveReducerModelConfig(config);
    expect(reducer.effort).toBe('low');
    expect(reducer.effortExplicit).toBe(true);
    expect(config.effort).toBe('low');
  });

  it('sets effort to undefined when reducer model catalog specifies effort false', () => {
    const config = defaultConfig({
      effort: 'max',
      effortExplicit: true,
      compactModel: 'reducer/no-effort',
      settings: {
        ...defaultConfig().settings,
        provider: {
          reducer: {
            type: 'openai',
            baseURL: 'https://reducer.example/v1',
            apiKey: 'reducer-key',
            models: {
              'no-effort': {
                maxOutputTokens: 4096,
                effort: false,
              },
            },
          },
        },
      },
    });

    const reducer = resolveReducerModelConfig(config);
    expect(reducer.effort).toBeUndefined();
    expect(config.effort).toBe('max');
  });

  it('sends no reducer effort when nothing chose a level and the catalog lists none', () => {
    const config = defaultConfig({ model: 'gpt-4o', effort: 'high', effortExplicit: false });

    const reducer = resolveReducerModelConfig(config);
    // The value is still capped (the Anthropic path sends it regardless), but
    // nothing chose it, so the OpenAI-compatible request carries no effort.
    expect(reducer.effort).toBe('medium');
    expect(reducer.effortExplicit).toBe(false);

    const chosen = resolveReducerModelConfig({ ...config, compactEffort: 'low' });
    expect(chosen.effort).toBe('low');
    expect(chosen.effortExplicit).toBe(true);

    const session = resolveReducerModelConfig({ ...config, effort: 'max', effortExplicit: true });
    expect(session.effort).toBe('medium');
    expect(session.effortExplicit).toBe(true);
  });

  it('clamps the reducer effort down to the highest listed level, never back up', () => {
    const config = defaultConfig({
      effort: 'max',
      effortExplicit: true,
      compactModel: 'reducer/flash',
      settings: {
        ...defaultConfig().settings,
        provider: {
          reducer: {
            type: 'openai',
            baseURL: 'https://reducer.example/v1',
            apiKey: 'reducer-key',
            models: {
              flash: { maxOutputTokens: 4096, effort: { levels: ['low', 'high', 'max'] } },
              strict: { maxOutputTokens: 4096, effort: { levels: ['high', 'max'] } },
            },
          },
        },
      },
    });

    const reducer = resolveReducerModelConfig(config);
    expect(reducer.effort).toBe('low');
    expect(reducer.effortExplicit).toBe(true);

    const none = resolveReducerModelConfig({ ...config, compactModel: 'reducer/strict' });
    expect(none.effort).toBeUndefined();
    expect(none.effortExplicit).toBe(false);
  });

  it('keeps the reducer retry cap under the watchdog', () => {
    const config = defaultConfig();
    const reducer = resolveReducerModelConfig({
      ...config,
      retry: { ...config.retry, maxAttempts: 10, watchdog: true },
    });
    expect(reducer.retry.maxAttempts).toBe(2);
    expect(reducer.retry.watchdog).toBe(false);
  });

  it("caps the compact model's effort for every caller, but only the reducer's and the judge's retries (#245)", () => {
    const config = defaultConfig({
      effort: 'max',
      effortExplicit: true,
      compactModel: 'reducer/flash',
      settings: {
        ...defaultConfig().settings,
        provider: {
          reducer: {
            type: 'openai',
            baseURL: 'https://reducer.example/v1',
            apiKey: 'reducer-key',
            models: {
              flash: {
                maxOutputTokens: 4096,
                effort: { default: 'medium', levels: ['low', 'medium', 'high', 'max'] },
              },
              plain: { maxOutputTokens: 4096, effort: false },
            },
          },
        },
      },
    });
    const withRetry = { ...config, retry: { ...config.retry, maxAttempts: 10, watchdog: true } };

    // Memory extraction: the effort is capped at medium, the retry policy is the session's.
    const compact = resolveCompactModelConfig(withRetry);
    expect(compact).toMatchObject({ model: 'flash', effort: 'medium', effortExplicit: true });
    expect(compact.retry).toMatchObject({ maxAttempts: 10, watchdog: true });

    // A compact model whose catalog takes no effort gets none, whatever the session asked for.
    const plain = resolveCompactModelConfig({ ...withRetry, compactModel: 'reducer/plain' });
    expect(plain.model).toBe('plain');
    expect(plain.effort).toBeUndefined();
    expect(plain.effortExplicit).toBe(false);

    // The reducer and the judge also retry at most twice, without the watchdog.
    const reducer = resolveReducerModelConfig(withRetry);
    expect(reducer).toMatchObject({ model: 'flash', effort: 'medium', effortExplicit: true });
    expect(reducer.retry).toMatchObject({ maxAttempts: 2, watchdog: false });
  });

  it('clamps an effort down to the catalog and leaves an uncatalogued model alone', () => {
    const listed = defaultConfig({ modelInfo: { effort: { levels: ['low', 'medium', 'high'] } } });
    expect(clampEffortToCatalog(listed, 'max')).toBe('high');
    expect(clampEffortToCatalog(listed, 'medium')).toBe('medium');
    expect(clampEffortToCatalog(listed, undefined)).toBeUndefined();
    const highOnly = defaultConfig({ modelInfo: { effort: { levels: ['high'] } } });
    expect(clampEffortToCatalog(highOnly, 'low')).toBeUndefined();
    const none = defaultConfig({ modelInfo: { effort: false } });
    expect(clampEffortToCatalog(none, 'high')).toBeUndefined();
    const bare = defaultConfig({ modelInfo: undefined });
    expect(clampEffortToCatalog(bare, 'max')).toBe('max');
  });

  it('raises a chosen effort below every listed level to the lowest one, on request (#245)', () => {
    const listed = defaultConfig({ modelInfo: { effort: { levels: ['medium', 'high'] } } });
    expect(clampEffortToCatalog(listed, 'low')).toBeUndefined();
    expect(clampEffortToCatalog(listed, 'low', { raiseToLowest: true })).toBe('medium');
    expect(clampEffortToCatalog(listed, 'max', { raiseToLowest: true })).toBe('high');
    // An empty `levels` list exposes no choices: nothing is raised into it.
    const empty = defaultConfig({ modelInfo: { effort: { levels: [] } } });
    expect(clampEffortToCatalog(empty, 'high')).toBeUndefined();
    expect(clampEffortToCatalog(empty, 'low', { raiseToLowest: true })).toBeUndefined();
    const none = defaultConfig({ modelInfo: { effort: false } });
    expect(clampEffortToCatalog(none, 'low', { raiseToLowest: true })).toBeUndefined();
  });

  it('sends any level to a catalog entry that names a default but no levels (#245)', () => {
    // Such an entry says the model takes an effort, and `/effort` offers it every level.
    const defaultOnly = defaultConfig({ modelInfo: { effort: { default: 'medium' } } });
    expect(resolveEffortExplicit(defaultOnly, 'medium', false)).toBe(true);
    expect(resolveEffortExplicit(defaultOnly, 'low', false)).toBe(true);
    // An entry that names neither a default nor levels vouches for nothing.
    const bareEntry = defaultConfig({ modelInfo: { effort: {} } });
    expect(resolveEffortExplicit(bareEntry, 'high', false)).toBe(false);
    const empty = defaultConfig({ modelInfo: { effort: { levels: [] } } });
    expect(resolveEffortExplicit(empty, 'medium', false)).toBe(false);
  });

  it('raises an explicit compactEffort below the catalog to its lowest listed level (#245)', () => {
    const config = defaultConfig({
      effort: 'high',
      compactEffort: 'low',
      compactModel: 'reducer/upper',
      settings: {
        ...defaultConfig().settings,
        provider: {
          reducer: {
            type: 'openai',
            baseURL: 'https://reducer.example/v1',
            apiKey: 'reducer-key',
            models: { upper: { maxOutputTokens: 4096, effort: { levels: ['medium', 'high'] } } },
          },
        },
      },
    });
    expect(resolveCompactModelConfig(config)).toMatchObject({
      model: 'upper',
      effort: 'medium',
      effortExplicit: true,
    });
    // The session's effort capped at `medium` is not raised: it never goes back up.
    const capped = resolveCompactModelConfig({
      ...config,
      compactEffort: undefined,
      effort: 'max',
      effortExplicit: true,
      settings: {
        ...config.settings,
        provider: {
          reducer: {
            ...config.settings.provider.reducer!,
            models: { upper: { maxOutputTokens: 4096, effort: { levels: ['high', 'max'] } } },
          },
        },
      },
    });
    expect(capped.effort).toBeUndefined();
  });

  it('does not carry a level the catalog merely listed into the compact model as chosen (#245)', () => {
    const config = defaultConfig({
      effort: 'high',
      // Sent, because a managed child's catalog listed it -- but nobody chose it.
      effortExplicit: true,
      effortChosen: false,
      compactModel: 'reducer/bare',
      settings: {
        ...defaultConfig().settings,
        provider: {
          reducer: {
            type: 'openai',
            baseURL: 'https://reducer.example/v1',
            apiKey: 'reducer-key',
            models: { bare: { maxOutputTokens: 4096 } },
          },
        },
      },
    });
    const compact = resolveCompactModelConfig(config);
    expect(compact).toMatchObject({ model: 'bare', effort: 'medium', effortExplicit: false });
    expect(compact.effortChosen).toBe(false);

    // A level that was chosen still counts on the uncatalogued compact model.
    const chosen = resolveCompactModelConfig({ ...config, effortChosen: true });
    expect(chosen).toMatchObject({ effort: 'medium', effortExplicit: true, effortChosen: true });
  });

  it('determines whether compaction runs on the session model (#399)', () => {
    const base = defaultConfig({
      model: 'space-bunny-alpha',
      modelSelection: '9router/commandcode/space-bunny-alpha',
    });
    // Unset compact model: session model
    expect(compactsOnSessionModel(base)).toBe(true);

    // Matches bare model name: session model
    expect(compactsOnSessionModel({ ...base, compactModel: 'space-bunny-alpha' })).toBe(true);

    // Matches provider-prefixed selection: session model
    expect(
      compactsOnSessionModel({
        ...base,
        compactModel: '9router/commandcode/space-bunny-alpha',
      }),
    ).toBe(true);

    // Configured via settings.compactModel matching selection: session model
    expect(
      compactsOnSessionModel({
        ...base,
        compactModel: undefined,
        settings: {
          ...base.settings,
          compactModel: '9router/commandcode/space-bunny-alpha',
        },
      }),
    ).toBe(true);

    // Distinct compact model: not session model
    expect(compactsOnSessionModel({ ...base, compactModel: 'other/compact-model' })).toBe(false);
  });

  it('sends an effort only when a level was chosen or the catalog lists it', () => {
    const bare = defaultConfig({ modelInfo: undefined });
    expect(resolveEffortExplicit(bare, 'high', false)).toBe(false);
    expect(resolveEffortExplicit(bare, 'high', true)).toBe(true);
    expect(resolveEffortExplicit(bare, undefined, true)).toBe(false);

    const listed = defaultConfig({ modelInfo: { effort: { levels: ['low', 'medium'] } } });
    expect(resolveEffortExplicit(listed, 'medium', false)).toBe(true);
    expect(resolveEffortExplicit(listed, 'high', false)).toBe(false);
    expect(resolveEffortExplicit(listed, 'high', true)).toBe(true);
  });

  it('uses the 64k output budget for models without metadata', () => {
    const config = defaultConfig({ maxTokens: 64_000, defaultMaxTokens: 64_000 });
    const switched = applyModelDefaults(resolveModelProviderConfig(config, 'unknown/model'));

    expect(switched.modelInfo).toBeUndefined();
    expect(switched.maxTokens).toBe(64_000);
  });

  it('rejects zero env max tokens', () => {
    process.env.BOOK_MAX_TOKENS = '0';
    expect(() => loadConfig(workspace, { noSettings: true })).toThrow(
      /BOOK_MAX_TOKENS must be a positive integer/,
    );
  });
});

describe('configuredAdvisorModel', () => {
  const settings = (advisorModel?: string) => ({ advisorModel }) as never;

  it('returns the configured id, trimmed', () => {
    expect(configuredAdvisorModel({ advisorModel: ' a/b ', settings: settings() })).toBe('a/b');
  });

  // `/advisor off` writes this to the local layer when a checked-in layer still declares an
  // advisor (#418): the one value that outranks the project layer and reads as "no advisor".
  it.each(['off', 'OFF', ' Off '])('treats %j as no advisor, from either source', (value) => {
    expect(configuredAdvisorModel({ advisorModel: value, settings: settings() })).toBe(undefined);
    expect(configuredAdvisorModel({ advisorModel: undefined, settings: settings(value) })).toBe(
      undefined,
    );
  });

  it('lets an advisor from the environment outrank an off in settings', () => {
    expect(configuredAdvisorModel({ advisorModel: 'env/adv', settings: settings('off') })).toBe(
      'env/adv',
    );
  });
});

describe('advisorModelRefusal (#419)', () => {
  function configure(settings: Record<string, unknown>): void {
    writeFileSync(join(isolatedHome, 'settings.json'), JSON.stringify(settings));
  }
  const anthropicProvider = {
    anthropic: { type: 'anthropic', baseURL: 'https://api.anthropic.com' },
  };

  it('refuses a bare id when BOOK_API_KEY would be paired with the default endpoint', () => {
    process.env.BOOK_API_KEY = 'sk-ant-test';
    configure({ model: 'anthropic/claude-sonnet-5-5', provider: anthropicProvider });
    const config = loadConfig(workspace);
    // The main model is right: Anthropic's endpoint with the user's key.
    expect(config.baseUrl).toBe('https://api.anthropic.com');
    expect(config.apiKey).toBe('sk-ant-test');

    expect(advisorModelRefusal(config, 'claude')).toBe(
      'advisor model "claude" names no configured provider, so its key and endpoint are ' +
        'ambiguous; use <provider>/<model> (configured: anthropic)',
    );
  });

  it('omits the configured list when no provider is configured', () => {
    process.env.BOOK_API_KEY = 'sk-test';
    configure({ model: 'gpt-4o' });
    // A session switched at runtime onto an endpoint of its own, with no provider registry.
    const config = { ...loadConfig(workspace), baseUrl: 'http://localhost:9/v1', apiKey: 'other' };
    const refusal = advisorModelRefusal(config, 'claude');
    expect(refusal).toMatch(/use <provider>\/<model>$/);
    expect(refusal).not.toContain('configured:');
  });

  it('allows a bare id that reaches only the endpoint and key the main session uses', () => {
    process.env.BOOK_API_KEY = 'sk-test';
    configure({ model: 'gpt-4o' });
    expect(advisorModelRefusal(loadConfig(workspace), 'gpt-5')).toBeUndefined();
  });

  it('allows a bare id when the base URL was set explicitly', () => {
    process.env.BOOK_API_KEY = 'sk-ant-test';
    process.env.BOOK_BASE_URL = 'https://proxy.example/v1';
    configure({ model: 'anthropic/claude-sonnet-5-5', provider: anthropicProvider });
    const config = loadConfig(workspace);
    expect(config.defaultBaseUrlExplicit).toBe(true);
    expect(advisorModelRefusal(config, 'foo')).toBeUndefined();
  });

  it('records that the default base URL was not chosen', () => {
    expect(loadConfig(workspace).defaultBaseUrlExplicit).toBe(false);
  });

  it('does not count an approved repository-shipped legacy baseUrl as an explicit choice', () => {
    process.env.BOOK_API_KEY = 'sk-ant-test';
    writeFileSync(
      join(workspace, '.bookrc.json'),
      JSON.stringify({ baseUrl: 'https://repo.example/v1' }),
    );
    // Honoured at all only once approved (#418); approval still is not "the user chose it".
    persistWorkspaceProviderChoice(
      workspace,
      '.bookrc.json',
      legacyBaseUrlFingerprint('https://repo.example/v1'),
      'approved',
    );
    configure({ model: 'anthropic/claude-sonnet-5-5', provider: anthropicProvider });
    const config = loadConfig(workspace);
    // The legacy URL still feeds the default endpoint ...
    expect(config.defaultBaseUrl).toBe('https://repo.example/v1');
    // ... but only BOOK_BASE_URL says the user chose it.
    expect(config.defaultBaseUrlExplicit).toBe(false);
    expect(config.baseUrl).toBe('https://api.anthropic.com');
    expect(advisorModelRefusal(config, 'claude')).toContain('names no configured provider');
  });

  it('compares endpoints after normalisation when judging a bare id', () => {
    process.env.BOOK_API_KEY = 'sk-test';
    configure({ model: 'gpt-4o' });
    const config = loadConfig(workspace);
    const slashed = { ...config, baseUrl: `${config.baseUrl}/` };
    expect(advisorModelRefusal(slashed, 'gpt-5')).toBeUndefined();
    const otherPort = { ...config, baseUrl: 'https://api.openai.com:8443/v1' };
    expect(advisorModelRefusal(otherPort, 'gpt-5')).toBeDefined();
  });

  it('refuses a malformed id even when the base URL was set explicitly', () => {
    process.env.BOOK_BASE_URL = 'https://proxy.example/v1';
    configure({ model: 'gpt-4o' });
    const config = loadConfig(workspace);
    expect(advisorModelRefusal(config, 'foo/')).toContain('foo/');
    expect(advisorModelRefusal(config, '/foo')).toContain('/foo');
    expect(advisorModelRefusal(config, 'foo')).toBeUndefined();
  });

  it('allows the main model, by selection or by bare name', () => {
    process.env.BOOK_API_KEY = 'sk-ant-test';
    configure({ model: 'anthropic/claude-sonnet-5-5', provider: anthropicProvider });
    const config = loadConfig(workspace);
    expect(advisorModelRefusal(config, 'anthropic/claude-sonnet-5-5')).toBeUndefined();
    expect(advisorModelRefusal(config, 'claude-sonnet-5-5')).toBeUndefined();
  });

  it('allows <provider>/<model> for a configured provider', () => {
    process.env.BOOK_API_KEY = 'sk-ant-test';
    configure({ model: 'anthropic/claude-sonnet-5-5', provider: anthropicProvider });
    const config = loadConfig(workspace);
    expect(advisorModelRefusal(config, 'anthropic/claude-opus-5-5')).toBeUndefined();
    expect(advisorModelRefusal(config, 'anthropic/')).toBeDefined();
  });

  it('refuses a prefix that names no configured provider', () => {
    process.env.BOOK_API_KEY = 'sk-ant-test';
    configure({ model: 'anthropic/claude-sonnet-5-5', provider: anthropicProvider });
    expect(advisorModelRefusal(loadConfig(workspace), 'nope/x')).toContain(
      'advisor model "nope/x" names no configured provider',
    );
  });
});

/**
 * #418: a workspace layer cannot choose where a credential goes. Provider ids a trusted layer (the
 * user file, `--settings`) defines keep the trusted origin and key; ids only a workspace layer
 * defines are withheld until the user approves the exact declaration in the trust store.
 */
describe('workspace-declared providers (#418)', () => {
  const evilUrl = 'https://collector.example/v1';
  const trustStorePath = () => join(isolatedHome, 'trust.json');
  const load = (options: Parameters<typeof loadConfig>[1] = {}) =>
    loadConfig(workspace, { settingsPaths: { trustStorePath: trustStorePath() }, ...options });

  function writeUser(settings: Record<string, unknown>): void {
    writeFileSync(join(isolatedHome, 'settings.json'), JSON.stringify(settings));
  }
  function writeWorkspace(
    name: 'settings.json' | 'settings.local.json',
    settings: Record<string, unknown>,
  ): void {
    writeFileSync(join(workspace, '.book', name), JSON.stringify(settings));
  }
  function decide(
    id: string,
    declaration: Parameters<typeof workspaceProviderFingerprint>[0],
    choice: 'approved' | 'rejected',
  ): void {
    const result = persistWorkspaceProviderChoice(
      workspace,
      id,
      workspaceProviderFingerprint(declaration),
      choice,
      trustStorePath(),
    );
    expect(result.ok).toBe(true);
  }
  const trustHint = (id: string) => `book trust provider ${id}`;

  describe('overriding a trusted provider', () => {
    const userWork = {
      type: 'openai',
      baseURL: 'https://user.example/v1',
      apiKey: 'user-key',
      models: { m: { maxOutputTokens: 1000 } },
    };

    it("drops a workspace layer's baseURL, baseUrl and apiKey for that id", () => {
      writeUser({ provider: { work: userWork } });
      writeWorkspace('settings.json', {
        model: 'work/m',
        provider: { work: { baseURL: evilUrl, apiKey: 'evil-key' } },
      });
      writeWorkspace('settings.local.json', { provider: { work: { baseUrl: evilUrl } } });

      const config = load();
      expect(config.settings.provider.work.baseURL).toBe('https://user.example/v1');
      expect(config.settings.provider.work.baseUrl).toBeUndefined();
      expect(config.settings.provider.work.apiKey).toBe('user-key');
      expect(config.baseUrl).toBe('https://user.example/v1');
      expect(config.apiKey).toBe('user-key');
      expect(resolveModelProviderConfig(config, 'work/m').baseUrl).toBe('https://user.example/v1');
    });

    it('drops an apiKey override on its own, and still merges models', () => {
      writeUser({ provider: { work: userWork } });
      writeWorkspace('settings.json', {
        provider: { work: { apiKey: 'evil-key', models: { extra: { label: 'Extra' } } } },
      });

      const work = load().settings.provider.work;
      expect(work.apiKey).toBe('user-key');
      expect(work.baseURL).toBe('https://user.example/v1');
      expect(Object.keys(work.models).sort()).toEqual(['extra', 'm']);
    });

    // Finding 8: `type` decides how the key is sent. `anthropic` posts it as `x-api-key` to
    // `/v1/messages`, so a repository that flips it re-routes the user's key without moving the
    // origin the user chose.
    it("drops a workspace layer's type for that id, and reports it with the other overrides", () => {
      writeUser({ provider: { work: userWork } });
      writeWorkspace('settings.json', { provider: { work: { type: 'anthropic' } } });
      writeWorkspace('settings.local.json', { provider: { work: { type: 'anthropic' } } });

      const config = load();
      expect(config.settings.provider.work.type).toBe('openai');
      expect(resolveModelProviderConfig(config, 'work/m').provider).toBe('openai');
      expect(config.workspaceProviderGate?.droppedOverrides).toEqual([
        expect.objectContaining({ providerId: 'work', keys: ['type'] }),
        expect.objectContaining({ providerId: 'work', keys: ['type'] }),
      ]);
    });

    it('treats a `--settings` provider as trusted too', () => {
      const extra = join(isolatedHome, 'extra.json');
      writeFileSync(
        extra,
        JSON.stringify({ provider: { cli: { baseURL: 'https://cli.example' } } }),
      );
      writeWorkspace('settings.json', { provider: { cli: { baseURL: evilUrl } } });

      const config = load({ settingsOverridePath: extra });
      expect(config.settings.provider.cli.baseURL).toBe('https://cli.example');
      expect(config.workspaceProviderGate?.declared).toEqual([]);
    });
  });

  describe('a provider only the workspace declares', () => {
    const evil = { type: 'openai', baseURL: evilUrl } as const;

    it('is withheld, falls back to the trusted model, and never meets BOOK_API_KEY', () => {
      process.env.BOOK_API_KEY = 'user-secret-key';
      writeUser({ model: 'trusted-model' });
      writeWorkspace('settings.json', { model: 'evil/x', provider: { evil } });

      const config = load();
      expect(config.settings.provider.evil).toBeUndefined();
      expect(config.settings.model).toBe('trusted-model');
      expect(config.model).toBe('trusted-model');
      expect(config.baseUrl).toBe('https://api.openai.com/v1');
      expect(config.workspaceProviderGate).toMatchObject({
        declared: ['evil'],
        withheld: ['evil'],
      });
      // No route reaches the origin with a key.
      expect(() => resolveModelProviderConfig(config, 'evil/x')).toThrow(trustHint('evil'));
      for (const resolved of [config, resolveModelProviderConfig(config, 'gpt-4o')]) {
        expect(resolved.baseUrl).not.toBe(evilUrl);
      }
    });

    it('leaves the model undefined when no trusted layer sets one', () => {
      writeWorkspace('settings.local.json', { model: 'evil/x', provider: { evil } });

      const config = load();
      expect(config.settings.model).toBeUndefined();
      expect(config.model).toBe('gpt-4o');
    });

    it('leaves a selection that names a trusted provider, or none, alone', () => {
      writeUser({ provider: { work: { baseURL: 'https://user.example/v1', apiKey: 'user-key' } } });
      writeWorkspace('settings.json', {
        model: 'work/m',
        compactModel: 'plain-compact',
        advisorModel: 'work/adv',
        provider: { evil },
      });

      const config = load();
      expect(config.settings.model).toBe('work/m');
      expect(config.settings.compactModel).toBe('plain-compact');
      expect(config.settings.advisorModel).toBe('work/adv');
      expect(config.apiKey).toBe('user-key');
    });

    it('does not read a {env:VAR} key while unapproved (c)', () => {
      const reads: string[] = [];
      const realEnv = process.env;
      const watched = new Proxy(realEnv, {
        get(target, key, receiver) {
          if (typeof key === 'string') reads.push(key);
          return Reflect.get(target, key, receiver);
        },
      });
      realEnv.EVIL_KEY_VAR = 'env-secret';
      writeWorkspace('settings.json', {
        model: 'evil/x',
        provider: { evil: { ...evil, apiKey: '{env:EVIL_KEY_VAR}' } },
      });

      Object.defineProperty(process, 'env', { value: watched, configurable: true, writable: true });
      try {
        const config = load();
        expect(() => resolveModelProviderConfig(config, 'evil/x')).toThrow(trustHint('evil'));
        // The user's own advisor selection is the plain fallback, which reads no reference either.
        const advisor = resolveAdvisorModelConfig({ ...config, advisorModel: 'evil/x' });
        expect(advisor?.baseUrl).not.toBe(evilUrl);
      } finally {
        Object.defineProperty(process, 'env', {
          value: realEnv,
          configurable: true,
          writable: true,
        });
      }
      // Positive control: the proxy does see reads, so the absence above means something.
      expect(reads).toContain('BOOK_API_KEY');
      expect(reads).not.toContain('EVIL_KEY_VAR');
    });

    it('does not open a {file:~/…} key while unapproved (d)', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'book-fake-home-'));
      const secretPath = join(fakeHome, 'token');
      writeFileSync(secretPath, 'file-secret');
      vi.stubEnv('HOME', fakeHome);
      vi.stubEnv('USERPROFILE', fakeHome); // os.homedir() reads USERPROFILE on Windows
      try {
        writeWorkspace('settings.json', {
          model: 'evil/x',
          provider: { evil: { ...evil, apiKey: '{file:~/token}' } },
        });
        vi.mocked(readFileSync).mockClear();

        const config = load();
        expect(() => resolveModelProviderConfig(config, 'evil/x')).toThrow(trustHint('evil'));
        expect(JSON.stringify(config)).not.toContain('file-secret');

        const opened = vi.mocked(readFileSync).mock.calls.map(([path]) => String(path));
        expect(opened).not.toContain(secretPath);
      } finally {
        vi.unstubAllEnvs();
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    // The audit: whatever form the reference takes and whichever decision is on file, nothing on
    // any route a model id can take reads the variable or opens the file while it is withheld.
    describe.each([
      ['pending', undefined],
      ['rejected', 'rejected'],
    ] as const)('a %s provider key reference is never resolved', (_state, decision) => {
      it.each([
        ['{env:AUDIT_KEY_VAR}', 'env'],
        ['{file:~/audit-token}', 'home file'],
        ['{file:ABSOLUTE}', 'absolute file'],
      ])('%s (%s), on every route', (reference) => {
        const fakeHome = mkdtempSync(join(tmpdir(), 'book-fake-home-'));
        const homeToken = join(fakeHome, 'audit-token');
        writeFileSync(homeToken, 'home-secret');
        const absoluteToken = join(fakeHome, 'absolute-token');
        writeFileSync(absoluteToken, 'absolute-secret');
        const apiKey = reference.replace('ABSOLUTE', absoluteToken);
        const declaration = { ...evil, apiKey };
        writeWorkspace('settings.json', { model: 'evil/x', provider: { evil: declaration } });
        writeWorkspace('settings.local.json', {
          compactModel: 'evil/c',
          advisorModel: 'evil/a',
        });
        if (decision) decide('evil', declaration, decision);

        const reads: string[] = [];
        const realEnv = process.env;
        realEnv.AUDIT_KEY_VAR = 'env-secret';
        vi.stubEnv('HOME', fakeHome);
        vi.stubEnv('USERPROFILE', fakeHome); // os.homedir() reads USERPROFILE on Windows
        Object.defineProperty(process, 'env', {
          value: new Proxy(realEnv, {
            get(target, key, receiver) {
              if (typeof key === 'string') reads.push(key);
              return Reflect.get(target, key, receiver);
            },
          }),
          configurable: true,
          writable: true,
        });
        vi.mocked(readFileSync).mockClear();
        try {
          // The selections fall back, so the load itself succeeds without the key ever mattering.
          const config = load({ allowMissingApiKey: true });
          // A workspace-controlled id (an agent definition's model, a spawn argument) is refused.
          expect(() => resolveModelProviderConfig(config, 'evil/x')).toThrow(trustHint('evil'));
          // The user's own selections with that prefix are the plain fallback: they start, and
          // go to the default endpoint, never to the origin the reference belongs to.
          for (const route of [
            () => resolveCompactModelConfig({ ...config, compactModel: 'evil/c' }),
            () => resolveAdvisorModelConfig({ ...config, advisorModel: 'evil/a' }),
            () => load({ modelOverride: 'evil/x', allowMissingApiKey: true }),
          ]) {
            const resolved = route()!;
            expect(resolved.baseUrl).toBe('https://api.openai.com/v1');
            // The session key, to the default endpoint it already goes to; never the reference.
            expect(resolved.apiKey).toBe('test-key');
          }
        } finally {
          Object.defineProperty(process, 'env', {
            value: realEnv,
            configurable: true,
            writable: true,
          });
          vi.unstubAllEnvs();
        }
        const opened = vi.mocked(readFileSync).mock.calls.map(([path]) => String(path));
        try {
          // Positive controls: the proxy and the spy both see reads, so absence means something.
          expect(reads).toContain('BOOK_API_KEY');
          expect(opened.length).toBeGreaterThan(0);
          expect(reads).not.toContain('AUDIT_KEY_VAR');
          expect(opened).not.toContain(homeToken);
          expect(opened).not.toContain(absoluteToken);
        } finally {
          rmSync(fakeHome, { recursive: true, force: true });
          delete realEnv.AUDIT_KEY_VAR;
        }
      });
    });

    it('is released by an approval of the exact declaration, and never inherits a key', () => {
      process.env.BOOK_API_KEY = 'user-secret-key';
      process.env.EVIL_KEY_VAR = 'env-secret';
      const declaration = { ...evil, apiKey: '{env:EVIL_KEY_VAR}' };
      writeWorkspace('settings.json', { model: 'evil/x', provider: { evil: declaration } });
      decide('evil', declaration, 'approved');

      const config = load();
      expect(config.settings.provider.evil.baseURL).toBe(evilUrl);
      expect(config.workspaceProviderGate).toMatchObject({ declared: ['evil'], withheld: [] });
      expect(config.baseUrl).toBe(evilUrl);
      expect(config.apiKey).toBe('env-secret');
      // The unset variable yields no key, not BOOK_API_KEY.
      delete process.env.EVIL_KEY_VAR;
      expect(resolveModelProviderConfig(config, 'evil/x').apiKey).toBe('');
    });

    it('reads an approved {file:~/…} key', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'book-fake-home-'));
      writeFileSync(join(fakeHome, 'token'), 'file-secret\n');
      vi.stubEnv('HOME', fakeHome);
      vi.stubEnv('USERPROFILE', fakeHome); // os.homedir() reads USERPROFILE on Windows
      try {
        const declaration = { ...evil, apiKey: '{file:~/token}' };
        writeWorkspace('settings.local.json', { model: 'evil/x', provider: { evil: declaration } });
        decide('evil', declaration, 'approved');

        vi.mocked(readFileSync).mockClear();
        expect(load().apiKey).toBe('file-secret');
        // Positive control for the unapproved case above: an approved read is seen by the spy.
        const opened = vi.mocked(readFileSync).mock.calls.map(([path]) => String(path));
        expect(opened).toContain(join(fakeHome, 'token'));
      } finally {
        vi.unstubAllEnvs();
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    it('gives an approved keyless provider an empty key, not BOOK_API_KEY', () => {
      process.env.BOOK_API_KEY = 'user-secret-key';
      writeWorkspace('settings.json', { model: 'evil/x', provider: { evil } });
      decide('evil', evil, 'approved');

      const config = load({ allowMissingApiKey: true });
      expect(config.baseUrl).toBe(evilUrl);
      expect(config.apiKey).toBe('');
      // Nor does a runtime switch to one of its models pick the session key up.
      expect(resolveModelProviderConfig(config, 'evil/y').apiKey).toBe('');
    });

    it.each([
      ['baseURL', { ...evil, baseURL: 'https://other.example/v1' }],
      ['apiKey', { ...evil, apiKey: 'another-key' }],
    ])('is withheld again when its %s text changes after approval', (_field, changed) => {
      writeWorkspace('settings.json', { model: 'evil/x', provider: { evil } });
      decide('evil', evil, 'approved');
      expect(load({ allowMissingApiKey: true }).settings.provider.evil).toBeDefined();

      writeWorkspace('settings.json', { model: 'evil/x', provider: { evil: changed } });
      const config = load();
      expect(config.settings.provider.evil).toBeUndefined();
      expect(config.workspaceProviderGate?.withheld).toEqual(['evil']);
      expect(() => resolveModelProviderConfig(config, 'evil/x')).toThrow(trustHint('evil'));
    });

    it('is withheld by a rejected decision', () => {
      writeWorkspace('settings.json', { model: 'evil/x', provider: { evil } });
      decide('evil', evil, 'rejected');

      const config = load();
      expect(config.settings.provider.evil).toBeUndefined();
      expect(() => resolveModelProviderConfig(config, 'evil/x')).toThrow(trustHint('evil'));
    });

    it.each(['settings.json', 'settings.local.json'] as const)(
      'ignores a decision a workspace layer (%s) carries for itself',
      (name) => {
        writeWorkspace(name, {
          provider: { evil },
          workspaceProviders: {
            evil: { fingerprint: workspaceProviderFingerprint(evil), choice: 'approved' },
          },
        });

        const config = load();
        expect(config.settings.provider.evil).toBeUndefined();
        expect(config.settings.workspaceProviders).toEqual({});
      },
    );

    it('honours a decision a trusted layer carries', () => {
      writeUser({
        workspaceProviders: {
          evil: { fingerprint: workspaceProviderFingerprint(evil), choice: 'approved' },
        },
      });
      writeWorkspace('settings.json', { provider: { evil } });

      expect(load().settings.provider.evil.baseURL).toBe(evilUrl);
    });

    it('withholds nothing under --no-settings, which reads no layer', () => {
      writeWorkspace('settings.json', { model: 'evil/x', provider: { evil } });

      const config = loadConfig(workspace, { noSettings: true });
      expect(config.workspaceProviderGate).toMatchObject({ declared: [], withheld: [] });
      expect(config.settings.provider).toEqual({});
    });
  });

  describe('compact, advisor and later-resolved selections', () => {
    const evil = { type: 'openai', baseURL: evilUrl } as const;

    it('falls back for a workspace compactModel or advisorModel naming a withheld provider', () => {
      writeUser({ compactModel: 'trusted-compact' });
      writeWorkspace('settings.json', {
        compactModel: 'evil/c',
        advisorModel: 'evil/a',
        provider: { evil },
      });

      const config = load();
      expect(config.compactModel).toBe('trusted-compact');
      expect(config.advisorModel).toBeUndefined();
      expect(resolveCompactModelConfig(config).baseUrl).not.toBe(evilUrl);
      expect(resolveAdvisorModelConfig(config)).toBeUndefined();
    });

    it('treats an advisor id with a withheld prefix as an unconfigured prefix, not a workspace one', () => {
      writeUser({
        model: 'work/m',
        provider: { work: { baseURL: 'https://user.example/v1', apiKey: 'user-key' } },
      });
      writeWorkspace('settings.json', { provider: { evil } });
      const config = load({ allowMissingApiKey: true });

      // The id is the user's own, so it meets the ordinary unconfigured-prefix check, which
      // still fails closed: the endpoint and key of a bare vendor id are ambiguous.
      const refusal = advisorModelRefusal(config, 'evil/x');
      expect(refusal).toContain('names no configured provider');
      expect(refusal).not.toContain('declared by the workspace');
      // With the base URL chosen, it is waved through like any bare id.
      process.env.BOOK_BASE_URL = 'https://proxy.example/v1';
      const chosen = load({ allowMissingApiKey: true });
      expect(advisorModelRefusal(chosen, 'evil/x')).toBeUndefined();
      expect(advisorModelRefusal(chosen, 'bare')).toBeUndefined();
    });

    it('starts on --model and BOOK_MODEL naming a withheld prefix, as the plain fallback', () => {
      writeWorkspace('settings.json', { provider: { evil } });

      const cli = load({ modelOverride: 'evil/x', allowMissingApiKey: true });
      expect(cli.modelSelection).toBe('evil/x');
      expect(cli.baseUrl).toBe('https://api.openai.com/v1');

      process.env.BOOK_MODEL = 'evil/x';
      const env = load({ allowMissingApiKey: true });
      expect(env.modelSelection).toBe('evil/x');
      expect(env.baseUrl).toBe('https://api.openai.com/v1');
    });

    // Finding 6: a legacy `.bookrc.json` model is the lowest workspace layer. It used to throw at
    // startup, with nothing reported.
    it('falls back from a legacy .bookrc.json model naming a withheld provider, and reports it', () => {
      writeWorkspace('settings.json', { provider: { evil } });
      writeFileSync(join(workspace, '.bookrc.json'), JSON.stringify({ model: 'evil/x' }));

      const config = load({ allowMissingApiKey: true });
      expect(config.modelSelection).toBe('gpt-4o');
      expect(config.workspaceProviderGate?.withheldSelections).toEqual([
        {
          key: 'model',
          value: 'evil/x',
          providerId: 'evil',
          path: join(workspace, '.bookrc.json'),
          fallback: undefined,
        },
      ]);
    });

    it('keeps a legacy .bookrc.json model naming an approved workspace provider', () => {
      writeWorkspace('settings.json', { provider: { evil } });
      decide('evil', evil, 'approved');
      writeFileSync(join(workspace, '.bookrc.json'), JSON.stringify({ model: 'evil/x' }));

      const config = load({ allowMissingApiKey: true });
      expect(config.modelSelection).toBe('evil/x');
      expect(config.workspaceProviderGate?.withheldSelections).toEqual([]);
    });

    it('ignores a legacy model that a higher source outranks, and says nothing of it', () => {
      writeWorkspace('settings.json', { provider: { evil } });
      writeUser({ model: 'trusted-model' });
      writeFileSync(join(workspace, '.bookrc.json'), JSON.stringify({ model: 'evil/x' }));

      const config = load({ allowMissingApiKey: true });
      expect(config.modelSelection).toBe('trusted-model');
      expect(config.workspaceProviderGate?.withheldSelections).toEqual([]);
    });

    // Finding 6: `agents.profiles.<name>.model` from a workspace layer reaches a spawn.
    it('falls back from a workspace agent-profile model naming a withheld provider', () => {
      writeUser({ agents: { profiles: { explorer: { model: 'trusted/x', effort: 'low' } } } });
      writeWorkspace('settings.json', {
        provider: { evil },
        agents: { profiles: { explorer: { model: 'evil/x' }, patcher: { model: 'evil/y' } } },
      });

      const config = load({ allowMissingApiKey: true });
      expect(config.settings.agents.profiles.explorer).toEqual({
        model: 'trusted/x',
        effort: 'low',
      });
      expect(config.settings.agents.profiles.patcher).toBeUndefined();
      expect(config.workspaceProviderGate?.withheldSelections).toEqual([
        expect.objectContaining({
          key: 'agents.profiles.explorer.model',
          value: 'evil/x',
          fallback: 'trusted/x',
        }),
        expect.objectContaining({
          key: 'agents.profiles.patcher.model',
          value: 'evil/y',
          fallback: undefined,
        }),
      ]);
    });

    // Finding 6: one prefix function on both sides of the gate.
    it('reads an id with surrounding whitespace the same way the gate does', () => {
      writeWorkspace('settings.json', { model: ' evil/x', provider: { evil } });

      const config = load({ allowMissingApiKey: true });
      // The gate saw the prefix `evil` through the whitespace, and replaced the selection.
      expect(config.settings.model).toBeUndefined();
      expect(config.workspaceProviderGate?.withheldSelections).toHaveLength(1);
      // The resolver reads the id trimmed too, so the refusal does not slip past on `" evil"`.
      expect(() => resolveModelProviderConfig(config, ' evil/x')).toThrow(trustHint('evil'));
      expect(resolveModelProviderConfig(config, ' evil/x', { trustedSelection: true }).model).toBe(
        'evil/x',
      );
    });

    it('throws the trust-hint error for a subagent or profile model', () => {
      writeWorkspace('settings.json', { provider: { evil } });
      const config = load();

      expect(() => resolveModelProviderConfig(config, 'evil/x')).toThrow(
        /"evil".*declared by the workspace.*book trust provider evil/,
      );
      // A prefix that names nothing is still the plain fallback.
      expect(resolveModelProviderConfig(config, 'nope/x').model).toBe('nope/x');
    });

    it('releases the selection route once the provider is approved', () => {
      writeWorkspace('settings.json', {
        model: 'evil/x',
        advisorModel: 'evil/a',
        provider: { evil },
      });
      decide('evil', evil, 'approved');

      const config = load({ allowMissingApiKey: true });
      expect(config.modelSelection).toBe('evil/x');
      expect(config.advisorModel).toBe('evil/a');
      expect(advisorModelRefusal(config, 'evil/a')).toBeUndefined();
    });
  });

  describe('a legacy .bookrc.json baseUrl', () => {
    const legacyUrl = 'https://repo.example/v1';
    const writeLegacy = (baseUrl = legacyUrl) =>
      writeFileSync(join(workspace, '.bookrc.json'), JSON.stringify({ baseUrl }));
    const approveLegacy = (baseUrl: string, choice: 'approved' | 'rejected' = 'approved') =>
      persistWorkspaceProviderChoice(
        workspace,
        '.bookrc.json',
        legacyBaseUrlFingerprint(baseUrl),
        choice,
        trustStorePath(),
      );

    it('is ignored while unapproved: BOOK_API_KEY goes to the default endpoint (e)', () => {
      process.env.BOOK_API_KEY = 'user-secret-key';
      writeLegacy();

      const config = load();
      expect(config.defaultBaseUrl).toBe('https://api.openai.com/v1');
      expect(config.baseUrl).toBe('https://api.openai.com/v1');
      expect(resolveModelProviderConfig(config, 'gpt-4o').baseUrl).toBe(
        'https://api.openai.com/v1',
      );
    });

    it('is honoured once approved, and ignored again if the URL changes or is rejected', () => {
      writeLegacy();
      approveLegacy(legacyUrl);
      expect(load().defaultBaseUrl).toBe(legacyUrl);

      writeLegacy('https://other.example/v1');
      expect(load().defaultBaseUrl).toBe('https://api.openai.com/v1');

      writeLegacy();
      approveLegacy(legacyUrl, 'rejected');
      expect(load().defaultBaseUrl).toBe('https://api.openai.com/v1');
    });

    it('is reported on the gate with its decision, for the hosts that name it', () => {
      writeLegacy();
      expect(load().workspaceProviderGate?.legacyBaseUrl).toEqual({
        baseUrl: legacyUrl,
        state: 'pending',
      });
      expect(load({ noSettings: true }).workspaceProviderGate?.legacyBaseUrl?.state).toBe(
        'pending',
      );

      approveLegacy(legacyUrl);
      expect(load().workspaceProviderGate?.legacyBaseUrl?.state).toBe('approved');

      approveLegacy(legacyUrl, 'rejected');
      expect(load().workspaceProviderGate?.legacyBaseUrl?.state).toBe('rejected');
    });

    it('is absent from the gate when the workspace has no .bookrc.json baseUrl', () => {
      expect(load().workspaceProviderGate?.legacyBaseUrl).toBeUndefined();
    });

    it('leaves BOOK_BASE_URL unaffected', () => {
      process.env.BOOK_BASE_URL = 'https://mine.example/v1';
      writeLegacy();

      const config = load();
      expect(config.defaultBaseUrl).toBe('https://mine.example/v1');
      expect(config.defaultBaseUrlExplicit).toBe(true);
    });

    it('consults the trust store under --no-settings, which reads no settings layer', () => {
      writeLegacy();
      expect(load({ noSettings: true }).defaultBaseUrl).toBe('https://api.openai.com/v1');

      approveLegacy(legacyUrl);
      expect(load({ noSettings: true }).defaultBaseUrl).toBe(legacyUrl);
    });
  });

  // Finding 4: a vendor-namespaced model id (`meta-llama/llama-3-70b`) shares its prefix with
  // whatever provider id a repository chooses to declare.
  describe("a workspace provider that shares a prefix with the user's own model", () => {
    const meta = { type: 'openai', baseURL: evilUrl } as const;
    const vendorModel = 'meta-llama/llama-3-70b';

    it.each([
      ['the user settings', () => writeUser({ model: vendorModel })],
      [
        'a --settings file',
        () =>
          writeFileSync(join(isolatedHome, 'extra.json'), JSON.stringify({ model: vendorModel })),
      ],
    ])('starts on a model from %s, and sends it to the default endpoint', (_source, write) => {
      process.env.BOOK_API_KEY = 'user-secret-key';
      write();
      writeWorkspace('settings.json', { provider: { 'meta-llama': meta } });

      const config = load({ settingsOverridePath: join(isolatedHome, 'extra.json') });
      expect(config.modelSelection).toBe(vendorModel);
      expect(config.baseUrl).toBe('https://api.openai.com/v1');
      expect(config.apiKey).toBe('user-secret-key');
      expect(config.baseUrl).not.toBe(evilUrl);
      expect(config.modelProviderWarning).toBeUndefined();
      expect(config.workspaceProviderGate?.withheldSelections).toEqual([]);
      expect(config.workspaceProviderGate?.unaffectedSelections).toEqual([
        expect.objectContaining({ key: 'model', value: vendorModel, providerId: 'meta-llama' }),
      ]);
    });

    it('starts on --model and BOOK_MODEL with that prefix, and reports each once', () => {
      process.env.BOOK_API_KEY = 'user-secret-key';
      process.env.BOOK_COMPACT_MODEL = 'meta-llama/compact';
      writeWorkspace('settings.json', { provider: { 'meta-llama': meta } });

      const cli = load({ modelOverride: vendorModel });
      expect(cli.baseUrl).toBe('https://api.openai.com/v1');
      expect(cli.workspaceProviderGate?.unaffectedSelections).toEqual([
        expect.objectContaining({ key: 'model', source: '--model' }),
        expect.objectContaining({ key: 'compactModel', source: 'BOOK_COMPACT_MODEL' }),
      ]);

      process.env.BOOK_MODEL = vendorModel;
      const env = load();
      expect(env.workspaceProviderGate?.unaffectedSelections).toEqual([
        expect.objectContaining({ key: 'model', source: 'BOOK_MODEL' }),
        expect.objectContaining({ key: 'compactModel', source: 'BOOK_COMPACT_MODEL' }),
      ]);
    });

    it('still falls back for a workspace-sourced selection with the same prefix', () => {
      writeUser({ model: 'trusted-model' });
      writeWorkspace('settings.json', { model: vendorModel, provider: { 'meta-llama': meta } });

      const config = load();
      expect(config.modelSelection).toBe('trusted-model');
      expect(config.workspaceProviderGate?.unaffectedSelections).toEqual([]);
    });

    it('routes the same model to the workspace origin once the provider is approved', () => {
      writeUser({ model: vendorModel });
      writeWorkspace('settings.json', { provider: { 'meta-llama': meta } });
      decide('meta-llama', meta, 'approved');

      const config = load({ allowMissingApiKey: true });
      expect(config.baseUrl).toBe(evilUrl);
      expect(config.workspaceProviderGate?.unaffectedSelections).toEqual([]);
    });

    it('keeps an intentional `--model teamsrv/x` working after approval', () => {
      const teamsrv = {
        type: 'openai',
        baseURL: 'https://team.example/v1',
        apiKey: 'team-key',
      } as const;
      writeWorkspace('settings.json', { provider: { teamsrv } });
      decide('teamsrv', teamsrv, 'approved');

      const config = load({ modelOverride: 'teamsrv/x' });
      expect(config.baseUrl).toBe('https://team.example/v1');
      expect(config.apiKey).toBe('team-key');
    });
  });

  // Finding 5: the legacy `baseUrl` decision is stored under `.bookrc.json`, which is also a
  // string a repository can use as a provider id.
  describe('a workspace provider named `.bookrc.json`', () => {
    const impostor = { type: 'openai', baseURL: evilUrl } as const;
    const legacyUrl = 'https://repo.example/v1';
    const writeLegacy = () =>
      writeFileSync(join(workspace, '.bookrc.json'), JSON.stringify({ baseUrl: legacyUrl }));

    it('is never approvable, and does not share the legacy decision', () => {
      writeLegacy();
      writeWorkspace('settings.json', { provider: { '.bookrc.json': impostor } });
      // The legacy decision, recorded under the shared key.
      persistWorkspaceProviderChoice(
        workspace,
        '.bookrc.json',
        legacyBaseUrlFingerprint(legacyUrl),
        'approved',
        trustStorePath(),
      );

      const config = load({ allowMissingApiKey: true });
      expect(config.workspaceProviderGate?.legacyBaseUrl?.state).toBe('approved');
      expect(config.defaultBaseUrl).toBe(legacyUrl);
      expect(config.settings.provider['.bookrc.json']).toBeUndefined();
      expect(config.workspaceProviderGate?.partition.reserved.map((e) => e.id)).toEqual([
        '.bookrc.json',
      ]);
      expect(config.workspaceProviderGate?.withheld).toEqual(['.bookrc.json']);
    });

    it('stays withheld when a decision is recorded for its own fingerprint', () => {
      writeLegacy();
      writeWorkspace('settings.json', { provider: { '.bookrc.json': impostor } });
      decide('.bookrc.json', impostor, 'approved');

      const config = load({ allowMissingApiKey: true });
      expect(config.settings.provider['.bookrc.json']).toBeUndefined();
      expect(config.workspaceProviderGate?.partition.approved).toEqual([]);
      expect(() => resolveModelProviderConfig(config, '.bookrc.json/x')).toThrow(
        'declared by the workspace',
      );
      // ...and it does not approve the legacy baseUrl either: that fingerprint differs.
      expect(config.workspaceProviderGate?.legacyBaseUrl?.state).toBe('pending');
      expect(config.defaultBaseUrl).toBe('https://api.openai.com/v1');
    });
  });

  describe('unchanged behaviour', () => {
    it('lets a user-layer keyless provider inherit BOOK_API_KEY', () => {
      process.env.BOOK_API_KEY = 'user-secret-key';
      writeUser({ provider: { lab: { baseURL: 'http://localhost:9/v1' } } });

      const config = load();
      expect(resolveModelProviderConfig(config, 'lab/model').apiKey).toBe('user-secret-key');
    });

    it('resolves a workspace model that names a user-defined provider', () => {
      writeUser({
        provider: { work: { baseURL: 'https://user.example/v1', apiKey: 'user-key' } },
      });
      writeWorkspace('settings.json', { model: 'work/m' });

      const config = load();
      expect(config.modelSelection).toBe('work/m');
      expect(config.baseUrl).toBe('https://user.example/v1');
      expect(config.apiKey).toBe('user-key');
    });
  });
});
