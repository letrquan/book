import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeCredential } from '../auth/store.js';
import { runAuthLoginCommand, runAuthLogoutCommand, runAuthStatusCommand } from './auth-cmd.js';
import { setExitFn } from './exit.js';

let workspace: string;
let home: string;
let out: string[];
let errors: string[];
let exitCodes: number[];
const previousEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-auth-cmd-ws-'));
  home = mkdtempSync(join(tmpdir(), 'book-auth-cmd-home-'));
  out = [];
  errors = [];
  exitCodes = [];
  for (const key of [
    'BOOK_API_KEY',
    'BOOK_AUTH_PROFILE',
    'BOOK_AUTH_CLIENT_ID_ANTHROPIC',
    'BOOK_HOME',
  ]) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.BOOK_HOME = home;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setExitFn(((code: number) => {
    exitCodes.push(code);
    // Not `never` in tests: the command under test keeps running, which is what
    // lets an assertion see both the message and the code.
    return undefined as never;
  }) as (code: number) => never);
});

afterEach(() => {
  vi.restoreAllMocks();
  setExitFn((code: number): never => process.exit(code));
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function output(): string {
  return out.join('\n');
}

/**
 * Auth settings are read only from a trusted source, so these write the
 * user-global file. A workspace file's auth block is stripped by the loader -
 * see `settings-loader.test.ts`.
 */
function writeUserSettings(document: unknown): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify(document));
}

describe('book auth status', () => {
  it('reports the API-key path when nothing is stored', () => {
    runAuthStatusCommand({ workspace, home });
    expect(output()).toContain('API key (BOOK_API_KEY');
    expect(output()).toContain('(none)');
  });

  it('names the inferred credential and its expiry', () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'at', expiresAt: 3_600_000, account: 'a@b.c' } },
      { home },
    );
    runAuthStatusCommand({ workspace, home }, 0);
    expect(output()).toContain('anthropic — Anthropic (Claude subscription)');
    expect(output()).toContain('only matching login');
    expect(output()).toContain('a@b.c');
  });

  it('never prints a token', () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'secret-at', refreshToken: 'secret-rt' } },
      { home },
    );
    runAuthStatusCommand({ workspace, home });
    expect(output()).not.toContain('secret-at');
    expect(output()).not.toContain('secret-rt');
  });

  it('says a selected profile has nothing logged in', () => {
    writeUserSettings({ auth: { profile: 'anthropic' } });
    runAuthStatusCommand({ workspace, home });
    expect(output()).toContain('book auth login anthropic');
  });

  it('reports an unreadable store instead of pretending it is empty', () => {
    writeFileSync(join(home, 'auth.json'), 'not json');
    runAuthStatusCommand({ workspace, home });
    expect(output()).toContain('Unreadable');
  });

  it('surfaces an unknown configured profile as a finding, not a crash', () => {
    writeUserSettings({ auth: { profile: 'nope' } });
    runAuthStatusCommand({ workspace, home });
    expect(output()).toMatch(/Unknown auth profile "nope"/);
  });

  it('degrades to built-in profiles when settings will not parse', () => {
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(join(workspace, '.book', 'settings.json'), '{ "model":');
    expect(() => runAuthStatusCommand({ workspace, home })).not.toThrow();
    expect(output()).toContain('anthropic');
  });

  it('emits JSON with no secrets and a client-id flag', () => {
    writeCredential('codex', { kind: 'oauth', tokens: { accessToken: 'secret-at' } }, { home });
    runAuthStatusCommand({ workspace, home, json: true });
    const parsed = JSON.parse(output());
    expect(JSON.stringify(parsed)).not.toContain('secret-at');
    expect(parsed.active).toMatchObject({ profile: 'codex' });
    expect(parsed.profiles).toContainEqual(
      expect.objectContaining({ id: 'codex', clientIdConfigured: false, loggedIn: true }),
    );
  });
});

describe('book auth login', () => {
  it('lists the profiles when none is named', async () => {
    await runAuthLoginCommand(undefined, { workspace, home });
    expect(errors.join('\n')).toContain('anthropic, codex');
    expect(exitCodes).toEqual([1]);
  });

  it('rejects an unknown profile', async () => {
    await runAuthLoginCommand('anthropik', { workspace, home });
    expect(errors.join('\n')).toContain('Unknown auth profile "anthropik"');
    expect(exitCodes).toEqual([1]);
  });

  it('explains that "api-key" is a setting, not a login', async () => {
    await runAuthLoginCommand('api-key', { workspace, home });
    expect(errors.join('\n')).toContain('not a login profile');
    expect(exitCodes).toEqual([1]);
  });

  /**
   * The flow stops before opening a browser or binding a port, and says exactly
   * which two knobs supply the id Book deliberately does not ship.
   */
  it('stops with both ways to configure a client id', async () => {
    await runAuthLoginCommand('anthropic', { workspace, home });
    const message = errors.join('\n');
    expect(message).toContain('BOOK_AUTH_CLIENT_ID_ANTHROPIC');
    expect(message).toContain('auth.profiles.anthropic.clientId');
    expect(exitCodes).toEqual([1]);
  });

  it('rejects a nonsense timeout before starting the flow', async () => {
    process.env.BOOK_AUTH_CLIENT_ID_ANTHROPIC = 'client-123';
    await runAuthLoginCommand('anthropic', { workspace, home, timeout: 'soon' });
    expect(errors.join('\n')).toContain('--timeout must be a positive number of seconds');
    expect(exitCodes).toEqual([1]);
  });
});

describe('book auth logout', () => {
  it('removes one stored credential', () => {
    writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'at' } }, { home });
    runAuthLogoutCommand('anthropic', { workspace, home });
    expect(output()).toContain('Removed the stored "anthropic" credential');
  });

  it('says so plainly when there was nothing to remove', () => {
    runAuthLogoutCommand('anthropic', { workspace, home });
    expect(output()).toContain('No stored credential for "anthropic"');
  });

  it('lists the stored profiles when none is named', () => {
    writeCredential('codex', { kind: 'oauth', tokens: { accessToken: 'at' } }, { home });
    runAuthLogoutCommand(undefined, { workspace, home });
    expect(errors.join('\n')).toContain('codex');
    expect(exitCodes).toEqual([1]);
  });

  it('clears everything with --all', () => {
    writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'a' } }, { home });
    writeCredential('codex', { kind: 'oauth', tokens: { accessToken: 'b' } }, { home });
    runAuthLogoutCommand(undefined, { workspace, home, all: true });
    expect(output()).toContain('Removed 2 credential(s)');
  });
});
