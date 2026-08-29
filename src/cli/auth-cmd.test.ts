import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listCredentials, writeCredential } from '../auth/store.js';
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
    'BOOK_PROVIDER',
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

  /**
   * The one question this command answers. Hardcoding 'auto' made it report
   * "API key" for a run that loadConfig would in fact resolve to a subscription.
   */
  it('applies the same provider filter loadConfig does', () => {
    writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'a' } }, { home });
    writeCredential('codex', { kind: 'oauth', tokens: { accessToken: 'b' } }, { home });
    process.env.BOOK_PROVIDER = 'anthropic';

    runAuthStatusCommand({ workspace, home });

    expect(output()).toContain('anthropic — Anthropic (Claude subscription)');
  });

  it('reports no active credential when two logins remain ambiguous', () => {
    writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'a' } }, { home });
    writeCredential('codex', { kind: 'oauth', tokens: { accessToken: 'b' } }, { home });

    runAuthStatusCommand({ workspace, home });

    expect(output()).toContain('API key (BOOK_API_KEY');
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
  it('stops with remedies that actually work', async () => {
    await runAuthLoginCommand('anthropic', { workspace, home });
    const message = errors.join('\n');
    expect(message).toContain('BOOK_AUTH_CLIENT_ID_ANTHROPIC');
    expect(message).toContain('<BOOK_HOME>/settings.json');
    // `book config set auth.…` is refused by this same CLI, so pointing the
    // very first onboarding message at it would be a dead end.
    expect(message).not.toContain('book config set');
    expect(exitCodes).toEqual([1]);
  });

  it.each([
    ['not a number', 'soon'],
    ['zero', '0'],
    ['negative', '-5'],
    // Over setTimeout's 32-bit ceiling the delay silently collapses to 1ms, so
    // "wait longer" would instead fail the login on the next tick.
    ['past the setTimeout ceiling', '3000000'],
  ])('rejects a %s timeout before starting the flow', async (_label, timeout) => {
    process.env.BOOK_AUTH_CLIENT_ID_ANTHROPIC = 'client-123';
    await runAuthLoginCommand('anthropic', { workspace, home, timeout });
    expect(errors.join('\n')).toContain('--timeout must be a whole number of seconds');
    expect(exitCodes).toEqual([1]);
  });

  it('accepts the api-key sentinel in any casing, with the tailored message', async () => {
    await runAuthLoginCommand('API-Key', { workspace, home });
    expect(errors.join('\n')).toContain('not a login profile');
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

  /**
   * `book auth logout codex --all` reads as "all sessions for codex" but would
   * wipe every profile, costing a browser round trip to restore.
   */
  it('refuses a profile and --all together rather than silently wiping both', () => {
    writeCredential('anthropic', { kind: 'oauth', tokens: { accessToken: 'a' } }, { home });
    writeCredential('codex', { kind: 'oauth', tokens: { accessToken: 'b' } }, { home });

    runAuthLogoutCommand('codex', { workspace, home, all: true });

    expect(errors.join('\n')).toContain('Pass a profile or --all, not both');
    expect(exitCodes).toEqual([1]);
    expect(listCredentials({ home })).toHaveLength(2);
  });

  /**
   * A corrupt store is what someone runs logout to recover from, so the
   * writer's refusal has to arrive as a message rather than a stack trace.
   */
  it.each([
    ['--all', () => runAuthLogoutCommand(undefined, { workspace, home, all: true })],
    ['one profile', () => runAuthLogoutCommand('anthropic', { workspace, home })],
  ])('reports an unreadable store instead of throwing (%s)', (_label, run) => {
    writeFileSync(join(home, 'auth.json'), 'not json');

    expect(() => run()).not.toThrow();
    expect(errors.join('\n')).toContain('unreadable');
    expect(errors.join('\n')).toContain('Delete the file');
    expect(exitCodes).toEqual([1]);
  });
});
