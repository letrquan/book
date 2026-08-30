import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyModelDefaults,
  freezeAgentConfig,
  loadConfig,
  resolveCompactModelConfig,
  resolveModelProviderConfig,
} from './config.js';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { defaultConfig } from './test/fixtures.js';
import { tmpdir } from 'os';

let workspace: string;
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
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_PROXY_KEY;
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  // Restore env.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, origEnv);
});

describe('loadConfig retry defaults', () => {
  it('loads default retry config (10 attempts, 600s timeout)', () => {
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.maxAttempts).toBe(10);
    expect(config.retry.requestTimeoutMs).toBe(600000);
    expect(config.retry.streamStallTimeoutMs).toBe(20000);
    expect(config.retry.toolRetries).toBe(1);
    expect(config.retry.watchdog).toBe(false);
    expect(config.retry.baseDelayMs).toBe(1000);
    expect(config.retry.maxDelayMs).toBe(30000);
    expect(config.retry.totalBudgetMs).toBe(0);
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

  it('keeps summary compaction and the Zero-Mem experiment disabled by default', () => {
    const config = loadConfig(workspace, { noSettings: true });

    expect(config.compactStrategy).toBe('summary');
    expect(config.experimentalZeroMem).toBe(false);
    expect(config.settings.experimental.zeroMem).toBe(false);
  });

  it('loads the Zero-Mem experiment from the trusted user-global settings file', () => {
    const bookHome = join(workspace, 'book-home');
    mkdirSync(bookHome, { recursive: true });
    writeFileSync(
      join(bookHome, 'settings.json'),
      JSON.stringify({ experimental: { zeroMem: true } }),
    );
    process.env.BOOK_HOME = bookHome;

    const config = loadConfig(workspace);

    expect(config.compactStrategy).toBe('summary');
    expect(config.experimentalZeroMem).toBe(true);
    expect(config.settings.experimental.zeroMem).toBe(true);
  });

  it('loads the Zero-Mem experiment from an explicit --settings document', () => {
    const overridePath = join(workspace, 'explicit-settings.json');
    writeFileSync(overridePath, JSON.stringify({ experimental: { zeroMem: true } }));

    expect(loadConfig(workspace, { settingsOverridePath: overridePath }).experimentalZeroMem).toBe(
      true,
    );
  });

  it('allows a strict environment opt-in and opt-out for the Zero-Mem experiment', () => {
    process.env.BOOK_EXPERIMENTAL_ZERO_MEM = ' TRUE ';
    expect(loadConfig(workspace, { noSettings: true }).experimentalZeroMem).toBe(true);

    process.env.BOOK_EXPERIMENTAL_ZERO_MEM = 'false';
    expect(loadConfig(workspace, { noSettings: true }).experimentalZeroMem).toBe(false);

    process.env.BOOK_EXPERIMENTAL_ZERO_MEM = '1';
    expect(() => loadConfig(workspace, { noSettings: true })).toThrow(
      'BOOK_EXPERIMENTAL_ZERO_MEM must be "true" or "false"',
    );
  });

  it('rejects legacy Zero-Mem environment selection with migration guidance', () => {
    process.env.BOOK_COMPACT_STRATEGY = 'SUMMARY';
    expect(loadConfig(workspace, { noSettings: true }).compactStrategy).toBe('summary');

    process.env.BOOK_COMPACT_STRATEGY = 'zero-mem';
    expect(() => loadConfig(workspace, { noSettings: true })).toThrow(
      'BOOK_EXPERIMENTAL_ZERO_MEM=true',
    );

    process.env.BOOK_COMPACT_STRATEGY = 'invalid';
    expect(() => loadConfig(workspace, { noSettings: true })).toThrow(
      'BOOK_COMPACT_STRATEGY is deprecated',
    );
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

describe('loadConfig harness boundary', () => {
  it('loads the inert off mode', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'off' } }),
    );

    expect(loadConfig(workspace).settings.harness.mode).toBe('off');
  });

  it('rejects a valid future mode before constructing runtime configuration', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'shadow' } }),
    );

    expect(() => loadConfig(workspace)).toThrow('Harness mode "shadow"');
  });

  it('accepts a workflow selection under an enabled mode', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'observe', workflow: 'safe-edit' } }),
    );

    expect(loadConfig(workspace).settings.harness.workflow).toBe('safe-edit');
  });

  it('fails closed when a workflow is selected while the harness is off', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'off', workflow: 'safe-edit' } }),
    );

    expect(() => loadConfig(workspace)).toThrow('requires an enabled harness mode');
  });

  it('rejects an unknown workflow id at load time', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'observe', workflow: 'does-not-exist' } }),
    );

    expect(() => loadConfig(workspace)).toThrow('Unknown harness workflow "does-not-exist"');
  });

  it('rejects a path-like workflow id before it can address the candidate store', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'observe', workflow: '../candidates/evil' } }),
    );

    expect(() => loadConfig(workspace)).toThrow();
  });

  it('leaves an off run on the baseline label when no workflow is selected', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'off' } }),
    );

    const config = loadConfig(workspace);
    expect(config.settings.harness.workflow).toBeUndefined();
    expect(config.harnessWorkflowOverride).toBeUndefined();
  });

  it('rejects an unavailable mode before a requested migration creates storage', () => {
    const bookHome = join(workspace, 'isolated-book-home');
    mkdirSync(bookHome, { recursive: true });
    writeFileSync(
      join(bookHome, 'permissions.json'),
      JSON.stringify({ rules: [{ toolName: 'Read', effect: 'allow' }] }),
    );
    process.env.BOOK_HOME = bookHome;
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'shadow' } }),
    );

    expect(() => loadConfig(workspace, { runMigrations: true })).toThrow('Harness mode "shadow"');
    expect(existsSync(join(workspace, '.book', 'settings.local.json'))).toBe(false);
    expect(existsSync(join(workspace, '.book', 'migrations.json'))).toBe(false);
  });

  it('re-resolves settings after a requested migration succeeds', () => {
    const bookHome = join(workspace, 'isolated-book-home');
    mkdirSync(bookHome, { recursive: true });
    writeFileSync(
      join(bookHome, 'permissions.json'),
      JSON.stringify({ rules: [{ toolName: 'Read', effect: 'allow' }] }),
    );
    process.env.BOOK_HOME = bookHome;

    const config = loadConfig(workspace, { runMigrations: true });

    expect(config.settings.permissions.allow).toContain('Read');
    expect(existsSync(join(workspace, '.book', 'migrations.json'))).toBe(true);
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
      join(workspace, '.book', 'settings.local.json'),
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
      join(workspace, '.book', 'settings.local.json'),
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
      join(workspace, '.book', 'settings.local.json'),
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
      join(workspace, '.book', 'settings.local.json'),
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
      join(workspace, '.book', 'settings.local.json'),
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

  it('errors clearly when provider api key env var is missing', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.local.json'),
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
      join(workspace, '.book', 'settings.local.json'),
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
      join(workspace, '.book', 'settings.local.json'),
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

  it('rejects provider-prefixed models with an empty model name', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.local.json'),
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
        join(workspace, '.book', 'settings.local.json'),
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
