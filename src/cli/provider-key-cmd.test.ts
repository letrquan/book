import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough, Readable } from 'stream';
import { isolateBookHome } from '../test/isolated-book-home.js';
import { ModelDiscoveryError } from '../provider/model-discovery.js';
import { runConfigCommand } from './config-cmd.js';
import { setExitFn } from './exit.js';
import type { ProviderKeyCommandOptions, ProviderKeyInput } from './provider-key-cmd.js';

const bookHome = isolateBookHome('book-provider-key-cmd-home-');
let workspace: string;
let out: string[];
let err: string[];

const NEW_KEY = 'sk-new-0123456789';

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-provider-key-cmd-ws-'));
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => void out.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...args) => void err.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args) => void err.push(args.join(' ')));
  setExitFn((code: number): never => {
    throw new Error(`exit ${code}`);
  });
});

afterEach(() => {
  setExitFn((code: number): never => process.exit(code));
  vi.restoreAllMocks();
  rmSync(workspace, { recursive: true, force: true });
});

function userPath(): string {
  return join(bookHome(), 'settings.json');
}

function seedUser(
  value: unknown = {
    provider: {
      gw: {
        type: 'openai',
        baseURL: 'https://gw.test/v1',
        apiKey: 'sk-old',
        models: { manual: { manual: true } },
      },
    },
  },
): string {
  mkdirSync(bookHome(), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(userPath(), text);
  return text;
}

function userKey(id = 'gw'): unknown {
  const document = JSON.parse(readFileSync(userPath(), 'utf-8')) as {
    provider: Record<string, { apiKey?: string }>;
  };
  return document.provider[id]?.apiKey;
}

function piped(text: string): ProviderKeyInput {
  return Readable.from([text]);
}

/** A stdin that claims to be a terminal and answers each prompt with the next line. */
function terminal(lines: string[]): { input: ProviderKeyInput; rawModes: boolean[] } {
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(mode: boolean) {
      rawModes.push(mode);
      return input;
    },
  });
  const feed = [...lines];
  // readline attaches its listener when a prompt opens: answer one prompt per resume.
  input.on('resume', () => {
    const next = feed.shift();
    if (next !== undefined) setTimeout(() => input.write(`${next}\r`), 5);
  });
  return { input, rawModes };
}

async function run(
  id: string | undefined,
  { scope, ...options }: ProviderKeyCommandOptions,
  extra?: string,
): Promise<string | undefined> {
  try {
    await runConfigCommand(workspace, 'provider-key', id, extra, {
      scope,
      providerKey: { stderr: new PassThrough(), ...options },
    });
    return undefined;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

describe('book config provider-key', () => {
  it('reads a piped key, checks it, and saves only the key', async () => {
    seedUser();
    const discover = vi.fn(async () => [{ id: 'one' }]);
    expect(await run('gw', { stdin: piped(`${NEW_KEY}\n`), discover })).toBeUndefined();

    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://gw.test/v1', apiKey: NEW_KEY }),
    );
    expect(JSON.parse(readFileSync(userPath(), 'utf-8'))).toEqual({
      provider: {
        gw: {
          type: 'openai',
          baseURL: 'https://gw.test/v1',
          apiKey: NEW_KEY,
          models: { manual: { manual: true } },
        },
      },
    });
    expect(out.join('\n')).toContain('Updated the API key of provider "gw"');
    expect([...out, ...err].join('\n')).not.toContain(NEW_KEY);
  });

  it('strips one trailing line ending from piped input', async () => {
    seedUser();
    expect(await run('gw', { stdin: piped(`${NEW_KEY}\r\n`), check: false })).toBeUndefined();
    expect(userKey()).toBe(NEW_KEY);
  });

  it('skips the endpoint with --no-check', async () => {
    seedUser();
    const discover = vi.fn(async () => [{ id: 'one' }]);
    expect(await run('gw', { stdin: piped(NEW_KEY), check: false, discover })).toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
    expect(userKey()).toBe(NEW_KEY);
  });

  it('refuses a key on the command line without echoing it', async () => {
    const before = seedUser();
    expect(await run('gw', { stdin: piped('') }, NEW_KEY)).toBe('exit 1');
    expect(err.join('\n')).toContain('stdin');
    expect([...out, ...err].join('\n')).not.toContain(NEW_KEY);
    expect(readFileSync(userPath(), 'utf-8')).toBe(before);
  });

  it('fails on an unknown id', async () => {
    seedUser();
    expect(await run('nope', { stdin: piped(NEW_KEY), check: false })).toBe('exit 1');
    expect(err.join('\n')).toContain('No provider "nope"');
    expect(err.join('\n')).toContain('gw');
  });

  it('refuses a provider only the repository declares', async () => {
    const before = seedUser();
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ provider: { repo: { type: 'openai', baseURL: 'https://evil.test/v1' } } }),
    );
    const discover = vi.fn(async () => [{ id: 'one' }]);
    expect(await run('repo', { stdin: piped(NEW_KEY), discover })).toBe('exit 1');
    expect(err.join('\n')).toContain('declared by this repository');
    expect(discover).not.toHaveBeenCalled();
    expect(readFileSync(userPath(), 'utf-8')).toBe(before);
  });

  it('refuses a workspace scope', async () => {
    const before = seedUser();
    expect(await run('gw', { stdin: piped(NEW_KEY), check: false, scope: 'local' })).toBe('exit 1');
    expect(err.join('\n')).toContain('user settings');
    expect(readFileSync(userPath(), 'utf-8')).toBe(before);
  });

  it('writes nothing when the check fails on piped input', async () => {
    const before = seedUser();
    const discover = vi.fn(async () => {
      throw new ModelDiscoveryError('Model discovery was not authorized.', 'auth');
    });
    expect(await run('gw', { stdin: piped(NEW_KEY), discover })).toBe('exit 1');
    expect(err.join('\n')).toContain('Model discovery was not authorized.');
    expect(err.join('\n')).toContain('--force');
    expect(readFileSync(userPath(), 'utf-8')).toBe(before);
  });

  it('saves despite a failed check with --force', async () => {
    seedUser();
    const discover = vi.fn(async () => {
      throw new ModelDiscoveryError('The model-list endpoint is not supported.', 'unsupported');
    });
    expect(await run('gw', { stdin: piped(NEW_KEY), discover, force: true })).toBeUndefined();
    expect(userKey()).toBe(NEW_KEY);
    expect(err.join('\n')).toContain('not supported');
  });

  it('refuses piped input far longer than any key', async () => {
    const before = seedUser();
    expect(await run('gw', { stdin: piped('x'.repeat(70 * 1024)), check: false })).toBe('exit 1');
    expect(err.join('\n')).toContain('longer than');
    expect(readFileSync(userPath(), 'utf-8')).toBe(before);
  });

  it('refuses an empty key', async () => {
    const before = seedUser();
    expect(await run('gw', { stdin: piped('\n'), check: false })).toBe('exit 1');
    expect(err.join('\n')).toContain('API key is required.');
    expect(readFileSync(userPath(), 'utf-8')).toBe(before);
  });

  describe('on a terminal', () => {
    it('reads the key hidden and restores the terminal', async () => {
      seedUser();
      const stderr = new PassThrough();
      let echoed = '';
      stderr.on('data', (chunk) => (echoed += String(chunk)));
      const { input, rawModes } = terminal([NEW_KEY]);
      expect(await run('gw', { stdin: input, stderr, check: false })).toBeUndefined();
      expect(userKey()).toBe(NEW_KEY);
      expect(echoed).toContain('API key for gw');
      expect(echoed).not.toContain(NEW_KEY);
      expect(rawModes.at(-1)).toBe(false);
    });

    it('offers save anyway after a failed check', async () => {
      seedUser();
      const discover = vi.fn(async () => {
        throw new ModelDiscoveryError('Model discovery was not authorized.', 'auth');
      });
      const { input } = terminal([NEW_KEY, 's']);
      expect(await run('gw', { stdin: input, discover })).toBeUndefined();
      expect(userKey()).toBe(NEW_KEY);
    });

    it('retries the check with the same key', async () => {
      seedUser();
      const discover = vi
        .fn()
        .mockRejectedValueOnce(new ModelDiscoveryError('Could not reach it.', 'network'))
        .mockResolvedValueOnce([{ id: 'one' }]);
      const { input } = terminal([NEW_KEY, 'r']);
      expect(await run('gw', { stdin: input, discover })).toBeUndefined();
      expect(discover).toHaveBeenCalledTimes(2);
      expect(userKey()).toBe(NEW_KEY);
    });

    it('takes a different key after a failed check', async () => {
      seedUser();
      const discover = vi
        .fn()
        .mockRejectedValueOnce(new ModelDiscoveryError('Not authorized.', 'auth'))
        .mockResolvedValueOnce([{ id: 'one' }]);
      const { input } = terminal(['sk-wrong', 'e', NEW_KEY]);
      expect(await run('gw', { stdin: input, discover })).toBeUndefined();
      expect(discover.mock.calls.map(([options]) => options.apiKey)).toEqual(['sk-wrong', NEW_KEY]);
      expect(userKey()).toBe(NEW_KEY);
    });

    it('cancels without writing', async () => {
      const before = seedUser();
      const discover = vi.fn(async () => {
        throw new ModelDiscoveryError('Not authorized.', 'auth');
      });
      const { input } = terminal([NEW_KEY, 'c']);
      expect(await run('gw', { stdin: input, discover })).toBe('exit 1');
      expect(readFileSync(userPath(), 'utf-8')).toBe(before);
    });
  });
});
