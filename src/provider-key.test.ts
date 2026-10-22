import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isolateBookHome } from './test/isolated-book-home.js';
import { defaultConfig } from './test/fixtures.js';
import { ModelDiscoveryError } from './provider/model-discovery.js';
import {
  checkProviderKey,
  providerKeyTarget,
  validateApiKey,
  writeProviderKey,
} from './provider-key.js';

const bookHome = isolateBookHome('book-provider-key-home-');
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-provider-key-ws-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const NEW_KEY = 'sk-new-0123456789';

function userPath(): string {
  return join(bookHome(), 'settings.json');
}

function localPath(): string {
  return join(workspace, '.book', 'settings.local.json');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

const retry = defaultConfig().retry;

describe('validateApiKey', () => {
  it('accepts what the wizard accepts and refuses line breaks', () => {
    expect(validateApiKey('sk-1')).toBe('sk-1');
    expect(validateApiKey('{env:GATEWAY_KEY}')).toBe('{env:GATEWAY_KEY}');
    expect(validateApiKey('{file:~/.keys/gw}')).toBe('{file:~/.keys/gw}');
    expect(() => validateApiKey('  ')).toThrow('API key is required.');
    expect(() => validateApiKey('a\nb')).toThrow('cannot contain line breaks');
  });
});

describe('providerKeyTarget', () => {
  it('finds a provider the user file defines', () => {
    writeJson(userPath(), {
      provider: { gw: { type: 'openai', baseURL: 'https://gw.test/v1', models: {} } },
    });
    const target = providerKeyTarget(workspace, 'gw');
    expect(target.kind).toBe('owned');
    if (target.kind === 'owned') expect(target.provider.baseURL).toBe('https://gw.test/v1');
  });

  it('names the workspace file of a provider only the repository declares', () => {
    writeJson(userPath(), { provider: { mine: { type: 'openai', models: {} } } });
    writeJson(join(workspace, '.book', 'settings.json'), {
      provider: { repo: { type: 'openai', baseURL: 'https://evil.test/v1', models: {} } },
    });
    expect(providerKeyTarget(workspace, 'repo')).toMatchObject({
      kind: 'workspace-only',
      declaredIn: join(workspace, '.book', 'settings.json'),
    });
    writeJson(localPath(), { provider: { forced: { type: 'openai', models: {} } } });
    expect(providerKeyTarget(workspace, 'forced')).toMatchObject({
      kind: 'workspace-only',
      declaredIn: localPath(),
    });
  });

  it('lists the configured ids for an unknown one', () => {
    writeJson(userPath(), {
      provider: { b: { type: 'openai', models: {} }, a: { type: 'openai', models: {} } },
    });
    expect(providerKeyTarget(workspace, 'nope')).toMatchObject({
      kind: 'unknown',
      configured: ['a', 'b'],
    });
    expect(providerKeyTarget(workspace, 'constructor').kind).toBe('unknown');
  });

  it('accepts an entry whose only fault is the key being replaced', () => {
    writeJson(userPath(), {
      provider: { gw: { type: 'openai', baseURL: 'https://gw.test/v1', apiKey: '' } },
    });
    expect(providerKeyTarget(workspace, 'gw').kind).toBe('owned');
    expect(writeProviderKey(workspace, 'gw', NEW_KEY).ok).toBe(true);
    expect(readJson(userPath())).toEqual({
      provider: { gw: { type: 'openai', baseURL: 'https://gw.test/v1', apiKey: NEW_KEY } },
    });
  });

  it('reports a user file that is not settings', () => {
    mkdirSync(bookHome(), { recursive: true });
    writeFileSync(userPath(), '{ "provider": ');
    expect(providerKeyTarget(workspace, 'gw').kind).toBe('unreadable');
  });
});

describe('writeProviderKey', () => {
  it('changes only apiKey, leaving a hand-written entry without schema defaults', () => {
    const before = {
      model: 'gw/manual-one',
      effort: 'high',
      provider: {
        // Hand-written: no `type`, no `models` — a schema round trip would add both.
        'my.gw': { baseURL: 'https://gw.test/v1', apiKey: 'sk-old' },
        gw: {
          type: 'anthropic',
          baseURL: 'https://gw.test',
          apiKey: '{env:OLD_KEY}',
          models: {
            'manual-one': { manual: true, label: 'Manual', contextWindow: 64_000 },
            discovered: { reportedContextWindow: 200_000, effort: false },
          },
        },
      },
    };
    writeJson(userPath(), before);

    expect(writeProviderKey(workspace, 'my.gw', NEW_KEY)).toEqual({ ok: true, path: userPath() });
    expect(writeProviderKey(workspace, 'gw', '{env:NEW_KEY}')).toEqual({
      ok: true,
      path: userPath(),
    });

    const expected = structuredClone(before);
    expected.provider['my.gw'].apiKey = NEW_KEY;
    expected.provider.gw.apiKey = '{env:NEW_KEY}';
    expect(readJson(userPath())).toEqual(expected);
  });

  it('clears the connection keys of a same-named local entry and keeps its overrides', () => {
    writeJson(userPath(), {
      provider: { gw: { type: 'openai', baseURL: 'https://gw.test/v1', apiKey: 'sk-old' } },
    });
    writeJson(localPath(), {
      model: 'gw/one',
      provider: {
        gw: {
          type: 'openai',
          baseURL: 'https://shadow.test/v1',
          apiKey: 'sk-stale-local',
          models: { one: { contextWindow: 32_000, reportedContextWindow: 100_000 } },
        },
        other: { apiKey: 'sk-other' },
      },
    });

    expect(writeProviderKey(workspace, 'gw', NEW_KEY)).toEqual({
      ok: true,
      path: userPath(),
      localCleared: localPath(),
    });
    // No catalog refresh and no activation happened, so the reported window and the local model
    // stay; only the connection keys go.
    expect(readJson(localPath())).toEqual({
      model: 'gw/one',
      provider: {
        gw: { models: { one: { contextWindow: 32_000, reportedContextWindow: 100_000 } } },
        other: { apiKey: 'sk-other' },
      },
    });
  });

  it('never creates a local file or a local entry', () => {
    writeJson(userPath(), { provider: { gw: { type: 'openai', models: {} } } });
    expect(writeProviderKey(workspace, 'gw', NEW_KEY).ok).toBe(true);
    expect(existsSync(localPath())).toBe(false);

    const local = `${JSON.stringify({ provider: { other: { apiKey: 'x' } } }, null, 2)}\n`;
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(localPath(), local);
    expect(writeProviderKey(workspace, 'gw', NEW_KEY)).toEqual({ ok: true, path: userPath() });
    expect(readFileSync(localPath(), 'utf-8')).toBe(local);
  });

  it('refuses an id the user file does not define, writing nothing', () => {
    const before = `${JSON.stringify({ provider: { gw: { type: 'openai' } } }, null, 2)}\n`;
    mkdirSync(bookHome(), { recursive: true });
    writeFileSync(userPath(), before);
    writeJson(join(workspace, '.book', 'settings.json'), {
      provider: { repo: { type: 'openai', models: {} } },
    });

    const result = writeProviderKey(workspace, 'repo', NEW_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('"repo" is not configured');
      expect(result.error).not.toContain(NEW_KEY);
    }
    expect(readFileSync(userPath(), 'utf-8')).toBe(before);
  });
});

describe('checkProviderKey', () => {
  const provider = { type: 'openai' as const, baseURL: 'https://gw.test/v1' };

  it('asks only the configured endpoint, with the resolved key and a capped retry', async () => {
    const discover = vi.fn(async () => [{ id: 'a' }, { id: 'b' }]);
    process.env.PROVIDER_KEY_TEST = NEW_KEY;
    try {
      await expect(
        checkProviderKey({
          provider,
          apiKey: '{env:PROVIDER_KEY_TEST}',
          workspace,
          retry,
          discover,
        }),
      ).resolves.toEqual({ ok: true, modelCount: 2 });
    } finally {
      delete process.env.PROVIDER_KEY_TEST;
    }
    expect(discover).toHaveBeenCalledTimes(1);
    const [options] = discover.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(options).toMatchObject({
      type: 'openai',
      baseUrl: 'https://gw.test/v1',
      apiKey: NEW_KEY,
    });
    // One request: `maxAttempts` counts retries after the first.
    expect((options.retry as typeof retry).maxAttempts).toBe(0);
    expect((options.retry as typeof retry).requestTimeoutMs).toBeLessThanOrEqual(20_000);
  });

  it('sends nothing for a provider without a base URL', async () => {
    const discover = vi.fn(async () => [{ id: 'a' }]);
    const result = await checkProviderKey({
      provider: { type: 'openai' },
      apiKey: NEW_KEY,
      workspace,
      retry,
      discover,
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('no base URL') });
    expect(discover).not.toHaveBeenCalled();
  });

  it('names an unresolved reference without sending anything', async () => {
    const discover = vi.fn(async () => [{ id: 'a' }]);
    delete process.env.PROVIDER_KEY_UNSET;
    await expect(
      checkProviderKey({
        provider,
        apiKey: '{env:PROVIDER_KEY_UNSET}',
        workspace,
        retry,
        discover,
      }),
    ).resolves.toEqual({ ok: false, error: 'Environment variable PROVIDER_KEY_UNSET is not set.' });
    expect(discover).not.toHaveBeenCalled();
  });

  it('reports a failure without the key in it', async () => {
    const discover = vi.fn(async () => {
      throw new ModelDiscoveryError(`rejected ${NEW_KEY} for this route`, 'auth');
    });
    const result = await checkProviderKey({
      provider,
      apiKey: NEW_KEY,
      workspace,
      retry,
      discover,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('rejected [redacted: provider key] for this route');
      expect(result.error).not.toContain(NEW_KEY);
    }
  });
});
